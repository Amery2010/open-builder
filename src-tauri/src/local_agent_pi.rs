use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentEvent, LocalAgentModel,
    LocalAgentRunScopeKind, LocalAgentStartRequest, LocalToolSpec,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_bridge::canonical_tool_digest;
use crate::local_agent_models::CatalogAuthority;
use crate::local_agent_protocol::{
    apply_minimal_environment, command_output_capped, finish_process, provider_error,
    spawn_stderr_drain, spawn_wrapped, turn_prompt, write_json, FrozenProcessSpec,
    PreparedPrivateFile, ProtocolContext, ProtocolOutcome, ProtocolOutputBudget, RunSupervisor,
};

const PI_MINIMUM_VERSION: (u64, u64, u64) = (0, 84, 4);
const PI_MAXIMUM_VERSION: (u64, u64, u64) = (0, 85, 0);
const PI_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const PI_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const PI_CANCEL_RESPONSE_TIMEOUT: Duration = Duration::from_millis(750);
const PI_AUTH_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PI_MODELS_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const PI_PROTOCOL_CONFIG_VERSION: u8 = 1;
const PI_CONFIG_ENV: &str = "OPEN_BUILDER_PI_CONFIG";
const PI_PROBE_NONCE_ENV: &str = "OPEN_BUILDER_PI_PROBE_NONCE";
const PI_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
const PI_EXTENSION_SOURCE: &str = include_str!("local_agent_pi_extension.mjs");
const PI_PROBE_EXTENSION_SOURCE: &str = include_str!("local_agent_pi_probe_extension.mjs");
const PI_ATTEST_COMMAND: &str = "/open-builder-attest";
const PI_AUTH_PROBE_COMMAND: &str = "open-builder-probe-auth";
const MAX_PI_MODELS: usize = 100;
const MAX_PI_JSON_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PI_SESSION_BYTES: usize = 128 * 1024 * 1024;
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PI_BUILTIN_TOOL_NAMES: &[&str] = &[
    "read",
    "bash",
    "powershell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
];

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "pi",
    setup_command: "pi",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: false,
    },
    probe_timeout: Duration::from_secs(30),
    unix_home_directories: &[".pi/bin"],
    windows_home_directories: &[".pi\\bin"],
    windows_local_directories: &["Programs\\Pi"],
    windows_program_directories: &["Pi"],
    require_empty_workspace: true,
};

fn pi_models_path() -> Result<Option<PathBuf>, String> {
    let configured = std::env::var_os(PI_AGENT_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let agent_dir = match configured {
        Some(path) if path.is_absolute() => Some(path),
        Some(_) => return Err("Pi agent directory must use an absolute path".to_string()),
        None => {
            #[cfg(windows)]
            let home = std::env::var_os("USERPROFILE");
            #[cfg(not(windows))]
            let home = std::env::var_os("HOME");
            home.map(|home| PathBuf::from(home).join(".pi").join("agent"))
        }
    };
    Ok(agent_dir.map(|path| path.join("models.json")))
}

fn safe_endpoint_identity(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value)
        .map_err(|_| "Pi models configuration contains an invalid provider URL".to_string())?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn safe_model_routing_identity(value: &Value) -> Result<String, String> {
    let providers = value
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| "Pi models configuration is missing its provider map".to_string())?;
    let mut safe_providers = serde_json::Map::new();
    for (provider_id, provider_value) in providers {
        let provider = provider_value
            .as_object()
            .ok_or_else(|| "Pi models configuration contains an invalid provider".to_string())?;
        let mut safe_provider = serde_json::Map::new();
        for key in ["api", "oauth"] {
            if let Some(value) = provider.get(key).and_then(Value::as_str) {
                safe_provider.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
        if let Some(value) = provider.get("authHeader").and_then(Value::as_bool) {
            safe_provider.insert("authHeader".to_string(), Value::Bool(value));
        }
        if let Some(value) = provider.get("baseUrl").and_then(Value::as_str) {
            safe_provider.insert(
                "baseUrl".to_string(),
                Value::String(safe_endpoint_identity(value)?),
            );
        }
        if let Some(headers) = provider.get("headers").and_then(Value::as_object) {
            let names = headers.keys().cloned().map(Value::String).collect();
            safe_provider.insert("headerNames".to_string(), Value::Array(names));
        }
        if let Some(models) = provider.get("models").and_then(Value::as_array) {
            let mut safe_models = Vec::with_capacity(models.len());
            for model_value in models {
                let model = model_value.as_object().ok_or_else(|| {
                    "Pi models configuration contains an invalid model".to_string()
                })?;
                let mut safe_model = serde_json::Map::new();
                for key in ["id", "api"] {
                    if let Some(value) = model.get(key).and_then(Value::as_str) {
                        safe_model.insert(key.to_string(), Value::String(value.to_string()));
                    }
                }
                if let Some(value) = model.get("baseUrl").and_then(Value::as_str) {
                    safe_model.insert(
                        "baseUrl".to_string(),
                        Value::String(safe_endpoint_identity(value)?),
                    );
                }
                if let Some(headers) = model.get("headers").and_then(Value::as_object) {
                    let names = headers.keys().cloned().map(Value::String).collect();
                    safe_model.insert("headerNames".to_string(), Value::Array(names));
                }
                safe_models.push(Value::Object(safe_model));
            }
            safe_provider.insert("models".to_string(), Value::Array(safe_models));
        }
        if let Some(overrides) = provider.get("modelOverrides").and_then(Value::as_object) {
            let mut safe_overrides = serde_json::Map::new();
            for (model_id, override_value) in overrides {
                let override_object = override_value.as_object().ok_or_else(|| {
                    "Pi models configuration contains an invalid model override".to_string()
                })?;
                let mut safe_override = serde_json::Map::new();
                for key in ["api", "baseUrl"] {
                    if let Some(value) = override_object.get(key).and_then(Value::as_str) {
                        let value = if key == "baseUrl" {
                            safe_endpoint_identity(value)?
                        } else {
                            value.to_string()
                        };
                        safe_override.insert(key.to_string(), Value::String(value));
                    }
                }
                if let Some(headers) = override_object.get("headers").and_then(Value::as_object) {
                    let names = headers.keys().cloned().map(Value::String).collect();
                    safe_override.insert("headerNames".to_string(), Value::Array(names));
                }
                safe_overrides.insert(model_id.clone(), Value::Object(safe_override));
            }
            safe_provider.insert("modelOverrides".to_string(), Value::Object(safe_overrides));
        }
        safe_providers.insert(provider_id.clone(), Value::Object(safe_provider));
    }
    let identity = serde_json::to_string(&Value::Object(safe_providers))
        .map_err(|_| "failed to fingerprint Pi model routing".to_string())?;
    Ok(crate::local_agent_runtime::hash_compatibility_material(&[
        "pi-model-routing-v1",
        &identity,
    ]))
}

fn models_configuration_identity() -> Result<String, String> {
    let Some(path) = pi_models_path()? else {
        return Ok("pi-model-routing-builtin".to_string());
    };
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok("pi-model-routing-builtin".to_string())
        }
        Err(_) => return Err("failed to inspect Pi models configuration".to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_PI_MODELS_CONFIG_BYTES {
        return Err(
            "Pi models configuration must be a regular file no larger than 2 MiB".to_string(),
        );
    }
    let bytes =
        std::fs::read(path).map_err(|_| "failed to read Pi models configuration".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Pi models configuration contains malformed JSON".to_string())?;
    safe_model_routing_identity(&value)
}

pub(crate) fn configuration_fingerprint() -> Result<String, String> {
    let minimum = format!(
        "{}.{}.{}",
        PI_MINIMUM_VERSION.0, PI_MINIMUM_VERSION.1, PI_MINIMUM_VERSION.2
    );
    let maximum = format!(
        "{}.{}.{}",
        PI_MAXIMUM_VERSION.0, PI_MAXIMUM_VERSION.1, PI_MAXIMUM_VERSION.2
    );
    let model_routing = models_configuration_identity()?;
    Ok(crate::local_agent_runtime::hash_compatibility_material(&[
        "pi-provider-config-v2",
        &format!("protocol={PI_PROTOCOL_CONFIG_VERSION}"),
        &format!("supported={minimum}..<{maximum}"),
        &model_routing,
        "credential-source=stored-auth-json",
        "native-tools=disabled",
        PI_EXTENSION_SOURCE,
        PI_PROBE_EXTENSION_SOURCE,
    ]))
}

pub(crate) struct PiProbeResult {
    pub ready: bool,
    pub models: Vec<LocalAgentModel>,
    pub catalog_authority: CatalogAuthority,
    pub message: Option<String>,
}

fn pi_catalog_authority(skipped_providers: bool) -> CatalogAuthority {
    if skipped_providers {
        CatalogAuthority::Partial
    } else {
        CatalogAuthority::Authoritative
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PiModelRef {
    provider: String,
    id: String,
}

#[derive(Clone, Debug)]
struct PiModelDescriptor {
    reference: PiModelRef,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiConfig<'a> {
    version: u8,
    tools_url: &'a str,
    call_url: &'a str,
    bearer_token: &'a str,
    attestation_nonce: &'a str,
    expected_cwd: &'a str,
    expected_model: Option<PiConfigModel<'a>>,
    system_prompt: &'a str,
    system_prompt_nonce: &'a str,
    expected_tool_names: &'a [String],
    tool_digest: &'a str,
    extension_path: &'a str,
}

#[derive(Serialize)]
struct PiConfigModel<'a> {
    provider: &'a str,
    id: &'a str,
}

struct PiIo {
    stdin: Box<dyn AsyncWrite + Send + Unpin>,
    reader: Box<dyn AsyncBufRead + Send + Unpin>,
    next_id: u64,
    cancellation: CancellationToken,
    output_budget: ProtocolOutputBudget,
    pending: VecDeque<Value>,
    completed_ids: HashSet<String>,
}

impl PiIo {
    async fn read_fresh_value(&mut self, observe_cancellation: bool) -> Result<Value, String> {
        loop {
            let line = if observe_cancellation {
                tokio::select! {
                    _ = self.cancellation.cancelled() => {
                        return Err("local agent run cancelled".to_string());
                    }
                    line = read_pi_line(&mut self.reader) => line?,
                }
            } else {
                read_pi_line(&mut self.reader).await?
            }
            .ok_or_else(|| "Pi RPC closed unexpectedly".to_string())?;
            self.output_budget.record(&line)?;
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| "Pi RPC emitted malformed JSON".to_string())?;
            if !value.is_object() {
                return Err("Pi RPC emitted a non-object record".to_string());
            }
            let completed_duplicate = value.get("type").and_then(Value::as_str) == Some("response")
                && value
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.completed_ids.contains(id));
            if !completed_duplicate {
                return Ok(value);
            }
        }
    }

    async fn next_value(&mut self) -> Result<Value, String> {
        if let Some(value) = self.pending.pop_front() {
            return Ok(value);
        }
        self.read_fresh_value(true).await
    }

    async fn request(&mut self, command: &str, mut body: Value) -> Result<Value, String> {
        let id = format!("open-builder-{}", self.next_id);
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| "Pi RPC request id overflowed".to_string())?;
        let object = body
            .as_object_mut()
            .ok_or_else(|| "invalid Pi RPC command".to_string())?;
        object.insert("id".to_string(), Value::String(id.clone()));
        object.insert("type".to_string(), Value::String(command.to_string()));
        write_json(&mut self.stdin, &body).await?;

        loop {
            let value = self.read_fresh_value(true).await?;
            if value.get("type").and_then(Value::as_str) == Some("response")
                && value.get("id").and_then(Value::as_str) == Some(id.as_str())
            {
                if value.get("command").and_then(Value::as_str) != Some(command) {
                    return Err("Pi RPC response command did not match its request".to_string());
                }
                self.completed_ids.insert(id);
                if value.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi RPC command failed")
                        .to_string());
                }
                return Ok(value.get("data").cloned().unwrap_or(Value::Null));
            }
            self.pending.push_back(value);
        }
    }

    async fn cancel_gracefully(&mut self) {
        let clear_id = format!("open-builder-cancel-clear-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        if write_json(
            &mut self.stdin,
            &json!({"id":clear_id,"type":"clear_queue"}),
        )
        .await
        .is_ok()
        {
            let _ = tokio::time::timeout(
                PI_CANCEL_RESPONSE_TIMEOUT,
                self.wait_for_response(&clear_id, "clear_queue"),
            )
            .await;
        }

        let abort_id = format!("open-builder-cancel-abort-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        if write_json(&mut self.stdin, &json!({"id":abort_id,"type":"abort"}))
            .await
            .is_ok()
        {
            let _ = tokio::time::timeout(
                PI_CANCEL_RESPONSE_TIMEOUT,
                self.wait_for_response(&abort_id, "abort"),
            )
            .await;
        }
    }

    async fn wait_for_response(&mut self, id: &str, command: &str) -> Result<(), String> {
        loop {
            let value = self.read_fresh_value(false).await?;
            if value.get("type").and_then(Value::as_str) == Some("response")
                && value.get("id").and_then(Value::as_str) == Some(id)
            {
                if value.get("command").and_then(Value::as_str) != Some(command)
                    || value.get("success").and_then(Value::as_bool) != Some(true)
                {
                    return Err(format!("Pi RPC {command} failed"));
                }
                self.completed_ids.insert(id.to_string());
                return Ok(());
            }
            self.pending.push_back(value);
        }
    }
}

