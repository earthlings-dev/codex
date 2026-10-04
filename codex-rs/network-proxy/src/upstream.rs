use crate::connect_policy::TargetCheckedTcpConnector;
use crate::connect_policy::is_non_public_target;
use crate::policy::is_private_network_ip;
use crate::state::NetworkProxyState;
use codex_utils_rustls_provider::ensure_rustls_crypto_provider;
use rama_core::Layer;
use rama_core::Service;
use rama_core::error::ErrorExt as _;
use rama_core::error::extra::OpaqueError;
use rama_core::extensions::ExtensionsRef;
use rama_core::rt::Executor;
use rama_core::service::BoxService;
use rama_http::Body;
use rama_http::Request;
use rama_http::Response;
use rama_http::Version;
use rama_http::layer::version_adapter::RequestVersionAdapter;
use rama_http_backend::client::HttpClientService;
use rama_http_backend::client::HttpConnector;
use rama_http_backend::client::proxy::layer::HttpProxyConnectorLayer;
use rama_net::ConnectorTargetInputExt;
use rama_net::ProtocolInputExt;
use rama_net::address::Host;
use rama_net::address::HostWithPort;
use rama_net::address::ProxyAddress;
use rama_net::client::EstablishedClientConnection;
use rama_tls_rustls::client::RustlsClientConfigExt;
use rama_tls_rustls::client::TlsConnectorLayer;
use rama_tls_rustls::client::client_root_certs;
use rama_tls_rustls::dep::rustls;
use rama_tls_rustls::types::client::TlsClientConfig;
use std::sync::Arc;
use std::time::Instant;
use tracing::info;
use tracing::warn;

#[cfg(target_os = "macos")]
use rama_unix::client::UnixConnector;

#[derive(Clone, Default)]
struct ProxyConfig {
    http: Option<ProxyAddress>,
    https: Option<ProxyAddress>,
    all: Option<ProxyAddress>,
    proxy_private_ips_via_upstream: bool,
}

impl ProxyConfig {
    fn from_env(proxy_private_ips_via_upstream: bool) -> Self {
        let http = read_proxy_env(&["HTTP_PROXY", "http_proxy"]);
        let https = read_proxy_env(&["HTTPS_PROXY", "https_proxy"]);
        let all = read_proxy_env(&["ALL_PROXY", "all_proxy"]);
        Self {
            http,
            https,
            all,
            proxy_private_ips_via_upstream,
        }
    }

    fn proxy_for_protocol(&self, is_secure: bool) -> Option<ProxyAddress> {
        if is_secure {
            self.https
                .clone()
                .or_else(|| self.http.clone())
                .or_else(|| self.all.clone())
        } else {
            self.http.clone().or_else(|| self.all.clone())
        }
    }

    fn proxy_for_target(&self, target: &HostWithPort, is_secure: bool) -> Option<ProxyAddress> {
        let proxy_private_ip = self.proxy_private_ips_via_upstream
            && matches!(&target.host, Host::Address(ip) if is_private_network_ip(*ip));
        if is_non_public_target(&target.host) && !proxy_private_ip {
            return None;
        }
        self.proxy_for_protocol(is_secure)
    }
}

fn read_proxy_env(keys: &[&str]) -> Option<ProxyAddress> {
    for key in keys {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match ProxyAddress::try_from(value) {
            Ok(proxy) => {
                if proxy
                    .protocol
                    .as_ref()
                    .map(rama_net::Protocol::is_http)
                    .unwrap_or(true)
                {
                    return Some(proxy);
                }
                warn!("ignoring {key}: non-http proxy protocol");
            }
            Err(err) => {
                warn!("ignoring {key}: invalid proxy address ({err})");
            }
        }
    }
    None
}

pub(crate) fn proxy_for_connect(
    target: &HostWithPort,
    state: &NetworkProxyState,
) -> Option<ProxyAddress> {
    ProxyConfig::from_env(state.proxy_private_ips_via_upstream)
        .proxy_for_target(target, /*is_secure*/ true)
}

#[derive(Clone)]
pub(crate) struct UpstreamClient {
    connector: BoxService<
        Request<Body>,
        EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
        OpaqueError,
    >,
    proxy_config: ProxyConfig,
}

impl UpstreamClient {
    pub(crate) fn direct(state: Arc<NetworkProxyState>) -> Self {
        Self::new(
            ProxyConfig::default(),
            TargetCheckedTcpConnector::new(state),
            client_root_certs(),
        )
    }

    pub(crate) fn from_env_proxy(state: Arc<NetworkProxyState>) -> Self {
        Self::new(
            ProxyConfig::from_env(state.proxy_private_ips_via_upstream),
            TargetCheckedTcpConnector::new(state),
            client_root_certs(),
        )
    }

