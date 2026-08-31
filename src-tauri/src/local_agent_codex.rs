use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::BufReader;
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentEvent, LocalAgentModel,
    LocalAgentStartRequest,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_protocol::{
    apply_minimal_environment, command_output_capped, finish_process, provider_error,
    read_capped_line, spawn_stderr_drain, spawn_wrapped, terminate, turn_prompt, write_json,
    ProtocolContext, ProtocolOutcome, ProtocolOutputBudget,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const CODEX_MCP_TOKEN_ENV: &str = "OPEN_BUILDER_MCP_TOKEN";

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "codex",
    setup_command: "codex login",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: true,
    },
    probe_timeout: PROBE_TIMEOUT,
    unix_home_directories: &[],
    windows_home_directories: &[".codex\\bin"],
    windows_local_directories: &["Programs\\Codex"],
    windows_program_directories: &["Codex"],
    require_empty_workspace: false,
};

fn first_output_line(output: &std::process::Output) -> Option<String> {
    let bytes = if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn process_args() -> Vec<String> {
    [
        "-c",
        "model_provider=\"openai\"",
        "-c",
        "mcp_servers={}",
        "-c",
        "notify=[]",
        "-c",
        "analytics.enabled=false",
        "-c",
        "otel.exporter=\"none\"",
        "-c",
        "otel.trace_exporter=\"none\"",
        "-c",
        "otel.metrics_exporter=\"none\"",
        "-c",
        "otel.log_user_prompt=false",
        "-c",
        "instructions=\"\"",
        "-c",
        "developer_instructions=\"\"",
        "-c",
        "include_permissions_instructions=false",
        "-c",
        "include_apps_instructions=false",
        "-c",
        "include_collaboration_mode_instructions=false",
        "-c",
        "include_environment_context=false",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.hooks=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.browser_use=false",
        "-c",
        "features.browser_use_external=false",
        "-c",
        "features.browser_use_full_cdp_access=false",
        "-c",
        "features.computer_use=false",
        "-c",
        "features.image_generation=false",
        "-c",
        "features.in_app_browser=false",
        "-c",
        "features.js_repl=false",
        "-c",
        "features.skill_search=false",
        "-c",
        "features.skill_mcp_dependency_install=false",
        "-c",
        "features.workspace_dependencies=false",
        "-c",
        "features.view_image=false",
        "-c",
        "agents.enabled=false",
        "-c",
        "project_doc_max_bytes=0",
        "app-server",
        "--strict-config",
        "--stdio",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

struct CodexIo {
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: u64,
    cancellation: CancellationToken,
    output_budget: ProtocolOutputBudget,
}

impl CodexIo {
    async fn read_value(&mut self) -> Result<Value, String> {
        let line = tokio::select! {
            _ = self.cancellation.cancelled() => return Err("local agent run cancelled".to_string()),
            line = read_capped_line(&mut self.reader) => line?,
        }
        .ok_or_else(|| "Codex App Server closed unexpectedly".to_string())?;
        self.output_budget.record(&line)?;
        serde_json::from_str(&line)
            .map_err(|_| "Codex App Server emitted malformed JSON".to_string())
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        write_json(
            &mut self.stdin,
            &json!({"jsonrpc":"2.0","method":method,"params":params}),
        )
        .await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        write_json(
            &mut self.stdin,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .await?;
        loop {
            let message = self.read_value().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    let summary = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex App Server request failed");
                    return Err(summary.to_string());
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                write_json(
                    &mut self.stdin,
                    &json!({
                        "jsonrpc":"2.0",
                        "id":request_id,
                        "error":{"code":-32601,"message":"Open Builder denies unexpected native requests"}
                    }),
                )
                .await?;
                return Err("Codex requested an unexpected native capability".to_string());
            }
        }
    }

    async fn request_without_waiting(&mut self, method: &str, params: Value) -> Result<(), String> {
        let id = self.next_id;
        self.next_id += 1;
        write_json(
            &mut self.stdin,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .await
    }
}

async fn initialize(io: &mut CodexIo) -> Result<(), String> {
    io.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "open-builder",
                "title": "Open Builder",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {"experimentalApi": false}
        }),
    )
    .await?;
    io.notify("initialized", json!({})).await
}

fn is_official_endpoint(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    host == "openai.com"
        || host.ends_with(".openai.com")
        || host == "chatgpt.com"
        || host.ends_with(".chatgpt.com")
}

async fn validate_effective_config(io: &mut CodexIo) -> Result<(), String> {
    let response = io
        .request("config/read", json!({"includeLayers": false}))
        .await?;
    let config = response
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| "Codex did not return a verifiable effective configuration".to_string())?;

    if config.get("model_provider").and_then(Value::as_str) != Some("openai") {
        return Err("Codex model provider isolation check failed".to_string());
    }
    for key in ["openai_base_url", "chatgpt_base_url"] {
        if let Some(value) = config
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            if !is_official_endpoint(value) {
                return Err(format!("Codex {key} is not an official provider endpoint"));
            }
        }
    }
    if config
        .get("model_instructions_file")
        .and_then(Value::as_str)
        .is_some_and(|path| !path.is_empty())
    {
        return Err("Codex loaded an external model instructions file".to_string());
    }

    let features = config
        .get("features")
        .and_then(Value::as_object)
        .ok_or_else(|| "Codex did not report its effective feature configuration".to_string())?;
    for feature in [
        "shell_tool",
        "unified_exec",
        "hooks",
        "multi_agent",
        "multi_agent_v2",
        "apps",
        "plugins",
        "browser_use",
        "browser_use_external",
        "browser_use_full_cdp_access",
        "computer_use",
        "image_generation",
        "in_app_browser",
        "skill_search",
        "skill_mcp_dependency_install",
        "workspace_dependencies",
        "view_image",
    ] {
        if features.get(feature).and_then(Value::as_bool) != Some(false) {
            return Err(format!("Codex feature {feature} is not disabled"));
        }
    }
    if config
        .get("agents")
        .and_then(Value::as_object)
        .and_then(|agents| agents.get("enabled"))
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Err("Codex native agents are not disabled".to_string());
    }
    if config
        .get("mcp_servers")
        .and_then(Value::as_object)
        .is_none_or(|servers| !servers.is_empty())
    {
        return Err("Codex loaded external MCP configuration".to_string());
    }
    Ok(())
}