async fn read_pi_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "failed to read Pi RPC output".to_string())?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("Pi RPC ended with an unterminated JSON record".to_string())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if bytes.len().saturating_add(consumed) > MAX_PI_JSON_LINE_BYTES {
            return Err("Pi RPC JSON event exceeded the line limit".to_string());
        }
        if let Some(index) = newline {
            if index > 0 && available[index - 1] == b'\r'
                || index == 0 && bytes.last() == Some(&b'\r')
            {
                return Err("Pi RPC used CRLF instead of strict LF framing".to_string());
            }
        }
        bytes.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            bytes.pop();
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "Pi RPC emitted invalid UTF-8".to_string());
        }
    }
}

struct ProbeDirectory(PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn create_probe_directory() -> Result<ProbeDirectory, String> {
    let path = std::env::temp_dir().join(format!("open-builder-pi-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|_| "failed to create Pi probe directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure Pi probe directory".to_string())?;
    }
    Ok(ProbeDirectory(path))
}

fn pi_isolation_args() -> Vec<String> {
    [
        "--mode",
        "rpc",
        "--no-builtin-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn pi_probe_args(extension_path: &Path) -> Vec<String> {
    let mut args = pi_isolation_args();
    args.push("--no-tools".to_string());
    args.push("--no-session".to_string());
    args.extend([
        "-e".to_string(),
        extension_path.to_string_lossy().to_string(),
    ]);
    args
}

fn parse_pi_version(text: &str) -> Option<(u64, u64, u64, bool)> {
    for (start, character) in text.char_indices() {
        if !character.is_ascii_digit() {
            continue;
        }
        let rest = &text[start..];
        let mut parts = rest.splitn(3, '.');
        let major_text = parts.next()?;
        let minor_and_rest = parts.next()?;
        let patch_and_rest = parts.next()?;
        if !major_text.chars().all(|value| value.is_ascii_digit()) {
            continue;
        }
        let minor_len = minor_and_rest
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .count();
        if minor_len == 0 || minor_len != minor_and_rest.len() {
            continue;
        }
        let patch_len = patch_and_rest
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .count();
        if patch_len == 0 {
            continue;
        }
        let suffix = &patch_and_rest[patch_len..];
        if suffix
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric() || value == '.')
        {
            continue;
        }
        let major = major_text.parse().ok()?;
        let minor = minor_and_rest.parse().ok()?;
        let patch = patch_and_rest[..patch_len].parse().ok()?;
        return Some((major, minor, patch, suffix.starts_with('-')));
    }
    None
}

pub(crate) fn validate_pi_version(version: Option<&str>) -> Result<(), String> {
    let text = version.ok_or_else(|| "Pi did not report its version".to_string())?;
    let (major, minor, patch, pre_release) =
        parse_pi_version(text).ok_or_else(|| "Pi returned an invalid version".to_string())?;
    let parsed = (major, minor, patch);
    if pre_release || parsed < PI_MINIMUM_VERSION || parsed >= PI_MAXIMUM_VERSION {
        return Err(
            "Pi 0.84.4 or newer is required, and Pi 0.85.x is not yet supported".to_string(),
        );
    }
    Ok(())
}

fn parse_model(value: &Value) -> Result<PiModelDescriptor, String> {
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Pi returned a model without a provider".to_string())?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Pi returned a model without an id".to_string())?;
    if provider.len() > 128
        || id.len() > 256
        || provider.chars().any(char::is_control)
        || id.chars().any(char::is_control)
    {
        return Err("Pi returned an invalid model identifier".to_string());
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(id)
        .chars()
        .take(160)
        .collect();
    Ok(PiModelDescriptor {
        reference: PiModelRef {
            provider: provider.to_string(),
            id: id.to_string(),
        },
        name,
    })
}

fn model_ref_from_wire(value: &str) -> Result<PiModelRef, String> {
    let (provider, id) = value
        .split_once('/')
        .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
        .ok_or_else(|| "Pi model must use provider/id".to_string())?;
    Ok(PiModelRef {
        provider: provider.to_string(),
        id: id.to_string(),
    })
}

fn model_ref_from_value(value: &Value) -> Option<PiModelRef> {
    Some(PiModelRef {
        provider: value.get("provider")?.as_str()?.to_string(),
        id: value.get("id")?.as_str()?.to_string(),
    })
}

fn parse_available_models(data: &Value) -> Result<Vec<PiModelDescriptor>, String> {
    let raw_models = data
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Pi did not return an available-model list".to_string())?;
    if raw_models.len() > MAX_PI_MODELS {
        return Err("Pi returned too many models".to_string());
    }
    let mut descriptors = Vec::with_capacity(raw_models.len());
    let mut seen = BTreeSet::new();
    for value in raw_models {
        let descriptor = parse_model(value)?;
        let wire_id = format!(
            "{}/{}",
            descriptor.reference.provider, descriptor.reference.id
        );
        if !seen.insert(wire_id) {
            return Err("Pi returned duplicate models".to_string());
        }
        descriptors.push(descriptor);
    }
    Ok(descriptors)
}

fn parse_thinking_levels(data: &Value) -> Result<Vec<String>, String> {
    let levels = data
        .get("levels")
        .and_then(Value::as_array)
        .ok_or_else(|| "Pi did not return thinking levels".to_string())?;
    let mut result = Vec::new();
    for level in levels {
        let level = level
            .as_str()
            .filter(|level| THINKING_LEVELS.contains(level))
            .ok_or_else(|| "Pi returned an invalid thinking level".to_string())?;
        if !result.iter().any(|existing| existing == level) {
            result.push(level.to_string());
        }
    }
    Ok(result)
}

fn pi_auth_check_args(provider: &str) -> Vec<String> {
    [
        "auth",
        "check",
        "--provider",
        provider,
        "--json",
        "--no-refresh",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

async fn provider_auth_ready_without_refresh(
    executable: &Path,
    provider: &str,
) -> Result<bool, String> {
    let args = pi_auth_check_args(provider);
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output =
        command_output_capped(executable, &args, PI_COMMAND_TIMEOUT, PI_AUTH_OUTPUT_BYTES).await?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Pi auth check returned malformed JSON".to_string())?;
    if value.get("provider").and_then(Value::as_str) != Some(provider) {
        return Err("Pi auth check returned a mismatched provider".to_string());
    }
    match value.get("status").and_then(Value::as_str) {
        Some("ready") if output.status.success() => Ok(true),
        Some("not_ready") => Ok(false),
        Some("invalid") => Err("Pi reported an invalid authentication state".to_string()),
        _ => Err("Pi auth check returned an invalid status".to_string()),
    }
}

struct PiProbeFiles {
    extension_path: PathBuf,
    nonce: String,
}

fn prepare_probe_files(directory: &Path) -> Result<PiProbeFiles, String> {
    let extension_path = directory.join(format!(
        "open-builder-pi-probe-{}.mjs",
        uuid::Uuid::new_v4()
    ));
    write_private_file(&extension_path, PI_PROBE_EXTENSION_SOURCE.as_bytes())?;
    let extension_path = std::fs::canonicalize(&extension_path)
        .map_err(|_| "failed to resolve the private Pi probe extension".to_string())?;
    Ok(PiProbeFiles {
        extension_path,
        nonce: uuid::Uuid::new_v4().to_string(),
    })
}

fn validate_probe_command_inventory(data: &Value, extension_path: &Path) -> Result<(), String> {
    let commands = data
        .get("commands")
        .and_then(Value::as_array)
        .filter(|commands| commands.len() <= 16)
        .ok_or_else(|| "Pi returned an invalid probe command inventory".to_string())?;
    let extension_path = extension_path.to_string_lossy();
    let mut saw_probe = false;
    for command in commands {
        let name = command
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Pi returned a malformed probe command".to_string())?;
        if command.get("source").and_then(Value::as_str) != Some("extension") {
            return Err("Pi loaded a non-extension command during its probe".to_string());
        }
        let source = source_info(command, "probe command")?;
        let source_name = source.get("source").and_then(Value::as_str).unwrap_or("");
        let source_path = source.get("path").and_then(Value::as_str).unwrap_or("");
        let source_scope = source.get("scope").and_then(Value::as_str).unwrap_or("");
        let source_origin = source.get("origin").and_then(Value::as_str).unwrap_or("");
        let allowed = if name == PI_AUTH_PROBE_COMMAND {
            saw_probe = source_name == "cli"
                && source_path == extension_path.as_ref()
                && source_scope == "temporary"
                && source_origin == "top-level";
            saw_probe
        } else {
            name == "llama"
                && source_name == "inline"
                && source_path == "<inline:llama.cpp>"
                && source_scope == "temporary"
                && source_origin == "top-level"
        };
        if !allowed {
            return Err("Pi loaded an unexpected command during its probe".to_string());
        }
    }
    if !saw_probe {
        return Err("Pi did not load the Open Builder authentication probe".to_string());
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct PiProviderAuthStatus {
    configured: bool,
    source: Option<String>,
}

fn parse_provider_auth_probe_event(
    event: &Value,
    nonce: &str,
    provider: &str,
) -> Result<Option<PiProviderAuthStatus>, String> {
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return Ok(None);
    }
    if event.get("method").and_then(Value::as_str) != Some("notify")
        || event.get("notifyType").and_then(Value::as_str) != Some("info")
    {
        return Err("Pi requested unexpected UI during its authentication probe".to_string());
    }
    let message = event
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi authentication probe omitted its payload".to_string())?;
    let value: Value = serde_json::from_str(message)
        .map_err(|_| "Pi authentication probe returned malformed JSON".to_string())?;
    let object = value
        .as_object()
        .filter(|value| value.len() == 6)
        .ok_or_else(|| "Pi authentication probe returned an invalid payload".to_string())?;
    if object.get("type").and_then(Value::as_str) != Some("open_builder_pi_auth_probe")
        || object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("nonce").and_then(Value::as_str) != Some(nonce)
        || object.get("provider").and_then(Value::as_str) != Some(provider)
    {
        return Err("Pi authentication probe did not match its request".to_string());
    }
    let configured = object
        .get("configured")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Pi authentication probe omitted its configured state".to_string())?;
    let source = match object.get("source") {
        Some(Value::String(source)) if !source.is_empty() && source.len() <= 64 => {
            Some(source.clone())
        }
        Some(Value::Null) => None,
        _ => return Err("Pi authentication probe returned an invalid source".to_string()),
    };
    Ok(Some(PiProviderAuthStatus { configured, source }))
}

async fn probe_provider_auth_source(
    io: &mut PiIo,
    model: &PiModelRef,
    nonce: &str,
) -> Result<PiProviderAuthStatus, String> {
    tokio::time::timeout(PI_COMMAND_TIMEOUT, async {
        io.request(
            "set_model",
            json!({"provider":model.provider,"modelId":model.id}),
        )
        .await?;
        io.request(
            "prompt",
            json!({"message":format!("/{PI_AUTH_PROBE_COMMAND} {nonce}")}),
        )
        .await?;
        loop {
            let event = io.next_value().await?;
            if let Some(status) = parse_provider_auth_probe_event(&event, nonce, &model.provider)? {
                return Ok(status);
            }
            match event.get("type").and_then(Value::as_str).unwrap_or("") {
                event_type if is_pre_attestation_selection_event(event_type) => {}
                "response" => {
                    return Err(
                        "Pi emitted an unmatched response during its authentication probe"
                            .to_string(),
                    )
                }
                _ => {
                    return Err(
                        "Pi emitted model activity during its authentication probe".to_string()
                    )
                }
            }
        }
    })
    .await
    .map_err(|_| "Pi authentication-source probe timed out".to_string())?
}

async fn model_efforts(io: &mut PiIo, model: &PiModelRef) -> Result<Vec<String>, String> {
    io.request(
        "set_model",
        json!({"provider":model.provider,"modelId":model.id}),
    )
    .await?;
    let data = io
        .request("get_available_thinking_levels", json!({}))
        .await?;
    parse_thinking_levels(&data)
}

async fn probe_runtime(executable: &Path) -> Result<PiProbeResult, String> {
    let probe_directory = create_probe_directory()?;
    let probe_files = prepare_probe_files(&probe_directory.0)?;
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    command
        .args(pi_probe_args(&probe_files.extension_path))
        .current_dir(&probe_directory.0)
        .env(PI_PROBE_NONCE_ENV, &probe_files.nonce)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0");
    let process = spawn_wrapped(command)?;
    let child = process.child.clone();
    let (stderr_capture, stderr_task) = spawn_stderr_drain(process.stderr);
    let tree_guard = process.tree_guard;
    let mut io = PiIo {
        stdin: Box::new(process.stdin),
        reader: Box::new(BufReader::new(process.stdout)),
        next_id: 1,
        cancellation: CancellationToken::new(),
        output_budget: ProtocolOutputBudget::default(),
        pending: VecDeque::new(),
        completed_ids: HashSet::new(),
    };

    let probe_result: Result<PiProbeResult, String> = async {
        let commands = io.request("get_commands", json!({})).await?;
        validate_probe_command_inventory(&commands, &probe_files.extension_path)?;
        let model_data = io.request("get_available_models", json!({})).await?;
        let state = io.request("get_state", json!({})).await?;
        let mut descriptors = parse_available_models(&model_data)?;
        if descriptors.is_empty() {
            return Ok(PiProbeResult {
                ready: false,
                models: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                message: Some("Pi has no configured model. Run pi and enter /login.".to_string()),
            });
        }

        let providers = descriptors
            .iter()
            .fold(BTreeMap::new(), |mut providers, model| {
                providers
                    .entry(model.reference.provider.clone())
                    .or_insert_with(|| model.reference.clone());
                providers
            });
        let mut stored_providers = Vec::new();
        let mut skipped_providers = false;
        for (provider, model) in providers {
            match probe_provider_auth_source(&mut io, &model, &probe_files.nonce).await {
                Ok(status) if status.configured && status.source.as_deref() == Some("stored") => {
                    stored_providers.push(provider);
                }
                Ok(_) | Err(_) => skipped_providers = true,
            }
        }

        let executable = executable.to_path_buf();
        let auth_results = stream::iter(stored_providers)
            .map(|provider| {
                let executable = executable.clone();
                async move {
                    let result = provider_auth_ready_without_refresh(&executable, &provider).await;
                    (provider, result)
                }
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        let mut ready_providers = HashSet::new();
        for (provider, result) in auth_results {
            match result {
                Ok(true) => {
                    ready_providers.insert(provider);
                }
                Ok(false) | Err(_) => skipped_providers = true,
            }
        }
        descriptors.retain(|model| ready_providers.contains(&model.reference.provider));
        if descriptors.is_empty() {
            return Ok(PiProbeResult {
                ready: false,
                models: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                message: Some(
                    "Pi credentials need setup in auth.json. Run pi and enter /login.".to_string(),
                ),
            });
        }

        let original_model = state.get("model").and_then(model_ref_from_value);
        let default_effort = state
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut described_models = Vec::with_capacity(descriptors.len());
        for descriptor in descriptors {
            match model_efforts(&mut io, &descriptor.reference).await {
                Ok(efforts) => described_models.push((descriptor, efforts)),
                Err(_) => skipped_providers = true,
            }
        }
        if described_models.is_empty() {
            return Ok(PiProbeResult {
                ready: false,
                models: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                message: Some(
                    "Pi did not expose a usable model. Run pi and verify /login and model settings."
                        .to_string(),
                ),
            });
        }
        let fallback_default = original_model
            .as_ref()
            .filter(|model| {
                described_models
                    .iter()
                    .any(|(candidate, _)| candidate.reference == **model)
            })
            .cloned()
            .unwrap_or_else(|| described_models[0].0.reference.clone());

        let mut models = Vec::with_capacity(described_models.len());
        for (descriptor, efforts) in described_models {
            let is_default = descriptor.reference == fallback_default;
            models.push(LocalAgentModel {
                id: format!(
                    "{}/{}",
                    descriptor.reference.provider, descriptor.reference.id
                ),
                display_name: format!("{} · {}", descriptor.reference.provider, descriptor.name),
                is_default,
                default_effort: is_default
                    .then(|| default_effort.clone())
                    .flatten()
                    .filter(|effort| efforts.contains(effort)),
                efforts,
            });
        }
        Ok(PiProbeResult {
            ready: true,
            models,
            catalog_authority: pi_catalog_authority(skipped_providers),
            message: skipped_providers.then(|| {
                "Some Pi providers or models were skipped because they were not safely configured."
                    .to_string()
            }),
        })
    }
    .await;

    drop(io.stdin);
    let process_result = finish_process(child, stderr_task, tree_guard).await;
    let result = probe_result.map_err(|error| provider_error(&error, &stderr_capture))?;
    let status = process_result.map_err(|error| provider_error(&error, &stderr_capture))?;
    if status.is_some_and(|status| !status.success()) {
        return Err(provider_error(
            "Pi RPC probe exited unsuccessfully",
            &stderr_capture,
        ));
    }
    Ok(result)
}

fn first_output_line(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

struct PiInstallationError {
    availability: LocalAgentAvailability,
    version: Option<String>,
    message: String,
}

impl PiInstallationError {
    fn unsupported(version: Option<String>, message: impl Into<String>) -> Self {
        Self {
            availability: LocalAgentAvailability::Unsupported,
            version,
            message: message.into(),
        }
    }

    fn error(version: Option<String>, message: impl Into<String>) -> Self {
        Self {
            availability: LocalAgentAvailability::Error,
            version,
            message: message.into(),
        }
    }
}

async fn inspect_installation(executable: &Path) -> Result<String, PiInstallationError> {
    let version_output = match command_output_capped(
        executable,
        &["--version"],
        PI_COMMAND_TIMEOUT,
        PI_AUTH_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) if output.status.success() => output,
        Ok(_) => {
            return Err(PiInstallationError::unsupported(
                None,
                "The selected Pi executable did not report a supported version.".to_string(),
            ))
        }
        Err(message) => {
            return Err(PiInstallationError::error(None, message));
        }
    };
    let version = first_output_line(&version_output.stdout);
    if let Err(message) = validate_pi_version(version.as_deref()) {
        return Err(PiInstallationError::unsupported(version, message));
    }
    let help = match command_output_capped(
        executable,
        &["--help"],
        PI_COMMAND_TIMEOUT,
        PI_AUTH_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) => {
            String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr)
        }
        Err(message) => {
            return Err(PiInstallationError::unsupported(version, message));
        }
    };
    for required in [
        "--mode",
        "--session-dir",
        "--session",
        "--no-builtin-tools",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
    ] {
        if !help.contains(required) {
            return Err(PiInstallationError::unsupported(
                version,
                format!("Pi is missing required isolation flag {required}"),
            ));
        }
    }

    let auth_help = command_output_capped(
        executable,
        &["auth", "check", "--help"],
        PI_COMMAND_TIMEOUT,
        PI_AUTH_OUTPUT_BYTES,
    )
    .await
    .map_err(|message| PiInstallationError::unsupported(version.clone(), message))?;
    let auth_help = String::from_utf8_lossy(&auth_help.stdout).to_string()
        + &String::from_utf8_lossy(&auth_help.stderr);
    for required in ["--json", "--no-refresh"] {
        if !auth_help.contains(required) {
            return Err(PiInstallationError::unsupported(
                version,
                format!("Pi auth check is missing required option {required}"),
            ));
        }
    }

    Ok(version.expect("validated Pi versions always contain a version string"))
}

pub(crate) async fn probe(executable: &Path) -> AdapterProbe {
    let version = match inspect_installation(executable).await {
        Ok(version) => version,
        Err(error) => {
            return AdapterProbe {
                availability: error.availability,
                version: error.version,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(error.message),
            }
        }
    };
    match probe_runtime(executable).await {
        Ok(result) => AdapterProbe {
            availability: if result.ready {
                LocalAgentAvailability::Ready
            } else {
                LocalAgentAvailability::NeedsSetup
            },
            version: Some(version),
            models: result.models,
            efforts: Vec::new(),
            catalog_authority: result.catalog_authority,
            verification_required: false,
            message: result.message,
        },
        Err(message) => AdapterProbe {
            availability: LocalAgentAvailability::Error,
            version: Some(version),
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some(message),
        },
    }
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    if request.native_search {
        return Err("Pi does not provide an isolated native search capability".to_string());
    }
    if request.scope.kind == LocalAgentRunScopeKind::Utility && request.session_id.is_some() {
        return Err("Pi utility runs cannot resume a persistent session".to_string());
    }
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        validate_session_id(session_id)?;
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<&str, String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| "Pi session id must be a canonical UUID".to_string())?;
    if parsed.hyphenated().to_string() != value {
        return Err("Pi session id must be a canonical UUID".to_string());
    }
    Ok(value)
}

fn tool_digest(tools: &[LocalToolSpec]) -> Result<(Vec<String>, String), String> {
    let mut tools = tools.iter().collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("Pi tool names must be unique".to_string());
    }

    let ordered = tools.into_iter().cloned().collect::<Vec<_>>();
    let digest = canonical_tool_digest(&ordered)?;
    Ok((names, digest))
}

fn pi_endpoint_urls(mcp_url: &str) -> Result<(String, String), String> {
    let url = reqwest::Url::parse(mcp_url)
        .map_err(|_| "Open Builder returned an invalid Pi bridge URL".to_string())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/mcp"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Pi bridge URL is not an isolated loopback endpoint".to_string());
    }
    let mut tools = url.clone();
    tools.set_path("/pi/tools");
    let mut call = url;
    call.set_path("/pi/call");
    Ok((tools.to_string(), call.to_string()))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|_| "failed to write private Pi configuration".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure private Pi configuration".to_string())?;
    }
    Ok(())
}

