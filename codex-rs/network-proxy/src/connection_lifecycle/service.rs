//! Cancels connection work when its executor's proxy scope ends, including HTTP upgrades.

use rama_core::Service;
use rama_core::extensions::ExtensionsRef;
use rama_core::rt::Executor;

/// Carries the proxy scope through connection, request, and upgrade extensions.
#[derive(Clone, Debug)]
pub(crate) struct ConnectionExecutor(pub(crate) Executor);

impl rama_core::extensions::Extension for ConnectionExecutor {}

#[derive(Clone)]
pub(crate) struct CancelOnShutdown<S> {
    inner: S,
}

impl<S> CancelOnShutdown<S> {
    pub(crate) fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S, Request> Service<Request> for CancelOnShutdown<S>
where
    S: Service<Request, Output = ()>,
    Request: ExtensionsRef + Send + 'static,
{
    type Output = ();
    type Error = S::Error;

    async fn serve(&self, request: Request) -> Result<(), Self::Error> {
        let guard = request
            .extensions()
            .get_ref::<ConnectionExecutor>()
            .and_then(|executor| executor.0.guard())
            .cloned();
        match guard {
            Some(guard) => {
                tokio::select! {
                    biased;
                    _ = guard.cancelled() => Ok(()),
                    result = self.inner.serve(request) => result,
                }
            }
            None => self.inner.serve(request).await,
        }
    }
}