async fn probe_app_server(executable: &Path) -> Result<(bool, Vec<LocalAgentModel>), String> {
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    command.args(process_args());
    let process = spawn_wrapped(command)?;
    let (saw_stderr, stderr_task) = spawn_stderr_drain(process.stderr);
    let child = process.child.clone();
    let mut tree_guard = process.tree_guard;
    let mut io = CodexIo {
        stdin: process.stdin,
        reader: BufReader::new(process.stdout),
        next_id: 1,
        cancellation: CancellationToken::new(),
        output_budget: ProtocolOutputBudget::default(),
    };
    let result = async {
        initialize(&mut io).await?;
        validate_effective_config(&mut io).await?;
        let account = io
            .request("account/read", json!({"refreshToken": false}))
            .await?;
        let models = io
            .request("model/list", json!({"limit": 100, "includeHidden": false}))
            .await?;
        let signed_in = account.get("account").is_some_and(|value| !value.is_null())
            || !account
                .get("requiresOpenaiAuth")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        let models = models
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                if model
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return None;
                }
                Some(LocalAgentModel {
                    id: model
                        .get("id")
                        .or_else(|| model.get("model"))?
                        .as_str()?
                        .to_string(),
                    display_name: model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    is_default: model
                        .get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    default_effort: model
                        .get("defaultReasoningEffort")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    efforts: model
                        .get("supportedReasoningEfforts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|entry| {
                            entry
                                .get("reasoningEffort")
                                .or_else(|| entry.get("effort"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect(),
                })
            })
            .collect();
        Ok((signed_in, models))
    }
    .await;
    if terminate(&child).await {
        tree_guard.cleanup();
    }
    stderr_task.abort();
    result.map_err(|error: String| provider_error(&error, saw_stderr.load(Ordering::Relaxed)))
}

fn thread_config(context: &ProtocolContext) -> Value {
    json!({
        "mcp_servers": {
            "open_builder": {
                "url": context.bridge_url,
                "bearer_token_env_var": CODEX_MCP_TOKEN_ENV,
                "required": true
            }
        },
        "notify": [],
        "instructions": "",
        "developer_instructions": "",
        "include_permissions_instructions": false,
        "include_apps_instructions": false,
        "include_collaboration_mode_instructions": false,
        "include_skill_instructions": false,
        "include_environment_context": false,
        "features": {
            "shell_tool": false,
            "unified_exec": false,
            "hooks": false,
            "multi_agent": false,
            "multi_agent_v2": false,
            "apps": false,
            "plugins": false,
            "browser_use": false,
            "browser_use_external": false,
            "browser_use_full_cdp_access": false,
            "computer_use": false,
            "image_generation": false,
            "in_app_browser": false,
            "js_repl": false,
            "skill_search": false,
            "skill_mcp_dependency_install": false,
            "workspace_dependencies": false,
            "view_image": false
        },
        "agents": {"enabled": false},
        "tools": {"view_image": false},
        "project_doc_max_bytes": 0,
        "web_search": if context.request.native_search { "live" } else { "disabled" }
    })
}

