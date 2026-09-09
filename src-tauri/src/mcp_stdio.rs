use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, ClientCapabilities, ClientInfo, ClientRequest,
    Implementation, ProtocolVersion, ServerResult,
};
use rmcp::service::{PeerRequestOptions, RoleClient, RunningService};
use rmcp::transport::TokioChildProcess;
use rmcp::{ClientLifecycleMode, ClientServiceExt, Peer};
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::oneshot;

const MAX_CONNECTIONS: usize = 64;
const MAX_ID_CHARS: usize = 64;
const MAX_COMMAND_BYTES: usize = 4 * 1024;
const MAX_ARGS: usize = 128;
const MAX_ARG_BYTES: usize = 8 * 1024;
const MAX_ENV_VARS: usize = 128;
const MAX_ENV_VALUE_BYTES: usize = 64 * 1024;
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_INSTRUCTIONS_BYTES: usize = 128 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 20 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CALL_TIMEOUT_MS: u64 = 30_000;
const MIN_CALL_TIMEOUT_MS: u64 = 1_000;
const MAX_CALL_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

type McpService = RunningService<RoleClient, ClientInfo>;
type CallKey = (String, String);

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioConfig {
    id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioConnectionInfo {
    server_info: Option<serde_json::Value>,
    instructions: Option<String>,
    tools: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioDiscovery {
    instructions: Option<String>,
    tools: serde_json::Value,
}

struct StdioConnection {
    service: McpService,
    stderr_task: tauri::async_runtime::JoinHandle<()>,
}

pub struct McpStdioState {
    connections: Mutex<HashMap<String, StdioConnection>>,
    calls: Mutex<HashMap<CallKey, oneshot::Sender<String>>>,
    connection_epoch: AtomicU64,
}

impl Default for McpStdioState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            calls: Mutex::new(HashMap::new()),
            connection_epoch: AtomicU64::new(0),
        }
    }
}

impl McpStdioState {
    fn begin_revocation(&self) -> Result<(u64, Vec<StdioConnection>), String> {
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| "MCP stdio connection lock poisoned".to_string())?;
        let epoch = self.connection_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        Ok((epoch, connections.drain().map(|(_, value)| value).collect()))
    }

    pub async fn shutdown_gracefully(&self) {
        if let Ok(mut calls) = self.calls.lock() {
            for (_, cancel) in calls.drain() {
                let _ = cancel.send("application exiting".to_string());
            }
        }
        let connections: Vec<StdioConnection> = self
            .connections
            .lock()
            .map(|mut connections| connections.drain().map(|(_, value)| value).collect())
            .unwrap_or_default();
        futures_util::future::join_all(connections.into_iter().map(close_connection)).await;
    }

    pub fn shutdown_now(&self) {
        if let Ok(mut calls) = self.calls.lock() {
            for (_, cancel) in calls.drain() {
                let _ = cancel.send("application exiting".to_string());
            }
        }
        if let Ok(mut connections) = self.connections.lock() {
            for (_, connection) in connections.drain() {
                connection.service.cancellation_token().cancel();
                connection.stderr_task.abort();
            }
        }
    }
}

impl Drop for McpStdioState {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > MAX_ID_CHARS {
        return Err(format!("{label} exceeds {MAX_ID_CHARS} characters"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(format!("{label} contains invalid characters"));
    }
    Ok(())
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

fn validate_config(config: &McpStdioConfig) -> Result<Option<PathBuf>, String> {
    validate_id("MCP server id", &config.id)?;
    if config.command.trim().is_empty() {
        return Err("MCP stdio command is required".to_string());
    }
    if config.command.len() > MAX_COMMAND_BYTES || config.command.contains('\0') {
        return Err(format!(
            "MCP stdio command must be <= {MAX_COMMAND_BYTES} bytes and contain no NUL"
        ));
    }
    if config.args.len() > MAX_ARGS {
        return Err(format!("too many MCP stdio arguments (max {MAX_ARGS})"));
    }
    if config
        .args
        .iter()
        .any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0'))
    {
        return Err(format!(
            "MCP stdio arguments must be <= {MAX_ARG_BYTES} bytes and contain no NUL"
        ));
    }
    if config.env.len() > MAX_ENV_VARS {
        return Err(format!(
            "too many MCP stdio environment variables (max {MAX_ENV_VARS})"
        ));
    }
    if config.env.iter().any(|(name, value)| {
        !valid_env_name(name) || value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0')
    }) {
        return Err(format!(
            "MCP stdio environment contains an invalid name, NUL, or value over {MAX_ENV_VALUE_BYTES} bytes"
        ));
    }

    let total_bytes = config.command.len()
        + config.args.iter().map(String::len).sum::<usize>()
        + config
            .env
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
        + config.cwd.as_ref().map(String::len).unwrap_or(0);
    if total_bytes > MAX_CONFIG_BYTES {
        return Err(format!(
            "MCP stdio configuration exceeds {MAX_CONFIG_BYTES} bytes"
        ));
    }

    let cwd = config.cwd.as_ref().map(PathBuf::from);
    if let Some(cwd) = &cwd {
        if !cwd.is_absolute() {
            return Err("MCP stdio working directory must be absolute".to_string());
        }
        if !cwd.is_dir() {
            return Err(
                "MCP stdio working directory does not exist or is not a directory".to_string(),
            );
        }
    }
    Ok(cwd)
}

fn spawn_stderr_drain(
    mut stderr: tokio::process::ChildStderr,
    saw_stderr: Arc<AtomicBool>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => saw_stderr.store(true, Ordering::Relaxed),
            }
        }
    })
}

