use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::local_agent::TrackedChannel;
use crate::local_agent::{
    LocalAgentEvent, LocalToolAnnotations, LocalToolHostApproval, LocalToolResolution,
    LocalToolSpec,
};
use crate::local_agent_runtime::{AdapterError, LocalCliFailureCode};
use crate::timeouts::wait_with_timeout_retries;

pub(crate) const MAX_ARGUMENT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_RESULT_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

const TOOL_CALL_BUDGET_EXHAUSTED: &str = "local agent tool-call budget exhausted";

type PendingResult = Result<LocalToolResolution, BrokerError>;

#[derive(Clone, Copy)]
struct BrokerLimits {
    max_argument_bytes: usize,
    max_result_bytes: usize,
    tool_call_timeout: Duration,
}

impl Default for BrokerLimits {
    fn default() -> Self {
        Self {
            max_argument_bytes: MAX_ARGUMENT_BYTES,
            max_result_bytes: MAX_RESULT_BYTES,
            tool_call_timeout: TOOL_CALL_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerTool {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: serde_json::Value,
    pub(crate) annotations: LocalToolAnnotations,
    pub(crate) host_approval: LocalToolHostApproval,
}

impl From<LocalToolSpec> for BrokerTool {
    fn from(value: LocalToolSpec) -> Self {
        Self {
            name: value.name,
            description: value.description,
            input_schema: value.input_schema,
            annotations: value.annotations,
            host_approval: value.host_approval,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BrokerToolCatalog {
    pub(crate) run_id: String,
    pub(crate) tools: Vec<BrokerTool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerErrorKind {
    MissingBearer,
    InvalidBearer,
    RunCancelled,
    UnknownTool,
    InvalidArguments,
    ArgumentsTooLarge,
    BudgetExhausted,
    ConsumerUnavailable,
    PendingCancelled,
    TimedOut,
    ResultTooLarge,
    Internal,
}

#[derive(Clone, Debug)]
pub(crate) struct BrokerError {
    kind: BrokerErrorKind,
    message: String,
}

impl BrokerError {
    fn new(kind: BrokerErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> BrokerErrorKind {
        self.kind
    }

    pub(crate) fn code(&self) -> &'static str {
        match self.kind {
            BrokerErrorKind::MissingBearer => "missing_bearer",
            BrokerErrorKind::InvalidBearer => "invalid_bearer",
            BrokerErrorKind::RunCancelled => "run_cancelled",
            BrokerErrorKind::UnknownTool => "unknown_tool",
            BrokerErrorKind::InvalidArguments => "invalid_arguments",
            BrokerErrorKind::ArgumentsTooLarge => "arguments_too_large",
            BrokerErrorKind::BudgetExhausted => "tool_budget_exhausted",
            BrokerErrorKind::ConsumerUnavailable => "consumer_unavailable",
            BrokerErrorKind::PendingCancelled => "tool_call_cancelled",
            BrokerErrorKind::TimedOut => "tool_call_timed_out",
            BrokerErrorKind::ResultTooLarge => "result_too_large",
            BrokerErrorKind::Internal => "internal_error",
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn is_tool_result_error(&self) -> bool {
        matches!(
            self.kind,
            BrokerErrorKind::PendingCancelled
                | BrokerErrorKind::TimedOut
                | BrokerErrorKind::ResultTooLarge
        )
    }
}

struct BrokerRun {
    run_id: String,
    tools: Vec<BrokerTool>,
    max_tool_calls: usize,
    tool_calls_started: AtomicUsize,
    cancellation: CancellationToken,
    channel: TrackedChannel,
    pending: Mutex<HashMap<String, PendingCall>>,
    failure: Mutex<Option<AdapterError>>,
}

struct PendingCall {
    name: String,
    sender: oneshot::Sender<PendingResult>,
    cancellation: CancellationToken,
    media_claimed: bool,
}

impl BrokerRun {
    fn fail(&self, code: LocalCliFailureCode, reason: &'static str) {
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(AdapterError::coded(code, reason));
            }
        }
        self.abort(reason);
    }

    fn abort(&self, reason: &str) {
        self.cancellation.cancel();
        self.cancel_pending(reason);
    }

    fn reserve_tool_call(&self) -> bool {
        if self.max_tool_calls == 0 {
            return true;
        }
        let mut started = self.tool_calls_started.load(Ordering::Acquire);
        while started < self.max_tool_calls {
            match self.tool_calls_started.compare_exchange_weak(
                started,
                started + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(current) => started = current,
            }
        }
        self.fail(
            LocalCliFailureCode::ToolBudgetExceeded,
            TOOL_CALL_BUDGET_EXHAUSTED,
        );
        false
    }

    fn cancel_pending(&self, reason: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, call) in pending.drain() {
                call.cancellation.cancel();
                let _ = call.sender.send(Err(BrokerError::new(
                    BrokerErrorKind::PendingCancelled,
                    reason,
                )));
            }
        }
    }
}

#[derive(Default)]
struct RegistryState {
    by_token: HashMap<String, Arc<BrokerRun>>,
    token_by_run: HashMap<String, String>,
}

struct PendingCallGuard {
    run: Arc<BrokerRun>,
    call_id: String,
}

impl PendingCallGuard {
    fn new(run: Arc<BrokerRun>, call_id: String) -> Self {
        Self { run, call_id }
    }
}

impl Drop for PendingCallGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.run.pending.lock() {
            if let Some(call) = pending.remove(&self.call_id) {
                call.cancellation.cancel();
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct ToolBroker {
    state: Arc<Mutex<RegistryState>>,
    limits: BrokerLimits,
}

impl Default for ToolBroker {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            limits: BrokerLimits::default(),
        }
    }
}

impl ToolBroker {
    #[cfg(test)]
    fn with_limits(max_argument_bytes: usize, max_result_bytes: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            limits: BrokerLimits {
                max_argument_bytes,
                max_result_bytes,
                tool_call_timeout: Duration::from_secs(5),
            },
        }
    }

    pub(crate) fn register(
        &self,
        run_id: String,
        tools: Vec<LocalToolSpec>,
        max_tool_calls: usize,
        cancellation: CancellationToken,
        channel: TrackedChannel,
    ) -> Result<String, String> {
        let tools = validate_tools(tools)?;
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let run = Arc::new(BrokerRun {
            run_id: run_id.clone(),
            tools,
            max_tool_calls,
            tool_calls_started: AtomicUsize::new(0),
            cancellation,
            channel,
            pending: Mutex::new(HashMap::new()),
            failure: Mutex::new(None),
        });

        let replaced = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "tool broker lock poisoned".to_string())?;
            let replaced = state
                .token_by_run
                .insert(run_id, token.clone())
                .and_then(|previous_token| state.by_token.remove(&previous_token));
            state.by_token.insert(token.clone(), run);
            replaced
        };
        if let Some(replaced) = replaced {
            replaced.abort("local agent run was replaced");
        }
        Ok(token)
    }

    pub(crate) fn catalog(
        &self,
        authorization: Option<&str>,
    ) -> Result<BrokerToolCatalog, BrokerError> {
        let run = self.run_from_authorization(authorization)?;
        if run.cancellation.is_cancelled() {
            return Err(BrokerError::new(
                BrokerErrorKind::RunCancelled,
                "local agent run is cancelled",
            ));
        }
        Ok(BrokerToolCatalog {
            run_id: run.run_id.clone(),
            tools: run.tools.clone(),
        })
    }

    pub(crate) async fn call(
        &self,
        authorization: Option<&str>,
        name: String,
        arguments: serde_json::Value,
    ) -> Result<LocalToolResolution, BrokerError> {
        let run = self.run_from_authorization(authorization)?;
        if run.cancellation.is_cancelled() {
            return Err(BrokerError::new(
                BrokerErrorKind::RunCancelled,
                "local agent run is cancelled",
            ));
        }
        if !run.tools.iter().any(|tool| tool.name == name) {
            run.fail(
                LocalCliFailureCode::IsolationViolation,
                "local agent requested an unknown tool",
            );
            return Err(BrokerError::new(
                BrokerErrorKind::UnknownTool,
                "tool is not authorized for this run",
            ));
        }
        if !arguments.is_object() {
            run.fail(
                LocalCliFailureCode::ProtocolViolation,
                "local agent supplied non-object tool arguments",
            );
            return Err(BrokerError::new(
                BrokerErrorKind::InvalidArguments,
                "tool arguments must be a JSON object",
            ));
        }
        let argument_bytes = serde_json::to_vec(&arguments)
            .map_err(|_| {
                BrokerError::new(BrokerErrorKind::InvalidArguments, "invalid tool arguments")
            })?
            .len();
        if argument_bytes > self.limits.max_argument_bytes {
            run.fail(
                LocalCliFailureCode::OutputLimit,
                "local agent tool arguments exceeded the request limit",
            );
            return Err(BrokerError::new(
                BrokerErrorKind::ArgumentsTooLarge,
                "tool arguments exceed the request limit",
            ));
        }
        if !run.reserve_tool_call() {
            return Err(BrokerError::new(
                BrokerErrorKind::BudgetExhausted,
                TOOL_CALL_BUDGET_EXHAUSTED,
            ));
        }

        let call_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let call_cancellation = run.cancellation.child_token();
        run.pending
            .lock()
            .map_err(|_| BrokerError::new(BrokerErrorKind::Internal, "tool call lock poisoned"))?
            .insert(
                call_id.clone(),
                PendingCall {
                    name: name.clone(),
                    sender,
                    cancellation: call_cancellation,
                    media_claimed: false,
                },
            );
        let _guard = PendingCallGuard::new(run.clone(), call_id.clone());

        if run
            .channel
            .send(LocalAgentEvent::ToolRequest {
                run_id: run.run_id.clone(),
                call_id,
                name,
                arguments,
            })
            .is_err()
        {
            run.fail(
                LocalCliFailureCode::ConsumerGone,
                "tool broker consumer is unavailable",
            );
            return Err(BrokerError::new(
                BrokerErrorKind::ConsumerUnavailable,
                "tool broker consumer is unavailable",
            ));
        }

        let result = tokio::select! {
            biased;
            _ = run.cancellation.cancelled() => Err(BrokerError::new(
                BrokerErrorKind::PendingCancelled,
                "Open Builder cancelled this tool call.",
            )),
            result = wait_with_timeout_retries(receiver, self.limits.tool_call_timeout) => {
                match result {
                    Ok(Ok(Ok(value))) => Ok(value),
                    Ok(Ok(Err(error))) => Err(error),
                    Ok(Err(_)) => Err(BrokerError::new(
                        BrokerErrorKind::PendingCancelled,
                        "Open Builder cancelled this tool call.",
                    )),
                    Err(_) => Err(BrokerError::new(
                        BrokerErrorKind::TimedOut,
                        "Open Builder tool call timed out.",
                    )),
                }
            }
        };
        result
    }

    pub(crate) fn resolve(
        &self,
        run_id: &str,
        call_id: &str,
        result: LocalToolResolution,
    ) -> Result<(), String> {
        let run = self.run_for_id(run_id).map_err(|error| error.message)?;
        let call = run
            .pending
            .lock()
            .map_err(|_| "tool call lock poisoned".to_string())?
            .remove(call_id)
            .ok_or_else(|| "local agent tool call is not pending".to_string())?;
        call.cancellation.cancel();

        if let Err(error) = self.validate_result_size(&result) {
            let message = error.message.clone();
            let _ = call.sender.send(Err(error));
            return Err(message);
        }
        call.sender
            .send(Ok(result))
            .map_err(|_| "local agent tool call was cancelled".to_string())
    }

    pub(crate) fn claim_pending_tool(
        &self,
        run_id: &str,
        call_id: &str,
        expected_name: &str,
    ) -> Result<CancellationToken, String> {
        let run = self.run_for_id(run_id).map_err(|error| error.message)?;
        if run.cancellation.is_cancelled() {
            return Err("local agent run is cancelled".to_string());
        }
        let mut pending = run
            .pending
            .lock()
            .map_err(|_| "tool call lock poisoned".to_string())?;
        let call = pending
            .get_mut(call_id)
            .ok_or_else(|| "local agent tool call is not pending".to_string())?;
        if call.name != expected_name {
            return Err("local agent tool call does not authorize this operation".to_string());
        }
        if call.media_claimed {
            return Err("local agent tool call authority was already claimed".to_string());
        }
        call.media_claimed = true;
        Ok(call.cancellation.child_token())
    }

    pub(crate) fn failure(&self, run_id: &str) -> Option<AdapterError> {
        let run = self.run_for_id(run_id).ok()?;
        let failure = run.failure.lock().ok()?.clone();
        failure
    }

    pub(crate) fn unregister(&self, run_id: &str, reason: &str) {
        let run = self.state.lock().ok().and_then(|mut state| {
            state
                .token_by_run
                .remove(run_id)
                .and_then(|token| state.by_token.remove(&token))
        });
        if let Some(run) = run {
            run.abort(reason);
        }
    }

    pub(crate) fn shutdown(&self, reason: &str) {
        let runs = self
            .state
            .lock()
            .map(|mut state| {
                state.token_by_run.clear();
                state
                    .by_token
                    .drain()
                    .map(|(_, run)| run)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for run in runs {
            run.abort(reason);
        }
    }

    fn validate_result_size(&self, result: &LocalToolResolution) -> Result<(), BrokerError> {
        let result_bytes = serde_json::to_vec(result)
            .map_err(|_| BrokerError::new(BrokerErrorKind::Internal, "invalid tool result"))?
            .len();
        if result_bytes > self.limits.max_result_bytes {
            return Err(BrokerError::new(
                BrokerErrorKind::ResultTooLarge,
                "Open Builder tool result exceeded the response limit.",
            ));
        }
        Ok(())
    }

    fn run_from_authorization(
        &self,
        authorization: Option<&str>,
    ) -> Result<Arc<BrokerRun>, BrokerError> {
        let authorization = authorization.ok_or_else(|| {
            BrokerError::new(
                BrokerErrorKind::MissingBearer,
                "missing tool broker credentials",
            )
        })?;
        let token = authorization
            .strip_prefix("Bearer ")
            .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
            .ok_or_else(|| {
                BrokerError::new(
                    BrokerErrorKind::InvalidBearer,
                    "invalid tool broker credentials",
                )
            })?;
        self.state
            .lock()
            .map_err(|_| BrokerError::new(BrokerErrorKind::Internal, "tool broker lock poisoned"))?
            .by_token
            .get(token)
            .cloned()
            .ok_or_else(|| {
                BrokerError::new(
                    BrokerErrorKind::InvalidBearer,
                    "invalid tool broker credentials",
                )
            })
    }

    fn run_for_id(&self, run_id: &str) -> Result<Arc<BrokerRun>, BrokerError> {
        let state = self.state.lock().map_err(|_| {
            BrokerError::new(BrokerErrorKind::Internal, "tool broker lock poisoned")
        })?;
        let token = state.token_by_run.get(run_id).ok_or_else(|| {
            BrokerError::new(
                BrokerErrorKind::RunCancelled,
                "local agent run is not active",
            )
        })?;
        state.by_token.get(token).cloned().ok_or_else(|| {
            BrokerError::new(
                BrokerErrorKind::RunCancelled,
                "local agent run is not active",
            )
        })
    }
}

fn validate_tools(tools: Vec<LocalToolSpec>) -> Result<Vec<BrokerTool>, String> {
    let mut names = HashSet::with_capacity(tools.len());
    let mut validated: Vec<BrokerTool> = Vec::with_capacity(tools.len());
    for tool in tools {
        if tool.name.is_empty() || !tool.input_schema.is_object() {
            return Err("invalid local agent tool definition".to_string());
        }
        if tool.annotations.read_only_hint == Some(true)
            && tool.annotations.destructive_hint == Some(true)
        {
            return Err(format!(
                "invalid local agent tool annotations: {}",
                tool.name
            ));
        }
        if !names.insert(tool.name.clone()) {
            return Err(format!("duplicate local agent tool: {}", tool.name));
        }
        validated.push(tool.into());
    }
    validated.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(validated)
}

pub(crate) fn canonical_tool_digest(tools: &[LocalToolSpec]) -> Result<String, String> {
    let mut tools = tools
        .iter()
        .cloned()
        .map(BrokerTool::from)
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    let canonical = serde_json::to_vec(&tools)
        .map_err(|_| "failed to serialize canonical local tools".to_string())?;
    let digest = Sha256::digest(canonical);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;
    use std::thread;

    use serde_json::json;
    use tauri::ipc::InvokeResponseBody;
    use tokio::sync::mpsc;

    use super::*;

    fn tool(name: &str) -> LocalToolSpec {
        LocalToolSpec {
            name: name.to_string(),
            description: format!("{name} description"),
            input_schema: json!({"type": "object"}),
            annotations: Default::default(),
            host_approval: Default::default(),
        }
    }

    fn channel() -> (
        tauri::ipc::Channel<LocalAgentEvent>,
        mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str(&json) {
                    let _ = sender.send(event);
                }
            }
            Ok(())
        });
        (channel, receiver)
    }

    fn failing_channel() -> tauri::ipc::Channel<LocalAgentEvent> {
        tauri::ipc::Channel::new(|_| {
            Err(std::io::Error::other("test event consumer is unavailable").into())
        })
    }

    fn resolution(text: &str) -> LocalToolResolution {
        LocalToolResolution {
            text: text.to_string(),
            is_error: Some(false),
            structured_content: None,
            content: None,
        }
    }

    fn register(
        broker: &ToolBroker,
        max_tool_calls: usize,
    ) -> (
        String,
        CancellationToken,
        mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let cancellation = CancellationToken::new();
        let (channel, receiver) = channel();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("allowed")],
                max_tool_calls,
                cancellation.clone(),
                channel.into(),
            )
            .unwrap();
        (token, cancellation, receiver)
    }

    #[test]
    fn bearer_authentication_is_strict_and_run_scoped() {
        let broker = ToolBroker::default();
        let (token, _, _) = register(&broker, 1);
        assert_eq!(
            broker.catalog(None).unwrap_err().kind(),
            BrokerErrorKind::MissingBearer
        );
        assert_eq!(
            broker.catalog(Some("Basic abc")).unwrap_err().kind(),
            BrokerErrorKind::InvalidBearer
        );
        assert_eq!(
            broker.catalog(Some("Bearer unknown")).unwrap_err().kind(),
            BrokerErrorKind::InvalidBearer
        );
        let catalog = broker.catalog(Some(&format!("Bearer {token}"))).unwrap();
        assert_eq!(catalog.run_id, "run");
        assert_eq!(catalog.tools[0].name, "allowed");
    }

    #[test]
    fn duplicate_tool_registration_is_rejected() {
        let broker = ToolBroker::default();
        let (channel, _) = channel();
        let result = broker.register(
            "run".to_string(),
            vec![tool("same"), tool("same")],
            1,
            CancellationToken::new(),
            channel.into(),
        );
        assert!(matches!(result, Err(message) if message.contains("duplicate")));
    }

    #[test]
    fn arbitrary_task_ids_cannot_claim_media_authority() {
        let broker = ToolBroker::default();
        assert!(broker
            .claim_pending_tool("missing-run", "missing-call", "generate_image")
            .is_err());
    }

    #[tokio::test]
    async fn another_pending_tool_cannot_authorize_image_generation() {
        let broker = ToolBroker::with_limits(128, 128);
        let (channel, mut events) = channel();
        let cancellation = CancellationToken::new();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("read_file")],
                1,
                cancellation,
                channel.into(),
            )
            .unwrap();
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "read_file".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let run_id = event["runId"].as_str().unwrap();
        let call_id = event["callId"].as_str().unwrap();
        assert!(broker
            .claim_pending_tool(run_id, call_id, "generate_image")
            .is_err());
        broker.resolve(run_id, call_id, resolution("read")).unwrap();
        assert_eq!(caller.await.unwrap().unwrap().text, "read");
    }

    #[tokio::test]
    async fn exact_pending_image_call_is_single_use_and_follows_parent_cancellation() {
        let broker = ToolBroker::with_limits(128, 128);
        let (channel, mut events) = channel();
        let parent_cancellation = CancellationToken::new();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("generate_image")],
                1,
                parent_cancellation.clone(),
                channel.into(),
            )
            .unwrap();
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(
                        Some(&authorization),
                        "generate_image".to_string(),
                        json!({}),
                    )
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let run_id = event["runId"].as_str().unwrap();
        let call_id = event["callId"].as_str().unwrap();
        let media_cancellation = broker
            .claim_pending_tool(run_id, call_id, "generate_image")
            .unwrap();
        assert!(!media_cancellation.is_cancelled());
        assert!(broker
            .claim_pending_tool(run_id, call_id, "generate_image")
            .is_err());

        parent_cancellation.cancel();
        assert!(media_cancellation.is_cancelled());
        assert_eq!(
            caller.await.unwrap().unwrap_err().kind(),
            BrokerErrorKind::PendingCancelled
        );
    }

    #[tokio::test]
    async fn unlimited_run_completes_more_than_512_host_calls() {
        let broker = ToolBroker::default();
        let (token, cancellation, mut events) = register(&broker, 0);
        let authorization = format!("Bearer {token}");
        for index in 0..600 {
            let caller = {
                let broker = broker.clone();
                let authorization = authorization.clone();
                tokio::spawn(async move {
                    broker
                        .call(
                            Some(&authorization),
                            "allowed".to_string(),
                            json!({"index": index}),
                        )
                        .await
                })
            };
            let event = tokio::select! {
                event = events.recv() => event.expect("missing Host tool event"),
                _ = cancellation.cancelled() => panic!("unlimited run stopped at call {}", index + 1),
            };
            assert_eq!(event["arguments"]["index"], index);
            broker
                .resolve(
                    "run",
                    event["callId"].as_str().unwrap(),
                    resolution("saved"),
                )
                .unwrap();
            assert_eq!(caller.await.unwrap().unwrap().text, "saved");
        }
        assert!(!cancellation.is_cancelled());
        assert!(broker.failure("run").is_none());
        broker.unregister("run", "test complete");
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn thirty_completed_calls_then_budget_stop_has_a_distinct_reason() {
        let broker = ToolBroker::default();
        let cancellation = crate::local_agent_runtime::RunCancellation::new();
        let (channel, mut events) = channel();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("allowed")],
                30,
                cancellation.authority_token(),
                channel.into(),
            )
            .unwrap();
        let authorization = format!("Bearer {token}");
        for _ in 0..30 {
            let caller = {
                let broker = broker.clone();
                let authorization = authorization.clone();
                tokio::spawn(async move {
                    broker
                        .call(Some(&authorization), "allowed".to_string(), json!({}))
                        .await
                })
            };
            let event = events.recv().await.unwrap();
            broker
                .resolve(
                    "run",
                    event["callId"].as_str().unwrap(),
                    resolution("saved"),
                )
                .unwrap();
            assert_eq!(caller.await.unwrap().unwrap().text, "saved");
        }
        assert!(!cancellation.authority_token().is_cancelled());
        let denied = broker
            .call(Some(&authorization), "allowed".to_string(), json!({}))
            .await
            .unwrap_err();
        assert_eq!(denied.kind(), BrokerErrorKind::BudgetExhausted);
        assert!(events.try_recv().is_err());
        assert!(cancellation.authority_token().is_cancelled());
        assert!(!cancellation.stop_requested());
        let failure = crate::local_agent_runtime::LocalCliFailure::from_adapter(
            crate::local_agent::LocalAgentProvider::Codex,
            crate::local_agent_runtime::LocalCliFailurePhase::Tool,
            &broker.failure("run").unwrap(),
            false,
            cancellation.stop_requested(),
        );
        assert_eq!(
            serde_json::to_value(failure).unwrap()["code"],
            "toolBudgetExceeded"
        );
    }

    #[test]
    fn largest_explicit_budget_stops_without_overflowing_the_counter() {
        let broker = ToolBroker::default();
        let (_, cancellation, _) = register(&broker, usize::MAX);
        let run = broker.run_for_id("run").unwrap();
        run.tool_calls_started
            .store(usize::MAX - 1, Ordering::Release);
        assert!(run.reserve_tool_call());
        assert!(!run.reserve_tool_call());
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn total_budget_is_atomic_under_concurrent_reservations() {
        let (channel, _) = channel();
        let run = Arc::new(BrokerRun {
            run_id: "run".to_string(),
            tools: vec![],
            max_tool_calls: 8,
            tool_calls_started: AtomicUsize::new(0),
            cancellation: CancellationToken::new(),
            channel: channel.into(),
            pending: Mutex::new(HashMap::new()),
            failure: Mutex::new(None),
        });
        let barrier = Arc::new(Barrier::new(33));
        let handles = (0..32)
            .map(|_| {
                let run = run.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    run.reserve_tool_call()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let reserved = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|reserved| *reserved)
            .count();
        assert_eq!(reserved, 8);
        assert!(run.cancellation.is_cancelled());
        assert_eq!(
            run.failure.lock().unwrap().as_ref().unwrap().code,
            Some(LocalCliFailureCode::ToolBudgetExceeded)
        );
    }

    #[tokio::test]
    async fn unknown_tool_and_oversized_arguments_abort_the_run() {
        let broker = ToolBroker::with_limits(32, 64);
        let (token, cancellation, _) = register(&broker, 2);
        let authorization = format!("Bearer {token}");
        let error = broker
            .call(Some(&authorization), "unknown".to_string(), json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::UnknownTool);
        assert!(cancellation.is_cancelled());
        assert_eq!(
            broker.failure("run").unwrap().code,
            Some(LocalCliFailureCode::IsolationViolation)
        );

        let broker = ToolBroker::with_limits(32, 64);
        let (token, cancellation, _) = register(&broker, 2);
        let authorization = format!("Bearer {token}");
        let error = broker
            .call(
                Some(&authorization),
                "allowed".to_string(),
                json!({"value": "x".repeat(64)}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::ArgumentsTooLarge);
        assert!(cancellation.is_cancelled());
        assert_eq!(
            broker.failure("run").unwrap().code,
            Some(LocalCliFailureCode::OutputLimit)
        );
    }

    #[tokio::test]
    async fn unavailable_event_consumer_aborts_the_run() {
        let broker = ToolBroker::with_limits(128, 128);
        let cancellation = CancellationToken::new();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("allowed")],
                1,
                cancellation.clone(),
                failing_channel().into(),
            )
            .unwrap();
        let error = broker
            .call(
                Some(&format!("Bearer {token}")),
                "allowed".to_string(),
                json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::ConsumerUnavailable);
        assert!(cancellation.is_cancelled());
        assert_eq!(
            broker.failure("run").unwrap().code,
            Some(LocalCliFailureCode::ConsumerGone)
        );
    }

    #[tokio::test]
    async fn broker_failure_closes_authority_without_requesting_stop() {
        let broker = ToolBroker::with_limits(128, 128);
        let cancellation = crate::local_agent_runtime::RunCancellation::new();
        let (channel, mut events) = channel();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("allowed")],
                2,
                cancellation.authority_token(),
                channel.into(),
            )
            .unwrap();
        let error = broker
            .call(
                Some(&format!("Bearer {token}")),
                "allowed".to_string(),
                json!([]),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::InvalidArguments);
        assert!(cancellation.authority_token().is_cancelled());
        assert!(!cancellation.stop_requested());
        assert!(events.try_recv().is_err());
        let recorded = broker.failure("run").unwrap();
        assert_eq!(recorded.code, Some(LocalCliFailureCode::ProtocolViolation));
        let run = broker.run_for_id("run").unwrap();
        broker.unregister("run", "normal cleanup");
        assert_eq!(run.failure.lock().unwrap().as_ref(), Some(&recorded));
    }

    #[tokio::test]
    async fn explicit_stop_closes_host_authority_without_a_broker_failure() {
        let broker = ToolBroker::with_limits(128, 128);
        let cancellation = crate::local_agent_runtime::RunCancellation::new();
        let (channel, mut events) = channel();
        let token = broker
            .register(
                "run".to_string(),
                vec![tool("allowed")],
                2,
                cancellation.authority_token(),
                channel.into(),
            )
            .unwrap();
        cancellation.request_stop();
        let error = broker
            .call(
                Some(&format!("Bearer {token}")),
                "allowed".to_string(),
                json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::RunCancelled);
        assert!(events.try_recv().is_err());
        assert!(broker.failure("run").is_none());
    }

    #[tokio::test]
    async fn oversized_result_resolves_and_removes_pending_call() {
        let broker = ToolBroker::with_limits(128, 64);
        let (token, _, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["type"], "toolRequest");
        let run_id = event["runId"].as_str().unwrap();
        let call_id = event["callId"].as_str().unwrap();
        let result = LocalToolResolution {
            text: "x".repeat(128),
            is_error: None,
            structured_content: None,
            content: None,
        };
        assert!(broker.resolve(run_id, call_id, result).is_err());
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::ResultTooLarge);
        assert!(matches!(
            broker.resolve(
                run_id,
                call_id,
                LocalToolResolution {
                    text: "late".to_string(),
                    is_error: None,
                    structured_content: None,
                    content: None,
                }
            ),
            Err(message) if message.contains("not pending")
        ));
    }

    #[tokio::test]
    async fn unregister_cancels_pending_calls() {
        let broker = ToolBroker::with_limits(128, 128);
        let (token, cancellation, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let _ = events.recv().await.unwrap();
        broker.unregister("run", "cancelled by test");
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::PendingCancelled);
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn closed_run_authority_rejects_late_tool_calls_without_emitting_events() {
        let broker = ToolBroker::with_limits(128, 128);
        let (token, cancellation, mut events) = register(&broker, 1);
        cancellation.cancel();
        let error = broker
            .call(
                Some(&format!("Bearer {token}")),
                "allowed".to_string(),
                json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::RunCancelled);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn cancellation_removes_pending_call_before_late_resolution() {
        let broker = ToolBroker::with_limits(128, 128);
        let (token, cancellation, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let run_id = event["runId"].as_str().unwrap().to_string();
        let call_id = event["callId"].as_str().unwrap().to_string();
        cancellation.cancel();
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::PendingCancelled);
        assert!(matches!(
            broker.resolve(
                &run_id,
                &call_id,
                LocalToolResolution {
                    text: "late".to_string(),
                    is_error: None,
                    structured_content: None,
                    content: None,
                }
            ),
            Err(message) if message.contains("not pending")
        ));
    }

    #[tokio::test]
    async fn a_slow_host_result_uses_one_call_across_timeout_windows() {
        let broker = ToolBroker::with_limits(128, 128);
        let (token, cancellation, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert!(!caller.is_finished());
        assert!(events.try_recv().is_err());
        broker
            .resolve(
                "run",
                event["callId"].as_str().unwrap(),
                resolution("saved once"),
            )
            .unwrap();
        assert_eq!(caller.await.unwrap().unwrap().text, "saved once");
        assert!(!cancellation.is_cancelled());
        assert_eq!(
            broker
                .run_for_id("run")
                .unwrap()
                .tool_calls_started
                .load(Ordering::Acquire),
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn host_timeout_fails_after_three_windows_and_rejects_late_result() {
        let broker = ToolBroker::with_limits(128, 128);
        let (token, _, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let started = tokio::time::Instant::now();
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::TimedOut);
        assert_eq!(started.elapsed(), Duration::from_secs(15));
        assert!(events.try_recv().is_err());
        assert!(broker
            .resolve("run", event["callId"].as_str().unwrap(), resolution("late"))
            .is_err());
    }

    #[tokio::test]
    async fn timeout_removes_pending_call_before_late_resolution() {
        let broker = ToolBroker {
            state: Arc::new(Mutex::new(RegistryState::default())),
            limits: BrokerLimits {
                max_argument_bytes: 128,
                max_result_bytes: 128,
                tool_call_timeout: Duration::from_millis(10),
            },
        };
        let (token, _, mut events) = register(&broker, 1);
        let authorization = format!("Bearer {token}");
        let caller = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .call(Some(&authorization), "allowed".to_string(), json!({}))
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let run_id = event["runId"].as_str().unwrap().to_string();
        let call_id = event["callId"].as_str().unwrap().to_string();
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), BrokerErrorKind::TimedOut);
        assert!(matches!(
            broker.resolve(
                &run_id,
                &call_id,
                LocalToolResolution {
                    text: "late".to_string(),
                    is_error: None,
                    structured_content: None,
                    content: None,
                }
            ),
            Err(message) if message.contains("not pending")
        ));
    }

    #[test]
    fn canonical_digest_sorts_tools_by_name() {
        let left = canonical_tool_digest(&[tool("b"), tool("a")]).unwrap();
        let right = canonical_tool_digest(&[tool("a"), tool("b")]).unwrap();
        assert_eq!(left, right);
        assert_eq!(left.len(), 64);
    }
}
