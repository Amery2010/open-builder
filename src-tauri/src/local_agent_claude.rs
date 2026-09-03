use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentEvent, LocalAgentModel,
    LocalAgentStartRequest,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_models::{
    CatalogAuthority, ClaudeGatewayCatalog, EffortKnowledge, ModelCandidate, ModelPreference,
};
use crate::local_agent_protocol::{
    apply_minimal_environment, command_output_capped, finish_process, read_capped_line,
    spawn_stderr_drain, spawn_wrapped, terminate, turn_prompt, write_json, FrozenProcessSpec,
    PreparedPrivateFile, ProtocolContext, ProtocolOutcome, ProtocolOutputBudget, RunSupervisor,
};
use crate::local_agent_runtime::{AdapterError, LocalCliFailureCode};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_CLAUDE_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLAUDE_PROVIDER_ENV_VALUE_BYTES: usize = 64 * 1024;
const MAX_CLAUDE_PROVIDER_ENV_BYTES: usize = 256 * 1024;
const CLAUDE_MCP_TOKEN_ENV: &str = "OPEN_BUILDER_MCP_TOKEN";
const CLAUDE_CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";
const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_TOOL_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 512;
const MAX_CLAUDE_EFFORT_BYTES: usize = 64;
const OPEN_BUILDER_MCP_NAME: &str = "open_builder";
const PREPARED_PRIVATE_FILES_CHANGED_ERROR: &str =
    "Private Claude run files changed during preparation";
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const CLAUDE_CONTROL_TOOLS: &[&str] = &["EndConversation"];
const CLAUDE_PROVIDER_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BETAS",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
];

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "claude",
    setup_command: "claude auth login",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: true,
    },
    // Version, isolation, and auth are separately bounded probe stages.
    probe_timeout: Duration::from_secs(30),
    unix_home_directories: &[".claude/local"],
    windows_home_directories: &[],
    windows_local_directories: &["Programs\\Claude"],
    windows_program_directories: &["Claude"],
    require_empty_workspace: false,
};

#[allow(dead_code)]
fn first_output_line(output: &std::process::Output) -> Option<String> {
    // Stderr may contain provider or configuration diagnostics and is never
    // promoted into renderer-visible version metadata.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn output_text(output: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn output_json(output: &std::process::Output, description: &str) -> Result<Value, String> {
    for bytes in [&output.stdout, &output.stderr] {
        if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
            if value.is_object() {
                return Ok(value);
            }
        }
    }
    let text = output_text(output);
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if value.is_object() {
                return Ok(value);
            }
        }
    }
    Err(format!("Claude {description} returned malformed JSON"))
}

fn parse_auth_status(output: &std::process::Output) -> Result<bool, String> {
    let value = output_json(output, "authentication status")?;
    value
        .get("loggedIn")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Claude authentication status omitted its login state".to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeFailureKind {
    Unsupported,
    Error,
}

#[derive(Debug)]
struct ProbeFailure {
    kind: ProbeFailureKind,
    message: String,
}

impl ProbeFailure {
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            kind: ProbeFailureKind::Unsupported,
            message: message.into(),
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            kind: ProbeFailureKind::Error,
            message: message.into(),
        }
    }
}

struct PrivateDirectory(PathBuf);

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn private_directory(prefix: &str) -> Result<PrivateDirectory, String> {
    let path = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path)
        .map_err(|_| "failed to create private Claude probe directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure private Claude probe directory".to_string())?;
    }
    Ok(PrivateDirectory(path))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|_| "failed to write private Claude configuration".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure private Claude configuration".to_string())?;
    }
    Ok(())
}

fn validate_user_settings_path(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("failed to inspect Claude user settings".to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_CLAUDE_SETTINGS_BYTES {
        return Err("Claude user settings must be a regular file no larger than 2 MiB".to_string());
    }
    Ok(Some(path.to_path_buf()))
}

fn user_settings_path() -> Result<Option<PathBuf>, String> {
    let config_dir = std::env::var_os(CLAUDE_CONFIG_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(windows)]
            let home = std::env::var_os("USERPROFILE");
            #[cfg(not(windows))]
            let home = std::env::var_os("HOME");
            home.map(|home| PathBuf::from(home).join(".claude"))
        });
    match config_dir {
        Some(config_dir) if config_dir.is_absolute() => {
            validate_user_settings_path(&config_dir.join("settings.json"))
        }
        Some(_) => Err("Claude config directory must use an absolute path".to_string()),
        None => Ok(None),
    }
}

struct ClaudeProviderEnvironment {
    values: Vec<(String, String)>,
    has_explicit_credential: bool,
    is_gateway: bool,
    configured_model: Option<String>,
    configured_effort: Option<String>,
    configuration_source: &'static str,
}

impl ClaudeProviderEnvironment {
    fn apply(&self, command: &mut Command) {
        for (name, value) in &self.values {
            command.env(name, value);
        }
    }

    fn bypasses_auth_status(&self) -> bool {
        self.has_explicit_credential
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find_map(|(candidate, value)| (candidate == name).then_some(value.as_str()))
    }
}

fn declared_efforts(value: Option<&str>) -> (Vec<String>, EffortKnowledge) {
    let Some(value) = value else {
        return (Vec::new(), EffortKnowledge::Unknown);
    };
    let capabilities = value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let mut efforts = Vec::new();
    if capabilities.contains("effort") {
        efforts.extend(["low", "medium", "high"].map(str::to_string));
    }
    if capabilities.contains("xhigh_effort") {
        efforts.push("xhigh".to_string());
    }
    if capabilities.contains("max_effort") {
        efforts.push("max".to_string());
    }
    (efforts, EffortKnowledge::Known)
}

fn declared_model(
    environment: &ClaudeProviderEnvironment,
    id: &str,
    model_key: &str,
    name_key: &str,
    capabilities_key: &str,
    configured_model: Option<&str>,
) -> ModelCandidate {
    let mapped_model = environment.value(model_key);
    let (efforts, effort_knowledge) = match environment.value(capabilities_key) {
        Some(capabilities) => declared_efforts(Some(capabilities)),
        None if mapped_model.is_none() => (
            CLAUDE_EFFORTS
                .iter()
                .map(|effort| (*effort).to_string())
                .collect(),
            EffortKnowledge::Known,
        ),
        None => (Vec::new(), EffortKnowledge::Unknown),
    };
    ModelCandidate {
        model: LocalAgentModel {
            id: id.to_string(),
            display_name: environment
                .value(name_key)
                .or(mapped_model)
                .unwrap_or(id)
                .chars()
                .take(160)
                .collect(),
            is_default: configured_model == Some(id),
            default_effort: None,
            efforts,
        },
        effort_knowledge,
    }
}

fn model_catalog_context_from_environment(
    environment: &ClaudeProviderEnvironment,
) -> (
    Vec<ModelCandidate>,
    CatalogAuthority,
    ModelPreference,
    Option<ClaudeGatewayCatalog>,
) {
    let configured_model = environment
        .value("ANTHROPIC_MODEL")
        .or(environment.configured_model.as_deref());
    let configured = ModelPreference {
        model: configured_model.map(str::to_string),
        effort: environment.configured_effort.clone(),
    };
    let mut candidates = Vec::new();
    for (id, model_key, name_key, capabilities_key) in [
        (
            "fable",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
        ),
        (
            "opus",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
        ),
        (
            "sonnet",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
        ),
        (
            "haiku",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
        ),
    ] {
        candidates.push(declared_model(
            environment,
            id,
            model_key,
            name_key,
            capabilities_key,
            configured_model,
        ));
    }
    if let Some(custom_id) = environment.value("ANTHROPIC_CUSTOM_MODEL_OPTION") {
        let (efforts, effort_knowledge) = declared_efforts(
            environment.value("ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES"),
        );
        candidates.push(ModelCandidate {
            model: LocalAgentModel {
                id: custom_id.to_string(),
                display_name: environment
                    .value("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME")
                    .unwrap_or(custom_id)
                    .chars()
                    .take(160)
                    .collect(),
                is_default: configured_model == Some(custom_id),
                default_effort: None,
                efforts,
            },
            effort_knowledge,
        });
    }
    let gateway = if environment.is_gateway {
        environment
            .value("ANTHROPIC_BASE_URL")
            .and_then(|base_url| {
                let custom_headers = environment
                    .value("ANTHROPIC_CUSTOM_HEADERS")
                    .map(str::to_string);
                if let Some(token) = environment.value("ANTHROPIC_AUTH_TOKEN") {
                    Some(ClaudeGatewayCatalog::with_bearer_token(
                        base_url.to_string(),
                        token.to_string(),
                        custom_headers,
                    ))
                } else {
                    environment.value("ANTHROPIC_API_KEY").map(|api_key| {
                        ClaudeGatewayCatalog::with_api_key(
                            base_url.to_string(),
                            api_key.to_string(),
                            custom_headers,
                        )
                    })
                }
            })
    } else {
        None
    };
    (candidates, CatalogAuthority::Partial, configured, gateway)
}

pub(crate) fn model_catalog_context() -> Result<
    (
        Vec<ModelCandidate>,
        ModelPreference,
        Option<ClaudeGatewayCatalog>,
    ),
    String,
> {
    let (candidates, _, configured, gateway) =
        model_catalog_context_from_environment(&load_provider_environment()?);
    Ok((candidates, configured, gateway))
}

fn validate_provider_value(name: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_CLAUDE_PROVIDER_ENV_VALUE_BYTES
        || value.contains('\0')
        || value.contains('\r')
        || (name != "ANTHROPIC_CUSTOM_HEADERS" && value.contains('\n'))
    {
        return Err(format!(
            "Claude provider setting {name} contains an invalid value"
        ));
    }
    Ok(())
}

fn validate_provider_url(value: &str) -> Result<bool, String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| "Claude gateway URL is invalid".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Claude gateway URL must not contain credentials, a query, or a fragment".to_string(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Claude gateway URL must include a host".to_string())?;
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err("Claude gateway URL must use HTTPS or loopback HTTP".to_string());
    }
    Ok(!(url.scheme() == "https"
        && host.eq_ignore_ascii_case("api.anthropic.com")
        && url.port_or_known_default() == Some(443)))
}

