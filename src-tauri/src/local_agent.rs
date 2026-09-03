use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::local_agent_adapter::{
    identity as adapter_identity, prepare_run as prepare_adapter_run, probe as probe_adapter,
    validate_request as validate_adapter_request, AdapterProbe, PreparedRunResources,
    ResolvedAdapterProbe,
};
use crate::local_agent_bridge::ToolBridge;
use crate::local_agent_models::{CatalogAuthority, LaunchValidation, ModelStrategy};
use crate::local_agent_runtime::{
    infer_failure_phase, AdapterError, InstallationIdentity, LocalCliFailure, LocalCliFailureCode,
    LocalCliFailurePhase, LocalCliRetryPolicy,
};

const MAX_ACTIVE_RUNS: usize = 8;
const MAX_START_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOOL_COUNT: usize = 128;
const MAX_TOOL_CALLS_PER_RUN: usize = 512;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_TOOL_DESCRIPTION_BYTES: usize = 128 * 1024;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_RUN_DURATION: Duration = Duration::from_secs(30 * 60);
const RUN_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentProvider {
    Codex,
    Claude,
    Pi,
    Antigravity,
}

impl LocalAgentProvider {
    fn command_name(self) -> &'static str {
        adapter_identity(self).command_name
    }

    fn setup_command(self) -> &'static str {
        adapter_identity(self).setup_command
    }

    fn capabilities(self) -> LocalAgentCapabilities {
        adapter_identity(self).capabilities
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentAvailability {
    NotFound,
    Unsupported,
    NeedsSetup,
    Ready,
    Error,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliInspectionStatus {
    Ready,
    VerificationRequired,
    SetupRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliUnavailableReason {
    NotFound,
    Unsupported,
    // The web/unsupported-host gate returns this before an IPC probe reaches
    // Rust; retain it here so the public inspection wire remains exhaustive.
    #[allow(dead_code)]
    HostUnsupported,
    ProbeError,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalCliCatalogAuthority {
    Authoritative,
    Partial,
}

impl From<CatalogAuthority> for LocalCliCatalogAuthority {
    fn from(value: CatalogAuthority) -> Self {
        match value {
            CatalogAuthority::Authoritative => Self::Authoritative,
            CatalogAuthority::Partial => Self::Partial,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentCapabilities {
    pub(crate) sessions: bool,
    pub(crate) reasoning: bool,
    pub(crate) tools: bool,
    pub(crate) native_search: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentModel {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    pub default_effort: Option<String>,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentPreference {
    pub(crate) model: String,
    pub(crate) effort: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalAgentPreferenceDecision {
    Keep { unverified: bool },
    Replace { preference: LocalAgentPreference },
}

impl Default for LocalAgentPreferenceDecision {
    fn default() -> Self {
        Self::Keep { unverified: false }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentProbe {
    provider: LocalAgentProvider,
    availability: LocalAgentAvailability,
    status: LocalCliInspectionStatus,
    reason_code: Option<LocalCliUnavailableReason>,
    path: Option<String>,
    path_source: Option<String>,
    version: Option<String>,
    installation_fingerprint: Option<String>,
    catalog_authority: LocalCliCatalogAuthority,
    checked_at: u64,
    setup_command: String,
    models: Vec<LocalAgentModel>,
    efforts: Vec<String>,
    preference_decision: LocalAgentPreferenceDecision,
    capabilities: LocalAgentCapabilities,
    message: Option<String>,
}

impl LocalAgentProbe {
    fn unavailable(
        provider: LocalAgentProvider,
        availability: LocalAgentAvailability,
        message: String,
    ) -> Self {
        let reason_code = Some(match availability {
            LocalAgentAvailability::NotFound => LocalCliUnavailableReason::NotFound,
            LocalAgentAvailability::Unsupported => LocalCliUnavailableReason::Unsupported,
            _ => LocalCliUnavailableReason::ProbeError,
        });
        Self {
            provider,
            availability,
            status: LocalCliInspectionStatus::Unavailable,
            reason_code,
            path: None,
            path_source: None,
            version: None,
            installation_fingerprint: None,
            catalog_authority: LocalCliCatalogAuthority::Partial,
            checked_at: inspection_timestamp(),
            setup_command: provider.setup_command().to_string(),
            models: Vec::new(),
            efforts: Vec::new(),
            preference_decision: LocalAgentPreferenceDecision::default(),
            capabilities: provider.capabilities(),
            message: Some(message),
        }
    }
}

fn inspection_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_conversation_scope_conflict(
    active_provider: LocalAgentProvider,
    active_scope: &LocalAgentRunScope,
    provider: LocalAgentProvider,
    scope: &LocalAgentRunScope,
) -> bool {
    active_provider == provider
        && active_scope.kind == LocalAgentRunScopeKind::Conversation
        && scope.kind == LocalAgentRunScopeKind::Conversation
        && active_scope.id == scope.id
}

fn is_pi_session_conflict(
    active_provider: LocalAgentProvider,
    active_session_id: Option<&str>,
    provider: LocalAgentProvider,
    session_id: Option<&str>,
) -> bool {
    provider == LocalAgentProvider::Pi
        && active_provider == provider
        && session_id.is_some()
        && active_session_id == session_id
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolAnnotations {
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    #[serde(default)]
    pub destructive_hint: Option<bool>,
    #[serde(default)]
    pub idempotent_hint: Option<bool>,
    #[serde(default)]
    pub open_world_hint: Option<bool>,
}

impl Default for LocalToolAnnotations {
    fn default() -> Self {
        Self {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            idempotent_hint: Some(false),
            open_world_hint: Some(true),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalToolHostApproval {
    #[default]
    None,
    Session,
    PerCall,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    #[serde(default)]
    pub annotations: LocalToolAnnotations,
    #[serde(default)]
    pub host_approval: LocalToolHostApproval,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentStartRequest {
    pub provider: LocalAgentProvider,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub system_prompt: String,
    pub prompt: String,
    pub bootstrap_context: Option<String>,
    pub session_id: Option<String>,
    pub session_compatibility_key: Option<String>,
    pub scope: LocalAgentRunScope,
    pub tools: Vec<LocalToolSpec>,
    pub max_tool_calls: usize,
    pub native_search: bool,
    pub mode: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentRunScopeKind {
    Conversation,
    Utility,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentRunScope {
    pub kind: LocalAgentRunScopeKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LocalToolContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
    },
    Audio {
        data: String,
        mime_type: String,
    },
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<String>,
        blob: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: String,
        title: Option<String>,
        description: Option<String>,
        mime_type: Option<String>,
        size: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolResolution {
    pub text: String,
    pub is_error: Option<bool>,
    pub structured_content: Option<serde_json::Value>,
    pub content: Option<Vec<LocalToolContent>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalAgentEvent {
    Status {
        state: String,
        message: Option<String>,
    },
    Session {
        session_id: String,
        cli_version: String,
    },
    Prepared {
        cli_version: String,
        compatibility_key: String,
        installation_fingerprint: String,
        actual_model: Option<String>,
        actual_effort: Option<String>,
        resumed: bool,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolRequest {
        run_id: String,
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    NativeTool {
        call_id: String,
        name: String,
        phase: String,
        arguments: Option<serde_json::Value>,
        result: Option<serde_json::Value>,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cached_input_tokens: Option<u64>,
    },
    Warning {
        message: String,
    },
    Error {
        message: String,
        retryable: bool,
        failure: LocalCliFailure,
    },
    Done {
        aborted: bool,
        session_id: Option<String>,
    },
}

struct ActiveRun {
    cancellation: CancellationToken,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    run_dir: PathBuf,
    provider: LocalAgentProvider,
    scope: LocalAgentRunScope,
    session_id: Option<String>,
    phase: Arc<RunPhaseTracker>,
}

struct RunPhaseTracker {
    phase: AtomicU8,
    pending_tools: AtomicUsize,
}

impl Default for RunPhaseTracker {
    fn default() -> Self {
        Self {
            phase: AtomicU8::new(Self::encode(LocalCliFailurePhase::Prepare)),
            pending_tools: AtomicUsize::new(0),
        }
    }
}

impl RunPhaseTracker {
    const fn encode(phase: LocalCliFailurePhase) -> u8 {
        match phase {
            LocalCliFailurePhase::Inspect => 0,
            LocalCliFailurePhase::Prepare => 1,
            LocalCliFailurePhase::Spawn => 2,
            LocalCliFailurePhase::Input => 3,
            LocalCliFailurePhase::Handshake => 4,
            LocalCliFailurePhase::Stream => 5,
            LocalCliFailurePhase::Tool => 6,
            LocalCliFailurePhase::Shutdown => 7,
        }
    }

    fn set(&self, phase: LocalCliFailurePhase) {
        let phase = if phase == LocalCliFailurePhase::Stream
            && self.pending_tools.load(Ordering::Acquire) > 0
        {
            LocalCliFailurePhase::Tool
        } else {
            phase
        };
        self.phase.store(Self::encode(phase), Ordering::Release);
    }

    fn current(&self) -> LocalCliFailurePhase {
        match self.phase.load(Ordering::Acquire) {
            0 => LocalCliFailurePhase::Inspect,
            1 => LocalCliFailurePhase::Prepare,
            2 => LocalCliFailurePhase::Spawn,
            3 => LocalCliFailurePhase::Input,
            4 => LocalCliFailurePhase::Handshake,
            5 => LocalCliFailurePhase::Stream,
            6 => LocalCliFailurePhase::Tool,
            _ => LocalCliFailurePhase::Shutdown,
        }
    }

    fn observe(&self, event: &LocalAgentEvent) {
        match event {
            LocalAgentEvent::Status { state, .. } if state == "preparing" => {
                self.set(LocalCliFailurePhase::Prepare)
            }
            LocalAgentEvent::Status { state, .. } if state == "handshaking" => {
                self.set(LocalCliFailurePhase::Handshake)
            }
            LocalAgentEvent::ToolRequest { .. } => {
                self.pending_tools.fetch_add(1, Ordering::AcqRel);
                self.set(LocalCliFailurePhase::Tool);
            }
            LocalAgentEvent::Session { .. }
            | LocalAgentEvent::TextDelta { .. }
            | LocalAgentEvent::ReasoningDelta { .. }
            | LocalAgentEvent::NativeTool { .. }
            | LocalAgentEvent::Usage { .. }
            | LocalAgentEvent::Warning { .. }
            | LocalAgentEvent::Status { .. } => self.set(LocalCliFailurePhase::Stream),
            LocalAgentEvent::Error { .. } | LocalAgentEvent::Done { .. } => {
                self.set(LocalCliFailurePhase::Shutdown)
            }
            LocalAgentEvent::Prepared { .. } => {}
        }
    }

    fn tool_resolved(&self) {
        let _ = self
            .pending_tools
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending > 0).then_some(pending - 1)
            });
        if self.pending_tools.load(Ordering::Acquire) == 0 {
            self.set(LocalCliFailurePhase::Stream);
        }
    }
}

/// Event channel that records the run phase at the send site, so each event
/// is serialized once instead of being deserialized and re-sent.
#[derive(Clone)]
pub struct TrackedChannel {
    target: tauri::ipc::Channel<LocalAgentEvent>,
    phase: Option<Arc<RunPhaseTracker>>,
}

impl TrackedChannel {
    fn tracked(target: tauri::ipc::Channel<LocalAgentEvent>, phase: Arc<RunPhaseTracker>) -> Self {
        Self {
            target,
            phase: Some(phase),
        }
    }

    pub fn send(&self, event: LocalAgentEvent) -> tauri::Result<()> {
        if let Some(phase) = &self.phase {
            phase.observe(&event);
        }
        self.target.send(event)
    }
}

impl From<tauri::ipc::Channel<LocalAgentEvent>> for TrackedChannel {
    fn from(target: tauri::ipc::Channel<LocalAgentEvent>) -> Self {
        Self {
            target,
            phase: None,
        }
    }
}

pub struct LocalAgentState {
    runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    bridge: Arc<ToolBridge>,
    model_strategy: Arc<ModelStrategy>,
    cleaned_run_roots: Mutex<HashSet<LocalAgentProvider>>,
}

impl Default for LocalAgentState {
    fn default() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
            bridge: Arc::new(ToolBridge::default()),
            model_strategy: Arc::new(ModelStrategy::default()),
            cleaned_run_roots: Mutex::new(HashSet::new()),
        }
    }
}

impl LocalAgentState {
    fn ensure_stale_runs_cleaned(
        &self,
        app: &AppHandle,
        provider: LocalAgentProvider,
    ) -> Result<(), String> {
        let mut cleaned = self
            .cleaned_run_roots
            .lock()
            .map_err(|_| "local agent cleanup lock poisoned".to_string())?;
        if cleaned.contains(&provider) {
            return Ok(());
        }
        cleanup_stale_run_root(&runs_directory(app, provider)?)?;
        cleaned.insert(provider);
        Ok(())
    }

    pub async fn shutdown_gracefully(&self) {
        let active = self
            .runs
            .lock()
            .map(|mut runs| runs.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for (run_id, run) in &active {
            run.cancellation.cancel();
            self.bridge.unregister(run_id, "application exiting");
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        for (_, mut run) in active {
            if let Some(mut task) = run.task.take() {
                if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
            let _ = std::fs::remove_dir_all(run.run_dir);
        }
        self.bridge.shutdown_now();
    }

    pub fn shutdown_now(&self) {
        if let Ok(mut runs) = self.runs.lock() {
            for (_, run) in runs.drain() {
                run.cancellation.cancel();
                if let Some(task) = run.task {
                    task.abort();
                }
                let _ = std::fs::remove_dir_all(run.run_dir);
            }
        }
        self.bridge.shutdown_now();
    }
}

impl Drop for LocalAgentState {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(transparent)]
struct ExecutableOverrides(HashMap<String, Option<String>>);

impl ExecutableOverrides {
    fn get(&self, provider: LocalAgentProvider) -> Option<&str> {
        self.0
            .get(provider.command_name())
            .and_then(Option::as_deref)
    }

    fn set(&mut self, provider: LocalAgentProvider, path: Option<String>) {
        self.0.insert(provider.command_name().to_string(), path);
    }
}

fn overrides_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "failed to resolve application config directory".to_string())?
        .join("local-agents.json"))
}

fn read_overrides(app: &AppHandle) -> ExecutableOverrides {
    let Ok(path) = overrides_path(app) else {
        return ExecutableOverrides::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return ExecutableOverrides::default();
    };
    if bytes.len() > 16 * 1024 {
        return ExecutableOverrides::default();
    }
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_overrides(app: &AppHandle, overrides: &ExecutableOverrides) -> Result<(), String> {
    let path = overrides_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "invalid application config path".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "failed to create application config directory".to_string())?;
    let bytes = serde_json::to_vec(overrides)
        .map_err(|_| "failed to serialize local CLI settings".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|_| "failed to write local CLI settings".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure local CLI settings".to_string())?;
    }
    std::fs::rename(&temporary, &path)
        .map_err(|_| "failed to replace local CLI settings".to_string())
}

fn valid_executable_name(provider: LocalAgentProvider, path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            adapter_identity(provider).accepts_executable_file_name(name, cfg!(windows))
        })
}

fn validate_executable_path(provider: LocalAgentProvider, path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().len() > MAX_PATH_BYTES {
        return Err("local CLI path is too long".to_string());
    }
    if !path.is_absolute() || !valid_executable_name(provider, path) {
        return Err(format!(
            "select the native {} executable",
            provider.command_name()
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "local CLI executable does not exist".to_string())?;
    if !canonical.is_file() {
        return Err("local CLI path is not a file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if canonical
            .metadata()
            .map_err(|_| "failed to inspect local CLI executable".to_string())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("local CLI file is not executable".to_string());
        }
    }
    Ok(canonical)
}

fn executable_candidates(provider: LocalAgentProvider) -> Vec<(PathBuf, String)> {
    let adapter = adapter_identity(provider);
    let file_name = adapter.executable_file_name(cfg!(windows));
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push((directory.join(&file_name), "path".to_string()));
        }
    }
    #[cfg(not(windows))]
    {
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            candidates.push((
                PathBuf::from(directory).join(&file_name),
                "common".to_string(),
            ));
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for directory in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".volta/bin",
                ".asdf/shims",
                ".cargo/bin",
                "Library/pnpm",
            ] {
                candidates.push((home.join(directory).join(&file_name), "common".to_string()));
            }
            for directory in adapter.unix_home_directories {
                candidates.push((home.join(directory).join(&file_name), "common".to_string()));
            }
            for (root, suffix) in [
                (".nvm/versions/node", "bin"),
                (".fnm/node-versions", "installation/bin"),
            ] {
                if let Ok(entries) = std::fs::read_dir(home.join(root)) {
                    for entry in entries.flatten().take(128) {
                        candidates.push((
                            entry.path().join(suffix).join(&file_name),
                            "common".to_string(),
                        ));
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            for directory in adapter.windows_home_directories {
                candidates.push((home.join(directory).join(&file_name), "common".to_string()));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            for directory in adapter
                .windows_local_directories
                .iter()
                .copied()
                .chain(["pnpm"])
            {
                candidates.push((local.join(directory).join(&file_name), "common".to_string()));
            }
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            for directory in adapter.windows_program_directories {
                candidates.push((
                    PathBuf::from(&program_files)
                        .join(directory)
                        .join(&file_name),
                    "common".to_string(),
                ));
            }
        }
    }
    candidates
}

fn resolve_executable(
    app: &AppHandle,
    provider: LocalAgentProvider,
) -> Result<Option<(PathBuf, String)>, String> {
    if let Some(path) = read_overrides(app).get(provider) {
        return validate_executable_path(provider, Path::new(path))
            .map(|path| Some((path, "override".to_string())));
    }
    for (candidate, source) in executable_candidates(provider) {
        if candidate.is_file() {
            if let Ok(path) = validate_executable_path(provider, &candidate) {
                return Ok(Some((path, source)));
            }
        }
    }
    Ok(None)
}

async fn probe_path(
    provider: LocalAgentProvider,
    path: PathBuf,
    path_source: String,
    model_strategy: &ModelStrategy,
    preference: LocalAgentPreference,
    force_refresh: bool,
) -> LocalAgentProbe {
    let ResolvedAdapterProbe {
        probe:
            AdapterProbe {
                availability,
                version,
                models,
                efforts,
                catalog_authority,
                verification_required: provider_verification_required,
                message,
            },
        preference_decision,
        launch_validation,
    } = probe_adapter(provider, &path, model_strategy, preference, force_refresh).await;
    let selection_rejected = matches!(&launch_validation, LaunchValidation::Rejected { .. });
    let verification_required = provider_verification_required
        || matches!(
            &launch_validation,
            LaunchValidation::Allowed {
                unverified: true,
                ..
            }
        )
        || matches!(
            &preference_decision,
            LocalAgentPreferenceDecision::Keep { unverified: true }
        );
    let status = inspection_status(availability, verification_required, selection_rejected);
    let reason_code = match availability {
        LocalAgentAvailability::NotFound => Some(LocalCliUnavailableReason::NotFound),
        LocalAgentAvailability::Unsupported => Some(LocalCliUnavailableReason::Unsupported),
        LocalAgentAvailability::Error => Some(LocalCliUnavailableReason::ProbeError),
        _ => None,
    };
    let installation_fingerprint = InstallationIdentity::capture(&path)
        .ok()
        .map(|identity| identity.fingerprint().to_string());
    LocalAgentProbe {
        provider,
        availability,
        status,
        reason_code,
        path: Some(path.to_string_lossy().to_string()),
        path_source: Some(path_source),
        version,
        installation_fingerprint,
        catalog_authority: catalog_authority.into(),
        checked_at: inspection_timestamp(),
        setup_command: provider.setup_command().to_string(),
        models,
        efforts,
        preference_decision,
        capabilities: provider.capabilities(),
        message: match launch_validation {
            LaunchValidation::Rejected { message: selection } => match message {
                Some(message) if message != selection => Some(format!("{message} {selection}")),
                Some(message) => Some(message),
                None => Some(selection),
            },
            LaunchValidation::Allowed { .. } => message,
        },
    }
}

fn inspection_status(
    availability: LocalAgentAvailability,
    verification_required: bool,
    selection_rejected: bool,
) -> LocalCliInspectionStatus {
    match availability {
        LocalAgentAvailability::Ready if selection_rejected => {
            LocalCliInspectionStatus::SetupRequired
        }
        LocalAgentAvailability::Ready if verification_required => {
            LocalCliInspectionStatus::VerificationRequired
        }
        LocalAgentAvailability::Ready => LocalCliInspectionStatus::Ready,
        LocalAgentAvailability::NeedsSetup => LocalCliInspectionStatus::SetupRequired,
        _ => LocalCliInspectionStatus::Unavailable,
    }
}

async fn probe_path_bounded(
    provider: LocalAgentProvider,
    path: PathBuf,
    path_source: String,
    model_strategy: &ModelStrategy,
    preference: LocalAgentPreference,
    force_refresh: bool,
) -> LocalAgentProbe {
    let timeout = adapter_identity(provider).probe_timeout;
    match tokio::time::timeout(
        timeout,
        probe_path(
            provider,
            path.clone(),
            path_source.clone(),
            model_strategy,
            preference,
            force_refresh,
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => LocalAgentProbe {
            provider,
            availability: LocalAgentAvailability::Error,
            status: LocalCliInspectionStatus::Unavailable,
            reason_code: Some(LocalCliUnavailableReason::ProbeError),
            path: Some(path.to_string_lossy().to_string()),
            path_source: Some(path_source),
            version: None,
            installation_fingerprint: InstallationIdentity::capture(&path)
                .ok()
                .map(|identity| identity.fingerprint().to_string()),
            catalog_authority: LocalCliCatalogAuthority::Partial,
            checked_at: inspection_timestamp(),
            setup_command: provider.setup_command().to_string(),
            models: Vec::new(),
            efforts: Vec::new(),
            preference_decision: LocalAgentPreferenceDecision::default(),
            capabilities: provider.capabilities(),
            message: Some("local CLI capability probe timed out".to_string()),
        },
    }
}

async fn probe(
    app: &AppHandle,
    model_strategy: &ModelStrategy,
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    force_refresh: bool,
) -> LocalAgentProbe {
    match resolve_executable(app, provider) {
        Ok(Some((path, source))) => {
            probe_path_bounded(
                provider,
                path,
                source,
                model_strategy,
                preference,
                force_refresh,
            )
            .await
        }
        Ok(None) => LocalAgentProbe::unavailable(
            provider,
            LocalAgentAvailability::NotFound,
            format!(
                "{} was not found on this computer.",
                provider.command_name()
            ),
        ),
        Err(message) => {
            LocalAgentProbe::unavailable(provider, LocalAgentAvailability::Error, message)
        }
    }
}

fn validate_start_request(request: &LocalAgentStartRequest) -> Result<(), AdapterError> {
    let request_bytes = serde_json::to_vec(request)
        .map_err(|_| "failed to serialize local agent request".to_string())?
        .len();
    if request_bytes > MAX_START_REQUEST_BYTES {
        return Err("local agent request exceeds the request limit".into());
    }
    if !matches!(
        request.mode.as_str(),
        "chat" | "plan" | "auto_qa" | "subagent"
    ) {
        return Err("invalid local agent execution mode".into());
    }
    let expected_scope = match request.mode.as_str() {
        "chat" | "plan" => LocalAgentRunScopeKind::Conversation,
        "auto_qa" | "subagent" => LocalAgentRunScopeKind::Utility,
        _ => unreachable!("execution mode was validated above"),
    };
    if request.scope.kind != expected_scope {
        return Err("local agent run scope does not match its execution mode".into());
    }
    if request.scope.kind == LocalAgentRunScopeKind::Utility
        && (request.session_id.is_some() || request.session_compatibility_key.is_some())
    {
        return Err("isolated utility runs cannot resume persistent CLI sessions".into());
    }
    if request.native_search && matches!(request.mode.as_str(), "auto_qa" | "subagent") {
        return Err("native search is not allowed in isolated execution modes".into());
    }
    if request.scope.id.trim().is_empty()
        || request.scope.id.len() > 256
        || request.scope.id.chars().any(char::is_control)
    {
        return Err("invalid local agent run scope".into());
    }
    if let Some(key) = request.session_compatibility_key.as_deref() {
        if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid local agent session compatibility key".into());
        }
    }
    validate_adapter_request(request)?;
    if request.prompt.trim().is_empty() {
        return Err("local agent prompt is required".into());
    }
    if request.tools.len() > MAX_TOOL_COUNT {
        return Err(format!("too many local agent tools (max {MAX_TOOL_COUNT})").into());
    }
    if request.max_tool_calls == 0 || request.max_tool_calls > MAX_TOOL_CALLS_PER_RUN {
        return Err(format!(
            "invalid local agent tool-call budget (expected 1..={MAX_TOOL_CALLS_PER_RUN})"
        )
        .into());
    }
    for tool in &request.tools {
        if tool.name.is_empty()
            || tool.name.len() > MAX_TOOL_NAME_BYTES
            || tool.name.chars().any(char::is_control)
            || tool.description.len() > MAX_TOOL_DESCRIPTION_BYTES
            || !tool.input_schema.is_object()
        {
            return Err("invalid local agent tool definition".into());
        }
    }
    for value in [
        request.model.as_deref(),
        request.effort.as_deref(),
        request.session_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("invalid local agent option".into());
        }
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|_| "failed to create private local agent directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure private local agent directory".to_string())?;
    }
    Ok(())
}

fn provider_data_directory(
    app: &AppHandle,
    provider: LocalAgentProvider,
) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "failed to resolve application local data directory".to_string())?
        .join("local-agents")
        .join(provider.command_name());
    ensure_private_directory(&path)?;
    Ok(path)
}

fn create_run_directory(app: &AppHandle, provider: LocalAgentProvider) -> Result<PathBuf, String> {
    let runs = runs_directory(app, provider)?;
    let path = runs.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&path)
        .map_err(|_| "failed to create isolated local agent directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure isolated local agent directory".to_string())?;
    }
    Ok(path)
}

fn runs_directory(app: &AppHandle, provider: LocalAgentProvider) -> Result<PathBuf, String> {
    let runs = provider_data_directory(app, provider)?.join("runs");
    ensure_private_directory(&runs)?;
    Ok(runs)
}

fn cleanup_stale_run_root(runs: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(runs)
        .map_err(|_| "failed to inspect stale local agent runs".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "failed to inspect a stale local agent run".to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(id) = uuid::Uuid::parse_str(name) else {
            continue;
        };
        if id.hyphenated().to_string() != name {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| "failed to inspect a stale local agent run".to_string())?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        std::fs::remove_dir_all(entry.path())
            .map_err(|_| "failed to remove a stale local agent run".to_string())?;
    }
    Ok(())
}

fn session_directory(app: &AppHandle, provider: LocalAgentProvider) -> Result<PathBuf, String> {
    let path = provider_data_directory(app, provider)?.join("sessions");
    ensure_private_directory(&path)?;
    Ok(path)
}

fn create_workspace_directory(
    provider: LocalAgentProvider,
    provider_data_dir: &Path,
    run_dir: &Path,
) -> Result<PathBuf, String> {
    // Pi persists resumable transcripts in `sessions`, but its cwd must be
    // disposable and private to this process. Utility runs may execute in
    // parallel, so a provider-wide cwd would mix their working state.
    let path = if provider == LocalAgentProvider::Pi {
        run_dir.join("workspace")
    } else {
        provider_data_dir.join("workspace")
    };
    ensure_private_directory(&path)?;
    if adapter_identity(provider).require_empty_workspace
        && std::fs::read_dir(&path)
            .map_err(|_| "failed to inspect the private local agent workspace".to_string())?
            .next()
            .is_some()
    {
        return Err("the private local agent workspace is not empty".to_string());
    }
    Ok(path)
}

fn workspace_directory(
    app: &AppHandle,
    provider: LocalAgentProvider,
    run_dir: &Path,
) -> Result<PathBuf, String> {
    let provider_data_dir = provider_data_directory(app, provider)?;
    create_workspace_directory(provider, &provider_data_dir, run_dir)
}

#[tauri::command]
pub async fn local_agent_probe(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    force_refresh: bool,
) -> Result<LocalAgentProbe, String> {
    Ok(probe(
        &app,
        &state.model_strategy,
        provider,
        preference,
        force_refresh,
    )
    .await)
}

#[tauri::command]
pub async fn local_agent_choose_executable(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
) -> Result<Option<LocalAgentProbe>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |selected| {
        let _ = sender.send(selected);
    });
    let Some(selected) = receiver
        .await
        .map_err(|_| "executable picker was cancelled".to_string())?
    else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|_| "selected executable path is invalid".to_string())?;
    let canonical = validate_executable_path(provider, &selected)?;
    let probe_result = probe_path_bounded(
        provider,
        canonical.clone(),
        "override".to_string(),
        &state.model_strategy,
        preference,
        true,
    )
    .await;
    if probe_result.availability == LocalAgentAvailability::Unsupported
        || probe_result.availability == LocalAgentAvailability::Error
    {
        return Err(probe_result
            .message
            .unwrap_or_else(|| "selected executable is unsupported".to_string()));
    }
    let mut overrides = read_overrides(&app);
    overrides.set(provider, Some(selected.to_string_lossy().to_string()));
    write_overrides(&app, &overrides)?;
    Ok(Some(probe_result))
}

#[tauri::command]
pub async fn local_agent_clear_executable(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
) -> Result<LocalAgentProbe, String> {
    let mut overrides = read_overrides(&app);
    overrides.set(provider, None);
    write_overrides(&app, &overrides)?;
    Ok(probe(&app, &state.model_strategy, provider, preference, true).await)
}

#[tauri::command]
pub async fn local_agent_start(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    request: LocalAgentStartRequest,
    on_event: tauri::ipc::Channel<LocalAgentEvent>,
) -> Result<String, LocalCliFailure> {
    let provider = request.provider;
    let requested_resume = request.session_id.is_some();
    let failure = |phase, message: String| {
        LocalCliFailure::classified(provider, phase, &message, requested_resume, false)
    };
    validate_start_request(&request).map_err(|error| {
        LocalCliFailure::from_adapter(
            provider,
            LocalCliFailurePhase::Prepare,
            &error,
            requested_resume,
            false,
        )
    })?;
    let (executable, _path_source) = resolve_executable(&app, provider)
        .map_err(|message| failure(LocalCliFailurePhase::Inspect, message))?
        .ok_or_else(|| {
            LocalCliFailure::new(
                provider,
                LocalCliFailureCode::ExecutableNotFound,
                LocalCliFailurePhase::Inspect,
                "The selected local CLI executable could not be found.",
                LocalCliRetryPolicy::Reprobe,
            )
        })?;
    state
        .ensure_stale_runs_cleaned(&app, provider)
        .map_err(|message| failure(LocalCliFailurePhase::Prepare, message))?;
    let run_dir = create_run_directory(&app, provider)
        .map_err(|message| failure(LocalCliFailurePhase::Prepare, message))?;
    let session_dir = match session_directory(&app, request.provider) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(failure(LocalCliFailurePhase::Prepare, error));
        }
    };
    let workspace_dir = match workspace_directory(&app, request.provider, &run_dir) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(failure(LocalCliFailurePhase::Prepare, error));
        }
    };
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
    let phase = Arc::new(RunPhaseTracker::default());
    let on_event = TrackedChannel::tracked(on_event, phase.clone());
    {
        let mut runs = state.runs.lock().map_err(|_| {
            LocalCliFailure::new(
                provider,
                LocalCliFailureCode::Internal,
                LocalCliFailurePhase::Prepare,
                "The local CLI run registry is unavailable.",
                LocalCliRetryPolicy::Manual,
            )
        })?;
        if runs.len() >= MAX_ACTIVE_RUNS {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(LocalCliFailure::new(
                provider,
                LocalCliFailureCode::RunAlreadyActive,
                LocalCliFailurePhase::Prepare,
                format!("Too many local CLI runs are active (max {MAX_ACTIVE_RUNS})."),
                LocalCliRetryPolicy::Manual,
            ));
        }
        if request.scope.kind == LocalAgentRunScopeKind::Conversation
            && runs.values().any(|active| {
                is_conversation_scope_conflict(
                    active.provider,
                    &active.scope,
                    provider,
                    &request.scope,
                )
            })
        {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(LocalCliFailure::new(
                provider,
                LocalCliFailureCode::RunAlreadyActive,
                LocalCliFailurePhase::Prepare,
                "This conversation already has an active run for the selected local CLI.",
                LocalCliRetryPolicy::None,
            ));
        }
        if provider == LocalAgentProvider::Pi
            && request.session_id.as_ref().is_some_and(|session_id| {
                runs.values().any(|active| {
                    is_pi_session_conflict(
                        active.provider,
                        active.session_id.as_deref(),
                        provider,
                        Some(session_id),
                    )
                })
            })
        {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(LocalCliFailure::new(
                provider,
                LocalCliFailureCode::RunAlreadyActive,
                LocalCliFailurePhase::Prepare,
                "This Pi session already has an active local CLI run.",
                LocalCliRetryPolicy::None,
            ));
        }
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancellation: cancellation.clone(),
                task: None,
                run_dir: run_dir.clone(),
                provider,
                scope: request.scope.clone(),
                session_id: request.session_id.clone(),
                phase: phase.clone(),
            },
        );
    }
    let (bridge_url, bridge_token) = match state
        .bridge
        .register(
            run_id.clone(),
            request.tools.clone(),
            request.max_tool_calls,
            cancellation.clone(),
            on_event.clone(),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            if let Ok(mut runs) = state.runs.lock() {
                runs.remove(&run_id);
            }
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(failure(LocalCliFailurePhase::Tool, error));
        }
    };

    let runs = state.runs.clone();
    let bridge = state.bridge.clone();
    let model_strategy = state.model_strategy.clone();
    let task_run_id = run_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _ = on_event.send(LocalAgentEvent::Status {
            state: "preparing".to_string(),
            message: None,
        });
        let mut work = Box::pin(async {
            let preparation_result = tokio::select! {
                _ = cancellation.cancelled() => Err(AdapterError::from("local agent run cancelled")),
                result = tokio::time::timeout(
                    adapter_identity(provider).probe_timeout,
                    prepare_adapter_run(
                        executable,
                        request,
                        &model_strategy,
                        PreparedRunResources {
                            run_dir: run_dir.clone(),
                            session_dir,
                            workspace_dir,
                            bridge_url,
                            bridge_token,
                            cancellation: cancellation.clone(),
                            channel: on_event.clone(),
                        },
                    ),
                ) => result
                    .map_err(|_| AdapterError::from("local CLI start preflight timed out"))
                    .and_then(|result| result),
            };
            let preparation = preparation_result.map_err(|error| {
                LocalCliFailure::from_adapter(
                    provider,
                    LocalCliFailurePhase::Prepare,
                    &error,
                    requested_resume,
                    cancellation.is_cancelled(),
                )
            })?;
            let cancelled_session = preparation.session_id();
            let resumed = preparation.resumed();
            let prepared_event = LocalAgentEvent::Prepared {
                cli_version: preparation.cli_version().to_string(),
                compatibility_key: preparation.compatibility_key().to_string(),
                installation_fingerprint: preparation.installation_fingerprint().to_string(),
                actual_model: preparation.actual_model().map(str::to_string),
                actual_effort: preparation.actual_effort().map(str::to_string),
                resumed,
            };
            on_event.send(prepared_event).map_err(|_| {
                LocalCliFailure::new(
                    provider,
                    LocalCliFailureCode::ConsumerGone,
                    LocalCliFailurePhase::Stream,
                    "The local CLI event consumer is no longer available.",
                    LocalCliRetryPolicy::None,
                )
            })?;
            if cancellation.is_cancelled() {
                return Ok(crate::local_agent_protocol::ProtocolOutcome {
                    session_id: cancelled_session,
                    aborted: true,
                });
            }
            if let Some(message) = preparation.warning().map(str::to_string) {
                on_event
                    .send(LocalAgentEvent::Warning { message })
                    .map_err(|_| {
                        LocalCliFailure::new(
                            provider,
                            LocalCliFailureCode::ConsumerGone,
                            LocalCliFailurePhase::Stream,
                            "The local CLI event consumer is no longer available.",
                            LocalCliRetryPolicy::None,
                        )
                    })?;
            }
            on_event
                .send(LocalAgentEvent::Status {
                    state: "handshaking".to_string(),
                    message: None,
                })
                .map_err(|_| {
                    LocalCliFailure::new(
                        provider,
                        LocalCliFailureCode::ConsumerGone,
                        LocalCliFailurePhase::Handshake,
                        "The local CLI event consumer is no longer available.",
                        LocalCliRetryPolicy::None,
                    )
                })?;
            preparation.launch().await.map_err(|error| {
                let phase = infer_failure_phase(&error.message, LocalCliFailurePhase::Stream);
                LocalCliFailure::from_adapter(
                    provider,
                    phase,
                    &error,
                    resumed,
                    cancellation.is_cancelled(),
                )
            })
        });
        let result = match tokio::time::timeout(MAX_RUN_DURATION, work.as_mut()).await {
            Ok(result) => result,
            Err(_) => {
                cancellation.cancel();
                let timeout_phase = phase.current();
                phase.set(LocalCliFailurePhase::Shutdown);
                let _ = tokio::time::timeout(RUN_CLEANUP_TIMEOUT, work.as_mut()).await;
                Err(LocalCliFailure::new(
                    provider,
                    LocalCliFailureCode::Timeout,
                    timeout_phase,
                    "The local CLI did not complete within the allowed time.",
                    LocalCliRetryPolicy::Manual,
                ))
            }
        };
        // If bounded cooperative cleanup also timed out, dropping this future
        // drops the process-tree guard and kills the Unix PGID / Windows job.
        drop(work);
        match result {
            Ok(outcome) => {
                let _ = on_event.send(LocalAgentEvent::Done {
                    aborted: outcome.aborted,
                    session_id: outcome.session_id,
                });
            }
            Err(failure) => {
                let retryable = failure.retry_policy != LocalCliRetryPolicy::None;
                let _ = on_event.send(LocalAgentEvent::Error {
                    message: failure.safe_message.clone(),
                    retryable,
                    failure,
                });
                let _ = on_event.send(LocalAgentEvent::Done {
                    aborted: cancellation.is_cancelled(),
                    session_id: None,
                });
            }
        }
        bridge.unregister(&task_run_id, "local agent run completed");
        let _ = std::fs::remove_dir_all(&run_dir);
        if let Ok(mut runs) = runs.lock() {
            runs.remove(&task_run_id);
        }
    });
    if let Ok(mut runs) = state.runs.lock() {
        if let Some(active) = runs.get_mut(&run_id) {
            active.task = Some(task);
        }
    }
    Ok(run_id)
}

