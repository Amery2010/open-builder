use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::local_agent_adapter::{
    identity as adapter_identity, prepare_start as prepare_adapter_start, probe as probe_adapter,
    run as run_adapter, validate_request as validate_adapter_request, AdapterProbe,
};
use crate::local_agent_bridge::ToolBridge;
use crate::local_agent_protocol::ProtocolContext;

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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentAvailability {
    NotFound,
    Unsupported,
    NeedsSetup,
    Ready,
    Error,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentCapabilities {
    pub(crate) sessions: bool,
    pub(crate) reasoning: bool,
    pub(crate) tools: bool,
    pub(crate) native_search: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentModel {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    pub default_effort: Option<String>,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentProbe {
    provider: LocalAgentProvider,
    availability: LocalAgentAvailability,
    path: Option<String>,
    path_source: Option<String>,
    version: Option<String>,
    setup_command: String,
    models: Vec<LocalAgentModel>,
    efforts: Vec<String>,
    capabilities: LocalAgentCapabilities,
    message: Option<String>,
}

impl LocalAgentProbe {
    fn unavailable(
        provider: LocalAgentProvider,
        availability: LocalAgentAvailability,
        message: String,
    ) -> Self {
        Self {
            provider,
            availability,
            path: None,
            path_source: None,
            version: None,
            setup_command: provider.setup_command().to_string(),
            models: Vec::new(),
            efforts: Vec::new(),
            capabilities: provider.capabilities(),
            message: Some(message),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
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
    pub tools: Vec<LocalToolSpec>,
    pub max_tool_calls: usize,
    pub native_search: bool,
    pub mode: String,
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

#[derive(Clone, Debug, Serialize)]
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
}

pub struct LocalAgentState {
    runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    bridge: Arc<ToolBridge>,
    cleaned_run_roots: Mutex<HashSet<LocalAgentProvider>>,
}

impl Default for LocalAgentState {
    fn default() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
            bridge: Arc::new(ToolBridge::default()),
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
) -> LocalAgentProbe {
    let AdapterProbe {
        availability,
        version,
        models,
        efforts,
        message,
    } = probe_adapter(provider, &path).await;
    LocalAgentProbe {
        provider,
        availability,
        path: Some(path.to_string_lossy().to_string()),
        path_source: Some(path_source),
        version,
        setup_command: provider.setup_command().to_string(),
        models,
        efforts,
        capabilities: provider.capabilities(),
        message,
    }
}

async fn probe_path_bounded(
    provider: LocalAgentProvider,
    path: PathBuf,
    path_source: String,
) -> LocalAgentProbe {
    let timeout = adapter_identity(provider).probe_timeout;
    match tokio::time::timeout(
        timeout,
        probe_path(provider, path.clone(), path_source.clone()),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => LocalAgentProbe {
            provider,
            availability: LocalAgentAvailability::Error,
            path: Some(path.to_string_lossy().to_string()),
            path_source: Some(path_source),
            version: None,
            setup_command: provider.setup_command().to_string(),
            models: Vec::new(),
            efforts: Vec::new(),
            capabilities: provider.capabilities(),
            message: Some("local CLI capability probe timed out".to_string()),
        },
    }
}

async fn probe(app: &AppHandle, provider: LocalAgentProvider) -> LocalAgentProbe {
    match resolve_executable(app, provider) {
        Ok(Some((path, source))) => probe_path_bounded(provider, path, source).await,
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

fn validate_start_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    let request_bytes = serde_json::to_vec(request)
        .map_err(|_| "failed to serialize local agent request".to_string())?
        .len();
    if request_bytes > MAX_START_REQUEST_BYTES {
        return Err("local agent request exceeds the request limit".to_string());
    }
    if !matches!(
        request.mode.as_str(),
        "chat" | "plan" | "auto_qa" | "subagent"
    ) {
        return Err("invalid local agent execution mode".to_string());
    }
    if request.native_search && matches!(request.mode.as_str(), "auto_qa" | "subagent") {
        return Err("native search is not allowed in isolated execution modes".to_string());
    }
    validate_adapter_request(request)?;
    if request.prompt.trim().is_empty() {
        return Err("local agent prompt is required".to_string());
    }
    if request.tools.len() > MAX_TOOL_COUNT {
        return Err(format!("too many local agent tools (max {MAX_TOOL_COUNT})"));
    }
    if request.max_tool_calls == 0 || request.max_tool_calls > MAX_TOOL_CALLS_PER_RUN {
        return Err(format!(
            "invalid local agent tool-call budget (expected 1..={MAX_TOOL_CALLS_PER_RUN})"
        ));
    }
    for tool in &request.tools {
        if tool.name.is_empty()
            || tool.name.len() > MAX_TOOL_NAME_BYTES
            || tool.name.chars().any(char::is_control)
            || tool.description.len() > MAX_TOOL_DESCRIPTION_BYTES
            || !tool.input_schema.is_object()
        {
            return Err("invalid local agent tool definition".to_string());
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
            return Err("invalid local agent option".to_string());
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

fn workspace_directory(app: &AppHandle, provider: LocalAgentProvider) -> Result<PathBuf, String> {
    let path = provider_data_directory(app, provider)?.join("workspace");
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

#[tauri::command]
pub async fn local_agent_probe(app: AppHandle, provider: LocalAgentProvider) -> LocalAgentProbe {
    probe(&app, provider).await
}

#[tauri::command]
pub async fn local_agent_choose_executable(
    app: AppHandle,
    provider: LocalAgentProvider,
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
    let probe_result =
        probe_path_bounded(provider, canonical.clone(), "override".to_string()).await;
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
    provider: LocalAgentProvider,
) -> Result<LocalAgentProbe, String> {
    let mut overrides = read_overrides(&app);
    overrides.set(provider, None);
    write_overrides(&app, &overrides)?;
    Ok(probe(&app, provider).await)
}

#[tauri::command]
pub async fn local_agent_start(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    request: LocalAgentStartRequest,
    on_event: tauri::ipc::Channel<LocalAgentEvent>,
) -> Result<String, String> {
    validate_start_request(&request)?;
    let (executable, _path_source) = resolve_executable(&app, request.provider)?
        .ok_or_else(|| format!("{} was not found", request.provider.command_name()))?;
    state.ensure_stale_runs_cleaned(&app, request.provider)?;
    let run_dir = create_run_directory(&app, request.provider)?;
    let session_dir = match session_directory(&app, request.provider) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(error);
        }
    };
    let workspace_dir = match workspace_directory(&app, request.provider) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(error);
        }
    };
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
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
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(error);
        }
    };
    {
        let mut runs = state
            .runs
            .lock()
            .map_err(|_| "local agent run lock poisoned".to_string())?;
        if runs.len() >= MAX_ACTIVE_RUNS {
            state.bridge.unregister(&run_id, "run limit reached");
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(format!(
                "too many active local agent runs (max {MAX_ACTIVE_RUNS})"
            ));
        }
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancellation: cancellation.clone(),
                task: None,
                run_dir: run_dir.clone(),
            },
        );
    }

    let runs = state.runs.clone();
    let bridge = state.bridge.clone();
    let task_run_id = run_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _ = on_event.send(LocalAgentEvent::Status {
            state: "probing".to_string(),
            message: None,
        });
        let mut work = Box::pin(async {
            let mut request = request;
            let preparation = tokio::time::timeout(
                adapter_identity(request.provider).probe_timeout,
                prepare_adapter_start(&executable, &mut request),
            )
            .await
            .map_err(|_| "local CLI start preflight timed out".to_string())??;
            if cancellation.is_cancelled() {
                return Ok(crate::local_agent_protocol::ProtocolOutcome {
                    session_id: request.session_id.clone(),
                    aborted: true,
                });
            }
            run_adapter(ProtocolContext {
                executable,
                request,
                run_dir: run_dir.clone(),
                session_dir,
                workspace_dir,
                bridge_url,
                bridge_token,
                cancellation: cancellation.clone(),
                channel: on_event.clone(),
                cli_version: preparation.cli_version,
            })
            .await
        });
        let result = match tokio::time::timeout(MAX_RUN_DURATION, work.as_mut()).await {
            Ok(result) => result,
            Err(_) => {
                cancellation.cancel();
                let _ = tokio::time::timeout(RUN_CLEANUP_TIMEOUT, work.as_mut()).await;
                Err("local agent run exceeded the 30 minute limit".to_string())
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
            Err(message) => {
                let _ = on_event.send(LocalAgentEvent::Error {
                    message,
                    retryable: false,
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
    state.bridge.resolve(&run_id, &call_id, result)
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
            tools: vec![LocalToolSpec {
                name: "read_files".to_string(),
                description: "Read files".to_string(),
                input_schema: serde_json::json!({"type":"object"}),
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
}