fn provider_environment_from_sources(
    settings: Option<&Value>,
    inherited: &BTreeMap<String, String>,
) -> Result<ClaudeProviderEnvironment, String> {
    let mut values = BTreeMap::new();
    let mut configured_model = None;
    let mut configured_effort = None;
    if let Some(settings) = settings {
        let settings = settings
            .as_object()
            .ok_or_else(|| "Claude user settings must contain a JSON object".to_string())?;
        if let Some(model) = settings.get("model") {
            let model = model
                .as_str()
                .ok_or_else(|| "Claude configured model must be a string".to_string())?;
            if !model.is_empty() {
                if model.len() > 256
                    || model
                        .chars()
                        .any(|character| character.is_control() || character.is_whitespace())
                {
                    return Err("Claude configured model id is invalid".to_string());
                }
                configured_model = Some(model.to_string());
            }
        }
        if let Some(effort) = settings.get("effortLevel") {
            let effort = effort
                .as_str()
                .ok_or_else(|| "Claude configured reasoning effort must be a string".to_string())?;
            if !effort.is_empty() {
                if !valid_effort(effort) {
                    return Err("Claude configured reasoning effort is invalid".to_string());
                }
                configured_effort = Some(effort.to_string());
            }
        }
        if let Some(environment) = settings.get("env") {
            let environment = environment
                .as_object()
                .ok_or_else(|| "Claude user settings env must contain a JSON object".to_string())?;
            for name in CLAUDE_PROVIDER_ENV_KEYS {
                if let Some(value) = environment.get(*name) {
                    let value = value.as_str().ok_or_else(|| {
                        format!("Claude provider setting {name} must be a string")
                    })?;
                    if !value.is_empty() {
                        values.insert((*name).to_string(), value.to_string());
                    }
                }
            }
        }
    }
    for name in CLAUDE_PROVIDER_ENV_KEYS {
        if let Some(value) = inherited.get(*name) {
            if value.is_empty() {
                values.remove(*name);
            } else {
                values.insert((*name).to_string(), value.clone());
            }
        }
    }

    let total_bytes = values.iter().try_fold(0_usize, |total, (name, value)| {
        validate_provider_value(name, value)?;
        total
            .checked_add(name.len().saturating_add(value.len()))
            .ok_or_else(|| "Claude provider settings exceed the size limit".to_string())
    })?;
    if total_bytes > MAX_CLAUDE_PROVIDER_ENV_BYTES {
        return Err("Claude provider settings exceed the size limit".to_string());
    }

    let has_explicit_credential =
        values.contains_key("ANTHROPIC_AUTH_TOKEN") || values.contains_key("ANTHROPIC_API_KEY");
    let is_gateway = values
        .get("ANTHROPIC_BASE_URL")
        .map(|value| validate_provider_url(value))
        .transpose()?
        .unwrap_or(false);
    if is_gateway && !has_explicit_credential {
        return Err("Claude gateway configuration requires an explicit credential".to_string());
    }

    Ok(ClaudeProviderEnvironment {
        values: values.into_iter().collect(),
        has_explicit_credential,
        is_gateway,
        configured_model,
        configured_effort,
        // Callers that load an on-disk settings file replace this with the
        // precise source after parsing. Direct source-based tests use the
        // conservative default, which is also the value used when no file
        // is present.
        configuration_source: "environment-or-defaults",
    })
}

fn load_provider_environment() -> Result<ClaudeProviderEnvironment, String> {
    let settings_path = user_settings_path()?;
    let configuration_source = if settings_path.is_some() {
        "user-settings"
    } else {
        "environment-or-defaults"
    };
    let settings = match settings_path {
        Some(path) => {
            let bytes = std::fs::read(path)
                .map_err(|_| "failed to read Claude user settings".to_string())?;
            if bytes.len() as u64 > MAX_CLAUDE_SETTINGS_BYTES {
                return Err(
                    "Claude user settings must be a regular file no larger than 2 MiB".to_string(),
                );
            }
            Some(
                serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| "Claude user settings contain malformed JSON".to_string())?,
            )
        }
        None => None,
    };
    let mut inherited = BTreeMap::new();
    for name in CLAUDE_PROVIDER_ENV_KEYS {
        if let Some(value) = std::env::var_os(name) {
            inherited.insert(
                (*name).to_string(),
                value.into_string().map_err(|_| {
                    format!("Claude provider setting {name} must contain UTF-8 text")
                })?,
            );
        }
    }
    let mut environment = provider_environment_from_sources(settings.as_ref(), &inherited)?;
    environment.configuration_source = configuration_source;
    Ok(environment)
}

fn configuration_fingerprint_for(environment: &ClaudeProviderEnvironment) -> String {
    let mut material = vec![
        "claude-provider-config-v1".to_string(),
        environment.configuration_source.to_string(),
        format!("gateway={}", environment.is_gateway),
        format!(
            "explicit-credential={}",
            environment.has_explicit_credential
        ),
        format!(
            "model={}",
            environment
                .configured_model
                .as_deref()
                .unwrap_or("<cli-default>")
        ),
        format!(
            "effort={}",
            environment
                .configured_effort
                .as_deref()
                .unwrap_or("<cli-default>")
        ),
    ];
    for (name, value) in &environment.values {
        if name == "ANTHROPIC_BASE_URL"
            || name == "ANTHROPIC_BETAS"
            || name == "ANTHROPIC_CUSTOM_MODEL_OPTION"
            || name == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"
            || name == "ANTHROPIC_MODEL"
            || name == "ANTHROPIC_REASONING_MODEL"
            || name.ends_with("_MODEL")
            || name.ends_with("_MODEL_NAME")
            || name.ends_with("_SUPPORTED_CAPABILITIES")
        {
            material.push(format!("setting:{name}={value}"));
        } else {
            material.push(format!("setting:{name}=present"));
        }
    }
    let parts = material.iter().map(String::as_str).collect::<Vec<_>>();
    crate::local_agent_runtime::hash_compatibility_material(&parts)
}

pub(crate) fn configuration_fingerprint() -> Result<String, String> {
    Ok(configuration_fingerprint_for(&load_provider_environment()?))
}

fn isolation_args(system_prompt: &Path, mcp_config: &Path) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--restricted".to_string(),
        "--strict-mcp-config".to_string(),
        "--mcp-config".to_string(),
        mcp_config.to_string_lossy().to_string(),
        "--setting-sources".to_string(),
        String::new(),
        "--system-prompt-file".to_string(),
        system_prompt.to_string_lossy().to_string(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
        "--tools".to_string(),
        String::new(),
        "--allowedTools".to_string(),
        String::new(),
    ]
}

fn private_probe_files(directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    let system_prompt = directory.join("system-prompt.txt");
    write_private_file(
        &system_prompt,
        b"Open Builder isolation preflight. Never emit user or assistant content.",
    )?;
    let mcp_config = directory.join("mcp.json");
    write_private_file(&mcp_config, br#"{"mcpServers":{}}"#)?;
    Ok((system_prompt, mcp_config))
}

fn contains_capability_marker(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "tool",
        "call",
        "write",
        "command",
        "permission",
        "request",
        "function",
        "shell",
        "exec",
        "patch",
        "input_json",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

fn capability_semantic_event(value: &Value) -> bool {
    fn inspect_fields(value: &Value) -> bool {
        ["type", "subtype", "name", "tool_name", "step_type"]
            .iter()
            .filter_map(|field| value.get(*field).and_then(Value::as_str))
            .any(contains_capability_marker)
    }

    if inspect_fields(value) {
        return true;
    }
    ["event", "content_block", "delta", "step_update"]
        .iter()
        .filter_map(|field| value.get(*field).filter(|nested| nested.is_object()))
        .any(capability_semantic_event)
}

fn validate_preflight_line(line: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| "Claude isolation preflight emitted malformed JSON".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "Claude isolation preflight emitted a non-object event".to_string())?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| "Claude isolation preflight emitted an event without a type".to_string())?;
    if matches!(kind, "user" | "assistant") {
        return Err(
            "Claude isolation preflight emitted user content before attestation".to_string(),
        );
    }
    if matches!(kind, "result" | "message") || capability_semantic_event(&value) {
        return Err(
            "Claude isolation preflight emitted an unexpected capability event".to_string(),
        );
    }
    Ok(())
}

async fn drain_preflight_output<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    budget: &mut ProtocolOutputBudget,
) -> Result<(), String> {
    while let Some(line) = read_capped_line(reader).await? {
        if line.trim().is_empty() {
            continue;
        }
        budget.record(&line)?;
        validate_preflight_line(&line)?;
    }
    Ok(())
}

async fn run_isolation_preflight(executable: &Path) -> Result<(), ProbeFailure> {
    let directory = private_directory("open-builder-claude-probe").map_err(ProbeFailure::error)?;
    let (system_prompt, mcp_config) =
        private_probe_files(&directory.0).map_err(ProbeFailure::error)?;
    let args = isolation_args(&system_prompt, &mcp_config);
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    let private_config = directory.0.join("claude-config");
    std::fs::create_dir(&private_config).map_err(|_| {
        ProbeFailure::error("failed to create private Claude preflight config directory")
    })?;
    command
        .args(args.iter().map(String::as_str))
        .current_dir(&directory.0)
        .env(CLAUDE_CONFIG_DIR_ENV, &private_config);
    let process = spawn_wrapped(command).map_err(ProbeFailure::error)?;
    let child = process.child.clone();
    let (saw_stderr, stderr_task) = spawn_stderr_drain(process.stderr);
    let mut reader = BufReader::new(process.stdout);
    let mut tree_guard = process.tree_guard;
    drop(process.stdin);
    let mut budget = ProtocolOutputBudget::default();
    let read_result = tokio::time::timeout(
        PROBE_TIMEOUT,
        drain_preflight_output(&mut reader, &mut budget),
    )
    .await;
    let read_result = match read_result {
        Ok(result) => result,
        Err(_) => {
            let _ = terminate(&child).await;
            tree_guard.cleanup();
            stderr_task.abort();
            return Err(ProbeFailure::error("Claude isolation preflight timed out"));
        }
    };
    if let Err(error) = read_result {
        let _ = terminate(&child).await;
        tree_guard.cleanup();
        stderr_task.abort();
        return Err(ProbeFailure::error(error));
    }
    let status = finish_process(child, stderr_task, tree_guard)
        .await
        .map_err(ProbeFailure::error)?;
    match status {
        Some(status) if status.success() => {}
        Some(_) => {
            let _ = saw_stderr;
            return Err(ProbeFailure::unsupported(
                "Claude is missing required structured isolation capabilities.",
            ));
        }
        None => {
            return Err(ProbeFailure::error(
                "Claude isolation preflight did not terminate cleanly",
            ));
        }
    }
    Ok(())
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
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(
                    "The selected Claude executable did not report a supported version."
                        .to_string(),
                ),
            }
        }
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version: None,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
            }
        }
    };
    let version = first_output_line(&version_output);
    let provider_environment = match load_provider_environment() {
        Ok(provider_environment) => provider_environment,
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
            }
        }
    };

    // Capability/isolation failures have precedence over authentication
    // failures. The preflight sends EOF and never invokes inference, so it is
    // safe to run even when the user has not signed in yet.
    if let Err(failure) = run_isolation_preflight(executable).await {
        return AdapterProbe {
            availability: match failure.kind {
                ProbeFailureKind::Unsupported => LocalAgentAvailability::Unsupported,
                ProbeFailureKind::Error => LocalAgentAvailability::Error,
            },
            version,
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some(failure.message),
        };
    }

    if provider_environment.bypasses_auth_status() {
        return AdapterProbe {
            availability: LocalAgentAvailability::Ready,
            version,
            models: Vec::new(),
            efforts: CLAUDE_EFFORTS
                .iter()
                .map(|effort| (*effort).to_string())
                .collect(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: true,
            message: Some(if provider_environment.is_gateway {
                "Claude gateway configuration detected; its credential will be verified by the first model request."
                    .to_string()
            } else {
                "Claude API credential detected; it will be verified by the first model request."
                    .to_string()
            }),
        };
    }

    let auth_output = match command_output_capped(
        executable,
        &["auth", "status", "--json"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) => output,
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
            }
        }
    };
    let logged_in = match parse_auth_status(&auth_output) {
        Ok(logged_in) => logged_in,
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
            }
        }
    };
    if !auth_output.status.success() && logged_in {
        return AdapterProbe {
            availability: LocalAgentAvailability::Error,
            version,
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some("Claude authentication status probe failed".to_string()),
        };
    }
    if !logged_in {
        return AdapterProbe {
            availability: LocalAgentAvailability::NeedsSetup,
            version,
            models: Vec::new(),
            efforts: CLAUDE_EFFORTS
                .iter()
                .map(|effort| (*effort).to_string())
                .collect(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some("Claude is not signed in; run claude auth login.".to_string()),
        };
    }

    AdapterProbe {
        availability: LocalAgentAvailability::Ready,
        version,
        models: Vec::new(),
        efforts: CLAUDE_EFFORTS
            .iter()
            .map(|effort| (*effort).to_string())
            .collect(),
        catalog_authority: CatalogAuthority::Partial,
        verification_required: false,
        message: None,
    }
}