struct PiRunFiles {
    config_path: PathBuf,
    extension_path: PathBuf,
    session_dir: PathBuf,
    resume_session_id: Option<String>,
    expected_cwd: String,
    expected_tool_names: Vec<String>,
    tool_digest: String,
    attestation_nonce: String,
    system_prompt_nonce: String,
}

fn find_persistent_session(session_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let suffix = format!("_{session_id}.jsonl");
    let mut found = None;
    for entry in
        std::fs::read_dir(session_dir).map_err(|_| "Pi session is unavailable".to_string())?
    {
        let entry = entry.map_err(|_| "Pi session is unavailable".to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.ends_with(&suffix) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|_| "Pi session is unavailable".to_string())?;
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_PI_SESSION_BYTES as u64
            || found.is_some()
        {
            return Err("Pi session is unavailable".to_string());
        }
        found = Some(entry.path());
    }
    found.ok_or_else(|| "Pi session is unavailable".to_string())
}

fn retarget_persistent_session(
    session_dir: &Path,
    session_id: &str,
    workspace: &Path,
) -> Result<PathBuf, String> {
    let path = find_persistent_session(session_dir, session_id)?;
    let bytes = std::fs::read(&path).map_err(|_| "Pi session is unavailable".to_string())?;
    if bytes.len() > MAX_PI_SESSION_BYTES {
        return Err("Pi session is unavailable".to_string());
    }
    let header_end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Pi session is unavailable".to_string())?;
    let mut header: Value = serde_json::from_slice(&bytes[..header_end])
        .map_err(|_| "Pi session is unavailable".to_string())?;
    let object = header
        .as_object_mut()
        .filter(|header| {
            header.get("type").and_then(Value::as_str) == Some("session")
                && header.get("id").and_then(Value::as_str) == Some(session_id)
        })
        .ok_or_else(|| "Pi session is unavailable".to_string())?;
    object.insert(
        "cwd".to_string(),
        Value::String(workspace.to_string_lossy().to_string()),
    );
    let mut rewritten =
        serde_json::to_vec(&header).map_err(|_| "Pi session is unavailable".to_string())?;
    rewritten.push(b'\n');
    rewritten.extend_from_slice(&bytes[header_end + 1..]);

    let temporary = session_dir.join(format!(".open-builder-{}.tmp", uuid::Uuid::new_v4()));
    write_private_file(&temporary, &rewritten)?;
    #[cfg(windows)]
    std::fs::remove_file(&path).map_err(|_| "Pi session is unavailable".to_string())?;
    if std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("Pi session is unavailable".to_string());
    }
    Ok(path)
}

fn prepare_run_files(context: &ProtocolContext) -> Result<PiRunFiles, String> {
    let expected_cwd = std::fs::canonicalize(&context.workspace_dir)
        .map_err(|_| "failed to resolve the private Pi workspace".to_string())?;
    if std::fs::read_dir(&expected_cwd)
        .map_err(|_| "failed to inspect the private Pi workspace".to_string())?
        .next()
        .is_some()
    {
        return Err("the private Pi workspace is not empty".to_string());
    }
    let expected_cwd = expected_cwd.to_string_lossy().to_string();
    let session_dir = if context.request.scope.kind == LocalAgentRunScopeKind::Utility {
        let path = context.run_dir.join("pi-sessions");
        std::fs::create_dir(&path)
            .map_err(|_| "failed to create the private Pi session directory".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "failed to secure the private Pi session directory".to_string())?;
        }
        path
    } else {
        context.session_dir.clone()
    };
    let resume_session_id = context
        .request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(validate_session_id)
        .transpose()?
        .map(|session_id| {
            retarget_persistent_session(&session_dir, session_id, Path::new(&expected_cwd))?;
            Ok::<_, String>(session_id.to_string())
        })
        .transpose()?;
    let (tools_url, call_url) = pi_endpoint_urls(&context.bridge_url)?;
    let (expected_tool_names, tool_digest) = tool_digest(&context.request.tools)?;
    let attestation_nonce = uuid::Uuid::new_v4().to_string();
    let system_prompt_nonce = uuid::Uuid::new_v4().to_string();

    let extension_path = context
        .run_dir
        .join(format!("open-builder-pi-{}.mjs", uuid::Uuid::new_v4()));
    write_private_file(&extension_path, PI_EXTENSION_SOURCE.as_bytes())?;
    let extension_path = std::fs::canonicalize(&extension_path)
        .map_err(|_| "failed to resolve the private Pi extension".to_string())?;
    let extension_text = extension_path.to_string_lossy().to_string();

    let config = PiConfig {
        version: PI_PROTOCOL_CONFIG_VERSION,
        tools_url: &tools_url,
        call_url: &call_url,
        bearer_token: &context.bridge_token,
        attestation_nonce: &attestation_nonce,
        expected_cwd: &expected_cwd,
        expected_model: None,
        system_prompt: &context.request.system_prompt,
        system_prompt_nonce: &system_prompt_nonce,
        expected_tool_names: &expected_tool_names,
        tool_digest: &tool_digest,
        extension_path: &extension_text,
    };
    let config_bytes = serde_json::to_vec(&config)
        .map_err(|_| "failed to serialize the private Pi configuration".to_string())?;
    let config_path = context
        .run_dir
        .join(format!("open-builder-pi-{}.json", uuid::Uuid::new_v4()));
    write_private_file(&config_path, &config_bytes)?;
    let config_path = std::fs::canonicalize(&config_path)
        .map_err(|_| "failed to resolve the private Pi configuration".to_string())?;

    Ok(PiRunFiles {
        config_path,
        extension_path,
        session_dir,
        resume_session_id,
        expected_cwd,
        expected_tool_names,
        tool_digest,
        attestation_nonce,
        system_prompt_nonce,
    })
}