fn safe_service_error(context: &str, saw_stderr: bool) -> String {
    if saw_stderr {
        format!("{context}; server stderr was redacted")
    } else {
        context.to_string()
    }
}

fn ensure_json_budget(value: &serde_json::Value, label: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| format!("failed to serialize MCP {label}"))?
        .len();
    if bytes > MAX_RESULT_BYTES {
        return Err(format!("MCP {label} exceeds {MAX_RESULT_BYTES} bytes"));
    }
    Ok(())
}

fn validate_instructions(instructions: Option<String>) -> Result<Option<String>, String> {
    if instructions
        .as_ref()
        .is_some_and(|value| value.len() > MAX_INSTRUCTIONS_BYTES)
    {
        return Err(format!(
            "MCP server instructions exceed {MAX_INSTRUCTIONS_BYTES} bytes"
        ));
    }
    Ok(instructions)
}

async fn create_connection(
    config: &McpStdioConfig,
) -> Result<(StdioConnection, McpStdioConnectionInfo), String> {
    let cwd = validate_config(config)?;
    let mut command = Command::new(&config.command);
    // Same least-privilege environment as local CLI runs and skill scripts: the
    // server sees the allowlist plus its own configured variables, never the
    // desktop app's full environment.
    crate::local_agent_protocol::apply_minimal_environment(&mut command);
    command
        .args(&config.args)
        .envs(&config.env)
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut wrapped_command = CommandWrap::from(command);
    wrapped_command.wrap(KillOnDrop);
    #[cfg(unix)]
    wrapped_command.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    wrapped_command.wrap(JobObject);

    let (transport, stderr) = TokioChildProcess::builder(wrapped_command)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "failed to start MCP stdio server".to_string())?;
    let stderr = stderr.ok_or_else(|| "failed to capture MCP server stderr".to_string())?;
    let saw_stderr = Arc::new(AtomicBool::new(false));
    let stderr_task = spawn_stderr_drain(stderr, saw_stderr.clone());

    let client_info = ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("open-builder", env!("CARGO_PKG_VERSION")),
    );
    let lifecycle = ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    };
    let mut service = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        client_info.serve_with_lifecycle(transport, lifecycle),
    )
    .await
    {
        Ok(Ok(service)) => service,
        Ok(Err(_)) => {
            stderr_task.abort();
            return Err(safe_service_error(
                "MCP stdio initialization failed",
                saw_stderr.load(Ordering::Relaxed),
            ));
        }
        Err(_) => {
            stderr_task.abort();
            return Err(safe_service_error(
                "MCP stdio initialization timed out",
                saw_stderr.load(Ordering::Relaxed),
            ));
        }
    };

    let peer_info = service.peer_info();
    let instructions = match validate_instructions(
        peer_info
            .as_ref()
            .and_then(|info| info.instructions.clone()),
    ) {
        Ok(instructions) => instructions,
        Err(error) => {
            let _ = service.close_with_timeout(SHUTDOWN_TIMEOUT).await;
            stderr_task.abort();
            return Err(error);
        }
    };
    let server_info = peer_info
        .as_ref()
        .and_then(|info| info.server_info.as_ref())
        .and_then(|info| serde_json::to_value(info).ok());
    let tools = match tokio::time::timeout(LIST_TIMEOUT, service.list_all_tools()).await {
        Ok(Ok(tools)) => tools,
        Ok(Err(_)) => {
            let _ = service.close_with_timeout(SHUTDOWN_TIMEOUT).await;
            stderr_task.abort();
            return Err("MCP tools/list failed".to_string());
        }
        Err(_) => {
            let _ = service.close_with_timeout(SHUTDOWN_TIMEOUT).await;
            stderr_task.abort();
            return Err("MCP tools/list timed out".to_string());
        }
    };
    let tools = serde_json::to_value(tools)
        .map_err(|_| "failed to serialize MCP tool definitions".to_string())?;
    if let Err(error) = ensure_json_budget(&tools, "tool definitions") {
        let _ = service.close_with_timeout(SHUTDOWN_TIMEOUT).await;
        stderr_task.abort();
        return Err(error);
    }

    Ok((
        StdioConnection {
            service,
            stderr_task,
        },
        McpStdioConnectionInfo {
            server_info,
            instructions,
            tools,
        },
    ))
}

