//! The main-task app-server transport. The image worker deliberately keeps its
//! own protocol and permissions; only validated Host MCP tools are allowed here.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Transport {
    AppServer,
    Exec,
}

impl Transport {
    pub(crate) fn protocol_version(self) -> &'static str {
        match self {
            Self::AppServer => "codex-app-server-v1-summary-auto",
            Self::Exec => "codex-exec-json-v3-summary-auto",
        }
    }
}

struct SchemaDirectory(PathBuf);
impl Drop for SchemaDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn schema_method(schema: &Value, name: &str) -> bool {
    schema
        .get("oneOf")
        .and_then(Value::as_array)
        .is_some_and(|variants| {
            variants.iter().any(|v| {
                v.pointer("/properties/method/enum")
                    .and_then(Value::as_array)
                    .is_some_and(|names| names.iter().any(|value| value.as_str() == Some(name)))
                    || v.pointer("/properties/method/const")
                        .and_then(Value::as_str)
                        == Some(name)
            })
        })
}
fn schema_fields(schema: &Value, name: &str, fields: &[&str]) -> bool {
    schema
        .get("definitions")
        .and_then(|v| v.get(name))
        .and_then(|v| v.get("properties"))
        .and_then(Value::as_object)
        .is_some_and(|properties| fields.iter().all(|field| properties.contains_key(*field)))
}
fn supported_schemas(requests: &Value, notifications: &Value) -> bool {
    [
        "initialize",
        "config/read",
        "thread/start",
        "thread/resume",
        "turn/start",
    ]
    .iter()
    .all(|name| schema_method(requests, name))
        && [
            "thread/started",
            "turn/started",
            "turn/completed",
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
        ]
        .iter()
        .all(|name| schema_method(notifications, name))
        && schema_fields(
            requests,
            "ThreadStartParams",
            &[
                "model",
                "approvalPolicy",
                "sandbox",
                "baseInstructions",
                "developerInstructions",
                "config",
                "dynamicTools",
                "experimentalRawEvents",
            ],
        )
        && schema_fields(
            requests,
            "ThreadResumeParams",
            &[
                "threadId",
                "model",
                "approvalPolicy",
                "sandbox",
                "baseInstructions",
                "developerInstructions",
                "config",
            ],
        )
        && schema_fields(
            requests,
            "TurnStartParams",
            &[
                "threadId",
                "input",
                "model",
                "effort",
                "summary",
                "sandboxPolicy",
            ],
        )
        && schema_fields(
            notifications,
            "AgentMessageDeltaNotification",
            &["threadId", "turnId", "itemId", "delta"],
        )
        && schema_fields(
            notifications,
            "ReasoningSummaryTextDeltaNotification",
            &["threadId", "turnId", "itemId", "summaryIndex", "delta"],
        )
}