fn valid_session_id(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > MAX_SESSION_ID_BYTES || value.chars().any(char::is_control)
    {
        return Err("Claude returned an invalid session id".to_string());
    }
    Ok(value)
}

fn valid_effort(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CLAUDE_EFFORT_BYTES
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        valid_session_id(session_id)?;
    }
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        if !valid_effort(effort) {
            return Err("the selected reasoning effort is invalid".to_string());
        }
    }
    for tool in &request.tools {
        validate_tool_name(&tool.name)?;
    }
    Ok(())
}

fn validate_tool_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_TOOL_NAME_BYTES
        || name.chars().any(char::is_control)
        || name.contains(',')
    {
        return Err(
            "Claude tool names must be non-empty and contain no control characters or commas"
                .to_string(),
        );
    }
    Ok(())
}

fn bridge_url_is_loopback(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/mcp"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn mcp_config(context: &ProtocolContext) -> Result<Value, String> {
    if !bridge_url_is_loopback(&context.bridge_url) {
        return Err("Claude bridge URL is not an isolated loopback endpoint".to_string());
    }
    Ok(json!({
        "mcpServers": {
            OPEN_BUILDER_MCP_NAME: {
                "type": "http",
                "url": context.bridge_url,
                // Claude Code defers MCP tools behind ToolSearch by default.
                // This run has a small exact catalog and must attest it before
                // user content, so load it eagerly and block init on connect.
                "alwaysLoad": true,
                "headers": {
                    "Authorization": format!("Bearer ${{{CLAUDE_MCP_TOKEN_ENV}}}")
                }
            }
        }
    }))
}

struct ClaudeRunFiles {
    system_prompt: PathBuf,
    mcp_config: PathBuf,
    system_prompt_file: PreparedPrivateFile,
    mcp_config_file: PreparedPrivateFile,
}

fn prepare_run_files(context: &ProtocolContext) -> Result<ClaudeRunFiles, String> {
    let system_prompt = context.run_dir.join(format!(
        "open-builder-claude-system-{}.txt",
        uuid::Uuid::new_v4()
    ));
    write_private_file(&system_prompt, context.request.system_prompt.as_bytes())?;
    let mcp_config_path = context.run_dir.join(format!(
        "open-builder-claude-mcp-{}.json",
        uuid::Uuid::new_v4()
    ));
    let config = serde_json::to_vec(&mcp_config(context)?)
        .map_err(|_| "failed to serialize private Claude MCP configuration".to_string())?;
    write_private_file(&mcp_config_path, &config)?;
    let system_prompt_file = PreparedPrivateFile::capture(&system_prompt, &context.run_dir)
        .map_err(|_| "failed to capture private Claude run files".to_string())?;
    let mcp_config_file = PreparedPrivateFile::capture(&mcp_config_path, &context.run_dir)
        .map_err(|_| "failed to capture private Claude run files".to_string())?;
    Ok(ClaudeRunFiles {
        system_prompt,
        mcp_config: mcp_config_path,
        system_prompt_file,
        mcp_config_file,
    })
}

fn native_tool_args(request: &LocalAgentStartRequest) -> Vec<&'static str> {
    if request.native_search {
        vec!["WebSearch", "WebFetch"]
    } else {
        Vec::new()
    }
}

fn allowed_tool_args(request: &LocalAgentStartRequest) -> Result<Vec<String>, String> {
    let mut names = Vec::with_capacity(request.tools.len() + 2);
    for tool in &request.tools {
        validate_tool_name(&tool.name)?;
        names.push(format!("mcp__{OPEN_BUILDER_MCP_NAME}__{}", tool.name));
    }
    names.extend(native_tool_args(request).into_iter().map(str::to_string));
    Ok(names)
}