async fn close_connection(mut connection: StdioConnection) {
    let _ = connection
        .service
        .close_with_timeout(SHUTDOWN_TIMEOUT)
        .await;
    connection.stderr_task.abort();
}

fn connection_peer(state: &McpStdioState, server_id: &str) -> Result<Peer<RoleClient>, String> {
    validate_id("MCP server id", server_id)?;
    let connections = state
        .connections
        .lock()
        .map_err(|_| "MCP stdio connection lock poisoned".to_string())?;
    let connection = connections
        .get(server_id)
        .ok_or_else(|| "MCP stdio server is not connected".to_string())?;
    if connection.service.is_closed() {
        return Err("MCP stdio server connection is closed".to_string());
    }
    Ok(connection.service.peer().clone())
}

fn cancel_server_calls(state: &McpStdioState, server_id: &str, reason: &str) {
    if let Ok(mut calls) = state.calls.lock() {
        let keys = calls
            .keys()
            .filter(|(id, _)| id == server_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(cancel) = calls.remove(&key) {
                let _ = cancel.send(reason.to_string());
            }
        }
    }
}

#[tauri::command]
pub async fn mcp_stdio_connect(
    state: tauri::State<'_, McpStdioState>,
    config: McpStdioConfig,
    expected_epoch: u64,
) -> Result<McpStdioConnectionInfo, String> {
    validate_config(&config)?;
    if state.connection_epoch.load(Ordering::Acquire) != expected_epoch {
        return Err("stale MCP stdio connection epoch".to_string());
    }
    let previous = {
        let mut connections = state
            .connections
            .lock()
            .map_err(|_| "MCP stdio connection lock poisoned".to_string())?;
        if connections.len() >= MAX_CONNECTIONS && !connections.contains_key(&config.id) {
            return Err(format!(
                "too many active MCP stdio servers (max {MAX_CONNECTIONS})"
            ));
        }
        connections.remove(&config.id)
    };
    if let Some(previous) = previous {
        cancel_server_calls(&state, &config.id, "MCP server reconnecting");
        close_connection(previous).await;
    }

    let (connection, info) = create_connection(&config).await?;
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "MCP stdio connection lock poisoned".to_string())?;
    if state.connection_epoch.load(Ordering::Acquire) != expected_epoch {
        drop(connections);
        close_connection(connection).await;
        return Err("MCP stdio connection was revoked during setup".to_string());
    }
    connections.insert(config.id, connection);
    Ok(info)
}