fn pi_run_args(files: &PiRunFiles) -> Vec<String> {
    let mut args = pi_isolation_args();
    args.extend([
        "--session-dir".to_string(),
        files.session_dir.to_string_lossy().to_string(),
        "-e".to_string(),
        files.extension_path.to_string_lossy().to_string(),
    ]);
    if let Some(session_id) = files.resume_session_id.as_ref() {
        args.extend(["--session".to_string(), session_id.to_string()]);
    }
    args
}

fn string_array(value: Option<&Value>, field: &str, max: usize) -> Result<Vec<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Pi attestation omitted {field}"))?;
    if values.len() > max {
        return Err(format!("Pi attestation returned too many {field}"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 512)
                .map(str::to_string)
                .ok_or_else(|| format!("Pi attestation returned invalid {field}"))
        })
        .collect()
}

fn empty_attestation_array(value: &Value, field: &str) -> Result<(), String> {
    if value
        .get(field)
        .and_then(Value::as_array)
        .is_none_or(|values| !values.is_empty())
    {
        return Err(format!("Pi loaded unexpected {field}"));
    }
    Ok(())
}

fn source_info<'a>(
    value: &'a Value,
    context: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get("sourceInfo")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Pi attestation returned invalid {context} source information"))
}

fn validate_attestation(
    value: &Value,
    files: &PiRunFiles,
    expected_model: &PiModelRef,
    expected_thinking: &str,
) -> Result<(), String> {
    if value.get("type").and_then(Value::as_str) != Some("open_builder_pi_attestation")
        || value.get("version").and_then(Value::as_u64) != Some(PI_PROTOCOL_CONFIG_VERSION.into())
        || value.get("attestationNonce").and_then(Value::as_str)
            != Some(files.attestation_nonce.as_str())
        || value.get("systemPromptNonce").and_then(Value::as_str)
            != Some(files.system_prompt_nonce.as_str())
        || value.get("extensionPath").and_then(Value::as_str)
            != Some(files.extension_path.to_string_lossy().as_ref())
        || value.get("cwd").and_then(Value::as_str) != Some(files.expected_cwd.as_str())
        || value.get("computedToolDigest").and_then(Value::as_str)
            != Some(files.tool_digest.as_str())
        || value.get("thinkingLevel").and_then(Value::as_str) != Some(expected_thinking)
    {
        return Err("Pi isolation attestation did not match the requested run".to_string());
    }
    let model = value
        .get("model")
        .and_then(model_ref_from_value)
        .ok_or_else(|| "Pi attestation omitted its selected model".to_string())?;
    if model != *expected_model {
        return Err("Pi attested a different model".to_string());
    }
    let provider_auth = value
        .get("providerAuth")
        .and_then(Value::as_object)
        .filter(|auth| {
            auth.len() == 2
                && auth.get("configured").and_then(Value::as_bool) == Some(true)
                && auth.get("source").and_then(Value::as_str) == Some("stored")
        })
        .ok_or_else(|| "Pi must use a credential stored by its auth.json login flow".to_string())?;
    debug_assert_eq!(provider_auth.len(), 2);

    let active_tools = string_array(value.get("activeTools"), "active tools", 256)?;
    if active_tools != files.expected_tool_names {
        return Err("Pi active tool inventory did not match Open Builder".to_string());
    }
    for field in ["contextFiles", "skills", "promptTemplates", "violations"] {
        empty_attestation_array(value, field)?;
    }

    let extension_path = files.extension_path.to_string_lossy();
    let extensions = value
        .get("extensions")
        .and_then(Value::as_array)
        .filter(|values| values.len() == 1)
        .ok_or_else(|| "Pi loaded an unexpected extension inventory".to_string())?;
    let extension = extensions[0]
        .as_object()
        .ok_or_else(|| "Pi returned a malformed extension inventory".to_string())?;
    if extension.get("path").and_then(Value::as_str) != Some(extension_path.as_ref())
        || extension.get("source").and_then(Value::as_str) != Some("cli")
        || extension.get("scope").and_then(Value::as_str) != Some("temporary")
        || extension.get("origin").and_then(Value::as_str) != Some("top-level")
    {
        return Err("Pi loaded an extension outside Open Builder".to_string());
    }

    let all_tools = value
        .get("allTools")
        .and_then(Value::as_array)
        .filter(|values| values.len() <= 512)
        .ok_or_else(|| "Pi returned an invalid complete tool inventory".to_string())?;
    let expected = files
        .expected_tool_names
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let expected_builtins = PI_BUILTIN_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| !expected.contains(name))
        .collect::<HashSet<_>>();
    if all_tools.len() != expected.len() + expected_builtins.len() {
        return Err("Pi complete tool inventory did not match Open Builder".to_string());
    }
    let mut found = HashSet::new();
    let mut found_builtins = HashSet::new();
    for tool in all_tools {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Pi returned a malformed tool inventory".to_string())?;
        let source = source_info(tool, "tool")?;
        let source_name = source.get("source").and_then(Value::as_str).unwrap_or("");
        let source_path = source.get("path").and_then(Value::as_str).unwrap_or("");
        let source_scope = source.get("scope").and_then(Value::as_str).unwrap_or("");
        let source_origin = source.get("origin").and_then(Value::as_str).unwrap_or("");
        if expected.contains(name) {
            if source_name != "cli"
                || source_path != extension_path.as_ref()
                || source_scope != "temporary"
                || source_origin != "top-level"
            {
                return Err("Pi exposed an Open Builder tool from an unexpected source".to_string());
            }
            if !found.insert(name) {
                return Err("Pi duplicated an Open Builder tool".to_string());
            }
        } else if expected_builtins.contains(name) {
            let expected_path = format!("<builtin:{name}>");
            if source_name != "builtin"
                || source_path != expected_path
                || source_scope != "temporary"
                || source_origin != "top-level"
            {
                return Err("Pi exposed a built-in tool from an unexpected source".to_string());
            }
            if !found_builtins.insert(name) {
                return Err("Pi duplicated a built-in tool".to_string());
            }
        } else {
            return Err("Pi loaded an unexpected tool capability".to_string());
        }
    }
    if found != expected {
        return Err("Pi omitted an Open Builder tool from its full inventory".to_string());
    }
    if found_builtins != expected_builtins {
        return Err("Pi built-in tool inventory did not match the supported CLI".to_string());
    }

    let commands = value
        .get("commands")
        .and_then(Value::as_array)
        .filter(|values| values.len() == 2)
        .ok_or_else(|| "Pi returned an invalid command inventory".to_string())?;
    let mut saw_attest = false;
    let mut saw_llama = false;
    for command in commands {
        let name = command.get("name").and_then(Value::as_str).unwrap_or("");
        let source = source_info(command, "command")?;
        let source_name = source.get("source").and_then(Value::as_str).unwrap_or("");
        let source_path = source.get("path").and_then(Value::as_str).unwrap_or("");
        let source_scope = source.get("scope").and_then(Value::as_str).unwrap_or("");
        let source_origin = source.get("origin").and_then(Value::as_str).unwrap_or("");
        let allowed = if name == "open-builder-attest" && !saw_attest {
            saw_attest = source_name == "cli"
                && source_path == extension_path.as_ref()
                && source_scope == "temporary"
                && source_origin == "top-level";
            saw_attest
        } else if name == "llama" && !saw_llama {
            saw_llama = source_name == "inline"
                && source_path == "<inline:llama.cpp>"
                && source_scope == "temporary"
                && source_origin == "top-level";
            saw_llama
        } else {
            false
        };
        if !allowed {
            return Err("Pi loaded an unexpected command".to_string());
        }
    }
    if !saw_attest || !saw_llama {
        return Err("Pi command inventory did not match the supported CLI".to_string());
    }
    Ok(())
}

fn validate_attestation_event(
    event: &Value,
    files: &PiRunFiles,
    expected_model: &PiModelRef,
    expected_thinking: &str,
) -> Result<bool, String> {
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return Ok(false);
    }
    if event.get("method").and_then(Value::as_str) != Some("notify")
        || event.get("notifyType").and_then(Value::as_str) != Some("info")
    {
        return Err("Pi requested unexpected extension UI before attestation".to_string());
    }
    let message = event
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi attestation notification omitted its payload".to_string())?;
    let value: Value = serde_json::from_str(message)
        .map_err(|_| "Pi attestation notification contained malformed JSON".to_string())?;
    validate_attestation(&value, files, expected_model, expected_thinking)?;
    Ok(true)
}

async fn wait_for_attestation(
    io: &mut PiIo,
    files: &PiRunFiles,
    expected_model: &PiModelRef,
    expected_thinking: &str,
) -> Result<(), String> {
    tokio::time::timeout(PI_HANDSHAKE_TIMEOUT, async {
        loop {
            let event = io.next_value().await?;
            if validate_attestation_event(&event, files, expected_model, expected_thinking)? {
                return Ok(());
            }
            match event.get("type").and_then(Value::as_str).unwrap_or("") {
                event_type if is_pre_attestation_selection_event(event_type) => {}
                "response" => {
                    return Err("Pi emitted an unmatched response before attestation".to_string())
                }
                _ => return Err("Pi emitted activity before isolation attestation".to_string()),
            }
        }
    })
    .await
    .map_err(|_| "Pi isolation attestation timed out".to_string())?
}

fn is_pre_attestation_selection_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "model_select" | "thinking_level_select" | "thinking_level_changed"
    )
}

struct ValidatedPiState {
    thinking: String,
    session_id: String,
}

fn validate_selected_state(
    state: &Value,
    selected_model: &PiModelRef,
    expected_effort: Option<&str>,
    expected_session: Option<&str>,
) -> Result<ValidatedPiState, String> {
    let state_model = state
        .get("model")
        .and_then(model_ref_from_value)
        .ok_or_else(|| "Pi did not report its selected model".to_string())?;
    if state_model != *selected_model {
        return Err("Pi selected a different model".to_string());
    }
    let thinking = state
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .filter(|value| THINKING_LEVELS.contains(value))
        .ok_or_else(|| "Pi did not report its thinking level".to_string())?;
    if expected_effort.is_some_and(|expected| expected != thinking) {
        return Err("Pi clamped the requested reasoning effort".to_string());
    }
    let session_id = state
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi did not return a valid session id".to_string())
        .and_then(validate_session_id)?;
    if expected_session.is_some_and(|expected| expected != session_id) {
        return Err("Pi resumed a different session".to_string());
    }
    Ok(ValidatedPiState {
        thinking: thinking.to_string(),
        session_id: session_id.to_string(),
    })
}

fn select_runtime_model(
    available_models: &Value,
    initial_state: &Value,
    requested_model: Option<&str>,
) -> Result<PiModelRef, String> {
    let descriptors = parse_available_models(available_models)?;
    if descriptors.is_empty() {
        return Err("Pi requires an available model".to_string());
    }
    if let Some(requested) = requested_model.filter(|value| !value.is_empty()) {
        let requested = model_ref_from_wire(requested)?;
        return descriptors
            .iter()
            .any(|candidate| candidate.reference == requested)
            .then_some(requested)
            .ok_or_else(|| "the selected model is not available in Pi".to_string());
    }
    initial_state
        .get("model")
        .and_then(model_ref_from_value)
        .filter(|selected| {
            descriptors
                .iter()
                .any(|candidate| candidate.reference == *selected)
        })
        .or_else(|| descriptors.first().map(|model| model.reference.clone()))
        .ok_or_else(|| "Pi requires an available model".to_string())
}

fn usage_values(value: &Value) -> Option<(u64, u64, u64)> {
    Some((
        value.get("input")?.as_u64()?,
        value.get("output")?.as_u64()?,
        value.get("cacheRead").and_then(Value::as_u64).unwrap_or(0),
    ))
}

fn send_usage(
    context: &ProtocolContext,
    usage: &Value,
    last_usage: &mut Option<(u64, u64, u64)>,
) -> Result<(), String> {
    let current =
        usage_values(usage).ok_or_else(|| "Pi emitted malformed token usage".to_string())?;
    if last_usage.as_ref() == Some(&current) {
        return Ok(());
    }
    *last_usage = Some(current);
    context
        .channel
        .send(LocalAgentEvent::Usage {
            input_tokens: Some(current.0),
            output_tokens: Some(current.1),
            cached_input_tokens: Some(current.2),
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())
}

fn emit_final_assistant_content(
    context: &ProtocolContext,
    message: &Value,
    saw_text_delta: bool,
    saw_reasoning_delta: bool,
    last_usage: &mut Option<(u64, u64, u64)>,
) -> Result<(), String> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Ok(());
    }
    if let Some(usage) = message.get("usage") {
        send_usage(context, usage, last_usage)?;
    }
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return Ok(());
    };
    for block in content {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" if !saw_text_delta => {
                if let Some(delta) = block.get("text").and_then(Value::as_str) {
                    context
                        .channel
                        .send(LocalAgentEvent::TextDelta {
                            delta: delta.to_string(),
                        })
                        .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                }
            }
            "thinking" if !saw_reasoning_delta => {
                if let Some(delta) = block.get("thinking").and_then(Value::as_str) {
                    context
                        .channel
                        .send(LocalAgentEvent::ReasoningDelta {
                            delta: delta.to_string(),
                        })
                        .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Debug)]