    pub(crate) fn direct_with_tls_root_store(
        state: Arc<NetworkProxyState>,
        tls_root_store: Arc<rustls::RootCertStore>,
    ) -> Self {
        Self::new(
            ProxyConfig::default(),
            TargetCheckedTcpConnector::new(state),
            tls_root_store,
        )
    }

    pub(crate) fn from_env_proxy_with_tls_root_store(
        state: Arc<NetworkProxyState>,
        tls_root_store: Arc<rustls::RootCertStore>,
    ) -> Self {
        Self::new(
            ProxyConfig::from_env(state.proxy_private_ips_via_upstream),
            TargetCheckedTcpConnector::new(state),
            tls_root_store,
        )
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn unix_socket(path: &str) -> Self {
        let connector = build_unix_connector(path);
        Self {
            connector,
            proxy_config: ProxyConfig::default(),
        }
    }

    fn new(
        proxy_config: ProxyConfig,
        transport: TargetCheckedTcpConnector,
        tls_root_store: Arc<rustls::RootCertStore>,
    ) -> Self {
        let connector = build_http_connector(transport, tls_root_store);
        Self {
            connector,
            proxy_config,
        }
    }
}

impl Service<Request<Body>> for UpstreamClient {
    type Output = Response;
    type Error = OpaqueError;

    async fn serve(&self, req: Request<Body>) -> Result<Self::Output, Self::Error> {
        let connector_target = req.connector_target();
        let authority = connector_target
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "<unknown>".to_string());
        let proxy = connector_target.as_ref().map_or_else(
            || self.proxy_config.proxy_for_protocol(/*is_secure*/ false),
            |target| {
                self.proxy_config.proxy_for_target(
                    target,
                    req.protocol()
                        .map(rama_net::Protocol::is_secure)
                        .unwrap_or(false),
                )
            },
        );
        match proxy.as_ref() {
            Some(proxy) => info!(
                "HTTP upstream route selected (target={authority}, route=upstream_proxy, proxy={})",
                proxy.address
            ),
            None => info!("HTTP upstream route selected (target={authority}, route=direct)"),
        }
        if let Some(proxy) = proxy {
            req.extensions().insert(proxy);
        }

        let connect_started_at = Instant::now();
        let EstablishedClientConnection {
            input: req,
            conn: http_connection,
        } = match self.connector.serve(req).await {
            Ok(connection) => {
                info!(
                    "HTTP upstream connection established (target={authority}, elapsed_ms={})",
                    connect_started_at.elapsed().as_millis()
                );
                connection
            }
            Err(err) => {
                warn!(
                    "HTTP upstream connection failed (target={authority}, elapsed_ms={})",
                    connect_started_at.elapsed().as_millis()
                );
                return Err(err);
            }
        };

        req.extensions().extend(http_connection.extensions());

        let request_started_at = Instant::now();
        match http_connection.serve(req).await {
            Ok(resp) => {
                info!(
                    "HTTP upstream response headers received (target={authority}, elapsed_ms={})",
                    request_started_at.elapsed().as_millis()
                );
                Ok(resp)
            }
            Err(err) => {
                warn!(
                    "HTTP upstream response headers failed (target={authority}, elapsed_ms={})",
                    request_started_at.elapsed().as_millis()
                );
                Err(err.context("HTTP upstream request failed").into_opaque_error())
            }
        }
    }
}

fn build_http_connector(
    transport: TargetCheckedTcpConnector,
    tls_root_store: Arc<rustls::RootCertStore>,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    OpaqueError,
> {
    ensure_rustls_crypto_provider();
    let proxy = HttpProxyConnectorLayer::optional().into_layer(transport);
    let tls_config = tls_client_config(tls_root_store);
    let tls = TlsConnectorLayer::auto()
        .with_base_config(tls_config)
        .into_layer(proxy);
    let tls = RequestVersionAdapter::new(tls).with_default_version(Version::HTTP_11);
    let connector = HttpConnector::new(tls, Executor::default());
    connector.boxed()
}

fn tls_client_config(tls_root_store: Arc<rustls::RootCertStore>) -> TlsClientConfig {
    TlsClientConfig::new()
        .with_alpn_http_auto()
        .with_modify_rustls_config(move |mut config| {
            let verifier =
                rustls::client::WebPkiServerVerifier::builder(tls_root_store.clone()).build()?;
            config.dangerous().set_certificate_verifier(verifier);
            Ok(config)
        })
}

#[cfg(test)]
#[path = "upstream_tests.rs"]
mod tests;

#[cfg(target_os = "macos")]
fn build_unix_connector(
    path: &str,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    OpaqueError,
> {
    let transport = UnixConnector::fixed(path);
    let connector = HttpConnector::new(transport, Executor::default());
    connector.boxed()
}