pub(crate) async fn select_transport(executable: &Path) -> Result<Transport, AdapterError> {
    let output = run_capability_command(executable, &["app-server", "--help"]).await?;
    let help = output_text(&output);
    if !output.status.success() {
        if [
            "unrecognized subcommand 'app-server'",
            "unknown subcommand 'app-server'",
        ]
        .iter()
        .any(|s| help.contains(s))
        {
            return Ok(Transport::Exec);
        }
        return Err("Codex app-server capability probe failed".into());
    }
    if !required_flags_present(&help, &["--stdio", "--strict-config"])
        || !help.contains("generate-json-schema")
    {
        return Ok(Transport::Exec);
    }
    let directory = SchemaDirectory(std::env::temp_dir().join(format!(
        "open-builder-codex-schema-{}",
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir(&directory.0)
        .map_err(|_| "failed to create Codex schema probe directory")?;
    let output = run_capability_command(
        executable,
        &[
            "app-server",
            "generate-json-schema",
            "--experimental",
            "--out",
            directory
                .0
                .to_str()
                .ok_or("Codex schema probe path is not UTF-8")?,
        ],
    )
    .await?;
    if !output.status.success() {
        return Err("Codex app-server schema probe failed".into());
    }
    let read = |name: &str| -> Result<Option<Value>, AdapterError> {
        match std::fs::read_to_string(directory.0.join(name)) {
            Ok(text) => Ok(Some(serde_json::from_str(&text).map_err(|_| {
                protocol_error("Codex app-server generated malformed protocol schema")
            })?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("failed to read Codex app-server protocol schema".into()),
        }
    };
    let (Some(requests), Some(notifications)) = (
        read("ClientRequest.json")?,
        read("ServerNotification.json")?,
    ) else {
        return Ok(Transport::Exec);
    };
    Ok(if supported_schemas(&requests, &notifications) {
        Transport::AppServer
    } else {
        Transport::Exec
    })
}

pub(super) fn args(
    context: &ProtocolContext,
    config: &CodexProviderConfig,
    prompt_path: &Path,
) -> Vec<String> {
    let mut args = vec![
        "app-server".to_string(),
        "--stdio".to_string(),
        "--strict-config".to_string(),
    ];
    for (key, value) in &config.overrides {
        push_config(&mut args, key, value.clone());
    }
    if !config
        .overrides
        .iter()
        .any(|(key, _)| key == "model_provider")
    {
        push_config(&mut args, "model_provider", toml_string("openai"));
    }
    if let Some(model) = &context.request.model {
        push_config(&mut args, "model", toml_string(model));
    }
    if let Some(effort) = &context.request.effort {
        push_config(&mut args, "model_reasoning_effort", toml_string(effort));
    }
    push_isolation_config(
        &mut args,
        prompt_path,
        &context.bridge_url,
        &context.request.tools,
        context.request.native_search,
        &config.excluded_environment_names(),
    );
    // exec tolerates this historical key, but app-server's strict parser does
    // not expose it. Explicit base instructions and disabled skill/tool features
    // remain authoritative for the main thread.
    if let Some(index) = args
        .iter()
        .position(|arg| arg == "include_skill_instructions=false")
    {
        args.drain(index - 1..=index);
    }
    push_config(&mut args, "sandbox_mode", toml_string("read-only"));
    push_config(&mut args, "model_reasoning_summary", toml_string("auto"));
    push_config(&mut args, "hide_agent_reasoning", "false".to_string());
    push_config(&mut args, "show_raw_agent_reasoning", "false".to_string());
    push_config(&mut args, "notify", "[]".to_string());
    args
}

fn protocol_error(message: &str) -> AdapterError {
    AdapterError::coded(LocalCliFailureCode::ProtocolViolation, message)
}

fn disabled_feature(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool) == Some(false)
        || value
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            == Some(false)
}

fn isolation_check(config: &Value, context: &ProtocolContext) -> Result<(), AdapterError> {
    let invalid = || {
        AdapterError::coded(
            LocalCliFailureCode::IsolationViolation,
            "Codex app-server effective isolation configuration did not match the prepared run",
        )
    };
    if config.get("approval_policy").and_then(Value::as_str) != Some("never")
        || config.get("sandbox_mode").and_then(Value::as_str) != Some("read-only")
        || config.get("developer_instructions").and_then(Value::as_str) != Some("")
        || config.get("instructions").and_then(Value::as_str) != Some("")
        || config.get("project_doc_max_bytes").and_then(Value::as_u64) != Some(0)
        || config
            .get("notify")
            .and_then(Value::as_array)
            .is_none_or(|v| !v.is_empty())
    {
        return Err(invalid());
    }
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
        "js_repl",
        "skill_search",
        "skill_mcp_dependency_install",
        "workspace_dependencies",
        "view_image",
    ] {
        if !disabled_feature(config.get("features").and_then(|v| v.get(feature))) {
            return Err(invalid());
        }
    }
    let servers = config
        .get("mcp_servers")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let server = servers.get("open_builder").ok_or_else(invalid)?;
    let expected_tools = sorted_tool_names(&context.request.tools);
    let actual_tools = server
        .get("enabled_tools")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if servers.iter().any(|(name, value)| {
        name != "open_builder" && value.get("enabled").and_then(Value::as_bool) != Some(false)
    }) || server.get("url").and_then(Value::as_str) != Some(context.bridge_url.as_str())
        || server.get("bearer_token_env_var").and_then(Value::as_str) != Some(CODEX_MCP_TOKEN_ENV)
        || server
            .get("default_tools_approval_mode")
            .and_then(Value::as_str)
            != Some("approve")
        || server.get("required").and_then(Value::as_bool) != Some(true)
        || server.get("enabled").and_then(Value::as_bool) == Some(false)
        || server.get("command").is_some_and(|v| !v.is_null())
        || actual_tools != &expected_tools.iter().map(|s| json!(s)).collect::<Vec<_>>()
    {
        return Err(invalid());
    }
    Ok(())
}

// Reading effective configuration does not start a thread or connect MCP servers.
// Codex recursively merges config tables, so replacing mcp_servers does not
// remove user entries. Freeze explicit disables for every inherited entry.
pub(super) async fn isolated_spec(
    context: &ProtocolContext,
    provider: &CodexProviderConfig,
    prompt_path: &Path,
) -> Result<FrozenProcessSpec, AdapterError> {
    let mut arguments = args(context, provider, prompt_path);
    let process = RunSupervisor::spawn(
        frozen_process_spec(context, provider, &arguments)?,
        CancellationToken::new(),
    )?;
    let supervisor = process.supervisor;
    let mut io = MainIo {
        stdin: process.stdin,
        stdout: BufReader::new(process.stdout),
        cancellation: context.cancellation.clone(),
    };
    let inspected = supervisor.monitor(async {
        let mut state = StreamState::default();
        io.request(1, "initialize", json!({"clientInfo":{"name":"open-builder-preflight","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}), &mut state, context).await?;
        io.send(&json!({"method":"initialized"})).await?;
        let result = io.request(2, "config/read", json!({"includeLayers":false}), &mut state, context).await?;
        let mut config = result.get("config").cloned().ok_or_else(|| protocol_error("Codex app-server configuration probe omitted its configuration"))?;
        let servers = config.get_mut("mcp_servers").and_then(Value::as_object_mut).ok_or_else(|| protocol_error("Codex app-server configuration probe omitted its MCP servers"))?;
        let mut disabled = Vec::new();
        for (name, server) in servers {
            if name == "open_builder" { continue; }
            let object = server.as_object_mut().ok_or_else(|| protocol_error("Codex app-server configuration returned an invalid MCP server"))?;
            object.insert("enabled".to_string(), json!(false));
            disabled.push(name.clone());
        }
        isolation_check(&config, context)?;
        Ok::<_,AdapterError>(disabled)
    }).await;
    let disabled =
        stop_app_server(supervisor, inspected, "Codex app-server preflight failed").await?;
    if !disabled.is_empty() {
        let entries = disabled
            .iter()
            .map(|name| format!("{}={{enabled=false}}", toml_string(name)))
            .collect::<Vec<_>>()
            .join(",");
        // The CLI splits -c paths on dots without TOML key unquoting. Supply
        // names in a TOML table so dots/quotes/hyphens remain literal server keys.
        let private = open_builder_mcp_config(
            &context.bridge_url,
            &sorted_tool_names(&context.request.tools),
        );
        let private_entries = private
            .strip_prefix('{')
            .and_then(|s| s.strip_suffix('}'))
            .expect("private MCP config is a table");
        push_config(
            &mut arguments,
            "mcp_servers",
            format!("{{{private_entries},{entries}}}"),
        );
    }
    frozen_process_spec(context, provider, &arguments).map_err(Into::into)
}

#[derive(Default)]
struct StreamState {
    thread: Option<String>,
    turn: Option<String>,
    items: HashMap<String, String>,
    text: HashMap<String, String>,
    completed: BTreeSet<String>,
    item_order: HashMap<String, usize>,
    last_text_order: Option<(usize, u64)>,
    last_reasoning_order: Option<(usize, u64)>,
    terminal: Option<bool>,
    expected_tools: BTreeSet<String>,
    #[cfg(test)]
    historical_usage_snapshots: usize,
}

impl StreamState {
    fn bind_thread(&mut self, id: &str) -> Result<(), AdapterError> {
        if !valid_session_id(id) || self.thread.as_deref().is_some_and(|old| old != id) {
            return Err(protocol_error("Codex app-server changed thread identity"));
        }
        self.thread = Some(id.to_string());
        Ok(())
    }
    fn bind_turn(&mut self, id: &str) -> Result<(), AdapterError> {
        if !valid_session_id(id) || self.turn.as_deref().is_some_and(|old| old != id) {
            return Err(protocol_error("Codex app-server changed turn identity"));
        }
        self.turn = Some(id.to_string());
        Ok(())
    }
    fn scope(&self, params: &Value, method: &str) -> Result<(), AdapterError> {
        if params.get("threadId").and_then(Value::as_str) != self.thread.as_deref()
            || params.get("turnId").and_then(Value::as_str) != self.turn.as_deref()
            || self.thread.is_none()
            || self.turn.is_none()
        {
            return Err(protocol_error(&format!(
                "Codex app-server notification has an unexpected thread or turn: {method} (active_turn={})", self.turn.is_some()
            )));
        }
        Ok(())
    }
    fn send(&self, context: &ProtocolContext, event: LocalAgentEvent) -> Result<(), AdapterError> {
        if context.cancellation.is_cancelled() {
            return Ok(());
        }
        context
            .channel
            .send(event)
            .map_err(|_| "local agent event consumer is unavailable".into())
    }
    fn append(
        &mut self,
        context: &ProtocolContext,
        key: String,
        delta: &str,
        reasoning: bool,
    ) -> Result<(), AdapterError> {
        if delta.is_empty() {
            return Ok(());
        }
        let (id, index) = if reasoning {
            let (id, index) = key
                .rsplit_once(":summary:")
                .ok_or_else(|| protocol_error("invalid summary identity"))?;
            (
                id,
                index
                    .parse::<u64>()
                    .map_err(|_| protocol_error("invalid summary section"))?,
            )
        } else {
            (
                key.strip_suffix(":text")
                    .ok_or_else(|| protocol_error("invalid text identity"))?,
                0,
            )
        };
        let order = (
            *self
                .item_order
                .get(id)
                .ok_or_else(|| protocol_error("text item has no sequence"))?,
            index,
        );
        let last = if reasoning {
            &mut self.last_reasoning_order
        } else {
            &mut self.last_text_order
        };
        if last.is_some_and(|previous| previous > order) {
            return Err(protocol_error(
                "Codex app-server appended content to an earlier output block",
            ));
        }
        *last = Some(order);
        self.text.entry(key).or_default().push_str(delta);
        self.send(
            context,
            if reasoning {
                LocalAgentEvent::ReasoningDelta {
                    delta: delta.to_string(),
                }
            } else {
                LocalAgentEvent::TextDelta {
                    delta: delta.to_string(),
                }
            },
        )
    }
    fn snapshot(
        &mut self,
        context: &ProtocolContext,
        key: String,
        value: &str,
        reasoning: bool,
    ) -> Result<(), AdapterError> {
        let previous = self.text.get(&key).map(String::as_str).unwrap_or("");
        if !value.starts_with(previous) {
            return Err(protocol_error(
                "Codex app-server completed text conflicts with streamed content",
            ));
        }
        let delta = value[previous.len()..].to_string();
        self.append(context, key, &delta, reasoning)
    }
    fn notification(
        &mut self,
        value: &Value,
        context: &ProtocolContext,
    ) -> Result<(), AdapterError> {
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("Codex app-server notification omitted its method"))?;
        let params = value.get("params").unwrap_or(&Value::Null);
        match method {
            "thread/started" => {
                let id = params
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("Codex app-server thread omitted its id"))?;
                self.bind_thread(id)?;
            }
            "turn/started" => {
                if params.get("threadId").and_then(Value::as_str) != self.thread.as_deref()
                    || self.thread.is_none()
                {
                    return Err(protocol_error(
                        "Codex app-server started a turn on an unexpected thread",
                    ));
                }
                let id = params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("Codex app-server turn omitted its id"))?;
                self.bind_turn(id)?;
            }
            "item/started" | "item/completed" => {
                self.scope(params, method)?;
                let item = params.get("item").ok_or_else(|| {
                    protocol_error("Codex app-server item event omitted its item")
                })?;
                validate_item_kind(item, context.request.native_search, &self.expected_tools)?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| protocol_error("Codex app-server item omitted its id"))?;
                let kind = item_kind(item);
                if self.items.get(id).is_some_and(|old| old != kind) {
                    return Err(protocol_error("Codex app-server changed item kind"));
                }
                let next_order = self.item_order.len();
                self.item_order.entry(id.to_string()).or_insert(next_order);
                self.items.insert(id.to_string(), kind.to_string());
                if self.completed.contains(id) {
                    return Err(protocol_error("Codex app-server repeated a completed item"));
                }
                if method == "item/completed" {
                    if matches!(kind, "agentMessage" | "agent_message" | "assistant_message") {
                        let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
                            protocol_error("Codex app-server completed message omitted text")
                        })?;
                        self.snapshot(context, format!("{id}:text"), text, false)?;
                    } else if kind == "reasoning" {
                        let prefix = format!("{id}:summary:");
                        if item.get("summary").and_then(Value::as_array).is_none()
                            && self.text.keys().any(|key| key.starts_with(&prefix))
                        {
                            return Err(protocol_error(
                                "Codex app-server completed reasoning omitted its streamed summary",
                            ));
                        }
                        if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                            for (index, entry) in summary.iter().enumerate() {
                                let text = entry
                                    .as_str()
                                    .or_else(|| entry.get("text").and_then(Value::as_str))
                                    .ok_or_else(|| {
                                        protocol_error(
                                            "Codex app-server returned an invalid summary",
                                        )
                                    })?;
                                self.snapshot(
                                    context,
                                    format!("{id}:summary:{index}"),
                                    text,
                                    true,
                                )?;
                            }
                            let prefix = format!("{id}:summary:");
                            if self.text.keys().any(|key| {
                                key.strip_prefix(&prefix)
                                    .and_then(|i| i.parse::<usize>().ok())
                                    .is_some_and(|i| i >= summary.len())
                            }) {
                                return Err(protocol_error(
                                    "Codex app-server completed summary omitted streamed sections",
                                ));
                            }
                        }
                    }
                    self.completed.insert(id.to_string());
                }
                if !matches!(
                    kind,
                    "agentMessage" | "agent_message" | "assistant_message" | "reasoning"
                ) {
                    for event in item_events(
                        method,
                        item,
                        context.request.native_search,
                        &self.expected_tools,
                        &mut HashMap::new(),
                    )? {
                        self.send(context, event)?;
                    }
                }
            }
            "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/summaryPartAdded" => {
                self.scope(params, method)?;
                let id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        protocol_error("Codex app-server delta omitted item identity")
                    })?;
                if self.completed.contains(id) {
                    return Err(protocol_error(
                        "Codex app-server emitted text after item completion",
                    ));
                }
                let reasoning = method != "item/agentMessage/delta";
                let kind = self.items.get(id).map(String::as_str).ok_or_else(|| {
                    protocol_error("Codex app-server delta arrived before item start")
                })?;
                if reasoning && kind != "reasoning"
                    || !reasoning && !matches!(kind, "agentMessage" | "agent_message")
                {
                    return Err(protocol_error(
                        "Codex app-server delta does not match item kind",
                    ));
                }
                let key = if reasoning {
                    let index = params
                        .get("summaryIndex")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            protocol_error("Codex app-server summary omitted section index")
                        })?;
                    format!("{id}:summary:{index}")
                } else {
                    format!("{id}:text")
                };
                if method.ends_with("summaryPartAdded") {
                    return Ok(());
                }
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("Codex app-server delta omitted text"))?;
                self.append(context, key, delta, reasoning)?;
            }
            "turn/completed" => {
                if params.get("threadId").and_then(Value::as_str) != self.thread.as_deref()
                    || self.turn.is_none()
                    || params.pointer("/turn/id").and_then(Value::as_str) != self.turn.as_deref()
                {
                    return Err(protocol_error(
                        "Codex app-server completed an unexpected turn",
                    ));
                }
                match params.pointer("/turn/status").and_then(Value::as_str) {
                    Some("completed") => self.terminal = Some(false),
                    Some("interrupted") => self.terminal = Some(true),
                    Some("failed") => {
                        return Err(classify_stream_failure(
                            params.get("turn").unwrap_or(params),
                            context.request.session_id.is_some(),
                        ))
                    }
                    _ => {
                        return Err(protocol_error(
                            "Codex app-server returned an unknown turn status",
                        ))
                    }
                }
            }
            "error" => {
                if params.get("willRetry").and_then(Value::as_bool) != Some(true) {
                    return Err(classify_stream_failure(
                        params,
                        context.request.session_id.is_some(),
                    ));
                }
            }
            "thread/tokenUsage/updated" => {
                // Resume emits a snapshot for the historical last turn before
                // a new turn starts. It is not usage for this invocation.
                if params.get("threadId").and_then(Value::as_str) != self.thread.as_deref()
                    || self.thread.is_none()
                {
                    return Err(protocol_error(
                        "Codex usage notification has an unexpected thread",
                    ));
                }
                if self.turn.is_none() {
                    #[cfg(test)]
                    {
                        self.historical_usage_snapshots += 1;
                    }
                    return Ok(());
                }
                self.scope(params, method)?;
                if let Some(usage) = params.pointer("/tokenUsage/last") {
                    let read = |key| usage.get(key).and_then(Value::as_u64);
                    self.send(
                        context,
                        LocalAgentEvent::Usage {
                            input_tokens: read("inputTokens"),
                            output_tokens: read("outputTokens"),
                            cached_input_tokens: read("cachedInputTokens"),
                        },
                    )?;
                }
            }
            "item/reasoning/textDelta" => {
                self.scope(params, method)?; /* Raw reasoning is not requested or displayed. */
            }
            // Exact v2 metadata notifications exported by Codex's schema. They
            // do not execute tools or grant authority; item/tool notifications
            // remain on the validated lifecycle paths above.
            "thread/status/changed"
            | "thread/readState/changed"
            | "thread/archived"
            | "thread/deleted"
            | "thread/unarchived"
            | "thread/reverted"
            | "thread/attachment/updated"
            | "thread/goal/updated"
            | "thread/prediction/updated"
            | "thread/goal/cleared"
            | "thread/queue/changed"
            | "thread/project/updated"
            | "thread/settings/updated"
            | "thread/compacted"
            | "thread/name/updated"
            | "thread/closed"
            | "account/rateLimits/updated"
            | "account/updated"
            | "configWarning"
            | "warning"
            | "deprecationNotice"
            | "guardianWarning"
            | "model/verification"
            | "model/safetyBuffering/updated"
            | "remoteControl/status/changed"
            | "turn/moderationMetadata" => {}
            "turn/plan/updated" => {
                self.scope(params, method)?;
            }
            "item/plan/delta" | "item/mcpToolCall/progress" => {
                self.scope(params, method)?;
                let id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("Codex progress event omitted its item id"))?;
                let expected = if method == "item/plan/delta" {
                    "plan"
                } else {
                    "mcpToolCall"
                };
                if self.items.get(id).map(String::as_str) != Some(expected)
                    || self.completed.contains(id)
                {
                    return Err(protocol_error(
                        "Codex progress event referenced an unvalidated item",
                    ));
                }
            }
            "mcpServer/startupStatus/updated" => {
                if let Some(name) = params
                    .get("name")
                    .or_else(|| params.get("serverName"))
                    .and_then(Value::as_str)
                {
                    if !is_private_mcp_server(name) {
                        return Err(protocol_error(
                            "Codex app-server started an unexpected MCP server",
                        ));
                    }
                }
            }
            _ => {
                let safe_method = if method.len() <= 120
                    && method
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
                {
                    method
                } else {
                    "[invalid method]"
                };
                return Err(protocol_error(&format!(
                    "Codex app-server emitted an unsupported notification: {safe_method}"
                )));
            }
        }
        Ok(())
    }
}