fn claude_args(
    request: &LocalAgentStartRequest,
    system_prompt: &Path,
    mcp_config: &Path,
    configured_model: Option<&str>,
    configured_effort: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = isolation_args(system_prompt, mcp_config);
    if let Some(model) = request
        .model
        .as_deref()
        .filter(|value| !value.is_empty())
        .or(configured_model)
    {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = request
        .effort
        .as_deref()
        .filter(|value| !value.is_empty())
        .or(configured_effort)
    {
        if !valid_effort(effort) {
            return Err("the selected reasoning effort is invalid".to_string());
        }
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.extend([
            "--resume".to_string(),
            valid_session_id(session_id)?.to_string(),
        ]);
    }

    let native = native_tool_args(request);
    let allowed = allowed_tool_args(request)?;
    let tools_index = args
        .iter()
        .position(|arg| arg == "--tools")
        .ok_or_else(|| "Claude isolation arguments omitted --tools".to_string())?;
    args.splice(
        tools_index + 1..=tools_index + 1,
        if native.is_empty() {
            vec![String::new()]
        } else {
            native.into_iter().map(str::to_string).collect()
        },
    );
    let allowed_index = args
        .iter()
        .position(|arg| arg == "--allowedTools")
        .ok_or_else(|| "Claude isolation arguments omitted --allowedTools".to_string())?;
    args.splice(
        allowed_index + 1..=allowed_index + 1,
        if allowed.is_empty() {
            vec![String::new()]
        } else {
            allowed
        },
    );
    Ok(args)
}

struct ClaudeIo {
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    cancellation: CancellationToken,
    output_budget: ProtocolOutputBudget,
}

impl ClaudeIo {
    async fn read_value(&mut self) -> Result<Value, String> {
        loop {
            let line = tokio::select! {
                _ = self.cancellation.cancelled() => {
                    return Err("local agent run cancelled".to_string());
                }
                line = read_capped_line(&mut self.reader) => line?,
            }
            .ok_or_else(|| "Claude stream-json process closed unexpectedly".to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            self.output_budget.record(&line)?;
            return serde_json::from_str(&line)
                .map_err(|_| "Claude stream-json emitted malformed JSON".to_string());
        }
    }

    async fn send_user(&mut self, prompt: &str) -> Result<(), String> {
        write_json(
            &mut self.stdin,
            &json!({
                "type": "user",
                "message": {"role": "user", "content": prompt}
            }),
        )
        .await
    }
}

fn event_type(value: &Value) -> Result<&str, String> {
    value
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Claude emitted an event without a type".to_string())
}

fn session_from_value(value: &Value) -> Option<&str> {
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(Value::as_str)
}

fn usage_number(value: &Value, names: &[&str]) -> Result<Option<u64>, String> {
    for name in names {
        if let Some(raw) = value.get(*name) {
            if raw.is_null() {
                continue;
            }
            return raw
                .as_u64()
                .map(Some)
                .ok_or_else(|| format!("Claude emitted malformed token usage field {name}"));
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ClaudeUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
}

fn parse_usage(value: &Value) -> Result<Option<ClaudeUsage>, String> {
    if !value.is_object() {
        return Err("Claude emitted a non-object token usage record".to_string());
    }
    let usage = ClaudeUsage {
        input_tokens: usage_number(value, &["input_tokens", "inputTokens"])?,
        output_tokens: usage_number(value, &["output_tokens", "outputTokens"])?,
        cached_input_tokens: usage_number(
            value,
            &[
                "cache_read_input_tokens",
                "cacheReadInputTokens",
                "cache_creation_input_tokens",
                "cacheCreationInputTokens",
                "cached_input_tokens",
                "cachedInputTokens",
            ],
        )?,
    };
    if usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.cached_input_tokens.is_none()
    {
        Ok(None)
    } else {
        Ok(Some(usage))
    }
}

fn usage_from(value: &Value, fields: &[&str]) -> Result<Option<ClaudeUsage>, String> {
    fields
        .iter()
        .find_map(|field| value.get(*field))
        .map_or(Ok(None), parse_usage)
}

#[derive(Clone, Debug, PartialEq)]
enum ClaudeEvent {
    Session(String),
    Text(String),
    Thinking(String),
    ToolStart {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolInputDelta {
        index: String,
        delta: String,
    },
    ToolStop {
        index: String,
    },
    ToolResult {
        id: String,
        result: Value,
    },
    Usage(ClaudeUsage),
    AssistantMessage(Value),
    Result {
        success: bool,
        session_id: Option<String>,
        text: Option<String>,
        usage: Option<ClaudeUsage>,
    },
    Retry {
        rate_limited: bool,
    },
    Error(String),
    Ignore,
}

fn block_index(value: &Value) -> String {
    value
        .get("index")
        .and_then(Value::as_u64)
        .map(|index| index.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn block_id(block: &Value, index: &str) -> String {
    block
        .get("id")
        .or_else(|| block.get("tool_use_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or(index)
        .to_string()
}

fn decode_content_block_start(value: &Value) -> Result<ClaudeEvent, String> {
    let index = block_index(value);
    let block = value
        .get("content_block")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Claude content block start omitted its block".to_string())?;
    let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
    match block_type {
        "tool_use" | "server_tool_use" => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "Claude tool-use block omitted its name".to_string())?;
            Ok(ClaudeEvent::ToolStart {
                id: block_id(block, &index),
                name: name.to_string(),
                arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
            })
        }
        "web_search_tool_result" | "web_fetch_tool_result" | "tool_result" => {
            Ok(ClaudeEvent::ToolResult {
                id: block_id(block, &index),
                result: block
                    .get("content")
                    .or_else(|| block.get("result"))
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        }
        "text" | "thinking" | "redacted_thinking" | "document" | "image" => Ok(ClaudeEvent::Ignore),
        "" => Err("Claude content block start omitted its type".to_string()),
        _ if block_type.contains("tool") => {
            Err("Claude emitted an unsupported native tool block".to_string())
        }
        _ => Err("Claude emitted an unsupported content block type".to_string()),
    }
}

fn decode_content_block_delta(value: &Value) -> Result<ClaudeEvent, String> {
    let index = block_index(value);
    let delta = value
        .get("delta")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Claude content block delta omitted its delta".to_string())?;
    match delta.get("type").and_then(Value::as_str).unwrap_or("") {
        "text_delta" => Ok(ClaudeEvent::Text(
            delta
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Claude text delta omitted its text".to_string())?
                .to_string(),
        )),
        "thinking_delta" | "redacted_thinking_delta" => Ok(ClaudeEvent::Thinking(
            delta
                .get("thinking")
                .or_else(|| delta.get("text"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Claude thinking delta omitted its text".to_string())?
                .to_string(),
        )),
        "input_json_delta" => {
            let partial = delta
                .get("partial_json")
                .and_then(Value::as_str)
                .ok_or_else(|| "Claude tool input delta omitted its JSON".to_string())?;
            if partial.len() > MAX_TOOL_INPUT_BYTES {
                return Err("Claude tool input exceeded the request limit".to_string());
            }
            Ok(ClaudeEvent::ToolInputDelta {
                index,
                delta: partial.to_string(),
            })
        }
        "signature_delta" | "citations_delta" => Ok(ClaudeEvent::Ignore),
        "" => Err("Claude content block delta omitted its type".to_string()),
        _ => Err("Claude emitted an unsupported content delta type".to_string()),
    }
}

fn decode_assistant_message(value: &Value) -> Result<Vec<ClaudeEvent>, String> {
    let message = value
        .get("message")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Claude assistant event omitted its message".to_string())?;
    let mut events = vec![ClaudeEvent::AssistantMessage(message.clone())];
    if let Some(usage) = message.get("usage").map(parse_usage).transpose()?.flatten() {
        events.push(ClaudeEvent::Usage(usage));
    }
    Ok(events)
}

fn decode_claude_event(value: &Value) -> Result<Vec<ClaudeEvent>, String> {
    let kind = event_type(value)?;
    let mut events = Vec::new();
    if let Some(session_id) = session_from_value(value) {
        events.push(ClaudeEvent::Session(
            valid_session_id(session_id)?.to_string(),
        ));
    }
    match kind {
        "system" => match value.get("subtype").and_then(Value::as_str) {
            Some("init" | "status" | "compact_boundary") => {}
            Some("api_retry") => events.push(ClaudeEvent::Retry {
                rate_limited: value
                    .get("error")
                    .and_then(Value::as_str)
                    .is_some_and(|error| error.eq_ignore_ascii_case("rate_limit")),
            }),
            _ => return Err("Claude emitted an unsupported system event".to_string()),
        },
        "stream_event" => {
            let nested = value
                .get("event")
                .filter(|value| value.is_object())
                .ok_or_else(|| "Claude stream event omitted its event payload".to_string())?;
            match nested.get("type").and_then(Value::as_str).unwrap_or("") {
                "message_start" => {
                    if let Some(message) = nested.get("message") {
                        if let Some(Some(usage)) =
                            message.get("usage").map(parse_usage).transpose()?
                        {
                            events.push(ClaudeEvent::Usage(usage));
                        }
                    }
                }
                "content_block_start" => events.push(decode_content_block_start(nested)?),
                "content_block_delta" => events.push(decode_content_block_delta(nested)?),
                "content_block_stop" => events.push(ClaudeEvent::ToolStop {
                    index: block_index(nested),
                }),
                "message_delta" => {
                    if let Some(usage) = usage_from(nested, &["usage"])? {
                        events.push(ClaudeEvent::Usage(usage));
                    }
                }
                "message_stop" | "ping" => {}
                _ => return Err("Claude emitted an unsupported stream metadata event".to_string()),
            }
        }
        "assistant" | "message" => events.extend(decode_assistant_message(value)?),
        "result" => {
            let success = value
                .get("is_error")
                .and_then(Value::as_bool)
                .map(|is_error| !is_error)
                .unwrap_or_else(|| value.get("subtype").and_then(Value::as_str) == Some("success"));
            let text = value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string);
            let usage = value.get("usage").map(parse_usage).transpose()?.flatten();
            events.push(ClaudeEvent::Result {
                success,
                session_id: session_from_value(value).map(str::to_string),
                text,
                usage,
            });
        }
        "error" => events.push(ClaudeEvent::Error(
            "Claude reported a stream error".to_string(),
        )),
        "tool_use" => events.push(ClaudeEvent::ToolStart {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "Claude tool-use event omitted its id".to_string())?
                .to_string(),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "Claude tool-use event omitted its name".to_string())?
                .to_string(),
            arguments: value.get("input").cloned().unwrap_or_else(|| json!({})),
        }),
        "tool_result" => events.push(ClaudeEvent::ToolResult {
            id: value
                .get("tool_use_id")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "Claude tool-result event omitted its id".to_string())?
                .to_string(),
            result: value
                .get("content")
                .or_else(|| value.get("result"))
                .cloned()
                .unwrap_or(Value::Null),
        }),
        "usage" => {
            if let Some(usage) = parse_usage(value)? {
                events.push(ClaudeEvent::Usage(usage));
            }
        }
        "permission_request" | "control_request" => {
            return Err("Claude requested an unexpected native capability".to_string())
        }
        _ => return Err("Claude emitted an unsupported event type".to_string()),
    }
    Ok(events)
}

fn validate_init_inventory(value: &Value, request: &LocalAgentStartRequest) -> Result<(), String> {
    let allowed_native = native_tool_args(request)
        .into_iter()
        .collect::<HashSet<_>>();
    let allowed_mcp = request
        .tools
        .iter()
        .map(|tool| format!("mcp__{OPEN_BUILDER_MCP_NAME}__{}", tool.name))
        .collect::<HashSet<_>>();
    // Claude's init record is the only point at which we can attest the
    // provider's effective tool set before accepting user content.  Treat
    // omitted inventories as a failed attestation even when the request did
    // not ask for host tools: an absent field cannot prove that the CLI did
    // not enable a native or external capability by default.
    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "Claude init omitted its tool inventory".to_string())?;
    let mut seen_tools = HashSet::with_capacity(tools.len());
    for tool in tools {
        let name = tool
            .as_str()
            .or_else(|| tool.get("name").and_then(Value::as_str))
            .ok_or_else(|| "Claude init returned a malformed tool inventory".to_string())?;
        if !seen_tools.insert(name) {
            return Err("Claude init repeated a tool capability".to_string());
        }
        if !allowed_native.contains(name)
            && !allowed_mcp.contains(name)
            && !CLAUDE_CONTROL_TOOLS.contains(&name)
        {
            return Err("Claude loaded an unauthorized native tool".to_string());
        }
    }

    for native in &allowed_native {
        if !seen_tools.contains(native) {
            return Err("Claude init omitted a requested native tool".to_string());
        }
    }
    for tool in &request.tools {
        let expected = format!("mcp__{OPEN_BUILDER_MCP_NAME}__{}", tool.name);
        if !seen_tools.contains(expected.as_str()) {
            return Err("Claude init omitted a requested Open Builder MCP tool".to_string());
        }
    }

    let servers = value
        .get("mcp_servers")
        .and_then(Value::as_array)
        .ok_or_else(|| "Claude init omitted its MCP inventory".to_string())?;
    let mut seen_servers = HashSet::with_capacity(servers.len());
    let mut open_builder_connected = false;
    for server in servers {
        let name = server
            .as_str()
            .or_else(|| server.get("name").and_then(Value::as_str))
            .ok_or_else(|| "Claude init returned a malformed MCP inventory".to_string())?;
        let canonical_name = match name {
            OPEN_BUILDER_MCP_NAME | "open-builder" => OPEN_BUILDER_MCP_NAME,
            _ => return Err("Claude loaded an external MCP server".to_string()),
        };
        if !seen_servers.insert(canonical_name) {
            return Err("Claude init repeated an MCP server".to_string());
        }
        if canonical_name == OPEN_BUILDER_MCP_NAME {
            if server.get("status").and_then(Value::as_str) != Some("connected") {
                return Err(
                    "Open Builder MCP bridge was not connected during Claude startup".to_string(),
                );
            }
            open_builder_connected = true;
        }
    }
    if !request.tools.is_empty() && !open_builder_connected {
        return Err("Claude did not load the Open Builder MCP bridge".to_string());
    }
    Ok(())
}

async fn wait_for_init(
    io: &mut ClaudeIo,
    context: &ProtocolContext,
    gateway_configured: bool,
) -> Result<String, AdapterError> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        loop {
            let value = io.read_value().await?;
            if event_type(&value)? == "system"
                && value.get("subtype").and_then(Value::as_str) == Some("init")
            {
                let session_id = session_from_value(&value)
                    .ok_or_else(|| "Claude init record omitted its session id".to_string())?;
                valid_session_id(session_id)?;
                if context
                    .request
                    .session_id
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .is_some_and(|expected| expected != session_id)
                {
                    return Err("Claude resumed a different session".into());
                }
                let cwd = value.get("cwd").and_then(Value::as_str).ok_or_else(|| {
                    "Claude init record omitted its working directory".to_string()
                })?;
                let expected_cwd = std::fs::canonicalize(&context.run_dir)
                    .map_err(|_| "failed to resolve the private Claude workspace".to_string())?;
                let actual_cwd = std::fs::canonicalize(cwd)
                    .map_err(|_| "Claude init reported an invalid working directory".to_string())?;
                if actual_cwd != expected_cwd {
                    return Err(
                        "Claude isolation init reported an unexpected working directory".into(),
                    );
                }
                if value.get("permissionMode").and_then(Value::as_str) != Some("dontAsk") {
                    return Err(
                        "Claude isolation init reported an unexpected permission mode".into(),
                    );
                }
                validate_init_inventory(&value, &context.request)?;
                return Ok(session_id.to_string());
            }
            if matches!(
                event_type(&value)?,
                "assistant" | "tool_use" | "tool_result" | "result"
            ) {
                return Err(
                    "Claude emitted user-visible activity before isolation attestation".into(),
                );
            }
            if event_type(&value)? == "error" {
                return Err(safe_error_text(
                    value.get("message").and_then(Value::as_str),
                    "Claude failed its isolated startup handshake",
                    gateway_configured,
                    context.request.session_id.is_some(),
                ));
            }
            if capability_semantic_event(&value) {
                return Err(
                    "Claude emitted an unexpected capability event before isolation attestation"
                        .into(),
                );
            }
        }
    })
    .await
    .map_err(|_| "Claude isolation handshake timed out".to_string())?
}

fn native_tool_name(name: &str) -> Option<&'static str> {
    match name {
        "WebSearch" | "web_search" | "web_search_preview" => Some("web_search"),
        "WebFetch" | "web_fetch" => Some("web_fetch"),
        _ => None,
    }
}

fn send_usage(
    context: &ProtocolContext,
    usage: &ClaudeUsage,
    last_usage: &mut Option<ClaudeUsage>,
) -> Result<(), String> {
    if last_usage.as_ref() == Some(usage) {
        return Ok(());
    }
    *last_usage = Some(usage.clone());
    context
        .channel
        .send(LocalAgentEvent::Usage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cached_input_tokens: usage.cached_input_tokens,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())
}

fn emit_native_start(
    context: &ProtocolContext,
    id: &str,
    name: &str,
    arguments: &Value,
) -> Result<(), String> {
    let normalized = native_tool_name(name)
        .ok_or_else(|| "Claude attempted to use an unauthorized native tool".to_string())?;
    context
        .channel
        .send(LocalAgentEvent::NativeTool {
            call_id: id.to_string(),
            name: normalized.to_string(),
            phase: "started".to_string(),
            arguments: Some(arguments.clone()),
            result: None,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())
}

fn emit_native_end(
    context: &ProtocolContext,
    id: &str,
    name: &str,
    result: Option<Value>,
) -> Result<(), String> {
    let normalized = native_tool_name(name)
        .ok_or_else(|| "Claude attempted to use an unauthorized native tool".to_string())?;
    context
        .channel
        .send(LocalAgentEvent::NativeTool {
            call_id: id.to_string(),
            name: normalized.to_string(),
            phase: "completed".to_string(),
            arguments: None,
            result,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())
}

fn assistant_content_events(message: &Value) -> Result<Vec<ClaudeEvent>, String> {
    let content = message
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Claude assistant message omitted content".to_string())?;
    let mut events = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    events.push(ClaudeEvent::Text(text.to_string()));
                }
            }
            "thinking" | "redacted_thinking" => {
                if let Some(text) = block
                    .get("thinking")
                    .or_else(|| block.get("text"))
                    .and_then(Value::as_str)
                {
                    events.push(ClaudeEvent::Thinking(text.to_string()));
                }
            }
            "tool_use" | "server_tool_use" => {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| "Claude assistant tool block omitted its id".to_string())?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| "Claude assistant tool block omitted its name".to_string())?;
                events.push(ClaudeEvent::ToolStart {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
                });
            }
            "tool_result" | "web_search_tool_result" | "web_fetch_tool_result" => {
                let id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| "Claude assistant tool result omitted its id".to_string())?;
                events.push(ClaudeEvent::ToolResult {
                    id: id.to_string(),
                    result: block
                        .get("content")
                        .or_else(|| block.get("result"))
                        .cloned()
                        .unwrap_or(Value::Null),
                });
            }
            "" => return Err("Claude assistant message contained a malformed block".to_string()),
            "document" | "image" => {}
            _ => return Err("Claude assistant message contained an unsupported block".to_string()),
        }
    }
    Ok(events)
}