#[tauri::command]
pub fn mcp_stdio_connection_epoch(state: tauri::State<'_, McpStdioState>) -> u64 {
    state.connection_epoch.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn mcp_stdio_disconnect_all(
    state: tauri::State<'_, McpStdioState>,
) -> Result<u64, String> {
    let (epoch, connections) = state.begin_revocation()?;
    if let Ok(mut calls) = state.calls.lock() {
        for (_, cancel) in calls.drain() {
            let _ = cancel.send("all local MCP servers revoked".to_string());
        }
    }
    futures_util::future::join_all(connections.into_iter().map(close_connection)).await;
    Ok(epoch)
}

#[tauri::command]
pub async fn mcp_stdio_list_tools(
    state: tauri::State<'_, McpStdioState>,
    server_id: String,
) -> Result<McpStdioDiscovery, String> {
    let peer = connection_peer(&state, &server_id)?;
    let instructions = validate_instructions(
        peer.peer_info()
            .as_ref()
            .and_then(|info| info.instructions.clone()),
    )?;
    let tools = tokio::time::timeout(LIST_TIMEOUT, peer.list_all_tools())
        .await
        .map_err(|_| "MCP tools/list timed out".to_string())?
        .map_err(|_| "MCP tools/list failed".to_string())?;
    let value = serde_json::to_value(tools)
        .map_err(|_| "failed to serialize MCP tool definitions".to_string())?;
    ensure_json_budget(&value, "tool definitions")?;
    Ok(McpStdioDiscovery {
        instructions,
        tools: value,
    })
}

#[tauri::command]
pub async fn mcp_stdio_call_tool(
    state: tauri::State<'_, McpStdioState>,
    server_id: String,
    call_id: String,
    name: String,
    arguments: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    validate_id("MCP server id", &server_id)?;
    validate_id("MCP call id", &call_id)?;
    if name.is_empty() || name.len() > MAX_TOOL_NAME_BYTES || name.chars().any(char::is_control) {
        return Err(format!(
            "MCP tool name must be 1-{MAX_TOOL_NAME_BYTES} bytes with no control characters"
        ));
    }
    if arguments
        .as_ref()
        .is_some_and(|arguments| !arguments.is_object())
    {
        return Err("MCP tool arguments must be a JSON object".to_string());
    }
    if serde_json::to_vec(&arguments)
        .map_err(|_| "failed to serialize MCP tool arguments".to_string())?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(format!(
            "MCP tool arguments exceed {MAX_REQUEST_BYTES} bytes"
        ));
    }

    let peer = connection_peer(&state, &server_id)?;
    let params = match arguments.and_then(|value| value.as_object().cloned()) {
        Some(arguments) => CallToolRequestParams::new(name).with_arguments(arguments),
        None => CallToolRequestParams::new(name),
    };
    let key = (server_id, call_id);
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        let mut calls = state
            .calls
            .lock()
            .map_err(|_| "MCP call lock poisoned".to_string())?;
        if calls.contains_key(&key) {
            return Err("MCP call id is already active".to_string());
        }
        calls.insert(key.clone(), cancel_tx);
    }

    let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
    let handle = match peer
        .send_cancellable_request(request, PeerRequestOptions::no_options())
        .await
    {
        Ok(handle) => handle,
        Err(_) => {
            if let Ok(mut calls) = state.calls.lock() {
                calls.remove(&key);
            }
            return Err("failed to send MCP tool call".to_string());
        }
    };

    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_CALL_TIMEOUT_MS)
        .clamp(MIN_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS);
    let mut handle = Some(handle);
    let response = tokio::select! {
        response = async {
            let request = handle.as_mut().expect("request handle is present");
            (&mut request.rx).await
        } => {
            match response {
                Ok(Ok(ServerResult::CallToolResult(result))) => {
                    serde_json::to_value(result)
                        .map_err(|_| "failed to serialize MCP tool result".to_string())
                }
                Ok(Ok(ServerResult::InputRequiredResult(_))) => {
                    Err("MCP tool requested additional input, which is not supported".to_string())
                }
                Ok(Ok(ServerResult::CreateTaskResult(_))) => {
                    Err("MCP asynchronous tasks are not supported".to_string())
                }
                Ok(Ok(_)) => Err("MCP server returned an unexpected tool response".to_string()),
                Ok(Err(_)) | Err(_) => Err("MCP tool call failed".to_string()),
            }
        }
        reason = &mut cancel_rx => {
            let reason = reason.unwrap_or_else(|_| "MCP tool call cancelled".to_string());
            if let Some(handle) = handle.take() {
                let _ = handle.cancel(Some(reason)).await;
            }
            Err("MCP tool call cancelled".to_string())
        }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            if let Some(handle) = handle.take() {
                let _ = handle.cancel(Some("MCP tool call timed out".to_string())).await;
            }
            Err("MCP tool call timed out".to_string())
        }
    };

    if let Ok(mut calls) = state.calls.lock() {
        calls.remove(&key);
    }
    let value = response?;
    ensure_json_budget(&value, "tool result")?;
    Ok(value)
}

