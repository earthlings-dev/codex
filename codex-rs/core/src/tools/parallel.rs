use std::sync::Arc;

use futures::lock::Mutex;
use tokio::sync::RwLock;
use tokio::sync::oneshot;
use tokio_util::either::Either;
use tokio_util::task::AbortOnDropHandle;

use crate::codex::Session;
use crate::codex::TurnContext;
use crate::error::CodexErr;
use crate::function_tool::FunctionCallError;
use crate::tools::context::SharedTurnDiffTracker;
use crate::tools::router::ToolCall;
use crate::tools::router::ToolRouter;
use codex_protocol::models::ResponseInputItem;

pub(crate) struct ToolCallRuntime {
    router: Arc<ToolRouter>,
    session: Arc<Session>,
    turn_context: Arc<TurnContext>,
    tracker: SharedTurnDiffTracker,
    sub_id: String,
    lock: Arc<RwLock<bool>>,
    pending_calls: Arc<Mutex<Vec<AbortOnDropHandle<()>>>>,
}

impl ToolCallRuntime {
    pub(crate) fn new(
        router: Arc<ToolRouter>,
        session: Arc<Session>,
        turn_context: Arc<TurnContext>,
        tracker: SharedTurnDiffTracker,
        sub_id: String,
    ) -> Self {
        Self {
            router,
            session,
            turn_context,
            tracker,
            sub_id,
            lock: Arc::new(RwLock::new(false)),
            pending_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(crate) async fn handle_tool_call(
        &self,
        call: ToolCall,
    ) -> Result<ResponseInputItem, CodexErr> {
        let supports_parallel = self.router.tool_supports_parallel(&call.tool_name);

        match self.spawn(call, supports_parallel).await {
            Ok(response) => Ok(response),
            Err(FunctionCallError::Fatal(message)) => Err(CodexErr::Fatal(message)),
            Err(other) => Err(CodexErr::Fatal(other.to_string())),
        }
    }

    async fn spawn(
        &self,
        call: ToolCall,
        supports_parallel: bool,
    ) -> Result<ResponseInputItem, FunctionCallError> {
        let router = Arc::clone(&self.router);
        let session = Arc::clone(&self.session);
        let turn = Arc::clone(&self.turn_context);
        let tracker = Arc::clone(&self.tracker);
        let sub_id = self.sub_id.clone();
        let (tx, rx) = oneshot::channel();
        let lock = self.lock.clone();
        let handle = tokio::spawn(async move {
            let _guard = if supports_parallel {
                Either::Left(lock.read().await)
            } else {
                Either::Right(lock.write().await)
            };

            let _ = tx.send(
                router
                    .dispatch_tool_call(session, turn, tracker, sub_id, call)
                    .await,
            );
        });

        self.pending_calls
            .lock()
            .await
            .push(AbortOnDropHandle::new(handle));

        rx.await.map_err(|err| {
            FunctionCallError::Fatal(format!("tool task failed to receive: {err:?}"))
        })?
    }
}