pub(crate) async fn probe(executable: &Path) -> AdapterProbe {
    let version_output = match command_output_capped(
        executable,
        &["--version"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) if output.status.success() => output,
        Ok(_) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Unsupported,
                version: None,
                models: Vec::new(),
                efforts: Vec::new(),
                message: Some(
                    "The selected Codex executable did not report a supported version.".to_string(),
                ),
            }
        }
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version: None,
                models: Vec::new(),
                efforts: Vec::new(),
                message: Some(message),
            }
        }
    };
    let version = first_output_line(&version_output);
    let help = match command_output_capped(
        executable,
        &["app-server", "--help"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) => {
            String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr)
        }
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Unsupported,
                version,
                models: Vec::new(),
                efforts: Vec::new(),
                message: Some(message),
            }
        }
    };
    if ["--stdio", "--strict-config"]
        .iter()
        .any(|flag| !help.contains(flag))
    {
        return AdapterProbe {
            availability: LocalAgentAvailability::Unsupported,
            version,
            models: Vec::new(),
            efforts: Vec::new(),
            message: Some("Codex is missing required structured-agent capabilities.".to_string()),
        };
    }
    match tokio::time::timeout(PROBE_TIMEOUT, probe_app_server(executable)).await {
        Ok(Ok((ready, models))) => AdapterProbe {
            availability: if ready {
                LocalAgentAvailability::Ready
            } else {
                LocalAgentAvailability::NeedsSetup
            },
            version,
            models,
            efforts: Vec::new(),
            message: (!ready).then(|| "Codex is not signed in; run codex login.".to_string()),
        },
        Ok(Err(_)) | Err(_) => AdapterProbe {
            availability: LocalAgentAvailability::Error,
            version,
            models: Vec::new(),
            efforts: Vec::new(),
            message: Some(
                "Codex account/model probe failed. Re-run login or upgrade the CLI.".to_string(),
            ),
        },
    }
}

pub(crate) fn validate_request(_request: &LocalAgentStartRequest) -> Result<(), String> {
    Ok(())
}

pub(crate) fn prepare_request(
    _request: &mut LocalAgentStartRequest,
    _models: &[LocalAgentModel],
) -> Result<(), String> {
    Ok(())
}