#[tauri::command]
pub async fn mcp_stdio_cancel(
    state: tauri::State<'_, McpStdioState>,
    server_id: String,
    call_id: String,
) -> Result<(), String> {
    validate_id("MCP server id", &server_id)?;
    validate_id("MCP call id", &call_id)?;
    if let Some(cancel) = state
        .calls
        .lock()
        .map_err(|_| "MCP call lock poisoned".to_string())?
        .remove(&(server_id, call_id))
    {
        let _ = cancel.send("cancelled by user".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_stdio_disconnect(
    state: tauri::State<'_, McpStdioState>,
    server_id: String,
) -> Result<(), String> {
    validate_id("MCP server id", &server_id)?;
    cancel_server_calls(&state, &server_id, "MCP server disconnected");
    let connection = state
        .connections
        .lock()
        .map_err(|_| "MCP stdio connection lock poisoned".to_string())?
        .remove(&server_id);
    if let Some(connection) = connection {
        close_connection(connection).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_command_without_interpreting_shell_metacharacters() {
        let config = McpStdioConfig {
            id: "server-1".to_string(),
            command: "binary;not-a-shell".to_string(),
            args: vec!["$(still-an-argument)".to_string()],
            env: HashMap::new(),
            cwd: None,
        };
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn full_clear_invalidates_pending_stdio_connection_epochs() {
        let state = McpStdioState::default();
        let pending_epoch = state.connection_epoch.load(Ordering::Acquire);
        let (revoked_epoch, connections) = state.begin_revocation().unwrap();

        assert!(connections.is_empty());
        assert_eq!(revoked_epoch, pending_epoch + 1);
        assert_ne!(
            state.connection_epoch.load(Ordering::Acquire),
            pending_epoch
        );
    }

    #[test]
    fn rejects_invalid_environment_and_relative_cwd() {
        let mut env = HashMap::new();
        env.insert("BAD-NAME".to_string(), "value".to_string());
        let invalid_env = McpStdioConfig {
            id: "server-1".to_string(),
            command: "node".to_string(),
            args: Vec::new(),
            env,
            cwd: None,
        };
        assert!(validate_config(&invalid_env).is_err());

        let relative_cwd = McpStdioConfig {
            id: "server-1".to_string(),
            command: "node".to_string(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: Some("relative/path".to_string()),
        };
        assert!(validate_config(&relative_cwd).is_err());
    }

    #[test]
    fn rejects_oversized_arguments() {
        let config = McpStdioConfig {
            id: "server-1".to_string(),
            command: "node".to_string(),
            args: vec!["x".repeat(MAX_ARG_BYTES + 1)],
            env: HashMap::new(),
            cwd: None,
        };
        assert!(validate_config(&config).is_err());
    }

    #[tokio::test]
    async fn connects_calls_cancels_and_closes_echo_fixture() {
        if Command::new("node")
            .arg("--version")
            .output()
            .await
            .is_err()
        {
            return;
        }

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture = manifest_dir.join("tests/fixtures/echo-mcp.mjs");
        // Only configured variables and the allowlist may reach the server.
        std::env::set_var("OPEN_BUILDER_ENV_CANARY", "leaked-from-parent");
        let config = McpStdioConfig {
            id: "echo-fixture".to_string(),
            command: "node".to_string(),
            args: vec![fixture.to_string_lossy().into_owned()],
            env: HashMap::from([(
                "OPEN_BUILDER_ENV_CONFIGURED".to_string(),
                "configured".to_string(),
            )]),
            cwd: Some(manifest_dir.to_string_lossy().into_owned()),
        };

        let (mut connection, info) = create_connection(&config)
            .await
            .expect("echo fixture should connect");
        assert_eq!(
            info.instructions.as_deref(),
            Some("Echo fixture instructions")
        );
        assert_eq!(info.tools[0]["name"], "echo");

        let mut arguments = serde_json::Map::new();
        arguments.insert("message".to_string(), serde_json::json!("hello"));
        let result = connection
            .service
            .call_tool(CallToolRequestParams::new("echo").with_arguments(arguments))
            .await
            .expect("echo tool should return a result");
        let result = serde_json::to_value(result).expect("tool result serializes");
        assert_eq!(result["structuredContent"]["echoed"], "hello");
        assert_eq!(result["structuredContent"]["configured"], "configured");
        assert!(
            result["structuredContent"]["canary"].is_null(),
            "parent environment leaked into the MCP server"
        );

        let mut delayed_arguments = serde_json::Map::new();
        delayed_arguments.insert("message".to_string(), serde_json::json!("cancel me"));
        delayed_arguments.insert("delayMs".to_string(), serde_json::json!(5_000));
        let delayed = CallToolRequestParams::new("echo").with_arguments(delayed_arguments);
        let handle = connection
            .service
            .peer()
            .send_cancellable_request(
                ClientRequest::CallToolRequest(CallToolRequest::new(delayed)),
                PeerRequestOptions::no_options(),
            )
            .await
            .expect("delayed call should start");
        handle
            .cancel(Some("fixture cancellation".to_string()))
            .await
            .expect("cancellation notification should be sent");

        let tools = connection
            .service
            .list_all_tools()
            .await
            .expect("connection should remain usable after cancellation");
        assert_eq!(tools.len(), 1);

        let closed = connection
            .service
            .close_with_timeout(SHUTDOWN_TIMEOUT)
            .await
            .expect("fixture close should not fail");
        assert!(
            closed.is_some(),
            "fixture process should exit within the deadline"
        );
        connection.stderr_task.abort();
    }
}