enum PiRuntimeEvent<'a> {
    AgentStart,
    AssistantMessageStart,
    OtherMessageStart,
    TextDelta(&'a str),
    ReasoningDelta(&'a str),
    ToolCallStart {
        content_index: u64,
        name: &'a str,
    },
    ToolCallDelta {
        content_index: u64,
        name: Option<&'a str>,
    },
    ToolCallEnd {
        content_index: u64,
        name: &'a str,
    },
    ToolActivity(&'a str),
    MessageEnd(&'a Value),
    Settled,
    Error(String),
    ForbiddenNative,
    UnmatchedResponse,
    Ignore,
}

struct DecodedPiRuntimeEvent<'a> {
    usage: Option<&'a Value>,
    event: PiRuntimeEvent<'a>,
}

fn tool_call_content_index(value: &serde_json::Map<String, Value>) -> Result<u64, String> {
    value
        .get("contentIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Pi tool-call event omitted its content index".to_string())
}

fn optional_tool_call_name(
    value: &serde_json::Map<String, Value>,
    content_index: u64,
) -> Result<Option<&str>, String> {
    let mut names = Vec::new();
    if let Some(name) = value.get("toolName") {
        names.push(
            name.as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "Pi tool-call event omitted its tool name".to_string())?,
        );
    }
    if let Some(tool_call) = value.get("toolCall") {
        let tool_call = tool_call
            .as_object()
            .ok_or_else(|| "Pi tool-call event omitted its tool name".to_string())?;
        let name = tool_call
            .get("name")
            .ok_or_else(|| "Pi tool-call event omitted its tool name".to_string())?;
        names.push(
            name.as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "Pi tool-call event omitted its tool name".to_string())?,
        );
    }
    if let Some(partial) = value.get("partial") {
        let content = partial
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| "Pi tool-call event omitted its partial content".to_string())?;
        let block =
            content
                .get(usize::try_from(content_index).map_err(|_| {
                    "Pi tool-call event reported an invalid content index".to_string()
                })?)
                .ok_or_else(|| "Pi tool-call event omitted its partial tool block".to_string())?;
        if block.get("type").and_then(Value::as_str) != Some("toolCall") {
            return Err("Pi tool-call event reported a non-tool partial block".to_string());
        }
        names.push(
            block
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "Pi tool-call event omitted its partial tool name".to_string())?,
        );
    }
    let Some(name) = names.first().copied() else {
        return Ok(None);
    };
    if names.iter().any(|candidate| *candidate != name) {
        return Err("Pi tool-call event reported conflicting tool names".to_string());
    }
    Ok(Some(name))
}

fn tool_call_name(
    value: &serde_json::Map<String, Value>,
    content_index: u64,
) -> Result<&str, String> {
    optional_tool_call_name(value, content_index)?
        .ok_or_else(|| "Pi tool-call event omitted its tool name".to_string())
}

fn decode_runtime_event(value: &Value) -> Result<DecodedPiRuntimeEvent<'_>, String> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|event_type| !event_type.is_empty())
        .ok_or_else(|| "Pi emitted an event without a type".to_string())?;
    let mut decoded = DecodedPiRuntimeEvent {
        usage: None,
        event: PiRuntimeEvent::Ignore,
    };
    decoded.event = match event_type {
        "agent_start" => PiRuntimeEvent::AgentStart,
        "message_start" => {
            let role = value
                .pointer("/message/role")
                .and_then(Value::as_str)
                .ok_or_else(|| "Pi message start omitted its role".to_string())?;
            if role == "assistant" {
                PiRuntimeEvent::AssistantMessageStart
            } else {
                PiRuntimeEvent::OtherMessageStart
            }
        }
        "message_update" => {
            decoded.usage = value.get("usage");
            let delta = value
                .get("assistantMessageEvent")
                .and_then(Value::as_object)
                .ok_or_else(|| "Pi message update omitted its assistant event".to_string())?;
            match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                "text_delta" => PiRuntimeEvent::TextDelta(
                    delta
                        .get("delta")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Pi text delta omitted its text".to_string())?,
                ),
                "thinking_delta" => PiRuntimeEvent::ReasoningDelta(
                    delta
                        .get("delta")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Pi thinking delta omitted its text".to_string())?,
                ),
                "toolcall_start" => {
                    let content_index = tool_call_content_index(delta)?;
                    PiRuntimeEvent::ToolCallStart {
                        content_index,
                        name: tool_call_name(delta, content_index)?,
                    }
                }
                "toolcall_delta" => {
                    let content_index = tool_call_content_index(delta)?;
                    delta
                        .get("delta")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Pi tool-call delta omitted its arguments".to_string())?;
                    PiRuntimeEvent::ToolCallDelta {
                        content_index,
                        name: optional_tool_call_name(delta, content_index)?,
                    }
                }
                "toolcall_end" => {
                    let content_index = tool_call_content_index(delta)?;
                    PiRuntimeEvent::ToolCallEnd {
                        content_index,
                        name: tool_call_name(delta, content_index)?,
                    }
                }
                "text_start" | "text_end" | "thinking_start" | "thinking_end" => {
                    PiRuntimeEvent::Ignore
                }
                "" => return Err("Pi assistant event omitted its type".to_string()),
                _ => return Err("Pi emitted an unsupported assistant event".to_string()),
            }
        }
        "message_end" => {
            let message = value
                .get("message")
                .filter(|message| message.is_object())
                .ok_or_else(|| "Pi message end omitted its message".to_string())?;
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .ok_or_else(|| "Pi message end omitted its role".to_string())?;
            if role == "assistant"
                && (message.get("content").and_then(Value::as_array).is_none()
                    || message.get("stopReason").and_then(Value::as_str).is_none())
            {
                return Err("Pi assistant message end was malformed".to_string());
            }
            PiRuntimeEvent::MessageEnd(message)
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            PiRuntimeEvent::ToolActivity(
                value
                    .get("toolName")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| "Pi tool execution omitted its tool name".to_string())?,
            )
        }
        "extension_error" => PiRuntimeEvent::Error(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Pi extension failed")
                .to_string(),
        ),
        "compaction_end" => value
            .get("errorMessage")
            .and_then(Value::as_str)
            .map(|error| PiRuntimeEvent::Error(error.to_string()))
            .unwrap_or(PiRuntimeEvent::Ignore),
        "agent_settled" => PiRuntimeEvent::Settled,
        "bash_execution_update" | "extension_ui_request" => PiRuntimeEvent::ForbiddenNative,
        "response" => PiRuntimeEvent::UnmatchedResponse,
        "agent_end"
        | "turn_start"
        | "turn_end"
        | "queue_update"
        | "compaction_start"
        | "auto_retry_start"
        | "auto_retry_end"
        | "summarization_retry_scheduled"
        | "summarization_retry_attempt_start"
        | "summarization_retry_finished"
        | "model_select"
        | "thinking_level_changed"
        | "thinking_level_select" => PiRuntimeEvent::Ignore,
        _ => return Err("Pi emitted an unsupported event type".to_string()),
    };
    Ok(decoded)
}

fn validate_tool_call_event<'a>(
    event: &PiRuntimeEvent<'a>,
    expected_tools: &HashSet<&str>,
    active_tool_calls: &mut BTreeMap<u64, String>,
) -> Result<(), String> {
    match event {
        PiRuntimeEvent::ToolCallStart {
            content_index,
            name,
        } => {
            if !expected_tools.contains(*name) {
                return Err("Pi used an unexpected tool".to_string());
            }
            if active_tool_calls
                .insert(*content_index, (*name).to_string())
                .is_some()
            {
                return Err("Pi started a duplicate tool call content block".to_string());
            }
        }
        PiRuntimeEvent::ToolCallDelta {
            content_index,
            name,
            ..
        } => {
            let Some(start_name) = active_tool_calls.get(content_index) else {
                return Err(
                    "Pi emitted a tool-call delta without an approved tool start".to_string(),
                );
            };
            if let Some(name) = name {
                if !expected_tools.contains(*name) || start_name != *name {
                    return Err("Pi changed the tool name within a tool call".to_string());
                }
            }
        }
        PiRuntimeEvent::ToolCallEnd {
            content_index,
            name,
        } => {
            if !expected_tools.contains(*name) {
                return Err("Pi used an unexpected tool".to_string());
            }
            let Some(start_name) = active_tool_calls.remove(content_index) else {
                return Err("Pi emitted a tool-call end without an approved tool start".to_string());
            };
            if start_name != *name {
                return Err("Pi changed the tool name within a tool call".to_string());
            }
        }
        PiRuntimeEvent::ToolActivity(name) if !expected_tools.contains(*name) => {
            return Err("Pi used an unexpected tool".to_string());
        }
        _ => {}
    }
    Ok(())
}

