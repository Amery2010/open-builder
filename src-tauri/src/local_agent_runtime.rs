use std::fmt;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::local_agent::LocalAgentProvider;

/// An explicit Stop cancels the parent; protocol completion only closes the
/// child used by the Provider and Host authority. Cleanup is not a Stop reason.
#[derive(Clone)]
pub(crate) struct RunCancellation {
    stop: CancellationToken,
    authority: CancellationToken,
}

impl RunCancellation {
    pub(crate) fn new() -> Self {
        let stop = CancellationToken::new();
        let authority = stop.child_token();
        Self { stop, authority }
    }

    pub(crate) fn authority_token(&self) -> CancellationToken {
        self.authority.clone()
    }

    pub(crate) fn request_stop(&self) {
        self.stop.cancel();
    }

    pub(crate) fn stop_requested(&self) -> bool {
        self.stop.is_cancelled()
    }

    pub(crate) async fn stopped(&self) {
        self.stop.cancelled().await;
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliFailureCode {
    ExecutableNotFound,
    CliUnsupported,
    SetupRequired,
    SelectionRejected,
    InstallationChanged,
    CredentialRejected,
    ModelRejected,
    RunAlreadyActive,
    SpawnFailed,
    InputFailed,
    HandshakeFailed,
    SessionUnavailable,
    ProviderApprovalRejected,
    ToolBridgeFailed,
    ToolBudgetExceeded,
    IsolationViolation,
    ProtocolViolation,
    OutputLimit,
    Timeout,
    ProcessExit,
    Cancelled,
    ConsumerGone,
    Internal,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliFailurePhase {
    Inspect,
    Prepare,
    Spawn,
    Input,
    Handshake,
    Stream,
    Tool,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliRetryPolicy {
    None,
    Reprobe,
    AfterSetup,
    FreshSessionSafe,
    Manual,
}

/// Fixed diagnostics attached by a trusted adapter validation branch.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliIsolationReason {
    ExternalMcpServer,
    UnauthorizedHostTool,
    NativeCapability,
    InvalidDiscovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliItemKind {
    McpToolCall,
    AgentMessage,
    Reasoning,
    Plan,
    UserMessage,
    ContextCompaction,
    WebSearch,
    CommandExecution,
    FileChange,
    DynamicToolCall,
    CollabAgentToolCall,
    HookPrompt,
    ImageView,
    ImageGeneration,
    ComputerUse,
    BrowserUse,
    SubAgentActivity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalCliFailure {
    pub code: LocalCliFailureCode,
    pub phase: LocalCliFailurePhase,
    pub provider: LocalAgentProvider,
    pub safe_message: String,
    pub diagnostic_id: String,
    pub had_activity: bool,
    pub had_host_side_effect: bool,
    pub retry_policy: LocalCliRetryPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation_reason: Option<LocalCliIsolationReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_kind: Option<LocalCliItemKind>,
}

/// A provider adapter failure. Adapters that already know the failure
/// category attach its code so the substring classifier is bypassed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    pub code: Option<LocalCliFailureCode>,
    pub message: String,
    pub isolation_reason: Option<LocalCliIsolationReason>,
    pub item_kind: Option<LocalCliItemKind>,
}

impl AdapterError {
    pub fn coded(code: LocalCliFailureCode, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
            isolation_reason: None,
            item_kind: None,
        }
    }
}

impl From<String> for AdapterError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            message,
            isolation_reason: None,
            item_kind: None,
        }
    }
}

impl From<&str> for AdapterError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl LocalCliFailure {
    pub fn new(
        provider: LocalAgentProvider,
        code: LocalCliFailureCode,
        phase: LocalCliFailurePhase,
        safe_message: impl Into<String>,
        retry_policy: LocalCliRetryPolicy,
    ) -> Self {
        Self {
            code,
            phase,
            provider,
            safe_message: safe_message.into(),
            diagnostic_id: uuid::Uuid::new_v4().to_string(),
            had_activity: false,
            had_host_side_effect: false,
            retry_policy,
            isolation_reason: None,
            item_kind: None,
        }
    }