#[tauri::command]
pub fn local_agent_resolve_tool(
    state: tauri::State<'_, LocalAgentState>,
    run_id: String,
    call_id: String,
    result: LocalToolResolution,
) -> Result<(), String> {
    state.bridge.resolve(&run_id, &call_id, result)?;
    if let Ok(runs) = state.runs.lock() {
        if let Some(run) = runs.get(&run_id) {
            run.phase.tool_resolved();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn local_agent_cancel(
    state: tauri::State<'_, LocalAgentState>,
    run_id: String,
) -> Result<bool, String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "local agent run lock poisoned".to_string())?;
    let Some(run) = runs.get(&run_id) else {
        return Ok(false);
    };
    run.phase.set(LocalCliFailurePhase::Shutdown);
    run.cancellation.cancel();
    state
        .bridge
        .unregister(&run_id, "local agent run cancelled");
    Ok(true)
}

#[tauri::command]
pub fn local_agent_cancel_all(state: tauri::State<'_, LocalAgentState>) -> Result<usize, String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "local agent run lock poisoned".to_string())?;
    let count = runs.len();
    for (run_id, run) in runs.iter() {
        run.phase.set(LocalCliFailurePhase::Shutdown);
        run.cancellation.cancel();
        state
            .bridge
            .unregister(run_id, "all local agent runs cancelled");
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider: LocalAgentProvider::Codex,
            model: None,
            effort: None,
            system_prompt: "system".to_string(),
            prompt: "build".to_string(),
            bootstrap_context: None,
            session_id: None,
            session_compatibility_key: None,
            scope: LocalAgentRunScope {
                kind: LocalAgentRunScopeKind::Conversation,
                id: "conversation-test".to_string(),
            },
            tools: vec![LocalToolSpec {
                name: "read_files".to_string(),
                description: "Read files".to_string(),
                input_schema: serde_json::json!({"type":"object"}),
                annotations: LocalToolAnnotations {
                    read_only_hint: Some(true),
                    destructive_hint: Some(false),
                    idempotent_hint: Some(true),
                    open_world_hint: Some(false),
                },
                host_approval: LocalToolHostApproval::None,
            }],
            max_tool_calls: 32,
            native_search: false,
            mode: "chat".to_string(),
        }
    }

    #[test]
    fn validates_start_request_shape() {
        assert!(validate_start_request(&request()).is_ok());
        let mut invalid = request();
        invalid.mode = "shell".to_string();
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.max_tool_calls = 0;
        assert!(validate_start_request(&invalid).is_err());
        invalid.max_tool_calls = MAX_TOOL_CALLS_PER_RUN + 1;
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.mode = "auto_qa".to_string();
        invalid.native_search = true;
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.scope.kind = LocalAgentRunScopeKind::Utility;
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.mode = "subagent".to_string();
        assert!(validate_start_request(&invalid).is_err());
        invalid.scope.kind = LocalAgentRunScopeKind::Utility;
        assert!(validate_start_request(&invalid).is_ok());
        invalid.session_id = Some("persistent-session".to_string());
        assert!(validate_start_request(&invalid).is_err());
        invalid.session_id = None;
        invalid.session_compatibility_key = Some("a".repeat(64));
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.scope.id.clear();
        assert!(validate_start_request(&invalid).is_err());
        let mut invalid = request();
        invalid.session_compatibility_key = Some("not-a-digest".to_string());
        assert!(validate_start_request(&invalid).is_err());
    }

    #[test]
    fn run_phase_tracks_handshake_stream_tool_and_shutdown() {
        let phase = RunPhaseTracker::default();
        phase.observe(&LocalAgentEvent::Status {
            state: "handshaking".to_string(),
            message: None,
        });
        assert_eq!(phase.current(), LocalCliFailurePhase::Handshake);

        phase.observe(&LocalAgentEvent::Session {
            session_id: "session".to_string(),
            cli_version: "cli".to_string(),
        });
        assert_eq!(phase.current(), LocalCliFailurePhase::Stream);

        phase.observe(&LocalAgentEvent::ToolRequest {
            run_id: "run".to_string(),
            call_id: "call".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({}),
        });
        phase.observe(&LocalAgentEvent::TextDelta {
            delta: "queued".to_string(),
        });
        assert_eq!(phase.current(), LocalCliFailurePhase::Tool);
        phase.tool_resolved();
        assert_eq!(phase.current(), LocalCliFailurePhase::Stream);

        phase.observe(&LocalAgentEvent::Done {
            aborted: false,
            session_id: Some("session".to_string()),
        });
        assert_eq!(phase.current(), LocalCliFailurePhase::Shutdown);
    }

    #[test]
    fn tracked_channel_observes_and_forwards_one_typed_event() {
        let (sender, receiver) = std::sync::mpsc::channel();
        let target = tauri::ipc::Channel::new(move |body| {
            sender
                .send(body)
                .map_err(|_| std::io::Error::other("test receiver is unavailable"))?;
            Ok(())
        });
        let phase = Arc::new(RunPhaseTracker::default());
        let channel = TrackedChannel::tracked(target, phase.clone());

        channel
            .send(LocalAgentEvent::ToolRequest {
                run_id: "run".to_string(),
                call_id: "call".to_string(),
                name: "read_file".to_string(),
                arguments: serde_json::json!({}),
            })
            .unwrap();

        assert_eq!(phase.current(), LocalCliFailurePhase::Tool);
        let tauri::ipc::InvokeResponseBody::Json(body) = receiver.recv().unwrap() else {
            panic!("tracked channel must forward JSON");
        };
        let event: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(event["type"], "toolRequest");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn serializes_antigravity_provider_for_the_public_contract() {
        assert_eq!(
            serde_json::to_value(LocalAgentProvider::Antigravity).unwrap(),
            serde_json::json!("antigravity")
        );
    }

    #[test]
    fn serializes_host_unsupported_for_wire_parity() {
        assert_eq!(
            serde_json::to_value(LocalCliUnavailableReason::HostUnsupported).unwrap(),
            serde_json::json!("hostUnsupported")
        );
    }

    #[test]
    fn serializes_model_preference_decisions_for_the_public_contract() {
        assert_eq!(
            serde_json::to_value(LocalAgentPreferenceDecision::Keep { unverified: true }).unwrap(),
            serde_json::json!({"kind":"keep","unverified":true})
        );
        assert_eq!(
            serde_json::to_value(LocalAgentPreferenceDecision::Replace {
                preference: LocalAgentPreference {
                    model: "gpt-test".to_string(),
                    effort: "max".to_string(),
                },
            })
            .unwrap(),
            serde_json::json!({
                "kind":"replace",
                "preference":{"model":"gpt-test","effort":"max"}
            })
        );
    }

    #[test]
    fn inspection_keeps_legacy_availability_and_adds_sendability_status() {
        let probe = LocalAgentProbe::unavailable(
            LocalAgentProvider::Codex,
            LocalAgentAvailability::NotFound,
            "Codex was not found".to_string(),
        );
        let value = serde_json::to_value(probe).unwrap();
        assert_eq!(value["availability"], "notFound");
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["reasonCode"], "notFound");
        assert!(value["checkedAt"].as_u64().is_some());
        assert_eq!(
            inspection_status(LocalAgentAvailability::Ready, false, true),
            LocalCliInspectionStatus::SetupRequired
        );
    }

    #[test]
    fn prepared_and_failure_events_use_the_typed_public_contract() {
        let prepared = serde_json::to_value(LocalAgentEvent::Prepared {
            cli_version: "codex 1.0.0".to_string(),
            compatibility_key: "a".repeat(64),
            installation_fingerprint: "b".repeat(64),
            actual_model: Some("gpt-test".to_string()),
            actual_effort: Some("high".to_string()),
            resumed: true,
        })
        .unwrap();
        assert_eq!(prepared["type"], "prepared");
        assert_eq!(prepared["actualModel"], "gpt-test");
        assert_eq!(prepared["resumed"], true);

        let failure = LocalCliFailure::new(
            LocalAgentProvider::Codex,
            LocalCliFailureCode::ProtocolViolation,
            LocalCliFailurePhase::Stream,
            "The local CLI returned an unsupported structured response.",
            LocalCliRetryPolicy::None,
        );
        let event = serde_json::to_value(LocalAgentEvent::Error {
            message: failure.safe_message.clone(),
            retryable: false,
            failure,
        })
        .unwrap();
        assert_eq!(event["failure"]["code"], "protocolViolation");
        assert_eq!(event["failure"]["phase"], "stream");
        assert_eq!(event["retryable"], false);

        let tool = serde_json::to_value(&request().tools[0]).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool["annotations"]["destructiveHint"], false);
        assert_eq!(tool["hostApproval"], "none");
    }

    #[test]
    fn serializes_only_same_conversation_and_provider_runs() {
        let conversation = LocalAgentRunScope {
            kind: LocalAgentRunScopeKind::Conversation,
            id: "conversation-1".to_string(),
        };
        let same = conversation.clone();
        let other = LocalAgentRunScope {
            kind: LocalAgentRunScopeKind::Conversation,
            id: "conversation-2".to_string(),
        };
        let utility = LocalAgentRunScope {
            kind: LocalAgentRunScopeKind::Utility,
            id: "utility-1".to_string(),
        };

        assert!(is_conversation_scope_conflict(
            LocalAgentProvider::Codex,
            &conversation,
            LocalAgentProvider::Codex,
            &same,
        ));
        assert!(!is_conversation_scope_conflict(
            LocalAgentProvider::Codex,
            &conversation,
            LocalAgentProvider::Claude,
            &same,
        ));
        assert!(!is_conversation_scope_conflict(
            LocalAgentProvider::Codex,
            &conversation,
            LocalAgentProvider::Codex,
            &other,
        ));
        assert!(!is_conversation_scope_conflict(
            LocalAgentProvider::Codex,
            &conversation,
            LocalAgentProvider::Codex,
            &utility,
        ));

        let session = "123e4567-e89b-12d3-a456-426614174000";
        assert!(is_pi_session_conflict(
            LocalAgentProvider::Pi,
            Some(session),
            LocalAgentProvider::Pi,
            Some(session),
        ));
        assert!(!is_pi_session_conflict(
            LocalAgentProvider::Pi,
            Some(session),
            LocalAgentProvider::Pi,
            None,
        ));
        assert!(!is_pi_session_conflict(
            LocalAgentProvider::Codex,
            Some(session),
            LocalAgentProvider::Codex,
            Some(session),
        ));
    }

    #[test]
    fn accepts_only_the_native_antigravity_executable_name() {
        let expected = if cfg!(windows) { "agy.exe" } else { "agy" };
        assert!(valid_executable_name(
            LocalAgentProvider::Antigravity,
            Path::new(expected)
        ));
        assert!(!valid_executable_name(
            LocalAgentProvider::Antigravity,
            Path::new("antigravity")
        ));
    }

    #[test]
    fn removes_only_app_owned_uuid_run_directories() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-stale-runs-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let stale = root.join(uuid::Uuid::new_v4().to_string());
        let unrelated = root.join("keep-me");
        std::fs::create_dir(&stale).unwrap();
        std::fs::write(stale.join("pi-config.json"), b"sensitive").unwrap();
        std::fs::create_dir(&unrelated).unwrap();

        cleanup_stale_run_root(&root).unwrap();

        assert!(!stale.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pi_parallel_runs_use_distinct_disposable_workspaces() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-pi-workspaces-test-{}",
            uuid::Uuid::new_v4()
        ));
        let provider_data = root.join("pi");
        let sessions = provider_data.join("sessions");
        let first_run = provider_data
            .join("runs")
            .join(uuid::Uuid::new_v4().to_string());
        let second_run = provider_data
            .join("runs")
            .join(uuid::Uuid::new_v4().to_string());
        for directory in [&sessions, &first_run, &second_run] {
            ensure_private_directory(directory).unwrap();
        }
        std::fs::write(sessions.join("persisted-session.jsonl"), b"resume state").unwrap();

        let first_workspace =
            create_workspace_directory(LocalAgentProvider::Pi, &provider_data, &first_run).unwrap();
        std::fs::write(first_workspace.join("run-local.txt"), b"first run").unwrap();
        let second_workspace =
            create_workspace_directory(LocalAgentProvider::Pi, &provider_data, &second_run)
                .unwrap();

        assert_eq!(first_workspace, first_run.join("workspace"));
        assert_eq!(second_workspace, second_run.join("workspace"));
        assert_ne!(first_workspace, second_workspace);
        assert!(std::fs::read_dir(&second_workspace)
            .unwrap()
            .next()
            .is_none());

        std::fs::remove_dir_all(&first_run).unwrap();
        assert!(!first_workspace.exists());
        assert!(second_workspace.exists());
        assert_eq!(
            std::fs::read(sessions.join("persisted-session.jsonl")).unwrap(),
            b"resume state"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