pub(crate) async fn run(context: ProtocolContext) -> Result<ProtocolOutcome, String> {
    let mut command = Command::new(&context.executable);
    apply_minimal_environment(&mut command);
    command
        .args(process_args())
        .current_dir(&context.run_dir)
        .env(CODEX_MCP_TOKEN_ENV, &context.bridge_token);
    let process = spawn_wrapped(command)?;
    let child = process.child.clone();
    let (saw_stderr, stderr_task) = spawn_stderr_drain(process.stderr);
    let tree_guard = process.tree_guard;
    let mut io = CodexIo {
        stdin: process.stdin,
        reader: BufReader::new(process.stdout),
        next_id: 1,
        cancellation: context.cancellation.clone(),
        output_budget: ProtocolOutputBudget::default(),
    };

    let run_result = async {
        let (thread_id, turn_id) = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            initialize(&mut io).await?;
            validate_effective_config(&mut io).await?;
            let common = json!({
                "approvalPolicy": "never",
                "cwd": context.run_dir,
                "developerInstructions": context.request.system_prompt,
                "model": context.request.model,
                "sandbox": "read-only",
                "runtimeWorkspaceRoots": [],
                "config": thread_config(&context)
            });
            let thread_response = if let Some(session_id) = context.request.session_id.as_deref() {
                let mut params = common.as_object().cloned().unwrap_or_default();
                params.insert("threadId".to_string(), json!(session_id));
                io.request("thread/resume", Value::Object(params)).await?
            } else {
                io.request("thread/start", common).await?
            };
            let thread_id = thread_response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Codex App Server did not return a thread id".to_string())?
                .to_string();
            let instruction_sources = thread_response
                .get("instructionSources")
                .or_else(|| thread_response.pointer("/thread/instructionSources"));
            if instruction_sources
                .and_then(Value::as_array)
                .is_some_and(|sources| !sources.is_empty())
            {
                return Err(
                    "Codex loaded external instruction files despite isolation".to_string(),
                );
            }
            let mcp_status = io
                .request(
                    "mcpServerStatus/list",
                    json!({"threadId": thread_id, "limit": 100}),
                )
                .await?;
            let entries = mcp_status
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "Codex did not return a verifiable MCP server inventory".to_string()
                })?;
            let names = entries
                .iter()
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>();
            if names.len() != 1
                || !matches!(names.first().copied(), Some("open_builder" | "open-builder"))
            {
                return Err("Codex MCP isolation check failed".to_string());
            }
            if entries
                .iter()
                .any(|entry| entry.get("status").and_then(Value::as_str) == Some("failed"))
            {
                return Err("Open Builder MCP bridge failed to start in Codex".to_string());
            }
            context
                .channel
                .send(LocalAgentEvent::Session {
                    session_id: thread_id.clone(),
                    cli_version: context.cli_version.clone(),
                })
                .map_err(|_| "local agent event consumer is unavailable".to_string())?;
            let turn_response = io
                .request(
                    "turn/start",
                    json!({
                        "threadId": thread_id,
                        "input": [{"type":"text","text":turn_prompt(&context.request)}],
                        "model": context.request.model,
                        "effort": context.request.effort,
                        "approvalPolicy": "never",
                        "sandboxPolicy": {"type":"readOnly","networkAccess":false},
                        "runtimeWorkspaceRoots": [],
                        "environments": []
                    }),
                )
                .await?;
            let turn_id = turn_response
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Codex App Server did not return a turn id".to_string())?
                .to_string();
            context
                .channel
                .send(LocalAgentEvent::Status {
                    state: "streaming".to_string(),
                    message: None,
                })
                .map_err(|_| "local agent event consumer is unavailable".to_string())?;
            Ok::<_, String>((thread_id, turn_id))
        })
        .await
        .map_err(|_| "Codex App Server handshake timed out".to_string())??;

        loop {
            let message = match io.read_value().await {
                Ok(message) => message,
                Err(_error) if context.cancellation.is_cancelled() => {
                    let _ = io
                        .request_without_waiting(
                            "turn/interrupt",
                            json!({"threadId":thread_id,"turnId":turn_id}),
                        )
                        .await;
                    return Ok(ProtocolOutcome {
                        session_id: Some(thread_id),
                        aborted: true,
                    });
                }
                Err(error) => return Err(error),
            };
            if message.get("id").is_some() && message.get("method").is_some() {
                let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                write_json(
                    &mut io.stdin,
                    &json!({
                        "jsonrpc":"2.0",
                        "id":request_id,
                        "error":{"code":-32601,"message":"Open Builder denies unexpected native requests"}
                    }),
                )
                .await?;
                return Err("Codex requested an unexpected native capability".to_string());
            }
            let Some(method) = message.get("method").and_then(Value::as_str) else {
                continue;
            };
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            match method {
                "item/agentMessage/delta" => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        context
                            .channel
                            .send(LocalAgentEvent::TextDelta {
                                delta: delta.to_string(),
                            })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        context
                            .channel
                            .send(LocalAgentEvent::ReasoningDelta {
                                delta: delta.to_string(),
                            })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                "item/started" | "item/completed" => {
                    if let Some(item) = params.get("item") {
                        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                        match item_type {
                            "webSearch" if context.request.native_search => {
                                context
                                    .channel
                                    .send(LocalAgentEvent::NativeTool {
                                        call_id: item
                                            .get("id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("codex-web-search")
                                            .to_string(),
                                        name: "web_search".to_string(),
                                        phase: if method == "item/started" {
                                            "started".to_string()
                                        } else {
                                            "completed".to_string()
                                        },
                                        arguments: item
                                            .get("query")
                                            .cloned()
                                            .map(|query| json!({"query":query})),
                                        result: if method == "item/completed" {
                                            item.get("results").cloned()
                                        } else {
                                            None
                                        },
                                    })
                                    .map_err(|_| {
                                        "local agent event consumer is unavailable".to_string()
                                    })?;
                            }
                            "webSearch" => {
                                return Err(
                                    "Codex attempted to use disabled native web search"
                                        .to_string(),
                                );
                            }
                            "mcpToolCall" => {
                                let server =
                                    item.get("server").and_then(Value::as_str).unwrap_or("");
                                if server != "open_builder" && server != "open-builder" {
                                    return Err(
                                        "Codex attempted to use an external MCP server".to_string(),
                                    );
                                }
                            }
                            "commandExecution"
                            | "fileChange"
                            | "dynamicToolCall"
                            | "collabAgentToolCall"
                            | "hookPrompt"
                            | "imageView"
                            | "imageGeneration"
                            | "sleep"
                            | "subAgentActivity"
                            | "enteredReviewMode"
                            | "exitedReviewMode" => {
                                return Err(format!(
                                    "Codex attempted to use disabled native capability {item_type}"
                                ));
                            }
                            "userMessage"
                            | "agentMessage"
                            | "plan"
                            | "reasoning"
                            | "contextCompaction" => {}
                            "" => {
                                return Err("Codex emitted a malformed thread item".to_string());
                            }
                            _ => {
                                return Err(format!(
                                    "Codex emitted an unsupported thread item {item_type}"
                                ));
                            }
                        }
                    }
                }
                "thread/tokenUsage/updated" => {
                    let usage = params.pointer("/tokenUsage/last").unwrap_or(&Value::Null);
                    context
                        .channel
                        .send(LocalAgentEvent::Usage {
                            input_tokens: usage.get("inputTokens").and_then(Value::as_u64),
                            output_tokens: usage.get("outputTokens").and_then(Value::as_u64),
                            cached_input_tokens: usage
                                .get("cachedInputTokens")
                                .and_then(Value::as_u64),
                        })
                        .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                }
                "error" => {
                    let will_retry = params
                        .get("willRetry")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let message = params
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string();
                    if will_retry {
                        context
                            .channel
                            .send(LocalAgentEvent::Warning { message })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    } else {
                        return Err(message);
                    }
                }
                "mcpServer/startupStatus/updated" => {
                    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                    if name != "open_builder" && name != "open-builder" {
                        return Err("Codex started an external MCP server".to_string());
                    }
                    if params.get("status").and_then(Value::as_str) == Some("failed") {
                        return Err("Open Builder MCP bridge failed to start in Codex".to_string());
                    }
                }
                "turn/completed" => {
                    let status = params
                        .pointer("/turn/status")
                        .and_then(Value::as_str)
                        .unwrap_or("failed");
                    if status == "completed" {
                        return Ok(ProtocolOutcome {
                            session_id: Some(thread_id),
                            aborted: false,
                        });
                    }
                    if status == "interrupted" {
                        return Ok(ProtocolOutcome {
                            session_id: Some(thread_id),
                            aborted: true,
                        });
                    }
                    return Err(params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string());
                }
                _ => {}
            }
        }
    }
    .await;

    drop(io.stdin);
    let process_result = finish_process(child, stderr_task, tree_guard).await;
    let outcome =
        run_result.map_err(|error| provider_error(&error, saw_stderr.load(Ordering::Relaxed)))?;
    let status = process_result
        .map_err(|error| provider_error(&error, saw_stderr.load(Ordering::Relaxed)))?;
    if !outcome.aborted && status.is_some_and(|status| !status.success()) {
        return Err(provider_error(
            "Codex App Server exited unsuccessfully",
            saw_stderr.load(Ordering::Relaxed),
        ));
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_disable_native_execution() {
        let args = process_args();
        assert!(args.contains(&"model_provider=\"openai\"".to_string()));
        assert!(args.contains(&"features.shell_tool=false".to_string()));
        assert!(args.contains(&"features.hooks=false".to_string()));
        assert!(!args.contains(&"include_skill_instructions=false".to_string()));
        assert!(!args.contains(&"tools.view_image=false".to_string()));
        assert!(args.ends_with(&[
            "app-server".to_string(),
            "--strict-config".to_string(),
            "--stdio".to_string()
        ]));
    }

    #[test]
    fn endpoint_attestation_accepts_only_official_https_hosts() {
        assert!(is_official_endpoint("https://api.openai.com/v1"));
        assert!(is_official_endpoint(
            "https://chatgpt.com/backend-api/codex"
        ));
        assert!(!is_official_endpoint("http://api.openai.com/v1"));
        assert!(!is_official_endpoint(
            "https://openai.com.attacker.example/v1"
        ));
        assert!(!is_official_endpoint("https://user@api.openai.com/v1"));
    }
}