async fn run_claude_protocol(
    context: &ProtocolContext,
    io: &mut ClaudeIo,
    gateway_configured: bool,
) -> Result<ProtocolOutcome, AdapterError> {
    if context.cancellation.is_cancelled() {
        return Ok(ProtocolOutcome {
            session_id: context.request.session_id.clone(),
            aborted: true,
        });
    }
    // Claude Code emits its stream-json `system/init` record only after the
    // first user record. The separate no-input preflight has already proved
    // the isolation flags and private configuration, so sending this record
    // is safe; wait_for_init still gates all assistant/tool activity.
    io.send_user(&turn_prompt(&context.request)).await?;
    let session_id = wait_for_init(io, context, gateway_configured).await?;
    context
        .channel
        .send(LocalAgentEvent::Session {
            session_id: session_id.clone(),
            cli_version: context.cli_version.clone(),
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;
    context
        .channel
        .send(LocalAgentEvent::Status {
            state: "streaming".to_string(),
            message: None,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;

    let expected_mcp = context
        .request
        .tools
        .iter()
        .map(|tool| format!("mcp__{OPEN_BUILDER_MCP_NAME}__{}", tool.name))
        .collect::<HashSet<_>>();
    let mut active_native: HashMap<String, String> = HashMap::new();
    let mut tool_input_deltas: HashMap<String, String> = HashMap::new();
    let mut last_usage = None;
    let mut retry_was_rate_limited = false;
    let mut saw_text = false;
    let mut saw_thinking = false;
    loop {
        let value = io.read_value().await?;
        if event_type(&value)? == "error" {
            return Err(safe_error_text(
                value.get("message").and_then(Value::as_str),
                "Claude reported a stream error",
                gateway_configured,
                context.request.session_id.is_some(),
            ));
        }
        for event in decode_claude_event(&value)? {
            match event {
                ClaudeEvent::Session(received) => {
                    if received != session_id {
                        return Err("Claude changed sessions during a run".into());
                    }
                }
                ClaudeEvent::Text(text) => {
                    if !text.is_empty() {
                        saw_text = true;
                        context
                            .channel
                            .send(LocalAgentEvent::TextDelta { delta: text })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                ClaudeEvent::Thinking(text) => {
                    if !text.is_empty() {
                        saw_thinking = true;
                        context
                            .channel
                            .send(LocalAgentEvent::ReasoningDelta { delta: text })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                ClaudeEvent::ToolStart {
                    id,
                    name,
                    arguments,
                } => {
                    if let Some(normalized) = native_tool_name(&name) {
                        if !context.request.native_search {
                            return Err(AdapterError::coded(
                                LocalCliFailureCode::IsolationViolation,
                                "Claude attempted to use disabled native web search",
                            ));
                        }
                        if let std::collections::hash_map::Entry::Vacant(entry) =
                            active_native.entry(id.clone())
                        {
                            emit_native_start(context, &id, normalized, &arguments)?;
                            entry.insert(normalized.to_string());
                        }
                    } else if !expected_mcp.contains(&name) {
                        return Err(AdapterError::coded(
                            LocalCliFailureCode::IsolationViolation,
                            "Claude attempted to use an unauthorized native or MCP tool",
                        ));
                    }
                }
                ClaudeEvent::ToolInputDelta { index, delta } => {
                    let entry = tool_input_deltas.entry(index).or_default();
                    if entry.len().saturating_add(delta.len()) > MAX_TOOL_INPUT_BYTES {
                        return Err("Claude tool input exceeded the request limit".into());
                    }
                    entry.push_str(&delta);
                }
                ClaudeEvent::ToolStop { index } => {
                    let _ = tool_input_deltas.remove(&index);
                }
                ClaudeEvent::ToolResult { id, result } => {
                    if let Some(name) = active_native.remove(&id) {
                        emit_native_end(context, &id, &name, Some(result))?;
                    } else if !id.is_empty() {
                        // MCP results are consumed by the Open Builder bridge.
                        // A result id that did not correspond to a native call is
                        // deliberately ignored because Claude does not guarantee
                        // that MCP result ids are exposed in the same envelope.
                    }
                }
                ClaudeEvent::Usage(usage) => send_usage(context, &usage, &mut last_usage)?,
                ClaudeEvent::AssistantMessage(message) => {
                    if let Some(usage) =
                        message.get("usage").map(parse_usage).transpose()?.flatten()
                    {
                        send_usage(context, &usage, &mut last_usage)?;
                    }
                    for nested in assistant_content_events(&message)? {
                        match nested {
                            ClaudeEvent::Text(text) if !saw_text => {
                                saw_text = true;
                                context
                                    .channel
                                    .send(LocalAgentEvent::TextDelta { delta: text })
                                    .map_err(|_| {
                                        "local agent event consumer is unavailable".to_string()
                                    })?;
                            }
                            ClaudeEvent::Thinking(text) if !saw_thinking => {
                                saw_thinking = true;
                                context
                                    .channel
                                    .send(LocalAgentEvent::ReasoningDelta { delta: text })
                                    .map_err(|_| {
                                        "local agent event consumer is unavailable".to_string()
                                    })?;
                            }
                            ClaudeEvent::ToolStart {
                                id,
                                name,
                                arguments,
                            } => {
                                if let Some(normalized) = native_tool_name(&name) {
                                    if !context.request.native_search {
                                        return Err(AdapterError::coded(
                                            LocalCliFailureCode::IsolationViolation,
                                            "Claude attempted to use disabled native web search",
                                        ));
                                    }
                                    if let std::collections::hash_map::Entry::Vacant(entry) =
                                        active_native.entry(id.clone())
                                    {
                                        emit_native_start(context, &id, normalized, &arguments)?;
                                        entry.insert(normalized.to_string());
                                    }
                                } else if !expected_mcp.contains(&name) {
                                    return Err(AdapterError::coded(
                                        LocalCliFailureCode::IsolationViolation,
                                        "Claude attempted to use an unauthorized native or MCP tool",
                                    ));
                                }
                            }
                            ClaudeEvent::ToolResult { id, result } => {
                                if let Some(name) = active_native.remove(&id) {
                                    emit_native_end(context, &id, &name, Some(result))?;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                ClaudeEvent::Result {
                    success,
                    session_id: received_session,
                    text,
                    usage,
                } => {
                    if let Some(received_session) = received_session {
                        if received_session != session_id {
                            return Err("Claude returned a different result session".into());
                        }
                    }
                    if let Some(usage) = usage {
                        send_usage(context, &usage, &mut last_usage)?;
                    }
                    for (id, name) in active_native.drain() {
                        emit_native_end(context, &id, &name, None)?;
                    }
                    if success {
                        if !saw_text {
                            if let Some(text) = text.filter(|text| !text.is_empty()) {
                                context
                                    .channel
                                    .send(LocalAgentEvent::TextDelta { delta: text })
                                    .map_err(|_| {
                                        "local agent event consumer is unavailable".to_string()
                                    })?;
                            }
                        }
                        return Ok(ProtocolOutcome {
                            session_id: Some(session_id.clone()),
                            aborted: false,
                        });
                    }
                    if retry_was_rate_limited {
                        return Err(AdapterError::coded(
                            LocalCliFailureCode::ProcessExit,
                            "Claude request was rate limited",
                        ));
                    }
                    return Err(safe_error_text(
                        text.as_deref(),
                        "Claude model request failed",
                        gateway_configured,
                        context.request.session_id.is_some(),
                    ));
                }
                ClaudeEvent::Retry { rate_limited } => {
                    retry_was_rate_limited |= rate_limited;
                }
                ClaudeEvent::Error(message) => return Err(message.into()),
                ClaudeEvent::Ignore => {}
            }
        }
    }
}

fn safe_error_text(
    value: Option<&str>,
    fallback: &str,
    gateway_configured: bool,
    attempted_resume: bool,
) -> AdapterError {
    let Some(text) = value.filter(|text| !text.trim().is_empty()) else {
        return fallback.into();
    };
    // Result payloads are provider-controlled and may contain authentication,
    // endpoint, or configuration details. Expose only a coarse category; the
    // raw payload remains in the CLI process and never reaches the renderer.
    let lower = text
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_ERROR_BYTES)
        .collect::<String>()
        .to_ascii_lowercase();
    let mentions_session = ["session", "conversation", "resume"]
        .iter()
        .any(|needle| lower.contains(needle));
    let unavailable = [
        "invalid",
        "missing",
        "not found",
        "expired",
        "unavailable",
        "does not exist",
        "no conversation found",
        "no session found",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if attempted_resume && mentions_session && unavailable {
        AdapterError::coded(
            LocalCliFailureCode::SessionUnavailable,
            "Claude session is unavailable",
        )
    } else if ["permission", "forbidden", "approval"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::ProviderApprovalRejected,
            "Claude provider approval rejected the requested capability.",
        )
    } else if ["native", "tool", "capability", "mcp"]
        .iter()
        .any(|needle| lower.contains(needle))
        && ["unauthor", "disabled", "unexpected"]
            .iter()
            .any(|needle| lower.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::IsolationViolation,
            "Claude requested an unavailable capability.",
        )
    } else if ["auth", "login", "unauthor", "credential", "token"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::CredentialRejected,
            if gateway_configured {
                "Claude gateway authentication failed; check its configured credential."
            } else {
                "Claude authentication failed; run claude auth login."
            },
        )
    } else if [
        "unknown model",
        "model not found",
        "invalid model",
        "selected model",
        "reasoning effort",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::ModelRejected,
            "Claude selected model or reasoning effort was rejected.",
        )
    } else if ["tool", "capability"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::IsolationViolation,
            "Claude requested an unavailable capability.",
        )
    } else if ["rate", "overload", "timeout", "temporarily"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        if lower.contains("rate") {
            AdapterError::coded(
                LocalCliFailureCode::ProcessExit,
                "Claude request was rate limited",
            )
        } else {
            "Claude request could not be completed; retry later.".into()
        }
    } else {
        fallback.into()
    }
}

pub(crate) struct PreparedClaudeRun {
    context: ProtocolContext,
    provider_environment: ClaudeProviderEnvironment,
    files: ClaudeRunFiles,
    process_spec: FrozenProcessSpec,
    configuration_fingerprint: String,
}

impl PreparedClaudeRun {
    pub(crate) fn configuration_fingerprint(&self) -> &str {
        &self.configuration_fingerprint
    }
}

fn frozen_process_spec(
    context: &ProtocolContext,
    provider_environment: &ClaudeProviderEnvironment,
    args: &[String],
) -> Result<FrozenProcessSpec, String> {
    let mut command = Command::new(&context.executable);
    apply_minimal_environment(&mut command);
    provider_environment.apply(&mut command);
    command
        .args(args)
        .current_dir(&context.run_dir)
        .env(CLAUDE_MCP_TOKEN_ENV, &context.bridge_token)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    FrozenProcessSpec::capture(&command).map(|spec| spec.redact_value(&context.bridge_token))
}

fn prepare_with_environment(
    context: ProtocolContext,
    provider_environment: ClaudeProviderEnvironment,
) -> Result<PreparedClaudeRun, String> {
    let files = prepare_run_files(&context)?;
    let configured_model = provider_environment
        .value("ANTHROPIC_MODEL")
        .or(provider_environment.configured_model.as_deref());
    let args = claude_args(
        &context.request,
        &files.system_prompt,
        &files.mcp_config,
        configured_model,
        provider_environment.configured_effort.as_deref(),
    )?;
    let process_spec = frozen_process_spec(&context, &provider_environment, &args)?;
    let configuration_fingerprint = configuration_fingerprint_for(&provider_environment);
    Ok(PreparedClaudeRun {
        context,
        provider_environment,
        files,
        process_spec,
        configuration_fingerprint,
    })
}

pub(crate) fn prepare_run(context: ProtocolContext) -> Result<PreparedClaudeRun, AdapterError> {
    let provider_environment = load_provider_environment()?;
    Ok(prepare_with_environment(context, provider_environment)?)
}

pub(crate) async fn launch_prepared(
    prepared: PreparedClaudeRun,
) -> Result<ProtocolOutcome, AdapterError> {
    let PreparedClaudeRun {
        context,
        provider_environment,
        files,
        process_spec,
        ..
    } = prepared;
    // Keep private files alive for the entire child-process lifetime. The
    // argv and environment were frozen by prepare_run; this launch path must
    // not reload settings or rebuild provider arguments.
    for file in [&files.system_prompt_file, &files.mcp_config_file] {
        file.verify_unchanged()
            .map_err(|_| PREPARED_PRIVATE_FILES_CHANGED_ERROR.to_string())?;
    }
    let _files = files;
    let gateway_configured = provider_environment.is_gateway;
    drop(provider_environment);
    run_prepared(&context, process_spec, gateway_configured).await
}

async fn run_prepared(
    context: &ProtocolContext,
    process_spec: FrozenProcessSpec,
    gateway_configured: bool,
) -> Result<ProtocolOutcome, AdapterError> {
    let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
    let supervisor = process.supervisor;
    let mut io = ClaudeIo {
        stdin: process.stdin,
        reader: BufReader::new(process.stdout),
        cancellation: context.cancellation.clone(),
        output_budget: ProtocolOutputBudget::default(),
    };
    let run_result = supervisor
        .monitor(run_claude_protocol(context, &mut io, gateway_configured))
        .await;
    drop(io.stdin);
    supervisor
        .finish(
            run_result,
            "Claude stream-json process exited unsuccessfully",
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_agent::LocalToolResolution;
    use crate::local_agent_bridge::ToolBridge;
    use tauri::ipc::InvokeResponseBody;
    use tokio::sync::mpsc;

    const CONTRACT_HOST_TOOL: &str = "host_write_probe";
    const CONTRACT_HOST_RESULT: &str = "host-resolution-ok:claude";

    fn compile_contract_cli(mode: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "open-builder-claude-contract-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            format!("open-builder-claude-contract-{mode}.exe")
        } else {
            format!("open-builder-claude-contract-{mode}")
        });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_local_cli.rs");
        let output = std::process::Command::new("rustc")
            .arg("--edition=2021")
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fake Claude CLI failed to compile: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        (root, executable)
    }

    fn event_channel() -> (
        tauri::ipc::Channel<LocalAgentEvent>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(value) = serde_json::from_str(&json) {
                    let _ = sender.send(value);
                }
            }
            Ok(())
        });
        (channel, receiver)
    }

    fn protocol_context(
        root: &Path,
        executable: PathBuf,
        request: LocalAgentStartRequest,
        channel: tauri::ipc::Channel<LocalAgentEvent>,
    ) -> ProtocolContext {
        let run_dir = root.join("run directory with spaces");
        let session_dir = root.join("session");
        let workspace_dir = root.join("workspace");
        for directory in [&run_dir, &session_dir, &workspace_dir] {
            std::fs::create_dir_all(directory).unwrap();
        }
        ProtocolContext {
            executable,
            request,
            run_dir,
            session_dir,
            workspace_dir,
            bridge_url: "http://127.0.0.1:34567/mcp".to_string(),
            bridge_token: "secret-bridge-token".to_string(),
            cancellation: CancellationToken::new(),
            channel: channel.into(),
            cli_version: "2.1.251-test".to_string(),
        }
    }

    async fn execute_contract(context: &ProtocolContext) -> Result<ProtocolOutcome, AdapterError> {
        let files = prepare_run_files(context)?;
        let args = claude_args(
            &context.request,
            &files.system_prompt,
            &files.mcp_config,
            None,
            None,
        )?;
        let provider_environment = provider_environment_from_sources(None, &BTreeMap::new())?;
        let process_spec = frozen_process_spec(context, &provider_environment, &args)?;
        let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
        let supervisor = process.supervisor;
        let mut io = ClaudeIo {
            stdin: process.stdin,
            reader: BufReader::new(process.stdout),
            cancellation: context.cancellation.clone(),
            output_budget: ProtocolOutputBudget::default(),
        };
        let result = supervisor
            .monitor(run_claude_protocol(context, &mut io, false))
            .await;
        drop(io.stdin);
        supervisor
            .finish(result, "Claude fake contract process exited unsuccessfully")
            .await
    }

    fn request(native_search: bool) -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider: crate::local_agent::LocalAgentProvider::Claude,
            model: None,
            effort: None,
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: None,
            session_id: None,
            session_compatibility_key: None,
            scope: crate::local_agent::LocalAgentRunScope {
                kind: crate::local_agent::LocalAgentRunScopeKind::Conversation,
                id: "test-conversation".to_string(),
            },
            tools: vec![crate::local_agent::LocalToolSpec {
                name: "read_file".to_string(),
                description: "read a file".to_string(),
                input_schema: json!({"type":"object"}),
                annotations: Default::default(),
                host_approval: Default::default(),
            }],
            max_tool_calls: 2,
            native_search,
            mode: "chat".to_string(),
        }
    }

    #[test]
    fn prepared_run_freezes_claude_files_and_configuration_fingerprint() {
        let root = private_directory("open-builder-claude-prepared-test").unwrap();
        let (channel, _events) = event_channel();
        let context = protocol_context(&root.0, PathBuf::from("claude"), request(false), channel);
        let initial_environment = provider_environment_from_sources(
            Some(&json!({"model":"opus-before","effortLevel":"high"})),
            &BTreeMap::new(),
        )
        .unwrap();
        let prepared = prepare_with_environment(context, initial_environment).unwrap();
        let initial_fingerprint = prepared.configuration_fingerprint().to_string();

        let changed_environment = provider_environment_from_sources(
            Some(&json!({"model":"opus-after","effortLevel":"low"})),
            &BTreeMap::new(),
        )
        .unwrap();
        let changed_fingerprint = configuration_fingerprint_for(&changed_environment);

        assert!(prepared.files.system_prompt.is_file());
        assert!(prepared.files.mcp_config.is_file());
        assert_ne!(initial_fingerprint, changed_fingerprint);
        assert_eq!(prepared.configuration_fingerprint(), initial_fingerprint);
    }

    #[tokio::test]
    async fn launch_rejects_tampered_private_file_before_spawning() {
        let (root, executable) = compile_contract_cli("success");
        let (channel, _events) = event_channel();
        let context = protocol_context(&root, executable, request(false), channel);
        let environment = provider_environment_from_sources(None, &BTreeMap::new()).unwrap();
        let prepared = prepare_with_environment(context, environment).unwrap();
        std::fs::write(&prepared.files.system_prompt, b"tampered").unwrap();

        let error = launch_prepared(prepared).await.unwrap_err();
        assert_eq!(error.message, PREPARED_PRIVATE_FILES_CHANGED_ERROR);
        assert!(!root.join("provider-invocation.log").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn args_prove_hidden_system_prompt_file_and_strict_isolation() {
        let req = request(true);
        let args = claude_args(
            &req,
            Path::new("/private/system"),
            Path::new("/private/mcp"),
            None,
            None,
        )
        .unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--system-prompt-file", "/private/system"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--mcp-config", "/private/mcp"]));
        assert!(!args.iter().any(|arg| arg == "--settings"));
        for flag in [
            "--restricted",
            "--strict-mcp-config",
            "--include-partial-messages",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "missing {flag}");
        }
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "dontAsk"]));
        assert!(args.windows(2).any(|pair| pair == ["--tools", "WebSearch"]));
        assert!(args.iter().any(|arg| arg == "WebFetch"));
        assert!(args.iter().any(|arg| arg == "mcp__open_builder__read_file"));
    }

    #[test]
    fn args_disable_native_tools_without_search_and_resume_provider_session() {
        let mut req = request(false);
        req.session_id = Some("claude-session-1".to_string());
        let args = claude_args(&req, Path::new("system"), Path::new("mcp"), None, None).unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(!args
            .iter()
            .any(|arg| arg == "WebSearch" || arg == "WebFetch"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--resume", "claude-session-1"]));
    }

    #[test]
    fn configured_model_and_effort_are_imported_when_ui_overrides_are_empty() {
        let req = request(false);
        let args = claude_args(
            &req,
            Path::new("system"),
            Path::new("mcp"),
            Some("opus"),
            Some("max"),
        )
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--model", "opus"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "max"]));
    }

    #[test]
    fn future_safe_effort_reaches_the_model_strategy_and_cli() {
        let mut req = request(false);
        req.effort = Some("future:v2".to_string());

        assert!(validate_request(&req).is_ok());
        let args = claude_args(&req, Path::new("system"), Path::new("mcp"), None, None).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--effort", "future:v2"]));

        req.effort = Some("unsafe effort".to_string());
        assert!(validate_request(&req).is_err());
        assert!(claude_args(&req, Path::new("system"), Path::new("mcp"), None, None,).is_err());
    }

    #[test]
    fn parses_auth_status_without_exposing_payload() {
        let output = std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: br#"{"loggedIn":false,"authMethod":"secret"}"#.to_vec(),
            stderr: Vec::new(),
        };
        assert!(!parse_auth_status(&output).unwrap());
    }

    #[test]
    fn user_settings_path_accepts_only_bounded_regular_files() {
        let directory = private_directory("open-builder-claude-settings-test").unwrap();
        let settings = directory.0.join("settings.json");
        write_private_file(&settings, br#"{"env":{}}"#).unwrap();
        assert_eq!(
            validate_user_settings_path(&settings).unwrap(),
            Some(settings.clone())
        );

        let not_a_file = directory.0.join("settings-directory");
        std::fs::create_dir(&not_a_file).unwrap();
        assert!(validate_user_settings_path(&not_a_file).is_err());

        let oversized = directory.0.join("oversized.json");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_CLAUDE_SETTINGS_BYTES + 1).unwrap();
        assert!(validate_user_settings_path(&oversized).is_err());
    }

    #[test]
    fn gateway_environment_copies_only_the_explicit_allowlist() {
        let settings = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://gateway.example/v1",
                "ANTHROPIC_AUTH_TOKEN": "settings-secret",
                "ANTHROPIC_CUSTOM_HEADERS": "X-Team: builders\nX-Route: claude",
                "ANTHROPIC_MODEL": "gateway-claude",
                "NODE_OPTIONS": "--require /tmp/unsafe.js",
                "OPEN_BUILDER_MCP_TOKEN": "replacement",
                "CLAUDE_CODE_USE_BEDROCK": "1"
            },
            "permissions": {"defaultMode": "bypassPermissions"},
            "hooks": {"SessionStart": [{"command": "unsafe"}]},
            "enabledPlugins": {"unsafe": true},
            "mcpServers": {"external": {"command": "unsafe"}}
        });
        let inherited = BTreeMap::from([(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "process-secret".to_string(),
        )]);
        let environment = provider_environment_from_sources(Some(&settings), &inherited).unwrap();
        let names = environment
            .values
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<HashSet<_>>();

        assert!(environment.is_gateway);
        assert!(environment.bypasses_auth_status());
        assert!(names.contains("ANTHROPIC_BASE_URL"));
        assert!(names.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(names.contains("ANTHROPIC_CUSTOM_HEADERS"));
        assert!(names.contains("ANTHROPIC_MODEL"));
        for rejected in [
            "NODE_OPTIONS",
            "OPEN_BUILDER_MCP_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "permissions",
            "hooks",
            "enabledPlugins",
            "mcpServers",
        ] {
            assert!(!names.contains(rejected));
        }
        assert!(environment
            .values
            .iter()
            .any(|(name, value)| { name == "ANTHROPIC_AUTH_TOKEN" && value == "process-secret" }));
    }

    #[test]
    fn local_model_declarations_keep_aliases_before_exact_ids() {
        let settings = json!({
            "model": "opus",
            "effortLevel": "max",
            "env": {
                "ANTHROPIC_BASE_URL": "https://gateway.example/v1",
                "ANTHROPIC_AUTH_TOKEN": "secret",
                "ANTHROPIC_MODEL": "gpt-5.6-sol",
                "ANTHROPIC_DEFAULT_FABLE_MODEL": "route-fable",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "route-opus",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Gateway Opus",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES":
                    "effort,xhigh_effort,max_effort,thinking",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "route-sonnet",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "route-haiku",
                "ANTHROPIC_CUSTOM_MODEL_OPTION": "custom-route",
                "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Custom route"
            }
        });
        let environment =
            provider_environment_from_sources(Some(&settings), &BTreeMap::new()).unwrap();
        let (candidates, authority, configured, gateway) =
            model_catalog_context_from_environment(&environment);

        assert_eq!(authority, CatalogAuthority::Partial);
        assert_eq!(configured.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(configured.effort.as_deref(), Some("max"));
        assert!(gateway.is_some());
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.model.id.as_str())
                .collect::<Vec<_>>(),
            ["fable", "opus", "sonnet", "haiku", "custom-route",]
        );
        let opus = &candidates[1];
        assert_eq!(opus.model.display_name, "Gateway Opus");
        assert_eq!(opus.effort_knowledge, EffortKnowledge::Known);
        assert_eq!(
            opus.model.efforts,
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(candidates[4].effort_knowledge, EffortKnowledge::Unknown);
    }

    #[test]
    fn built_in_aliases_remain_available_without_gateway_declarations() {
        let environment = provider_environment_from_sources(None, &BTreeMap::new()).unwrap();
        let (candidates, authority, configured, gateway) =
            model_catalog_context_from_environment(&environment);

        assert_eq!(authority, CatalogAuthority::Partial);
        assert_eq!(configured, ModelPreference::default());
        assert!(gateway.is_none());
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.model.id.as_str())
                .collect::<Vec<_>>(),
            ["fable", "opus", "sonnet", "haiku"]
        );
        assert!(candidates
            .iter()
            .all(|candidate| candidate.effort_knowledge == EffortKnowledge::Known));
        assert!(candidates
            .iter()
            .all(|candidate| candidate.model.efforts.len() == CLAUDE_EFFORTS.len()));
    }

    #[test]
    fn top_level_model_and_effort_are_preserved_for_isolated_launches() {
        let settings = json!({"model":"opus","effortLevel":"max"});
        let environment =
            provider_environment_from_sources(Some(&settings), &BTreeMap::new()).unwrap();
        let (candidates, _, configured, _) = model_catalog_context_from_environment(&environment);

        assert_eq!(configured.model.as_deref(), Some("opus"));
        assert_eq!(configured.effort.as_deref(), Some("max"));
        assert!(candidates
            .iter()
            .find(|candidate| candidate.model.id == "opus")
            .is_some_and(|candidate| candidate.model.is_default));
    }

    #[test]
    fn top_level_future_safe_effort_is_preserved_as_unverified_input() {
        let settings = json!({"effortLevel":"future:v2"});
        let environment =
            provider_environment_from_sources(Some(&settings), &BTreeMap::new()).unwrap();
        let (_, _, configured, _) = model_catalog_context_from_environment(&environment);

        assert_eq!(configured.effort.as_deref(), Some("future:v2"));
    }

    #[test]
    fn gateway_environment_rejects_unsafe_urls_and_missing_credentials() {
        for base_url in [
            "http://gateway.example",
            "https://user:secret@gateway.example",
            "https://gateway.example/?token=secret",
            "https://gateway.example/#fragment",
        ] {
            let settings = json!({"env": {
                "ANTHROPIC_BASE_URL": base_url,
                "ANTHROPIC_AUTH_TOKEN": "secret"
            }});
            assert!(provider_environment_from_sources(Some(&settings), &BTreeMap::new()).is_err());
        }

        let missing_credential = json!({"env": {"ANTHROPIC_BASE_URL": "https://gateway.example"}});
        assert!(
            provider_environment_from_sources(Some(&missing_credential), &BTreeMap::new()).is_err()
        );

        let loopback = json!({"env": {
            "ANTHROPIC_BASE_URL": "http://127.2.3.4:4000",
            "ANTHROPIC_API_KEY": "secret"
        }});
        assert!(
            provider_environment_from_sources(Some(&loopback), &BTreeMap::new())
                .unwrap()
                .is_gateway
        );
    }

    #[test]
    fn parses_pretty_printed_auth_status_without_exposing_payload() {
        let output = std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: b"{\n  \"loggedIn\": true,\n  \"authMethod\": \"secret\"\n}\n".to_vec(),
            stderr: Vec::new(),
        };
        assert!(parse_auth_status(&output).unwrap());
    }

    #[test]
    fn malformed_auth_status_is_an_error() {
        let output = std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: b"not-json".to_vec(),
            stderr: Vec::new(),
        };
        assert!(parse_auth_status(&output).is_err());
    }

    #[test]
    fn redacts_provider_error_payloads() {
        let error = safe_error_text(
            Some("authorization failed: bearer secret-token and endpoint details"),
            "Claude model request failed",
            false,
            false,
        );
        assert_eq!(error.code, Some(LocalCliFailureCode::CredentialRejected));
        assert_eq!(
            error.message,
            "Claude authentication failed; run claude auth login."
        );
        assert!(!error.message.contains("secret-token"));

        let gateway_error = safe_error_text(
            Some("authorization failed: bearer secret-token and endpoint details"),
            "Claude model request failed",
            true,
            false,
        );
        assert_eq!(
            gateway_error.code,
            Some(LocalCliFailureCode::CredentialRejected)
        );
        assert_eq!(
            gateway_error.message,
            "Claude gateway authentication failed; check its configured credential."
        );
        assert!(!gateway_error.message.contains("secret-token"));

        let session = safe_error_text(
            Some("No conversation found for session resume-123"),
            "Claude model request failed",
            false,
            true,
        );
        assert_eq!(session.code, Some(LocalCliFailureCode::SessionUnavailable));
        assert_eq!(session.message, "Claude session is unavailable");

        let model = safe_error_text(
            Some("invalid model selection"),
            "Claude model request failed",
            false,
            false,
        );
        assert_eq!(model.code, Some(LocalCliFailureCode::ModelRejected));

        let isolation = safe_error_text(
            Some("attempted an unauthorized native tool"),
            "Claude model request failed",
            false,
            false,
        );
        assert_eq!(
            isolation.code,
            Some(LocalCliFailureCode::IsolationViolation)
        );

        let approval = safe_error_text(
            Some("permission denied for a tool call"),
            "Claude model request failed",
            false,
            false,
        );
        assert_eq!(
            approval.code,
            Some(LocalCliFailureCode::ProviderApprovalRejected)
        );

        let generic = safe_error_text(
            Some("No conversation found for session resume-123"),
            "Claude model request failed",
            false,
            false,
        );
        assert_eq!(generic.code, None);
        assert_eq!(generic.message, "Claude model request failed");
    }

    #[test]
    fn parses_stream_text_thinking_usage_and_result() {
        let text = decode_claude_event(&json!({
            "type":"stream_event",
            "event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}
        }))
        .unwrap();
        assert_eq!(text, vec![ClaudeEvent::Text("hello".to_string())]);
        let thinking = decode_claude_event(&json!({
            "type":"stream_event",
            "event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"reason"}}
        }))
        .unwrap();
        assert_eq!(thinking, vec![ClaudeEvent::Thinking("reason".to_string())]);
        let result = decode_claude_event(&json!({
            "type":"result","subtype":"success","is_error":false,"session_id":"s","result":"done","usage":{"input_tokens":3,"output_tokens":2}
        }))
        .unwrap();
        assert!(matches!(result.first(), Some(ClaudeEvent::Session(_))));
        assert!(result
            .iter()
            .any(|event| matches!(event, ClaudeEvent::Result { success: true, .. })));
    }

    #[test]
    fn rejects_malformed_stream_event_and_unauthorized_tool() {
        assert!(decode_claude_event(&json!({
            "type":"stream_event","event":{"type":"content_block_delta"}
        }))
        .is_err());
        let value = decode_claude_event(&json!({
            "type":"tool_use","id":"tool-1","name":"Bash","input":{}
        }))
        .unwrap();
        let ClaudeEvent::ToolStart { name, .. } = &value[0] else {
            panic!("expected tool event")
        };
        assert!(!request(false)
            .tools
            .iter()
            .any(|tool| format!("mcp__open_builder__{}", tool.name) == *name));
        assert!(native_tool_name(name).is_none());
    }

    #[test]
    fn ignores_only_allowlisted_claude_metadata_events() {
        let retry = decode_claude_event(&json!({
            "type":"system",
            "subtype":"api_retry",
            "attempt":1,
            "error":"rate_limit",
            "retry_delay_ms":10
        }))
        .unwrap();
        assert!(retry
            .iter()
            .any(|event| matches!(event, ClaudeEvent::Retry { rate_limited: true })));
        assert!(decode_claude_event(&json!({
            "type":"stream_event",
            "event":{"type":"ping"}
        }))
        .unwrap()
        .is_empty());
        assert!(decode_claude_event(&json!({"type":"future_noncritical_event"})).is_err());
        assert!(decode_claude_event(&json!({"type":"permission_request"})).is_err());
        assert!(decode_claude_event(&json!({
            "type":"stream_event",
            "event":{"type":"future_tool_request"}
        }))
        .is_err());
    }

    #[test]
    fn private_mcp_config_expands_only_runtime_bearer_token() {
        let context = ProtocolContext {
            executable: PathBuf::from("claude"),
            request: request(false),
            run_dir: PathBuf::from("/tmp"),
            session_dir: PathBuf::from("/tmp/session"),
            workspace_dir: PathBuf::from("/tmp/workspace"),
            bridge_url: "http://127.0.0.1:3333/mcp".to_string(),
            bridge_token: "secret-token".to_string(),
            cancellation: CancellationToken::new(),
            channel: tauri::ipc::Channel::new(|_| Ok(())).into(),
            cli_version: "2.1.251".to_string(),
        };
        let config = mcp_config(&context).unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(serialized.contains("${OPEN_BUILDER_MCP_TOKEN}"));
        assert_eq!(
            config["mcpServers"][OPEN_BUILDER_MCP_NAME]["alwaysLoad"],
            json!(true)
        );
        assert!(!serialized.contains("secret-token"));
    }

    #[test]
    fn preflight_rejects_user_content_before_attestation() {
        assert!(validate_preflight_line(r#"{"type":"assistant"}"#).is_err());
        assert!(validate_preflight_line(r#"{}"#).is_err());
        assert!(validate_preflight_line(r#"{"type":"system","subtype":"init"}"#).is_ok());
        assert!(validate_preflight_line(r#"{"type":"system","subtype":"status"}"#).is_ok());
        for line in [
            r#"{"type":"permission_request","name":"Write"}"#,
            r#"{"type":"control_request","name":"initialize"}"#,
            r#"{"type":"future_tool_request"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}"#,
        ] {
            assert!(validate_preflight_line(line).is_err(), "accepted {line}");
        }
    }

    #[test]
    fn init_inventory_allows_only_requested_mcp_and_native_search_tools() {
        let req = request(true);
        assert!(validate_init_inventory(
            &json!({
                "tools":["mcp__open_builder__read_file","WebSearch","WebFetch"],
                "mcp_servers":[{"name":"open_builder","status":"connected"}]
            }),
            &req
        )
        .is_ok());
        assert!(validate_init_inventory(
            &json!({
                "tools":["Bash"],
                "mcp_servers":[]
            }),
            &req
        )
        .is_err());
        assert!(validate_init_inventory(
            &json!({
                "tools":["mcp__open_builder__read_file","WebSearch","WebFetch","EndConversation"],
                "mcp_servers":[{"name":"open_builder","status":"connected"}]
            }),
            &req
        )
        .is_ok());
        assert!(validate_init_inventory(
            &json!({
                "tools":["WebSearch","WebFetch"],
                "mcp_servers":[{"name":"open_builder","status":"connected"}]
            }),
            &req
        )
        .is_err());
        for status in ["pending", "needs-auth", "failed"] {
            assert!(
                validate_init_inventory(
                    &json!({
                        "tools":["mcp__open_builder__read_file","WebSearch","WebFetch"],
                        "mcp_servers":[{"name":"open_builder","status":status}]
                    }),
                    &req
                )
                .is_err(),
                "accepted Open Builder status {status}"
            );
        }
        assert!(validate_init_inventory(
            &json!({"tools":[],"mcp_servers":[{"name":"filesystem"}]}),
            &req
        )
        .is_err());
    }

    #[test]
    fn init_inventory_requires_both_fields_even_without_requested_tools() {
        let mut req = request(false);
        req.tools.clear();

        assert!(validate_init_inventory(&json!({"tools":[],"mcp_servers":[]}), &req).is_ok());
        assert!(validate_init_inventory(&json!({"mcp_servers":[]}), &req).is_err());
        assert!(validate_init_inventory(&json!({"tools":[]}), &req).is_err());
        assert!(
            validate_init_inventory(&json!({"tools":["Bash"],"mcp_servers":[]}), &req).is_err()
        );
        assert!(validate_init_inventory(
            &json!({"tools":[],"mcp_servers":[{"name":"filesystem"}]}),
            &req
        )
        .is_err());
    }

    #[test]
    fn assistant_content_blocks_fail_closed_for_unknown_types() {
        assert!(assistant_content_events(&json!({
            "content": [{"type":"document"}]
        }))
        .is_ok());
        assert!(assistant_content_events(&json!({
            "content": [{"type":"future_metadata"}]
        }))
        .is_err());
        assert!(assistant_content_events(&json!({
            "content": [{"type":"future_tool_result"}]
        }))
        .is_err());
    }

    #[tokio::test]
    async fn real_fake_process_proves_fresh_and_resume_claude_contracts() {
        for resumed in [false, true] {
            let (root, executable) = compile_contract_cli("success");
            let (channel, mut events) = event_channel();
            let mut request = request(true);
            request.tools[0].name = CONTRACT_HOST_TOOL.to_string();
            request.session_id = resumed.then(|| "resume-claude-session".to_string());
            let expected_session = request
                .session_id
                .clone()
                .unwrap_or_else(|| "fake-claude-session".to_string());
            let run_id = format!("claude-contract-{resumed}");
            let cancellation = CancellationToken::new();
            let bridge = ToolBridge::default();
            let (bridge_url, bridge_token) = bridge
                .register(
                    run_id.clone(),
                    request.tools.clone(),
                    request.max_tool_calls,
                    cancellation.clone(),
                    channel.clone().into(),
                )
                .await
                .unwrap();
            let mut context = protocol_context(&root, executable, request, channel);
            context.bridge_url = bridge_url;
            context.bridge_token = bridge_token;
            context.cancellation = cancellation;

            let run = execute_contract(&context);
            tokio::pin!(run);
            let mut recorded = Vec::new();
            let mut host_request_index = None;
            let outcome = loop {
                tokio::select! {
                    result = &mut run => break result.unwrap(),
                    event = events.recv() => {
                        let event = event.expect("Claude contract event channel closed");
                        let event_index = recorded.len();
                        if event.get("type").and_then(Value::as_str) == Some("toolRequest") {
                            assert!(host_request_index.replace(event_index).is_none());
                            assert_eq!(event["runId"], run_id);
                            assert_eq!(event["name"], CONTRACT_HOST_TOOL);
                            assert_eq!(event["arguments"]["provider"], "claude");
                            bridge.resolve(
                                event["runId"].as_str().unwrap(),
                                event["callId"].as_str().unwrap(),
                                LocalToolResolution {
                                    text: CONTRACT_HOST_RESULT.to_string(),
                                    is_error: Some(false),
                                    structured_content: Some(json!({"provider":"claude","resolved":true})),
                                    content: None,
                                },
                            ).unwrap();
                        }
                        recorded.push(event);
                    }
                }
            };
            assert_eq!(
                outcome.session_id.as_deref(),
                Some(expected_session.as_str())
            );
            assert!(!outcome.aborted);

            while let Ok(event) = events.try_recv() {
                recorded.push(event);
            }
            for event_type in [
                "session",
                "status",
                "reasoningDelta",
                "textDelta",
                "nativeTool",
                "usage",
            ] {
                assert!(
                    recorded
                        .iter()
                        .any(|event| event.get("type").and_then(Value::as_str) == Some(event_type)),
                    "missing {event_type}: {recorded:?}"
                );
            }
            let host_request_index = host_request_index.expect("missing Host tool request");
            let text_index = recorded
                .iter()
                .position(|event| event.get("type").and_then(Value::as_str) == Some("textDelta"))
                .expect("missing Claude text after Host resolution");
            assert!(text_index > host_request_index);

            let invocation = std::fs::read_to_string(root.join("provider-invocation.log")).unwrap();
            assert!(invocation.contains("prompt"));
            assert!(invocation.contains("--input-format\u{1f}stream-json"));
            assert_eq!(invocation.contains("\u{1f}--resume\u{1f}"), resumed);
            assert!(!invocation.contains("secret-bridge-token"));
            bridge.unregister(&run_id, "Claude contract complete");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn real_fake_process_rejects_unknown_claude_capability_event() {
        let (root, executable) = compile_contract_cli("unknown");
        let (channel, _events) = event_channel();
        let mut request = request(true);
        request.tools.clear();
        let context = protocol_context(&root, executable, request, channel);
        let error = match execute_contract(&context).await {
            Ok(_) => panic!("unknown Claude capability event must fail closed"),
            Err(error) => error,
        };
        assert!(
            error.message.contains("unexpected native capability"),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_covers_claude_failure_contracts() {
        for mode in ["malformed", "oversized", "nonzero", "stderr-approval"] {
            let (root, executable) = compile_contract_cli(mode);
            let (channel, _events) = event_channel();
            let context = protocol_context(&root, executable, request(false), channel);
            let error = execute_contract(&context)
                .await
                .expect_err("Claude failure fixture must not complete");
            match mode {
                "malformed" => assert!(error.message.contains("malformed JSON"), "{error}"),
                "oversized" => assert!(error.message.contains("line limit"), "{error}"),
                "stderr-approval" => {
                    assert!(
                        error.message.contains("provider approval rejected"),
                        "{error}"
                    )
                }
                _ => assert!(
                    error.message.contains("failed to write")
                        || error.message.contains("closed unexpectedly")
                        || error.message.contains("closed before"),
                    "{error}"
                ),
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