async fn run_pi_protocol(
    context: &ProtocolContext,
    io: &mut PiIo,
    files: &PiRunFiles,
) -> Result<ProtocolOutcome, String> {
    let models = io.request("get_available_models", json!({})).await?;
    let initial_state = io.request("get_state", json!({})).await?;
    let selected_model =
        select_runtime_model(&models, &initial_state, context.request.model.as_deref())?;
    io.request(
        "set_model",
        json!({"provider":selected_model.provider,"modelId":selected_model.id}),
    )
    .await?;
    let levels = parse_thinking_levels(
        &io.request("get_available_thinking_levels", json!({}))
            .await?,
    )?;
    if let Some(effort) = context
        .request
        .effort
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !levels.iter().any(|level| level == effort) {
            return Err("the selected reasoning effort is not available in Pi".to_string());
        }
        io.request("set_thinking_level", json!({"level":effort}))
            .await?;
    }
    let state = io.request("get_state", json!({})).await?;
    let state = validate_selected_state(
        &state,
        &selected_model,
        context
            .request
            .effort
            .as_deref()
            .filter(|value| !value.is_empty()),
        context
            .request
            .session_id
            .as_deref()
            .filter(|value| !value.is_empty()),
    )?;
    let thinking = state.thinking;
    let session_id = state.session_id;

    let attest_prompt = format!(
        "{PI_ATTEST_COMMAND} {} {}",
        files.attestation_nonce, files.system_prompt_nonce
    );
    io.request("prompt", json!({"message":attest_prompt}))
        .await?;
    wait_for_attestation(io, files, &selected_model, &thinking).await?;
    context
        .channel
        .send(LocalAgentEvent::Session {
            session_id: session_id.clone(),
            cli_version: context.cli_version.clone(),
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;

    let prompt = format!("User request:\n{}", turn_prompt(&context.request));
    io.request("prompt", json!({"message":prompt})).await?;
    context
        .channel
        .send(LocalAgentEvent::Status {
            state: "streaming".to_string(),
            message: None,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;

    let expected_tools = files
        .expected_tool_names
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut saw_agent_start = false;
    let mut saw_text_delta = false;
    let mut saw_reasoning_delta = false;
    let mut last_usage = None;
    let mut active_tool_calls = BTreeMap::<u64, String>::new();
    loop {
        let event = io.next_value().await?;
        let decoded = decode_runtime_event(&event)?;
        if let Some(usage) = decoded.usage {
            send_usage(context, usage, &mut last_usage)?;
        }
        validate_tool_call_event(&decoded.event, &expected_tools, &mut active_tool_calls)?;
        match decoded.event {
            PiRuntimeEvent::AgentStart => saw_agent_start = true,
            PiRuntimeEvent::AssistantMessageStart => {
                if !active_tool_calls.is_empty() {
                    return Err(
                        "Pi started a new assistant message with an active tool call".to_string(),
                    );
                }
                saw_text_delta = false;
                saw_reasoning_delta = false;
            }
            PiRuntimeEvent::OtherMessageStart | PiRuntimeEvent::Ignore => {}
            PiRuntimeEvent::TextDelta(delta) => {
                saw_text_delta = true;
                context
                    .channel
                    .send(LocalAgentEvent::TextDelta {
                        delta: delta.to_string(),
                    })
                    .map_err(|_| "local agent event consumer is unavailable".to_string())?;
            }
            PiRuntimeEvent::ReasoningDelta(delta) => {
                saw_reasoning_delta = true;
                context
                    .channel
                    .send(LocalAgentEvent::ReasoningDelta {
                        delta: delta.to_string(),
                    })
                    .map_err(|_| "local agent event consumer is unavailable".to_string())?;
            }
            PiRuntimeEvent::ToolCallStart { .. }
            | PiRuntimeEvent::ToolCallDelta { .. }
            | PiRuntimeEvent::ToolCallEnd { .. }
            | PiRuntimeEvent::ToolActivity(_) => {}
            PiRuntimeEvent::MessageEnd(message) => {
                if !active_tool_calls.is_empty() {
                    return Err(
                        "Pi ended an assistant message with an active tool call".to_string()
                    );
                }
                emit_final_assistant_content(
                    context,
                    message,
                    saw_text_delta,
                    saw_reasoning_delta,
                    &mut last_usage,
                )?;
                if message.get("role").and_then(Value::as_str) == Some("assistant")
                    && message.get("stopReason").and_then(Value::as_str) == Some("error")
                {
                    return Err(message
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi model request failed")
                        .to_string());
                }
            }
            PiRuntimeEvent::Settled => {
                if !saw_agent_start {
                    return Err("Pi settled without starting the requested agent run".to_string());
                }
                if !active_tool_calls.is_empty() {
                    return Err("Pi settled with an active tool call".to_string());
                }
                return Ok(ProtocolOutcome {
                    session_id: Some(session_id),
                    aborted: false,
                });
            }
            PiRuntimeEvent::Error(error) => return Err(error),
            PiRuntimeEvent::ForbiddenNative => {
                return Err("Pi attempted an unexpected native capability".to_string())
            }
            PiRuntimeEvent::UnmatchedResponse => {
                return Err("Pi emitted an unmatched RPC response".to_string())
            }
        }
    }
}
pub(crate) struct PreparedPiRun {
    context: ProtocolContext,
    files: PiRunFiles,
    process_spec: FrozenProcessSpec,
    private_files: Vec<PreparedPrivateFile>,
    configuration_fingerprint: String,
}

impl PreparedPiRun {
    pub(crate) fn configuration_fingerprint(&self) -> &str {
        &self.configuration_fingerprint
    }
}

pub(crate) fn prepare_run(context: ProtocolContext) -> Result<PreparedPiRun, String> {
    if context.request.native_search {
        return Err("Pi does not provide an isolated native search capability".to_string());
    }
    if context.cancellation.is_cancelled() {
        return Err("local agent run cancelled".to_string());
    }
    let files = prepare_run_files(&context)?;
    let args = pi_run_args(&files);
    let private_files = vec![
        PreparedPrivateFile::capture(&files.extension_path, &context.run_dir)?,
        PreparedPrivateFile::capture(&files.config_path, &context.run_dir)?,
    ];
    let process_spec = frozen_process_spec(&context, &files, &args)?;
    let configuration_fingerprint = configuration_fingerprint()?;
    Ok(PreparedPiRun {
        context,
        files,
        process_spec,
        private_files,
        configuration_fingerprint,
    })
}

fn frozen_process_spec(
    context: &ProtocolContext,
    files: &PiRunFiles,
    args: &[String],
) -> Result<FrozenProcessSpec, String> {
    let mut command = Command::new(&context.executable);
    apply_minimal_environment(&mut command);
    command
        .args(args)
        .current_dir(&files.expected_cwd)
        .env(PI_CONFIG_ENV, &files.config_path)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0");
    FrozenProcessSpec::capture(&command).map(|spec| spec.redact_value(&context.bridge_token))
}

pub(crate) async fn launch_prepared(prepared: PreparedPiRun) -> Result<ProtocolOutcome, String> {
    if prepared.configuration_fingerprint().is_empty() {
        return Err("Pi prepared configuration fingerprint is unavailable".to_string());
    }
    let PreparedPiRun {
        context,
        files,
        process_spec,
        private_files,
        configuration_fingerprint: _,
    } = prepared;
    if context.cancellation.is_cancelled() {
        return Ok(ProtocolOutcome {
            session_id: context.request.session_id.clone(),
            aborted: true,
        });
    }
    for private_file in &private_files {
        private_file.verify_unchanged()?;
    }
    let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
    let supervisor = process.supervisor;
    let mut io = PiIo {
        stdin: Box::new(process.stdin),
        reader: Box::new(BufReader::new(process.stdout)),
        next_id: 1,
        cancellation: context.cancellation.clone(),
        output_budget: ProtocolOutputBudget::default(),
        pending: VecDeque::new(),
        completed_ids: HashSet::new(),
    };

    let run_result = supervisor
        .monitor(async {
            match run_pi_protocol(&context, &mut io, &files).await {
                Ok(outcome) => Ok(outcome),
                Err(_) if context.cancellation.is_cancelled() => {
                    io.cancel_gracefully().await;
                    Ok(ProtocolOutcome {
                        session_id: context.request.session_id.clone(),
                        aborted: true,
                    })
                }
                Err(error) => {
                    io.cancel_gracefully().await;
                    Err(error)
                }
            }
        })
        .await;
    drop(io.stdin);
    supervisor
        .finish(run_result, "Pi RPC exited unsuccessfully")
        .await
}

#[cfg(test)]
async fn run(context: ProtocolContext) -> Result<ProtocolOutcome, String> {
    launch_prepared(prepare_run(context)?).await
}

#[cfg(test)]
mod tests {
    use crate::local_agent::LocalToolResolution;
    use crate::local_agent_bridge::ToolBridge;
    use tauri::ipc::InvokeResponseBody;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::mpsc;

    use super::*;

    const CONTRACT_HOST_TOOL: &str = "host_write_probe";
    const CONTRACT_HOST_RESULT: &str = "host-resolution-ok:pi";

    fn compile_contract_cli(mode: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("open-builder-pi-contract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            format!("open-builder-pi-contract-{mode}.exe")
        } else {
            format!("open-builder-pi-contract-{mode}")
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
            "fake Pi CLI failed to compile: {}",
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

    fn contract_request(session_id: Option<String>) -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider: crate::local_agent::LocalAgentProvider::Pi,
            model: Some("openai/gpt-test".to_string()),
            effort: Some("high".to_string()),
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: None,
            session_id,
            session_compatibility_key: None,
            scope: crate::local_agent::LocalAgentRunScope {
                kind: crate::local_agent::LocalAgentRunScopeKind::Conversation,
                id: "test-conversation".to_string(),
            },
            tools: vec![LocalToolSpec {
                name: CONTRACT_HOST_TOOL.to_string(),
                description: "Write only to the fake contract workspace".to_string(),
                input_schema: json!({
                    "type":"object",
                    "properties":{"provider":{"const":"pi"}},
                    "required":["provider"],
                    "additionalProperties":false
                }),
                annotations: Default::default(),
                host_approval: Default::default(),
            }],
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        }
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
            channel,
            cli_version: "0.84.4-test".to_string(),
        }
    }

    fn test_io(
        stdin: DuplexStream,
        stdout: DuplexStream,
        output_budget: ProtocolOutputBudget,
    ) -> PiIo {
        PiIo {
            stdin: Box::new(stdin),
            reader: Box::new(BufReader::new(stdout)),
            next_id: 1,
            cancellation: CancellationToken::new(),
            output_budget,
            pending: VecDeque::new(),
            completed_ids: HashSet::new(),
        }
    }

    #[test]
    fn accepts_only_the_supported_pi_minor_line() {
        for version in ["0.84.4", "pi 0.84.4", "0.84.9+build.1"] {
            assert!(validate_pi_version(Some(version)).is_ok(), "{version}");
        }
        for version in [
            "0.84.3",
            "0.84.4-beta.1",
            "0.83.99",
            "0.85.0",
            "0.85.0-beta.1",
            "1.0.0",
            "invalid",
        ] {
            assert!(validate_pi_version(Some(version)).is_err(), "{version}");
        }
    }

    #[test]
    fn skipped_pi_providers_make_the_catalog_partial() {
        assert_eq!(pi_catalog_authority(false), CatalogAuthority::Authoritative);
        assert_eq!(pi_catalog_authority(true), CatalogAuthority::Partial);
    }

    #[test]
    fn probe_arguments_are_fully_isolated() {
        let extension_path = Path::new("/private/probe.mjs");
        assert_eq!(
            pi_probe_args(extension_path),
            [
                "--mode",
                "rpc",
                "--no-builtin-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-approve",
                "--no-tools",
                "--no-session",
                "-e",
                "/private/probe.mjs",
            ]
        );
        assert_eq!(
            pi_auth_check_args("anthropic"),
            [
                "auth",
                "check",
                "--provider",
                "anthropic",
                "--json",
                "--no-refresh",
            ]
        );
    }

    #[test]
    fn windows_policy_accepts_only_the_native_pi_executable() {
        assert!(IDENTITY.accepts_executable_file_name("pi.exe", true));
        assert!(IDENTITY.accepts_executable_file_name("PI.EXE", true));
        for name in ["pi.cmd", "pi.ps1", "pi.js", "anything.exe"] {
            assert!(!IDENTITY.accepts_executable_file_name(name, true), "{name}");
        }
        assert!(IDENTITY.accepts_executable_file_name("pi", false));
        assert!(!IDENTITY.accepts_executable_file_name("pi.exe", false));
    }

    #[test]
    fn session_ids_are_canonical_opaque_uuids() {
        let canonical = "123e4567-e89b-12d3-a456-426614174000";
        assert_eq!(validate_session_id(canonical).unwrap(), canonical);
        for value in [
            "../../auth.json",
            "/private/tmp/session.jsonl",
            "123e4567",
            "123E4567-E89B-12D3-A456-426614174000",
            "{123e4567-e89b-12d3-a456-426614174000}",
        ] {
            assert!(validate_session_id(value).is_err(), "{value}");
        }

        let request = |session_id: &str| LocalAgentStartRequest {
            provider: crate::local_agent::LocalAgentProvider::Pi,
            model: Some("openai/gpt-test".to_string()),
            effort: Some("high".to_string()),
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: None,
            session_id: Some(session_id.to_string()),
            session_compatibility_key: None,
            scope: crate::local_agent::LocalAgentRunScope {
                kind: crate::local_agent::LocalAgentRunScopeKind::Conversation,
                id: "test-conversation".to_string(),
            },
            tools: Vec::new(),
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        };
        assert!(validate_request(&request(canonical)).is_ok());
        assert!(validate_request(&request("../../session.jsonl")).is_err());
    }

    #[test]
    fn retargets_only_the_requested_persistent_session_to_the_run_workspace() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-pi-session-retarget-{}",
            uuid::Uuid::new_v4()
        ));
        let sessions = root.join("sessions");
        let workspace = root.join("run").join("workspace");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let session_path = sessions.join(format!("2026-01-01T00-00-00-000Z_{session_id}.jsonl"));
        let body = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"123e4567-e89b-12d3-a456-426614174000\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/stale/run/workspace\"}\n",
            "{\"type\":\"message\",\"id\":\"message-1\",\"role\":\"assistant\"}\n"
        );
        write_private_file(&session_path, body.as_bytes()).unwrap();

        let resolved = retarget_persistent_session(&sessions, session_id, &workspace).unwrap();
        assert_eq!(resolved, session_path);
        let rewritten = std::fs::read_to_string(&resolved).unwrap();
        let mut lines = rewritten.lines();
        let header: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["id"], session_id);
        assert_eq!(header["cwd"], workspace.to_string_lossy().as_ref());
        assert_eq!(
            lines.next(),
            Some("{\"type\":\"message\",\"id\":\"message-1\",\"role\":\"assistant\"}")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn utility_runs_keep_pi_session_files_inside_the_disposable_run() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-pi-utility-session-{}",
            uuid::Uuid::new_v4()
        ));
        let (channel, _events) = event_channel();
        let mut request = contract_request(None);
        request.mode = "subagent".to_string();
        request.scope.kind = LocalAgentRunScopeKind::Utility;
        request.scope.id = "utility-1".to_string();
        let context = protocol_context(&root, root.join("unused-pi"), request, channel);
        let files = prepare_run_files(&context).unwrap();

        assert_eq!(files.session_dir, context.run_dir.join("pi-sessions"));
        assert!(files.resume_session_id.is_none());
        assert!(files.session_dir.starts_with(&context.run_dir));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prepared_run_freezes_pi_files_and_configuration_fingerprint() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-pi-prepared-run-{}",
            uuid::Uuid::new_v4()
        ));
        let (channel, _events) = event_channel();
        let mut request = contract_request(None);
        request.mode = "subagent".to_string();
        request.scope.kind = LocalAgentRunScopeKind::Utility;
        request.scope.id = "utility-prepared".to_string();
        let context = protocol_context(&root, root.join("unused-pi"), request, channel);
        let prepared = prepare_run(context).unwrap();
        let frozen_config = std::fs::read(&prepared.files.config_path).unwrap();
        let expected_fingerprint = configuration_fingerprint().unwrap();
        assert_eq!(prepared.private_files.len(), 2);
        std::fs::write(&prepared.files.config_path, b"tampered").unwrap();
        assert!(prepared.private_files[1].verify_unchanged().is_err());
        std::fs::write(&prepared.files.config_path, &frozen_config).unwrap();

        assert_eq!(
            std::fs::read(&prepared.files.config_path).unwrap(),
            frozen_config
        );
        assert_eq!(
            prepared.configuration_fingerprint(),
            expected_fingerprint.as_str()
        );
        assert_eq!(prepared.configuration_fingerprint().len(), 64);
        assert!(!prepared
            .configuration_fingerprint()
            .contains("secret-bridge-token"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pi_routing_identity_tracks_provider_endpoints_without_credentials() {
        let first = json!({
            "providers": {
                "private": {
                    "baseUrl": "https://user:secret-one@example.test/v1?token=hidden",
                    "api": "openai-responses",
                    "apiKey": "secret-api-key-one",
                    "headers": {
                        "Authorization": "Bearer secret-header-one",
                        "X-Tenant": "tenant-one"
                    },
                    "models": [{"id":"model-1","baseUrl":"https://models.example.test/v1"}]
                }
            }
        });
        let credential_change = json!({
            "providers": {
                "private": {
                    "baseUrl": "https://other:secret-two@example.test/v1?token=other",
                    "api": "openai-responses",
                    "apiKey": "secret-api-key-two",
                    "headers": {
                        "Authorization": "Bearer secret-header-two",
                        "X-Tenant": "tenant-two"
                    },
                    "models": [{"id":"model-1","baseUrl":"https://models.example.test/v1"}]
                }
            }
        });
        let endpoint_change = json!({
            "providers": {
                "private": {
                    "baseUrl": "https://replacement.example.test/v1",
                    "api": "openai-responses",
                    "models": [{"id":"model-1","baseUrl":"https://models.example.test/v1"}]
                }
            }
        });
        let first = safe_model_routing_identity(&first).unwrap();
        assert_eq!(
            first,
            safe_model_routing_identity(&credential_change).unwrap()
        );
        assert_ne!(
            first,
            safe_model_routing_identity(&endpoint_change).unwrap()
        );
        assert!(!first.contains("secret"));
    }

    #[test]
    fn pi_version_line_never_falls_back_to_stderr() {
        assert_eq!(
            first_output_line(b"pi 0.84.4\nwarning"),
            Some("pi 0.84.4".to_string())
        );
        assert_eq!(first_output_line(b""), None);
    }

    #[test]
    fn pre_attestation_accepts_official_selection_events() {
        for event_type in [
            "model_select",
            "thinking_level_select",
            "thinking_level_changed",
        ] {
            assert!(is_pre_attestation_selection_event(event_type));
        }
        assert!(!is_pre_attestation_selection_event("message_update"));
    }

    #[test]
    fn validates_probe_command_and_auth_source_payloads() {
        let extension = Path::new("/private/probe.mjs");
        let commands = json!({
            "commands":[{
                "name":"open-builder-probe-auth",
                "source":"extension",
                "sourceInfo":{
                    "path":"/private/probe.mjs",
                    "source":"cli",
                    "scope":"temporary",
                    "origin":"top-level"
                }
            }]
        });
        assert!(validate_probe_command_inventory(&commands, extension).is_ok());

        let nonce = "123e4567-e89b-12d3-a456-426614174000";
        let event = json!({
            "type":"extension_ui_request",
            "method":"notify",
            "notifyType":"info",
            "message":serde_json::to_string(&json!({
                "type":"open_builder_pi_auth_probe",
                "version":1,
                "nonce":nonce,
                "provider":"anthropic",
                "configured":true,
                "source":"stored"
            })).unwrap()
        });
        assert_eq!(
            parse_provider_auth_probe_event(&event, nonce, "anthropic").unwrap(),
            Some(PiProviderAuthStatus {
                configured: true,
                source: Some("stored".to_string()),
            })
        );

        let mut mismatched = event;
        mismatched["message"] = json!("{}");
        assert!(parse_provider_auth_probe_event(&mismatched, nonce, "anthropic").is_err());
    }

    #[tokio::test]
    async fn rpc_request_buffers_out_of_order_probe_events() {
        let (pi_stdin, stdin_peer) = tokio::io::duplex(2048);
        let (mut stdout_peer, pi_stdout) = tokio::io::duplex(4096);
        let responder = tokio::spawn(async move {
            let mut reader = BufReader::new(stdin_peer);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(request["type"], "get_available_models");
            let id = request["id"].as_str().unwrap();
            let transcript = format!(
                "{{\"type\":\"model_select\",\"model\":{{\"provider\":\"openai\",\"id\":\"gpt-test\"}}}}\n{{\"id\":\"{id}\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{{\"models\":[{{\"provider\":\"openai\",\"id\":\"gpt-test\",\"name\":\"GPT Test\",\"reasoning\":true}}]}}}}\n"
            );
            stdout_peer.write_all(transcript.as_bytes()).await.unwrap();
            stdout_peer.shutdown().await.unwrap();
        });
        let mut io = test_io(pi_stdin, pi_stdout, ProtocolOutputBudget::default());
        let data = io.request("get_available_models", json!({})).await.unwrap();
        let models = parse_available_models(&data).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].reference.provider, "openai");
        assert_eq!(models[0].reference.id, "gpt-test");
        assert_eq!(io.next_value().await.unwrap()["type"], "model_select");
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn rpc_io_rejects_malformed_eof_and_exhausted_output() {
        let (stdin, _stdin_peer) = tokio::io::duplex(64);
        let (mut output, stdout) = tokio::io::duplex(64);
        output.write_all(b"not-json\n").await.unwrap();
        let mut io = test_io(stdin, stdout, ProtocolOutputBudget::default());
        assert!(io
            .next_value()
            .await
            .unwrap_err()
            .contains("malformed JSON"));

        let (stdin, _stdin_peer) = tokio::io::duplex(64);
        let (output, stdout) = tokio::io::duplex(64);
        drop(output);
        let mut io = test_io(stdin, stdout, ProtocolOutputBudget::default());
        assert!(io
            .next_value()
            .await
            .unwrap_err()
            .contains("closed unexpectedly"));

        let (stdin, _stdin_peer) = tokio::io::duplex(64);
        let (mut output, stdout) = tokio::io::duplex(64);
        output.write_all(b"{}\n").await.unwrap();
        let mut io = test_io(stdin, stdout, ProtocolOutputBudget::exhausted_for_test());
        assert!(io
            .next_value()
            .await
            .unwrap_err()
            .contains("cumulative byte limit"));
    }

    #[tokio::test]
    async fn cancellation_writes_clear_queue_before_abort() {
        let (pi_stdin, stdin_peer) = tokio::io::duplex(2048);
        let (mut stdout_peer, pi_stdout) = tokio::io::duplex(2048);
        let responder = tokio::spawn(async move {
            let mut reader = BufReader::new(stdin_peer);
            let mut commands = Vec::new();
            for expected in ["clear_queue", "abort"] {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(line.trim_end()).unwrap();
                assert_eq!(request["type"], expected);
                let id = request["id"].as_str().unwrap();
                commands.push(expected.to_string());
                let response = format!(
                    "{{\"id\":\"{id}\",\"type\":\"response\",\"command\":\"{expected}\",\"success\":true,\"data\":{{}}}}\n"
                );
                stdout_peer.write_all(response.as_bytes()).await.unwrap();
            }
            commands
        });
        let mut io = test_io(pi_stdin, pi_stdout, ProtocolOutputBudget::default());
        io.cancel_gracefully().await;
        assert_eq!(responder.await.unwrap(), ["clear_queue", "abort"]);
    }

    #[test]
    fn decodes_streaming_tool_and_settled_transcript() {
        assert!(matches!(
            decode_runtime_event(&json!({"type":"agent_start"}))
                .unwrap()
                .event,
            PiRuntimeEvent::AgentStart
        ));
        assert!(matches!(
            decode_runtime_event(&json!({"type":"message_start","message":{"role":"assistant"}}))
                .unwrap()
                .event,
            PiRuntimeEvent::AssistantMessageStart
        ));

        let text = json!({
            "type":"message_update",
            "usage":{"input":1,"output":2,"cacheRead":3},
            "assistantMessageEvent":{"type":"text_delta","delta":"hello"}
        });
        let decoded = decode_runtime_event(&text).unwrap();
        assert_eq!(usage_values(decoded.usage.unwrap()), Some((1, 2, 3)));
        assert!(matches!(decoded.event, PiRuntimeEvent::TextDelta("hello")));

        let thinking = json!({
            "type":"message_update",
            "assistantMessageEvent":{"type":"thinking_delta","delta":"reason"}
        });
        assert!(matches!(
            decode_runtime_event(&thinking).unwrap().event,
            PiRuntimeEvent::ReasoningDelta("reason")
        ));
        let tool = json!({
            "type":"tool_execution_start",
            "toolName":"read_files"
        });
        assert!(matches!(
            decode_runtime_event(&tool).unwrap().event,
            PiRuntimeEvent::ToolActivity("read_files")
        ));

        let tool_start = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_start",
                "contentIndex":0,
                "toolName":"read_files"
            }
        });
        assert!(matches!(
            decode_runtime_event(&tool_start).unwrap().event,
            PiRuntimeEvent::ToolCallStart {
                content_index: 0,
                name: "read_files"
            }
        ));
        let tool_delta = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_delta",
                "contentIndex":0,
                "delta":"{\"path\":"
            }
        });
        assert!(matches!(
            decode_runtime_event(&tool_delta).unwrap().event,
            PiRuntimeEvent::ToolCallDelta {
                content_index: 0,
                name: None,
            }
        ));
        let tool_end = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_end",
                "contentIndex":0,
                "toolCall":{"name":"read_files"}
            }
        });
        assert!(matches!(
            decode_runtime_event(&tool_end).unwrap().event,
            PiRuntimeEvent::ToolCallEnd {
                content_index: 0,
                name: "read_files"
            }
        ));
        assert!(decode_runtime_event(&json!({
            "type":"message_update",
            "assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0}
        }))
        .is_err());
        assert!(decode_runtime_event(&json!({
            "type":"message_update",
            "assistantMessageEvent":{"type":"toolcall_delta","delta":"{}"}
        }))
        .is_err());
        assert!(decode_runtime_event(&json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_start",
                "contentIndex":0,
                "toolName":"read_files",
                "toolCall":{"name":"write_file"}
            }
        }))
        .is_err());
        assert!(decode_runtime_event(&json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_delta",
                "contentIndex":0,
                "delta":"{}",
                "partial":{"content":[{"type":"toolCall","name":"write_file"}]}
            }
        }))
        .is_ok());
        assert!(decode_runtime_event(&json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_end",
                "contentIndex":0,
                "toolCall":{"name":"read_files"}
            }
        }))
        .is_ok());
        assert!(matches!(
            decode_runtime_event(&json!({"type":"agent_settled"}))
                .unwrap()
                .event,
            PiRuntimeEvent::Settled
        ));
        assert!(matches!(
            decode_runtime_event(&json!({"type":"queue_update"}))
                .unwrap()
                .event,
            PiRuntimeEvent::Ignore
        ));
        assert!(decode_runtime_event(&json!({"type":"future_noncritical_event"})).is_err());
        assert!(decode_runtime_event(&json!({"type":"permission_request"})).is_err());
        assert!(decode_runtime_event(
            &json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta"}})
        )
        .is_err());
        assert!(decode_runtime_event(&json!({"message":{}})).is_err());
    }

    #[test]
    fn validates_pi_tool_call_deltas_against_the_started_host_tool() {
        let expected = HashSet::from(["read_files"]);
        let start_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_start",
                "contentIndex":3,
                "toolName":"read_files"
            }
        });
        let start = decode_runtime_event(&start_value).unwrap().event;
        let delta_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_delta",
                "contentIndex":3,
                "delta":"{}"
            }
        });
        let delta = decode_runtime_event(&delta_value).unwrap().event;
        let end_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_end",
                "contentIndex":3,
                "toolCall":{"name":"read_files"}
            }
        });
        let end = decode_runtime_event(&end_value).unwrap().event;
        let mut active = BTreeMap::new();
        validate_tool_call_event(&start, &expected, &mut active).unwrap();
        validate_tool_call_event(&delta, &expected, &mut active).unwrap();
        validate_tool_call_event(&end, &expected, &mut active).unwrap();
        assert!(active.is_empty());

        let unstarted_delta_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_delta",
                "contentIndex":4,
                "delta":"{}"
            }
        });
        let unstarted_delta = decode_runtime_event(&unstarted_delta_value).unwrap().event;
        assert!(validate_tool_call_event(&unstarted_delta, &expected, &mut active).is_err());

        let wrong_end_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_end",
                "contentIndex":3,
                "toolCall":{"name":"write_files"}
            }
        });
        let wrong_end = decode_runtime_event(&wrong_end_value).unwrap().event;
        assert!(validate_tool_call_event(&wrong_end, &expected, &mut active).is_err());

        let mut active = BTreeMap::new();
        let start_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_start",
                "contentIndex":3,
                "toolName":"read_files"
            }
        });
        let start = decode_runtime_event(&start_value).unwrap().event;
        validate_tool_call_event(&start, &expected, &mut active).unwrap();
        let mismatched_delta_value = json!({
            "type":"message_update",
            "assistantMessageEvent":{
                "type":"toolcall_delta",
                "contentIndex":3,
                "delta":"{}",
                "toolName":"write_files"
            }
        });
        let mismatched_delta = decode_runtime_event(&mismatched_delta_value).unwrap().event;
        assert!(validate_tool_call_event(&mismatched_delta, &expected, &mut active).is_err());
    }

    #[test]
    fn validates_model_effort_and_resume_state() {
        let model = PiModelRef {
            provider: "openai".to_string(),
            id: "gpt-test".to_string(),
        };
        let session = "123e4567-e89b-12d3-a456-426614174000";
        let state = json!({
            "model":{"provider":"openai","id":"gpt-test"},
            "thinkingLevel":"high",
            "sessionId":session
        });
        let validated =
            validate_selected_state(&state, &model, Some("high"), Some(session)).unwrap();
        assert_eq!(validated.thinking, "high");
        assert_eq!(validated.session_id, session);
        assert_eq!(
            parse_thinking_levels(&json!({"levels":["off","high","high"]})).unwrap(),
            ["off", "high"]
        );

        let mut wrong_model = state.clone();
        wrong_model["model"]["id"] = json!("other");
        assert!(
            validate_selected_state(&wrong_model, &model, Some("high"), Some(session)).is_err()
        );
        assert!(validate_selected_state(&state, &model, Some("low"), Some(session)).is_err());
        assert!(validate_selected_state(
            &state,
            &model,
            Some("high"),
            Some("223e4567-e89b-12d3-a456-426614174000")
        )
        .is_err());
        let mut path_session = state.clone();
        path_session["sessionId"] = json!("../../outside.jsonl");
        assert!(validate_selected_state(&path_session, &model, Some("high"), None).is_err());

        let models = json!({"models":[
            {"provider":"openai","id":"gpt-test","name":"GPT Test"},
            {"provider":"anthropic","id":"claude-test","name":"Claude Test"}
        ]});
        assert_eq!(select_runtime_model(&models, &state, None).unwrap(), model);
        assert_eq!(
            select_runtime_model(&models, &state, Some("anthropic/claude-test"))
                .unwrap()
                .provider,
            "anthropic"
        );
        assert!(select_runtime_model(&models, &state, Some("missing/model")).is_err());
    }

    #[test]
    fn derives_only_the_registered_loopback_broker_routes() {
        assert_eq!(
            pi_endpoint_urls("http://127.0.0.1:43210/mcp").unwrap(),
            (
                "http://127.0.0.1:43210/pi/tools".to_string(),
                "http://127.0.0.1:43210/pi/call".to_string()
            )
        );
        for url in [
            "https://127.0.0.1:43210/mcp",
            "http://localhost:43210/mcp",
            "http://127.0.0.1:43210/other",
            "http://127.0.0.1/mcp",
            "http://user@127.0.0.1:43210/mcp",
        ] {
            assert!(pi_endpoint_urls(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn strict_reader_accepts_lf_and_rejects_crlf_or_unterminated_records() {
        let (mut writer, reader) = tokio::io::duplex(256);
        writer
            .write_all(b"{\"type\":\"agent_start\"}\n")
            .await
            .unwrap();
        writer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_pi_line(&mut reader).await.unwrap().as_deref(),
            Some("{\"type\":\"agent_start\"}")
        );
        assert!(read_pi_line(&mut reader).await.unwrap().is_none());

        let (mut writer, reader) = tokio::io::duplex(256);
        writer.write_all(b"{}\r\n").await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(read_pi_line(&mut BufReader::new(reader)).await.is_err());

        let (mut writer, reader) = tokio::io::duplex(256);
        writer.write_all(b"{}").await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(read_pi_line(&mut BufReader::new(reader)).await.is_err());
    }

    fn attestation_files() -> PiRunFiles {
        PiRunFiles {
            config_path: PathBuf::from("/private/run/config.json"),
            extension_path: PathBuf::from("/private/run/extension.mjs"),
            session_dir: PathBuf::from("/private/sessions"),
            resume_session_id: None,
            expected_cwd: "/private/workspace".to_string(),
            expected_tool_names: vec!["read_files".to_string(), "write_file".to_string()],
            tool_digest: "digest".to_string(),
            attestation_nonce: "attest".to_string(),
            system_prompt_nonce: "system".to_string(),
        }
    }

    fn valid_attestation() -> Value {
        json!({
            "type":"open_builder_pi_attestation",
            "version":1,
            "attestationNonce":"attest",
            "systemPromptNonce":"system",
            "extensionPath":"/private/run/extension.mjs",
            "cwd":"/private/workspace",
            "model":{"provider":"openai","id":"gpt-test"},
            "providerAuth":{"configured":true,"source":"stored"},
            "thinkingLevel":"high",
            "activeTools":["read_files","write_file"],
            "allTools":[
                {"name":"read","sourceInfo":{"path":"<builtin:read>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"bash","sourceInfo":{"path":"<builtin:bash>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"powershell","sourceInfo":{"path":"<builtin:powershell>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"edit","sourceInfo":{"path":"<builtin:edit>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"write","sourceInfo":{"path":"<builtin:write>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"grep","sourceInfo":{"path":"<builtin:grep>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"find","sourceInfo":{"path":"<builtin:find>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"ls","sourceInfo":{"path":"<builtin:ls>","source":"builtin","scope":"temporary","origin":"top-level"}},
                {"name":"read_files","sourceInfo":{"path":"/private/run/extension.mjs","source":"cli","scope":"temporary","origin":"top-level"}},
                {"name":"write_file","sourceInfo":{"path":"/private/run/extension.mjs","source":"cli","scope":"temporary","origin":"top-level"}}
            ],
            "extensions":[{"path":"/private/run/extension.mjs","source":"cli","scope":"temporary","origin":"top-level"}],
            "contextFiles":[],
            "skills":[],
            "promptTemplates":[],
            "violations":[],
            "commands":[
                {"name":"open-builder-attest","sourceInfo":{"path":"/private/run/extension.mjs","source":"cli","scope":"temporary","origin":"top-level"}},
                {"name":"llama","sourceInfo":{"path":"<inline:llama.cpp>","source":"inline","scope":"temporary","origin":"top-level"}}
            ],
            "computedToolDigest":"digest"
        })
    }

    #[test]
    fn validates_the_full_pi_attestation_fixture() {
        let files = attestation_files();
        let model = PiModelRef {
            provider: "openai".to_string(),
            id: "gpt-test".to_string(),
        };
        assert!(validate_attestation(&valid_attestation(), &files, &model, "high").is_ok());

        let mut unexpected = valid_attestation();
        unexpected["activeTools"] = json!(["read_files", "bash"]);
        assert!(validate_attestation(&unexpected, &files, &model, "high").is_err());

        let mut injected = valid_attestation();
        injected["skills"] = json!(["untrusted"]);
        assert!(validate_attestation(&injected, &files, &model, "high").is_err());

        let mut unknown_builtin = valid_attestation();
        unknown_builtin["allTools"][0] = json!({
            "name":"future_builtin",
            "sourceInfo":{
                "path":"<builtin:future_builtin>",
                "source":"builtin",
                "scope":"temporary",
                "origin":"top-level"
            }
        });
        assert!(validate_attestation(&unknown_builtin, &files, &model, "high").is_err());

        let mut inline_tool = valid_attestation();
        inline_tool["allTools"][0] = json!({
            "name":"inline_write",
            "sourceInfo":{
                "path":"<inline:write>",
                "source":"inline",
                "scope":"temporary",
                "origin":"top-level"
            }
        });
        assert!(validate_attestation(&inline_tool, &files, &model, "high").is_err());

        let mut inline_command = valid_attestation();
        inline_command["commands"][1] = json!({
            "name":"write-project",
            "sourceInfo":{
                "path":"<inline:write-project>",
                "source":"inline",
                "scope":"temporary",
                "origin":"top-level"
            }
        });
        assert!(validate_attestation(&inline_command, &files, &model, "high").is_err());

        for source in [
            "runtime",
            "environment",
            "fallback",
            "models_json_key",
            "models_json_command",
        ] {
            let mut unsafe_auth = valid_attestation();
            unsafe_auth["providerAuth"]["source"] = json!(source);
            assert!(validate_attestation(&unsafe_auth, &files, &model, "high").is_err());
        }

        let mut unconfigured = valid_attestation();
        unconfigured["providerAuth"]["configured"] = json!(false);
        assert!(validate_attestation(&unconfigured, &files, &model, "high").is_err());

        let mut leaked_label = valid_attestation();
        leaked_label["providerAuth"]["label"] = json!("must not be attested");
        assert!(validate_attestation(&leaked_label, &files, &model, "high").is_err());
    }

    #[tokio::test]
    async fn parses_a_pi_0844_fake_transcript_without_splitting_unicode_separators() {
        let transcript = concat!(
            "{\"type\":\"agent_start\"}\n",
            "{\"type\":\"message_update\",\"usage\":{\"input\":1,\"output\":1,\"cacheRead\":0},\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"a\u{2028}b\"}}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"a\u{2028}b\"}],\"stopReason\":\"stop\",\"usage\":{\"input\":1,\"output\":1,\"cacheRead\":0}}}\n",
            "{\"type\":\"agent_settled\"}\n"
        );
        let (mut writer, reader) = tokio::io::duplex(2048);
        writer.write_all(transcript.as_bytes()).await.unwrap();
        writer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        let mut types = Vec::new();
        while let Some(line) = read_pi_line(&mut reader).await.unwrap() {
            let value: Value = serde_json::from_str(&line).unwrap();
            types.push(value["type"].as_str().unwrap().to_string());
        }
        assert_eq!(
            types,
            [
                "agent_start",
                "message_update",
                "message_end",
                "agent_settled"
            ]
        );
    }

    #[tokio::test]
    async fn real_fake_process_proves_fresh_and_resume_pi_rpc_contracts() {
        let resumed_session = "123e4567-e89b-12d3-a456-426614174000";
        for resumed in [false, true] {
            let (root, executable) = compile_contract_cli("success");
            let (channel, mut events) = event_channel();
            let request = contract_request(resumed.then(|| resumed_session.to_string()));
            let run_id = format!("pi-contract-{resumed}");
            let cancellation = CancellationToken::new();
            let bridge = ToolBridge::default();
            let (bridge_url, bridge_token) = bridge
                .register(
                    run_id.clone(),
                    request.tools.clone(),
                    request.max_tool_calls,
                    cancellation.clone(),
                    channel.clone(),
                )
                .await
                .unwrap();
            let mut context = protocol_context(&root, executable, request, channel);
            context.bridge_url = bridge_url;
            context.bridge_token = bridge_token;
            context.cancellation = cancellation;
            if resumed {
                let persisted = context
                    .session_dir
                    .join(format!("2026-01-01T00-00-00-000Z_{resumed_session}.jsonl"));
                let header = json!({
                    "type":"session",
                    "version":3,
                    "id":resumed_session,
                    "timestamp":"2026-01-01T00:00:00.000Z",
                    "cwd":"/stale/pi/workspace"
                });
                write_private_file(
                    &persisted,
                    format!("{}\n", serde_json::to_string(&header).unwrap()).as_bytes(),
                )
                .unwrap();
            }
            let run = run(context);
            tokio::pin!(run);
            let mut recorded = Vec::new();
            let mut host_request_index = None;
            let outcome = loop {
                tokio::select! {
                    result = &mut run => break result.unwrap(),
                    event = events.recv() => {
                        let event = event.expect("Pi contract event channel closed");
                        let event_index = recorded.len();
                        if event.get("type").and_then(Value::as_str) == Some("toolRequest") {
                            assert!(host_request_index.replace(event_index).is_none());
                            assert_eq!(event["runId"], run_id);
                            assert_eq!(event["name"], CONTRACT_HOST_TOOL);
                            assert_eq!(event["arguments"]["provider"], "pi");
                            bridge.resolve(
                                event["runId"].as_str().unwrap(),
                                event["callId"].as_str().unwrap(),
                                LocalToolResolution {
                                    text: CONTRACT_HOST_RESULT.to_string(),
                                    is_error: Some(false),
                                    structured_content: Some(json!({"provider":"pi","resolved":true})),
                                    content: None,
                                },
                            ).unwrap();
                        }
                        recorded.push(event);
                    }
                }
            };
            assert_eq!(outcome.session_id.as_deref(), Some(resumed_session));
            assert!(!outcome.aborted);

            while let Ok(event) = events.try_recv() {
                recorded.push(event);
            }
            for event_type in ["session", "status", "reasoningDelta", "textDelta", "usage"] {
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
                .expect("missing Pi text after Host resolution");
            assert!(text_index > host_request_index);

            let invocation = std::fs::read_to_string(root.join("provider-invocation.log")).unwrap();
            assert!(invocation.contains("\"type\":\"get_available_models\""));
            assert!(invocation.contains("User request:\\nprompt"));
            assert!(invocation.contains("--mode\u{1f}rpc"));
            assert_eq!(invocation.contains("\u{1f}--session\u{1f}"), resumed);
            assert!(!invocation.contains("secret-bridge-token"));
            bridge.unregister(&run_id, "Pi contract complete");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn real_fake_process_rejects_unknown_pi_capability_event() {
        let (root, executable) = compile_contract_cli("unknown");
        let (channel, _events) = event_channel();
        let mut request = contract_request(None);
        request.tools.clear();
        let context = protocol_context(&root, executable, request, channel);
        let error = match run(context).await {
            Ok(_) => panic!("unknown Pi capability event must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("unsupported event type"), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_covers_pi_failure_contracts() {
        for mode in ["malformed", "oversized", "nonzero", "stderr-approval"] {
            let (root, executable) = compile_contract_cli(mode);
            let (channel, _events) = event_channel();
            let context = protocol_context(&root, executable, contract_request(None), channel);
            let error = run(context)
                .await
                .expect_err("Pi failure fixture must not complete");
            match mode {
                "malformed" => assert!(error.contains("malformed JSON"), "{error}"),
                "oversized" => assert!(error.contains("line limit"), "{error}"),
                "stderr-approval" => {
                    assert!(error.contains("provider approval rejected"), "{error}")
                }
                _ => assert!(
                    error.contains("failed to write")
                        || error.contains("closed unexpectedly")
                        || error.contains("closed before"),
                    "{error}"
                ),
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