struct MainIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    cancellation: CancellationToken,
}
impl MainIo {
    async fn send(&mut self, value: &Value) -> Result<(), AdapterError> {
        Ok(crate::local_agent_protocol::write_json(&mut self.stdin, value).await?)
    }
    async fn read(&mut self) -> Result<Value, AdapterError> {
        let line = tokio::select! { _ = self.cancellation.cancelled() => return Err(AdapterError::coded(LocalCliFailureCode::Cancelled, "local agent run cancelled")), line = read_capped_line(&mut self.stdout) => line? };
        serde_json::from_str(
            &line.ok_or_else(|| {
                protocol_error("Codex app-server closed before completing the turn")
            })?,
        )
        .map_err(|_| protocol_error("Codex app-server emitted malformed JSON"))
    }
    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        state: &mut StreamState,
        context: &ProtocolContext,
    ) -> Result<Value, AdapterError> {
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        crate::timeouts::wait_with_timeout_retries(
            async {
                loop {
                    let value = self.read().await?;
                    if value.get("id").is_some() {
                        if value.get("method").is_some() {
                            return Err(AdapterError::coded(
                                LocalCliFailureCode::IsolationViolation,
                                "Codex app-server requested an unauthorized client capability",
                            ));
                        }
                        if value.get("id").and_then(Value::as_u64) != Some(id) {
                            return Err(protocol_error(
                                "Codex app-server returned an unexpected request id",
                            ));
                        }
                        if value.get("error").is_some() {
                            return Err(classify_stream_failure(
                                &value,
                                context.request.session_id.is_some(),
                            ));
                        }
                        return value.get("result").cloned().ok_or_else(|| {
                            protocol_error("Codex app-server response omitted its result")
                        });
                    }
                    state.notification(&value, context)?;
                }
            },
            APP_SERVER_HANDSHAKE_TIMEOUT,
        )
        .await
        .map_err(|_| AdapterError::from("Codex app-server handshake timed out"))?
    }
}

