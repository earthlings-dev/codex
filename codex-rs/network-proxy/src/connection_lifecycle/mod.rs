mod listeners;
mod scope;
mod service;

pub(crate) use listeners::ProxyListeners;
#[cfg(test)]
pub(crate) use scope::ConnectionLifecycle;
pub(crate) use service::CancelOnShutdown;
pub(crate) use service::ConnectionExecutor;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