    /// Uses the adapter's own category when it attached one; otherwise falls
    /// back to substring classification of the message.
    pub fn from_adapter(
        provider: LocalAgentProvider,
        phase: LocalCliFailurePhase,
        error: &AdapterError,
        attempted_resume: bool,
        cancelled: bool,
    ) -> Self {
        if !cancelled {
            if let Some(code) = error.code {
                if let Some((safe_message, retry_policy)) =
                    coded_failure(code, attempted_resume, &error.message)
                {
                    let mut failure =
                        Self::new(provider, code, phase, safe_message, retry_policy);
                    if code == LocalCliFailureCode::IsolationViolation {
                        failure.isolation_reason = error.isolation_reason;
                        failure.item_kind = error.item_kind;
                    }
                    return failure;
                }
            }
        }
        Self::classified(provider, phase, &error.message, attempted_resume, cancelled)
    }

    pub fn classified(
        provider: LocalAgentProvider,
        phase: LocalCliFailurePhase,
        internal_message: &str,
        attempted_resume: bool,
        cancelled: bool,
    ) -> Self {
        let message = internal_message.to_ascii_lowercase();
        let (code, safe_message, retry_policy) = if cancelled
            || message.contains("run cancelled")
            || message.contains("run canceled")
        {
            (
                LocalCliFailureCode::Cancelled,
                "The local CLI run was cancelled.",
                LocalCliRetryPolicy::None,
            )
        } else if attempted_resume && is_session_unavailable(&message) {
            (
                LocalCliFailureCode::SessionUnavailable,
                "The saved local CLI session is no longer available.",
                LocalCliRetryPolicy::FreshSessionSafe,
            )
        } else if message.contains("installation changed")
            || message.contains("executable changed")
            || message.contains("changed during preparation")
        {
            (
                LocalCliFailureCode::InstallationChanged,
                "The local CLI installation or launch configuration changed while the run was being prepared.",
                LocalCliRetryPolicy::Reprobe,
            )
        } else if message.contains("was not found") || message.contains("executable does not exist")
        {
            (
                LocalCliFailureCode::ExecutableNotFound,
                "The selected local CLI executable could not be found.",
                LocalCliRetryPolicy::Reprobe,
            )
        } else if message.contains("installed local cli is unsupported")
            || message.contains("local cli version is not supported")
            || message.contains("upgrade the")
        {
            (
                LocalCliFailureCode::CliUnsupported,
                "The installed local CLI does not provide the required capabilities.",
                LocalCliRetryPolicy::AfterSetup,
            )
        } else if message.contains("needs setup")
            || message.contains("not authenticated")
            || message.contains("login") && message.contains("required")
            || message.contains("eligibility check")
        {
            (
                LocalCliFailureCode::SetupRequired,
                if message.contains("eligibility check") {
                    "The local CLI account is not eligible for this provider or region."
                } else {
                    "The local CLI needs setup before it can run."
                },
                LocalCliRetryPolicy::AfterSetup,
            )
        } else if message.contains("credential")
            || message.contains("api key")
            || message.contains("authentication")
            || ((message.contains("unauthorized") || message.contains("401"))
                && !message.contains("attempted")
                && !message.contains("native")
                && !message.contains("capability"))
        {
            (
                LocalCliFailureCode::CredentialRejected,
                "The local CLI rejected its configured credentials.",
                LocalCliRetryPolicy::AfterSetup,
            )
        } else if is_rate_limited(&message) {
            (
                LocalCliFailureCode::ProcessExit,
                "The local CLI provider rate limit prevented this request from completing.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("unknown model")
            || message.contains("model not found")
            || message.contains("invalid model")
            || message.contains("selected model")
            || message.contains("reasoning effort")
        {
            (
                LocalCliFailureCode::ModelRejected,
                "The local CLI rejected the selected model or reasoning effort.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("selection") || message.contains("invalid local agent option") {
            (
                LocalCliFailureCode::SelectionRejected,
                "The selected local CLI options are not valid.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("already has an active")
            || message.contains("run already active")
        {
            (
                LocalCliFailureCode::RunAlreadyActive,
                "This conversation already has an active run for the selected local CLI.",
                LocalCliRetryPolicy::None,
            )
        } else if message.contains("failed to start") || phase == LocalCliFailurePhase::Spawn {
            (
                LocalCliFailureCode::SpawnFailed,
                "The local CLI process could not be started.",
                LocalCliRetryPolicy::Reprobe,
            )
        } else if message.contains("failed to write")
            || message.contains("failed to flush")
            || message.contains("failed to close")
            || phase == LocalCliFailurePhase::Input
        {
            (
                LocalCliFailureCode::InputFailed,
                "Open Builder could not deliver the request to the local CLI.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("event consumer") {
            (
                LocalCliFailureCode::ConsumerGone,
                "The local CLI event consumer is no longer available.",
                LocalCliRetryPolicy::None,
            )
        } else if is_provider_approval_rejected(&message) {
            (
                LocalCliFailureCode::ProviderApprovalRejected,
                "The local CLI rejected an Open Builder tool before it reached Host authorization.",
                LocalCliRetryPolicy::None,
            )
        } else if message.contains("isolation")
            || message.contains("external mcp")
            || message.contains("unauthorized")
            || message.contains("disabled native capability")
            || message.contains("unexpected permission")
        {
            (
                LocalCliFailureCode::IsolationViolation,
                "The local CLI attempted to use a capability outside the Open Builder sandbox.",
                LocalCliRetryPolicy::None,
            )
        } else if phase == LocalCliFailurePhase::Tool
            || ((message.contains("bridge") || message.contains("tool result"))
                && !message.contains("attempted")
                && !message.contains("unauthorized")
                && !message.contains("disabled native")
                && !message.contains("external mcp"))
        {
            (
                LocalCliFailureCode::ToolBridgeFailed,
                "The Open Builder tool bridge could not complete the local CLI request.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("output") && message.contains("limit")
            || message.contains("event limit")
            || message.contains("line limit")
        {
            (
                LocalCliFailureCode::OutputLimit,
                "The local CLI exceeded a bounded output limit.",
                LocalCliRetryPolicy::None,
            )
        } else if phase == LocalCliFailurePhase::Handshake
            || message.contains("handshake")
            || message.contains("closed before")
        {
            (
                LocalCliFailureCode::HandshakeFailed,
                "The local CLI did not complete its structured startup handshake.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("timed out") || message.contains("exceeded the 30 minute") {
            (
                LocalCliFailureCode::Timeout,
                "The local CLI did not complete within the allowed time.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("exited unsuccessfully")
            || message.contains("failed to wait")
            || phase == LocalCliFailurePhase::Shutdown
        {
            (
                LocalCliFailureCode::ProcessExit,
                "The local CLI process exited before completing the request.",
                LocalCliRetryPolicy::Manual,
            )
        } else if message.contains("malformed")
            || message.contains("invalid utf-8")
            || message.contains("unexpected")
            || message.contains("protocol")
            || message.contains("unsupported thread item")
            || message.contains("emitted") && message.contains("unsupported")
            || message.contains("assistant message contained an unsupported")
        {
            (
                LocalCliFailureCode::ProtocolViolation,
                "The local CLI returned an unsupported structured response.",
                LocalCliRetryPolicy::None,
            )
        } else {
            (
                LocalCliFailureCode::Internal,
                "The local CLI run could not be completed.",
                LocalCliRetryPolicy::Manual,
            )
        };

        Self::new(provider, code, phase, safe_message, retry_policy)
    }
}

/// Safe text for the codes adapters attach today. A code without an entry
/// falls back to substring classification of the message. The internal
/// message only refines wording; it never changes the attached code.
fn coded_failure(
    code: LocalCliFailureCode,
    attempted_resume: bool,
    message: &str,
) -> Option<(&'static str, LocalCliRetryPolicy)> {
    match code {
        LocalCliFailureCode::CredentialRejected => Some((
            "The local CLI rejected its configured credentials.",
            LocalCliRetryPolicy::AfterSetup,
        )),
        LocalCliFailureCode::ModelRejected => Some((
            "The local CLI rejected the selected model or reasoning effort.",
            LocalCliRetryPolicy::Manual,
        )),
        LocalCliFailureCode::SessionUnavailable => Some((
            "The saved local CLI session is no longer available.",
            if attempted_resume {
                LocalCliRetryPolicy::FreshSessionSafe
            } else {
                LocalCliRetryPolicy::Manual
            },
        )),
        LocalCliFailureCode::ProviderApprovalRejected => Some((
            "The local CLI rejected an Open Builder tool before it reached Host authorization.",
            LocalCliRetryPolicy::None,
        )),
        LocalCliFailureCode::IsolationViolation => Some((
            "The local CLI attempted to use a capability outside the Open Builder sandbox.",
            LocalCliRetryPolicy::None,
        )),
        LocalCliFailureCode::ProtocolViolation => Some((
            "The local CLI returned an unsupported structured response.",
            LocalCliRetryPolicy::None,
        )),
        LocalCliFailureCode::OutputLimit => Some((
            if message == "local agent tool arguments exceeded the request limit" {
                "The local CLI tool arguments exceeded the allowed size."
            } else {
                "The local CLI exceeded a bounded output limit."
            },
            LocalCliRetryPolicy::None,
        )),
        LocalCliFailureCode::ToolBudgetExceeded => Some((
            "The local CLI tool-call budget was exhausted.",
            LocalCliRetryPolicy::Manual,
        )),
        LocalCliFailureCode::ToolBridgeFailed => Some((
            "The Open Builder tool bridge could not complete the local CLI request.",
            LocalCliRetryPolicy::Manual,
        )),
        LocalCliFailureCode::ConsumerGone => Some((
            "The local CLI event consumer is no longer available.",
            LocalCliRetryPolicy::None,
        )),
        LocalCliFailureCode::ProcessExit => Some((
            if is_rate_limited(&message.to_ascii_lowercase()) {
                "The local CLI provider rate limit prevented this request from completing."
            } else {
                "The local CLI process exited before completing the request."
            },
            LocalCliRetryPolicy::Manual,
        )),
        _ => None,
    }
}

/// Rate-limit and quota wording shared by every provider classifier.
pub(crate) fn is_rate_limited(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "rate limit",
        "rate-limit",
        "rate_limit",
        "ratelimit",
        "too many requests",
        "429",
        "quota",
        "usage limit",
        "usagelimitexceeded",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Operating-system permission failures (EACCES, EPERM, `os error 13`) come
/// from the CLI's own files, not from its provider approval layer.
pub(crate) fn is_operating_system_permission_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    ["os error", "eacces", "eperm", "errno"]
        .iter()
        .any(|needle| message.contains(needle))
}

/// Provider approval wording. Explicit approval phrases always count; bare
/// "permission denied" / "not authorized" count only when the text also names
/// a tool or MCP context and is not an operating-system error, so a Node or
/// Rust EACCES from the CLI's own cache never becomes a non-retryable
/// provider approval rejection.
pub(crate) fn is_provider_approval_rejected(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    if [
        "approval policy is never",
        "requires approval",
        "approval required",
        "approval was rejected",
        "permission to use",
        "user cancelled mcp tool call",
        "user canceled mcp tool call",
        "provider approval rejected",
    ]
    .iter()
    .any(|needle| message.contains(needle))
    {
        return true;
    }
    if is_operating_system_permission_error(&message) {
        return false;
    }
    ["permission denied", "not authorized"]
        .iter()
        .any(|needle| message.contains(needle))
        && ["tool", "mcp"]
            .iter()
            .any(|needle| message.contains(needle))
}

pub fn infer_failure_phase(message: &str, fallback: LocalCliFailurePhase) -> LocalCliFailurePhase {
    let message = message.to_ascii_lowercase();
    if message.contains("changed during preparation") {
        LocalCliFailurePhase::Prepare
    } else if message.contains("failed to start") || message.contains("spawn") {
        LocalCliFailurePhase::Spawn
    } else if message.contains("failed to write")
        || message.contains("failed to flush")
        || message.contains("failed to close")
        || message.contains("stdin")
    {
        LocalCliFailurePhase::Input
    } else if message.contains("handshake")
        || message.contains("initialization")
        || message.contains("init inventory")
        || message.contains("closed before")
    {
        LocalCliFailurePhase::Handshake
    } else if is_provider_approval_rejected(&message)
        || message.contains("tool bridge")
        || message.contains("tool result")
        || message.contains("mcp tool")
    {
        LocalCliFailurePhase::Tool
    } else if message.contains("failed to wait")
        || message.contains("shutdown")
        || message.contains("exited unsuccessfully")
    {
        LocalCliFailurePhase::Shutdown
    } else {
        fallback
    }
}

impl fmt::Display for LocalCliFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.safe_message)
    }
}

impl std::error::Error for LocalCliFailure {}

fn is_session_unavailable(message: &str) -> bool {
    let mentions_session = ["session", "thread", "conversation", "resume"]
        .iter()
        .any(|needle| message.contains(needle));
    let unavailable = [
        "invalid",
        "missing",
        "not found",
        "expired",
        "unavailable",
        "does not exist",
        "no conversation found",
    ]
    .iter()
    .any(|needle| message.contains(needle));
    mentions_session && unavailable
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallationIdentity {
    canonical_path: PathBuf,
    fingerprint: String,
}

impl InstallationIdentity {
    pub fn capture(path: &Path) -> Result<Self, String> {
        let canonical_path = std::fs::canonicalize(path)
            .map_err(|_| "local CLI executable does not exist".to_string())?;
        let metadata = canonical_path
            .metadata()
            .map_err(|_| "failed to inspect local CLI executable".to_string())?;
        if !metadata.is_file() {
            return Err("local CLI path is not a file".to_string());
        }
        let fingerprint = installation_fingerprint(&canonical_path, &metadata);
        Ok(Self {
            canonical_path,
            fingerprint,
        })
    }

    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn verify_unchanged(&self) -> Result<(), String> {
        let current = Self::capture(&self.canonical_path)?;
        if current.fingerprint != self.fingerprint {
            return Err("local CLI installation changed during preparation".to_string());
        }
        Ok(())
    }
}

fn installation_fingerprint(path: &Path, metadata: &Metadata) -> String {
    let mut hash = Sha256::new();
    hash.update(b"open-builder-local-cli-installation-v1\0");
    update_path_hash(&mut hash, path);
    hash.update(metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
            hash.update(duration.as_secs().to_le_bytes());
            hash.update(duration.subsec_nanos().to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(metadata.dev().to_le_bytes());
        hash.update(metadata.ino().to_le_bytes());
        hash.update(metadata.mode().to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn update_path_hash(hash: &mut Sha256, path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hash.update(path.as_os_str().as_bytes());
    }
    #[cfg(not(unix))]
    hash.update(path.to_string_lossy().as_bytes());
}

pub fn hash_compatibility_material(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"open-builder-local-cli-compatibility-v1\0");
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub struct CompatibilityKeyMaterial<'a> {
    pub provider: LocalAgentProvider,
    pub protocol_version: &'a str,
    pub installation_fingerprint: &'a str,
    pub configuration_fingerprint: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub mode: &'a str,
    pub tool_digest: &'a str,
}

pub fn compatibility_key(material: CompatibilityKeyMaterial<'_>) -> String {
    hash_compatibility_material(&[
        match material.provider {
            LocalAgentProvider::Codex => "codex",
            LocalAgentProvider::Claude => "claude",
            LocalAgentProvider::Pi => "pi",
            LocalAgentProvider::Antigravity => "antigravity",
        },
        material.protocol_version,
        material.installation_fingerprint,
        material.configuration_fingerprint,
        material.model.unwrap_or("<cli-default>"),
        material.effort.unwrap_or("<cli-default>"),
        material.mode,
        "open-builder-tool-bridge-v2",
        material.tool_digest,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_metadata_is_optional_typed_and_cleared_by_cancellation() {
        let mut error =
            AdapterError::coded(LocalCliFailureCode::IsolationViolation, "private details");
        error.isolation_reason = Some(LocalCliIsolationReason::InvalidDiscovery);
        error.item_kind = Some(LocalCliItemKind::McpToolCall);
        let failure = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Tool,
            &error,
            false,
            false,
        );
        let mut json = serde_json::to_value(&failure).unwrap();
        assert_eq!(json["isolationReason"], "invalidDiscovery");
        assert_eq!(json["itemKind"], "mcpToolCall");
        assert!(!json.to_string().contains("private details"));
        json.as_object_mut().unwrap().remove("isolationReason");
        json.as_object_mut().unwrap().remove("itemKind");
        let legacy: LocalCliFailure = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(legacy.isolation_reason, None);
        assert_eq!(legacy.item_kind, None);
        assert_eq!(serde_json::to_value(legacy).unwrap(), json);
        json["isolationReason"] = serde_json::json!("provider-controlled-text");
        assert!(serde_json::from_value::<LocalCliFailure>(json).is_err());
        let cancelled = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Tool,
            &error,
            false,
            true,
        );
        assert_eq!(cancelled.code, LocalCliFailureCode::Cancelled);
        assert_eq!(cancelled.isolation_reason, None);
        assert_eq!(cancelled.item_kind, None);
        let untyped = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Stream,
            "isolation: externalMcpServer private details",
            false,
            false,
        );
        assert_eq!(untyped.isolation_reason, None);
        assert_eq!(untyped.item_kind, None);
    }

    #[test]
    fn session_unavailable_is_the_only_fresh_session_retry() {
        let failure = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Handshake,
            "thread not found while resuming",
            true,
            false,
        );
        assert_eq!(failure.code, LocalCliFailureCode::SessionUnavailable);
        assert_eq!(failure.retry_policy, LocalCliRetryPolicy::FreshSessionSafe);

        let timeout = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Handshake,
            "Codex exec handshake timed out",
            true,
            false,
        );
        assert_eq!(timeout.code, LocalCliFailureCode::HandshakeFailed);
        assert_eq!(timeout.phase, LocalCliFailurePhase::Handshake);
        assert_ne!(timeout.retry_policy, LocalCliRetryPolicy::FreshSessionSafe);

        let rate_limit = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            "Claude request was rate limited",
            false,
            false,
        );
        assert_eq!(rate_limit.code, LocalCliFailureCode::ProcessExit);
        assert_eq!(rate_limit.retry_policy, LocalCliRetryPolicy::Manual);

        let generic_request = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            "Claude model request failed",
            false,
            false,
        );
        assert_ne!(generic_request.code, LocalCliFailureCode::ModelRejected);

        let setup = LocalCliFailure::classified(
            LocalAgentProvider::Pi,
            LocalCliFailurePhase::Prepare,
            "pi needs setup; Pi has no configured model; run pi",
            false,
            false,
        );
        assert_eq!(setup.code, LocalCliFailureCode::SetupRequired);
    }

    #[test]
    fn process_exit_codes_only_mention_rate_limits_when_the_message_does() {
        let exit = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Shutdown,
            &AdapterError::coded(
                LocalCliFailureCode::ProcessExit,
                "CLI exited unsuccessfully; exit status 1",
            ),
            false,
            false,
        );
        assert_eq!(exit.code, LocalCliFailureCode::ProcessExit);
        assert_eq!(exit.retry_policy, LocalCliRetryPolicy::Manual);
        assert!(!exit.safe_message.contains("rate limit"));

        let rate_limit = LocalCliFailure::from_adapter(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            &AdapterError::coded(
                LocalCliFailureCode::ProcessExit,
                "Claude request was rate limited",
            ),
            false,
            false,
        );
        assert_eq!(rate_limit.code, LocalCliFailureCode::ProcessExit);
        assert!(rate_limit.safe_message.contains("rate limit"));

        let quota = LocalCliFailure::classified(
            LocalAgentProvider::Antigravity,
            LocalCliFailurePhase::Stream,
            "Antigravity image generation quota was exhausted.",
            false,
            false,
        );
        assert_eq!(quota.code, LocalCliFailureCode::ProcessExit);
        assert!(quota.safe_message.contains("rate limit"));

        let generated = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            "Failed to generate a response",
            false,
            false,
        );
        assert!(!generated.safe_message.contains("rate limit"));
    }

    #[test]
    fn operating_system_permission_errors_are_not_provider_approval_rejections() {
        let node = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            "EACCES: permission denied, open '/Users/x/.npm/_cacache/index-v5'",
            false,
            false,
        );
        assert_ne!(node.code, LocalCliFailureCode::ProviderApprovalRejected);
        assert_eq!(node.retry_policy, LocalCliRetryPolicy::Manual);

        let rust = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Stream,
            "Permission denied (os error 13)",
            false,
            false,
        );
        assert_ne!(rust.code, LocalCliFailureCode::ProviderApprovalRejected);

        assert!(is_provider_approval_rejected(
            "MCP tool call requires approval, but approval policy is never"
        ));
        assert!(is_provider_approval_rejected(
            "permission denied for MCP tool open_builder__write_file"
        ));
        assert!(!is_provider_approval_rejected("permission denied"));
        assert!(!is_provider_approval_rejected(
            "EACCES: permission denied while writing the tool cache"
        ));
        assert_eq!(
            infer_failure_phase(
                "EACCES: permission denied, mkdir '/tmp/x'",
                LocalCliFailurePhase::Stream
            ),
            LocalCliFailurePhase::Stream
        );
    }

    #[test]
    fn compatibility_key_changes_for_launch_authority_inputs() {
        let material =
            |installation_fingerprint, tool_digest, model, effort| CompatibilityKeyMaterial {
                provider: LocalAgentProvider::Codex,
                protocol_version: "codex-exec-json-v2",
                installation_fingerprint,
                configuration_fingerprint: "config-a",
                model: Some(model),
                effort: Some(effort),
                mode: "chat",
                tool_digest,
            };
        let base = compatibility_key(material("installation-a", "tools-a", "gpt-test", "high"));
        let changed = compatibility_key(material("installation-b", "tools-a", "gpt-test", "high"));
        assert_ne!(base, changed);

        let changed_tools =
            compatibility_key(material("installation-a", "tools-b", "gpt-test", "high"));
        assert_ne!(base, changed_tools);

        let changed_model =
            compatibility_key(material("installation-a", "tools-a", "gpt-other", "high"));
        assert_ne!(base, changed_model);

        let changed_effort =
            compatibility_key(material("installation-a", "tools-a", "gpt-test", "medium"));
        assert_ne!(base, changed_effort);
    }

    #[test]
    fn run_failure_phase_is_inferred_before_public_classification() {
        assert_eq!(
            infer_failure_phase(
                "failed to write the Codex request",
                LocalCliFailurePhase::Stream
            ),
            LocalCliFailurePhase::Input
        );
        assert_eq!(
            infer_failure_phase(
                "provider approval rejected the MCP tool call",
                LocalCliFailurePhase::Stream
            ),
            LocalCliFailurePhase::Tool
        );
        assert_eq!(
            infer_failure_phase(
                "Claude isolation handshake timed out",
                LocalCliFailurePhase::Stream
            ),
            LocalCliFailurePhase::Handshake
        );
        assert_eq!(
            infer_failure_phase(
                "private local CLI artifact changed during preparation",
                LocalCliFailurePhase::Stream
            ),
            LocalCliFailurePhase::Prepare
        );
    }

    #[test]
    fn installation_identity_rejects_a_changed_executable() {
        let path = std::env::temp_dir().join(format!(
            "open-builder-installation-identity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"first").unwrap();
        let identity = InstallationIdentity::capture(&path).unwrap();
        std::fs::write(&path, b"second-version").unwrap();
        assert!(identity.verify_unchanged().is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn classified_failure_never_echoes_internal_cli_output() {
        let sentinel = "secret-sentinel-value";
        let failure = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            &format!("authentication failed with API key {sentinel}"),
            false,
            false,
        );
        assert_eq!(failure.code, LocalCliFailureCode::CredentialRejected);
        assert!(!failure.safe_message.contains(sentinel));
        assert!(!serde_json::to_string(&failure).unwrap().contains(sentinel));

        let unauthorized = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            "gateway returned HTTP 401 Unauthorized",
            false,
            false,
        );
        assert_eq!(unauthorized.code, LocalCliFailureCode::CredentialRejected);

        let isolation = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Stream,
            "Codex attempted to use an unauthorized native tool",
            false,
            false,
        );
        assert_eq!(isolation.code, LocalCliFailureCode::IsolationViolation);

        let tool_phase_isolation = LocalCliFailure::classified(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Tool,
            "Claude attempted to use an external MCP server",
            false,
            false,
        );
        assert_eq!(
            tool_phase_isolation.code,
            LocalCliFailureCode::IsolationViolation
        );
        assert_eq!(tool_phase_isolation.retry_policy, LocalCliRetryPolicy::None);

        let approval = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Tool,
            "MCP tool call requires approval, but approval policy is never",
            false,
            false,
        );
        assert_eq!(approval.code, LocalCliFailureCode::ProviderApprovalRejected);
        assert_eq!(approval.phase, LocalCliFailurePhase::Tool);
        assert_eq!(approval.retry_policy, LocalCliRetryPolicy::None);

        for message in [
            "Codex emitted an unsupported event type",
            "Claude assistant message contained an unsupported block",
            "Pi emitted an unsupported assistant event",
            "Antigravity emitted an unsupported stream event",
        ] {
            let failure = LocalCliFailure::classified(
                LocalAgentProvider::Codex,
                LocalCliFailurePhase::Stream,
                message,
                false,
                false,
            );
            assert_eq!(failure.code, LocalCliFailureCode::ProtocolViolation);
            assert_eq!(failure.retry_policy, LocalCliRetryPolicy::None);
        }

        let unsupported_installation = LocalCliFailure::classified(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Prepare,
            "the installed local CLI is unsupported: upgrade the Codex CLI",
            false,
            false,
        );
        assert_eq!(
            unsupported_installation.code,
            LocalCliFailureCode::CliUnsupported
        );
    }

    #[test]
    fn coded_adapter_errors_bypass_substring_classification() {
        let coded = AdapterError::coded(
            LocalCliFailureCode::CredentialRejected,
            "thread not found while resuming",
        );
        let failure = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Stream,
            &coded,
            true,
            false,
        );
        assert_eq!(failure.code, LocalCliFailureCode::CredentialRejected);
        assert_eq!(failure.retry_policy, LocalCliRetryPolicy::AfterSetup);
        assert!(!failure.safe_message.contains("thread"));

        let cancelled = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Stream,
            &coded,
            true,
            true,
        );
        assert_eq!(cancelled.code, LocalCliFailureCode::Cancelled);

        let session = AdapterError::coded(
            LocalCliFailureCode::SessionUnavailable,
            "Codex exec exited unsuccessfully; CLI session is unavailable",
        );
        let not_resumed = LocalCliFailure::from_adapter(
            LocalAgentProvider::Codex,
            LocalCliFailurePhase::Shutdown,
            &session,
            false,
            false,
        );
        assert_ne!(
            not_resumed.retry_policy,
            LocalCliRetryPolicy::FreshSessionSafe
        );

        let rate_limit = LocalCliFailure::from_adapter(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            &AdapterError::coded(
                LocalCliFailureCode::ProcessExit,
                "thread not found while resuming",
            ),
            true,
            false,
        );
        assert_eq!(rate_limit.code, LocalCliFailureCode::ProcessExit);
        assert!(!rate_limit.safe_message.contains("thread"));
        assert!(!rate_limit.safe_message.contains("rate limit"));

        let isolation = LocalCliFailure::from_adapter(
            LocalAgentProvider::Pi,
            LocalCliFailurePhase::Tool,
            &AdapterError::coded(
                LocalCliFailureCode::IsolationViolation,
                "authentication failed",
            ),
            false,
            false,
        );
        assert_eq!(isolation.code, LocalCliFailureCode::IsolationViolation);
        assert_eq!(isolation.retry_policy, LocalCliRetryPolicy::None);

        let uncoded = LocalCliFailure::from_adapter(
            LocalAgentProvider::Claude,
            LocalCliFailurePhase::Stream,
            &AdapterError::from("Claude request was rate limited"),
            false,
            false,
        );
        assert_eq!(uncoded.code, LocalCliFailureCode::ProcessExit);
    }
}