pub(super) async fn run(
    context: &ProtocolContext,
    process_spec: FrozenProcessSpec,
) -> Result<ProtocolOutcome, AdapterError> {
    let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
    let supervisor = process.supervisor;
    let mut io = MainIo {
        stdin: process.stdin,
        stdout: BufReader::new(process.stdout),
        cancellation: context.cancellation.clone(),
    };
    let result = supervisor.monitor(async {
        let mut state = StreamState { expected_tools: context.request.tools.iter().map(|tool| tool.name.clone()).collect(), ..StreamState::default() };
        io.request(1, "initialize", json!({"clientInfo":{"name":"open-builder","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}), &mut state, context).await?;
        io.send(&json!({"method":"initialized"})).await?;
        let config = io.request(2, "config/read", json!({"includeLayers":false}), &mut state, context).await?;
        isolation_check(config.get("config").unwrap_or(&Value::Null), context)?;
        let mut params = json!({"model":context.request.model,"cwd":context.run_dir,"approvalPolicy":"never","sandbox":"read-only","baseInstructions":context.request.system_prompt,"developerInstructions":"","config":{"model_reasoning_summary":"auto"}});
        let method = if let Some(id) = context.request.session_id.as_deref() { state.bind_thread(id)?; params["threadId"] = json!(id); "thread/resume" } else {
            params["allowProviderModelFallback"] = json!(false); params["ephemeral"] = json!(false); params["experimentalRawEvents"] = json!(false); params["dynamicTools"] = json!([]); params["environments"] = json!([]); params["runtimeWorkspaceRoots"] = json!([]); params["selectedCapabilityRoots"] = json!([]); "thread/start"
        };
        let thread = io.request(3, method, params, &mut state, context).await?;
        if context.request.model.as_deref().is_some_and(|model| thread.get("model").and_then(Value::as_str) != Some(model))
            || context.request.effort.as_deref().is_some_and(|effort| thread.get("reasoningEffort").and_then(Value::as_str) != Some(effort)) {
            return Err(AdapterError::coded(LocalCliFailureCode::SelectionRejected, "Codex app-server changed the selected model or reasoning effort"));
        }
        if thread.get("approvalPolicy").and_then(Value::as_str)!=Some("never") || thread.pointer("/sandbox/type").and_then(Value::as_str)!=Some("readOnly") {
            return Err(AdapterError::coded(LocalCliFailureCode::IsolationViolation,"Codex app-server changed the prepared thread permissions"));
        }
        state.bind_thread(thread.pointer("/thread/id").and_then(Value::as_str).ok_or_else(|| protocol_error("Codex app-server did not return a thread id"))?)?;
        state.send(context, LocalAgentEvent::Session {session_id: state.thread.clone().unwrap(), cli_version:context.cli_version.clone()})?;
        state.send(context, LocalAgentEvent::Status {state:LocalCliRunState::Streaming,message:None})?;
        let turn = io.request(4, "turn/start", json!({"threadId":state.thread,"input":[{"type":"text","text":turn_prompt(&context.request)}],"model":context.request.model,"effort":context.request.effort,"summary":"auto","cwd":context.run_dir,"approvalPolicy":"never","sandboxPolicy":{"type":"readOnly"},"environments":[],"runtimeWorkspaceRoots":[]}), &mut state, context).await?;
        state.bind_turn(turn.pointer("/turn/id").and_then(Value::as_str).ok_or_else(|| protocol_error("Codex app-server did not return a turn id"))?)?;
        while state.terminal.is_none() { let value = io.read().await?; if value.get("id").is_some() {return Err(protocol_error("Codex app-server requested an unauthorized client capability"));} state.notification(&value, context)?; }
        Ok::<_,AdapterError>(ProtocolOutcome {session_id:state.thread,aborted:state.terminal.unwrap()})
    }).await;
    let result = match result {
        Err(error) if error.code == Some(LocalCliFailureCode::Cancelled) => Ok(ProtocolOutcome {
            session_id: context.request.session_id.clone(),
            aborted: true,
        }),
        other => other,
    };
    stop_app_server(supervisor, result, "Codex app-server main task failed").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_agent::{LocalAgentProvider, LocalAgentRunScope, LocalAgentRunScopeKind};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::sync::mpsc;

    struct Fixture {
        root: PathBuf,
        context: ProtocolContext,
        events: mpsc::UnboundedReceiver<Value>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "open-builder-stream-contract-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let (sender, events) = mpsc::unbounded_channel();
            let channel = Channel::new(move |body| {
                let InvokeResponseBody::Json(text) = body else {
                    panic!("expected JSON event")
                };
                sender.send(serde_json::from_str(&text).unwrap()).unwrap();
                Ok(())
            });
            let context = ProtocolContext {
                executable: PathBuf::from("codex"),
                run_dir: root.clone(),
                session_dir: root.clone(),
                workspace_dir: root.clone(),
                bridge_url: "http://127.0.0.1:34567/mcp".to_string(),
                bridge_token: "fixture-token".to_string(),
                cli_version: "fixture".to_string(),
                cancellation: CancellationToken::new(),
                channel: channel.into(),
                request: LocalAgentStartRequest {
                    utility_effort_policy: None,
                    provider: LocalAgentProvider::Codex,
                    model: Some("selected-model".to_string()),
                    effort: Some("high".to_string()),
                    system_prompt: "system".to_string(),
                    prompt: "task".to_string(),
                    bootstrap_context: None,
                    session_id: None,
                    session_compatibility_key: None,
                    scope: LocalAgentRunScope {
                        kind: LocalAgentRunScopeKind::Conversation,
                        id: "test".to_string(),
                    },
                    tools: Vec::new(),
                    max_tool_calls: 0,
                    native_search: false,
                    mode: "chat".to_string(),
                },
            };
            Self {
                root,
                context,
                events,
            }
        }
        fn state(&self) -> StreamState {
            StreamState {
                thread: Some("thread-1".to_string()),
                turn: Some("turn-1".to_string()),
                ..StreamState::default()
            }
        }
        fn events(&mut self) -> Vec<Value> {
            let mut result = Vec::new();
            while let Ok(v) = self.events.try_recv() {
                result.push(v);
            }
            result
        }
    }
    fn item(method: &str, id: &str, kind: &str, text: &str) -> Value {
        json!({"method":method,"params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":id,"type":kind,"text":text}}})
    }
    fn delta(id: &str, text: &str) -> Value {
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":id,"delta":text}})
    }
    fn summary(id: &str, index: u64, text: &str) -> Value {
        json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":id,"summaryIndex":index,"delta":text}})
    }

    #[test]
    fn streams_before_terminal_and_reconciles_snapshots_without_duplicate_text() {
        let mut fixture = Fixture::new();
        let mut state = fixture.state();
        for (id, text) in [("a", "你好🌍"), ("b", "Second")] {
            state
                .notification(
                    &item("item/started", id, "agentMessage", ""),
                    &fixture.context,
                )
                .unwrap();
            state
                .notification(&delta(id, text), &fixture.context)
                .unwrap();
            assert_eq!(fixture.events()[0]["delta"], text);
            assert!(state.terminal.is_none());
            state
                .notification(
                    &item("item/completed", id, "agentMessage", &format!("{text}!")),
                    &fixture.context,
                )
                .unwrap();
            assert_eq!(fixture.events()[0]["delta"], "!");
        }
    }
    #[test]
    fn summary_indices_and_items_reconcile_independently() {
        let mut fixture = Fixture::new();
        let mut state = fixture.state();
        for id in ["r1", "r2"] {
            state
                .notification(&item("item/started", id, "reasoning", ""), &fixture.context)
                .unwrap();
            state
                .notification(&summary(id, 0, "one"), &fixture.context)
                .unwrap();
            state
                .notification(&summary(id, 1, "two"), &fixture.context)
                .unwrap();
            state.notification(&json!({"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":id,"type":"reasoning","summary":["one","two!"]}}}),&fixture.context).unwrap();
        }
        let text = fixture
            .events()
            .iter()
            .map(|e| e["delta"].as_str().unwrap())
            .collect::<String>();
        assert_eq!(text, "onetwo!onetwo!");
    }
    #[test]
    fn conflicting_snapshots_scope_and_disabled_capabilities_fail_closed() {
        let mut fixture = Fixture::new();
        let mut state = fixture.state();
        state
            .notification(
                &item("item/started", "a", "agentMessage", ""),
                &fixture.context,
            )
            .unwrap();
        state
            .notification(&delta("a", "already shown"), &fixture.context)
            .unwrap();
        assert!(state
            .notification(
                &item("item/completed", "a", "agentMessage", "different"),
                &fixture.context
            )
            .is_err());
        assert_eq!(fixture.events()[0]["delta"], "already shown");
        let mut wrong = delta("a", "late");
        wrong["params"]["turnId"] = json!("other");
        assert!(state.notification(&wrong, &fixture.context).is_err());
        assert!(state
            .notification(
                &item("item/started", "shell", "commandExecution", ""),
                &fixture.context
            )
            .is_err());
        assert!(state.notification(&json!({"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"m","type":"mcpToolCall","server":"external","tool":"read"}}}),&fixture.context).is_err());
    }
    #[test]
    fn empty_and_cancelled_deltas_do_not_make_content() {
        let mut fixture = Fixture::new();
        let mut state = fixture.state();
        state
            .notification(
                &item("item/started", "r", "reasoning", ""),
                &fixture.context,
            )
            .unwrap();
        state
            .notification(&summary("r", 0, ""), &fixture.context)
            .unwrap();
        assert!(fixture.events().is_empty());
        fixture.context.cancellation.cancel();
        state
            .notification(&summary("r", 0, "late"), &fixture.context)
            .unwrap();
        assert!(fixture.events().is_empty());
        assert_ne!(
            Transport::AppServer.protocol_version(),
            Transport::Exec.protocol_version()
        );
        assert_ne!(Transport::Exec.protocol_version(), "codex-exec-json-v2");
    }

    #[cfg(unix)]
    fn executable(fixture: &Fixture, mode: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = fixture.root.join("fake-codex");
        let script = include_str!("../tests/fixtures/fake_codex_app_server.py")
            .replace("FIXTURE_MODE", mode);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn process_streams_before_response_and_reaps_daemon_fresh_and_resume() {
        for resumed in [false, true] {
            let mut fixture = Fixture::new();
            fixture.context.executable = executable(&fixture, "success");
            if resumed {
                fixture.context.request.session_id = Some("thread-1".to_string());
            }
            let prepared = prepare_run_for_test(&fixture.context, Transport::AppServer).await;
            let future = run(&fixture.context, prepared);
            tokio::pin!(future);
            let first = tokio::select! { event=fixture.events.recv()=>event.unwrap(), result=&mut future=>panic!("run ended before activity: {:?}",result.err().map(|e|e.message)) };
            assert_eq!(first["type"], "session");
            let mut texts = Vec::new();
            let mut reasoning = Vec::new();
            let outcome = loop {
                tokio::select! {
                    event = fixture.events.recv() => {
                        let event = event.unwrap();
                        if event["type"] == "textDelta" {
                            if event["delta"] == "你好🌍" {
                                assert!(!fixture.root.join("response-sent").exists());
                                std::fs::write(fixture.root.join("observer-saw-delta"), b"ok").unwrap();
                            }
                            texts.push(event["delta"].as_str().unwrap().to_string());
                        }
                        if event["type"] == "reasoningDelta" {
                            reasoning.push(event["delta"].as_str().unwrap().to_string());
                        }
                    },
                    result = &mut future => break result.unwrap()
                }
            };
            while let Ok(event) = fixture.events.try_recv() {
                if event["type"] == "textDelta" {
                    texts.push(event["delta"].as_str().unwrap().to_string());
                }
                if event["type"] == "reasoningDelta" {
                    reasoning.push(event["delta"].as_str().unwrap().to_string());
                }
            }
            assert!(!outcome.aborted);
            assert_eq!(outcome.session_id.as_deref(), Some("thread-1"));
            assert_eq!(texts.concat(), "你好🌍!");
            assert_eq!(reasoning.concat(), "first second");
            let counts = std::fs::read_to_string(fixture.root.join("sent-turns")).unwrap();
            assert_eq!(counts, "1\n");
        }
    }
    #[cfg(unix)]
    async fn prepare_run_for_test(
        context: &ProtocolContext,
        transport: Transport,
    ) -> FrozenProcessSpec {
        let path = context.run_dir.join("instructions.md");
        std::fs::write(&path, "system").unwrap();
        assert_eq!(
            transport,
            select_transport(&context.executable).await.unwrap()
        );
        isolated_spec(context, &CodexProviderConfig::default(), &path)
            .await
            .unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn post_send_failure_never_replays_or_falls_back() {
        let mut fixture = Fixture::new();
        fixture.context.executable = executable(&fixture, "fail-after-send");
        let spec = prepare_run_for_test(&fixture.context, Transport::AppServer).await;
        assert!(run(&fixture.context, spec).await.is_err());
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("sent-turns")).unwrap(),
            "1\n"
        );
        assert!(!fixture.root.join("exec-started").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn only_explicit_missing_capability_selects_exec() {
        for (mode, expected) in [
            ("old", Some(Transport::Exec)),
            ("unsupported-help", Some(Transport::Exec)),
            ("permission", None),
            ("unknown-failure", None),
        ] {
            let fixture = Fixture::new();
            let executable = executable(&fixture, mode);
            assert_eq!(select_transport(&executable).await.ok(), expected);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_live_stream_without_finishing_text() {
        let mut fixture = Fixture::new();
        fixture.context.executable = executable(&fixture, "hang");
        let spec = prepare_run_for_test(&fixture.context, Transport::AppServer).await;
        let future = run(&fixture.context, spec);
        tokio::pin!(future);
        loop {
            tokio::select! {event=fixture.events.recv()=>{if event.unwrap()["type"]=="textDelta"{fixture.context.cancellation.cancel();break;}},_=&mut future=>panic!("expected live stream")}
        }
        let result = tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .unwrap()
            .unwrap();
        assert!(result.aborted);
    }
    #[test]
    fn earlier_item_or_summary_tail_cannot_be_appended_after_later_output() {
        let fixture = Fixture::new();
        let mut state = fixture.state();
        for id in ["a", "b"] {
            state
                .notification(
                    &item("item/started", id, "agentMessage", ""),
                    &fixture.context,
                )
                .unwrap();
            state
                .notification(&delta(id, id), &fixture.context)
                .unwrap();
        }
        assert!(state
            .notification(
                &item("item/completed", "a", "agentMessage", "a-tail"),
                &fixture.context
            )
            .is_err());
        let mut state = fixture.state();
        state
            .notification(
                &item("item/started", "r", "reasoning", ""),
                &fixture.context,
            )
            .unwrap();
        state
            .notification(&summary("r", 0, "first"), &fixture.context)
            .unwrap();
        state
            .notification(&summary("r", 1, "second"), &fixture.context)
            .unwrap();
        assert!(state
            .notification(&summary("r", 0, "late"), &fixture.context)
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn schema_missing_capability_falls_back_but_schema_failure_does_not() {
        for (mode, expected) in [
            ("missing-summary", Some(Transport::Exec)),
            ("schema-failure", None),
        ] {
            let fixture = Fixture::new();
            let executable = executable(&fixture, mode);
            assert_eq!(select_transport(&executable).await.ok(), expected);
        }
    }
    #[tokio::test]
    #[ignore = "read-only installed app-server preflight; no model request is sent"]
    async fn manual_real_app_server_isolation_preflight() {
        let mut fixture = Fixture::new();
        fixture.context.executable = PathBuf::from(
            std::env::var("OPEN_BUILDER_MANUAL_CLI_EXECUTABLE").expect("set executable"),
        );
        assert_eq!(
            select_transport(&fixture.context.executable).await.unwrap(),
            Transport::AppServer
        );
        let path = fixture.root.join("instructions.md");
        std::fs::write(&path, "Isolated no-model preflight").unwrap();
        let spec = isolated_spec(&fixture.context, &CodexProviderConfig::default(), &path)
            .await
            .unwrap();
        let process = RunSupervisor::spawn(spec, CancellationToken::new()).unwrap();
        let supervisor = process.supervisor;
        let mut io = MainIo {
            stdin: process.stdin,
            stdout: BufReader::new(process.stdout),
            cancellation: fixture.context.cancellation.clone(),
        };
        let result=supervisor.monitor(async {
            let mut state=StreamState::default();
            io.request(1,"initialize",json!({"clientInfo":{"name":"open-builder-validation","version":"1"},"capabilities":{"experimentalApi":true}}),&mut state,&fixture.context).await?;
            io.send(&json!({"method":"initialized"})).await?;
            let value=io.request(2,"config/read",json!({"includeLayers":false}),&mut state,&fixture.context).await?;
            isolation_check(&value["config"],&fixture.context)
        }).await;
        stop_app_server(supervisor, result, "preflight verification failed")
            .await
            .unwrap();
        println!("Codex app-server schema and effective isolation verified; no model request sent");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn isolation_failure_and_client_approval_never_trigger_fallback() {
        let mut fixture = Fixture::new();
        fixture.context.executable = executable(&fixture, "isolation-mismatch");
        let path = fixture.root.join("instructions.md");
        std::fs::write(&path, "system").unwrap();
        let error = isolated_spec(&fixture.context, &CodexProviderConfig::default(), &path)
            .await
            .err()
            .expect("isolation mismatch must fail");
        assert_eq!(error.code, Some(LocalCliFailureCode::IsolationViolation));
        assert!(!fixture.root.join("sent-turns").exists());
        let mut fixture = Fixture::new();
        fixture.context.executable = executable(&fixture, "approval-request");
        let spec = prepare_run_for_test(&fixture.context, Transport::AppServer).await;
        let error = run(&fixture.context, spec).await.unwrap_err();
        assert_eq!(error.code, Some(LocalCliFailureCode::IsolationViolation));
        assert!(!error.message.contains("sentinel"));
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("sent-turns")).unwrap(),
            "1\n"
        );
        assert!(!fixture.root.join("exec-started").exists());
    }
    #[test]
    fn documented_metadata_is_ignored_without_allowing_native_tool_activity() {
        let mut fixture = Fixture::new();
        let mut state = fixture.state();
        for method in [
            "thread/readState/changed",
            "thread/status/changed",
            "thread/settings/updated",
            "thread/queue/changed",
            "thread/compacted",
        ] {
            state
                .notification(
                    &json!({"method":method,"params":{"threadId":"thread-1"}}),
                    &fixture.context,
                )
                .unwrap();
        }
        assert!(fixture.events().is_empty());
        for method in [
            "item/commandExecution/outputDelta",
            "item/fileChange/outputDelta",
            "turn/diff/updated",
            "item/autoApprovalReview/started",
        ] {
            assert!(state.notification(&json!({"method":method,"params":{"threadId":"thread-1","turnId":"turn-1","delta":"private text"}}),&fixture.context).is_err());
        }
    }
    #[test]
    fn resume_usage_snapshot_does_not_count_as_current_turn_activity() {
        let mut fixture = Fixture::new();
        let mut state = StreamState {
            thread: Some("thread-1".to_string()),
            ..StreamState::default()
        };
        let historical = json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"old-turn","tokenUsage":{"last":{"inputTokens":123,"outputTokens":45}}}});
        state.notification(&historical, &fixture.context).unwrap();
        assert!(fixture.events().is_empty());
        let mut foreign = historical.clone();
        foreign["params"]["threadId"] = json!("foreign");
        assert!(state.notification(&foreign, &fixture.context).is_err());
        assert!(state
            .notification(&delta("a", "historical text"), &fixture.context)
            .is_err());
        state.bind_turn("turn-1").unwrap();
        assert!(state.notification(&historical, &fixture.context).is_err());
        let mut current = historical;
        current["params"]["turnId"] = json!("turn-1");
        state.notification(&current, &fixture.context).unwrap();
        assert_eq!(fixture.events()[0]["inputTokens"], 123);
    }
    #[tokio::test]
    #[ignore = "resumes only a designated local validation thread; does not start a model turn"]
    async fn manual_real_app_server_resume_without_turn() {
        let mut fixture = Fixture::new();
        fixture.context.executable = PathBuf::from(
            std::env::var("OPEN_BUILDER_MANUAL_CLI_EXECUTABLE").expect("set executable"),
        );
        let identity: Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::env::var("OPEN_BUILDER_RESUME_PROBE_FILE").expect("set private identity file"),
            )
            .unwrap(),
        )
        .unwrap();
        let thread_id = identity["threadId"].as_str().unwrap();
        let bridge = crate::local_agent_bridge::ToolBridge::default();
        let (url, token) = bridge
            .register(
                "no-model-resume-probe".to_string(),
                Vec::new(),
                0,
                fixture.context.cancellation.clone(),
                fixture.context.channel.clone(),
            )
            .await
            .unwrap();
        fixture.context.bridge_url = url;
        fixture.context.bridge_token = token;
        fixture.context.request.model = None;
        fixture.context.request.effort = None;
        let path = fixture.root.join("instructions.md");
        std::fs::write(&path, "No-model resume validation").unwrap();
        let spec = isolated_spec(&fixture.context, &CodexProviderConfig::default(), &path)
            .await
            .unwrap();
        let process = RunSupervisor::spawn(spec, CancellationToken::new()).unwrap();
        let supervisor = process.supervisor;
        let mut io = MainIo {
            stdin: process.stdin,
            stdout: BufReader::new(process.stdout),
            cancellation: fixture.context.cancellation.clone(),
        };
        let result=supervisor.monitor(async {
            let mut state=StreamState::default();
            io.request(1,"initialize",json!({"clientInfo":{"name":"open-builder-resume-validation","version":"1"},"capabilities":{"experimentalApi":true}}),&mut state,&fixture.context).await?;
            io.send(&json!({"method":"initialized"})).await?;
            state.bind_thread(thread_id)?;
            let response=io.request(2,"thread/resume",json!({"threadId":thread_id,"cwd":fixture.root,"approvalPolicy":"never","sandbox":"read-only","baseInstructions":"No-model resume validation","developerInstructions":""}),&mut state,&fixture.context).await?;
            state.bind_thread(response.pointer("/thread/id").and_then(Value::as_str).ok_or_else(||protocol_error("missing resume thread"))?)?;
            // Resume may acknowledge before publishing historical token usage.
            // Drain only notifications, without starting a new model turn.
            let drain = tokio::time::timeout(Duration::from_secs(4), async {
                while state.historical_usage_snapshots == 0 {
                    let value=io.read().await?;
                    state.notification(&value,&fixture.context)?;
                }
                Ok::<_,AdapterError>(())
            }).await;
            if let Ok(result)=drain { result?; }
            println!("{}",json!({"check":"no-model-resume","historicalUsageObserved":state.historical_usage_snapshots>0}));
            assert!(state.turn.is_none());
            assert!(state.historical_usage_snapshots > 0, "resume must reproduce a historical usage notification");
            Ok::<_,AdapterError>(())
        }).await;
        let result = stop_app_server(supervisor, result, "no-model resume failed").await;
        bridge.shutdown_now();
        result.unwrap();
        assert!(fixture.events().is_empty());
        println!("Native thread resume accepted historical metadata without current-turn content or usage; no model turn started");
    }
}
