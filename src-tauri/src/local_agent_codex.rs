use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentEvent, LocalAgentModel,
    LocalAgentStartRequest, LocalToolSpec,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_media::{
    read_generated_image, GeneratedImageBytes, PreparedLocalImageRequest,
};
use crate::local_agent_models::{
    CatalogAuthority, EffortKnowledge, ModelCandidate, ModelPreference,
};
use crate::local_agent_protocol::{
    apply_minimal_environment, command_output_capped, contains_capability_semantics,
    read_capped_line, turn_prompt, FrozenProcessSpec, PreparedPrivateFile, ProtocolContext,
    ProtocolOutcome, ProtocolOutputBudget, RunSupervisor,
};
use crate::local_agent_runtime::{AdapterError, LocalCliFailureCode};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_MODEL_PROBE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CODEX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CODEX_PROVIDER_VALUE_BYTES: usize = 64 * 1024;
const MAX_CODEX_PROVIDER_ENV_BYTES: usize = 256 * 1024;
const MAX_CODEX_EFFORT_BYTES: usize = 64;
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";
const SYNTHETIC_OPENAI_PROVIDER: &str = "open_builder_proxy";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
const HANDSHAKE_TIMEOUT_ERROR: &str = "Codex exec handshake timed out";
const CODEX_MCP_TOKEN_ENV: &str = "OPEN_BUILDER_MCP_TOKEN";
const MCP_APPROVAL_CAPABILITY_TOOL: &str = "open_builder_capability_probe";
const MCP_APPROVAL_REJECTION_ERROR: &str =
    "Open Builder tool bridge approval was rejected by Codex";
const MODEL_DISCOVERY_WARNING: &str =
    "Codex model discovery was unavailable; the current model selection remains unverified.";
const STRUCTURED_CAPABILITY_ERROR: &str =
    "Codex is missing required structured execution capabilities; upgrade the Codex CLI.";
const LOGIN_PROBE_ERROR: &str = "Codex login status could not be verified.";
const MODEL_PROBE_ERROR: &str = "Codex model discovery could not be completed.";
const RUN_ERROR: &str = "Codex exec returned an invalid or unsuccessful response.";
const PREPARED_INSTRUCTIONS_CHANGED_ERROR: &str =
    "Private Codex instructions changed during preparation";
const MAX_SESSION_ID_BYTES: usize = 512;
const APP_SERVER_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const APP_SERVER_MAX_PRE_RESPONSE_NOTIFICATIONS: usize = 256;
const IMAGE_WORKER_INSTRUCTIONS: &str = "You are an isolated image generation worker. Use the built-in image generation capability exactly once for the user's request. If reference images are attached, use them only as visual references for the requested edit. Do not use shell, browser, MCP, apps, plugins, skills, collaboration, or any other capability. A text-only answer is not a successful result.";
const MEDIA_UNSUPPORTED: &str = "local CLI image generation is unsupported";

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "codex",
    setup_command: "codex login",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: true,
        image_generation: true,
        image_editing: true,
        media_capabilities_verified: false,
    },
    // The readiness probe runs several independently bounded stages.
    probe_timeout: Duration::from_secs(45),
    unix_home_directories: &[],
    windows_home_directories: &[".codex\\bin"],
    windows_local_directories: &["Programs\\Codex"],
    windows_program_directories: &["Codex"],
    require_empty_workspace: false,
};

fn first_output_line(output: &std::process::Output) -> Option<String> {
    // Never surface stderr as a version string: CLI stderr can contain
    // provider diagnostics or other data that must stay out of the UI.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn output_text(output: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    text
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoginStatus {
    Authenticated,
    NotAuthenticated,
    Unknown,
}

#[derive(Clone, Default)]
struct CodexProviderConfig {
    overrides: Vec<(String, String)>,
    environment: Vec<(String, String)>,
    default_model: Option<String>,
    default_effort: Option<String>,
    custom_provider: bool,
}

impl CodexProviderConfig {
    fn apply(&self, command: &mut Command) {
        command.envs(self.environment.iter().cloned());
    }

    fn uses_custom_provider(&self) -> bool {
        self.custom_provider
    }

    fn bypasses_login_status(&self) -> bool {
        self.custom_provider
    }

    fn excluded_environment_names(&self) -> Vec<String> {
        let mut names = BTreeSet::from([CODEX_MCP_TOKEN_ENV.to_string()]);
        names.extend(self.environment.iter().map(|(name, _)| name.clone()));
        names.into_iter().collect()
    }

    fn configured_model(&self) -> Option<LocalAgentModel> {
        self.default_model.as_ref().map(|model| LocalAgentModel {
            id: model.clone(),
            display_name: model.clone(),
            is_default: true,
            default_effort: self.default_effort.clone(),
            efforts: self.default_effort.iter().cloned().collect(),
        })
    }
}

pub(crate) fn model_catalog_context(
    models: Vec<LocalAgentModel>,
) -> Result<(Vec<ModelCandidate>, ModelPreference), String> {
    let provider_config = load_provider_config()?;
    let configured = ModelPreference {
        model: provider_config.default_model.clone(),
        effort: provider_config.default_effort.clone(),
    };
    let configured_model = configured.model.as_deref();
    let custom_provider = provider_config.uses_custom_provider();
    let candidates = models
        .into_iter()
        .map(|mut model| {
            if let Some(configured_model) = configured_model {
                model.is_default = model.id == configured_model;
            }
            let efforts = model.efforts.clone();
            if custom_provider || efforts.is_empty() {
                ModelCandidate::unknown(model)
            } else {
                ModelCandidate {
                    model,
                    effort_knowledge: EffortKnowledge::Known,
                }
            }
        })
        .collect();
    Ok((candidates, configured))
}

fn validate_user_config_path(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("failed to inspect Codex user configuration".to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_CODEX_CONFIG_BYTES {
        return Err(
            "Codex user configuration must be a regular file no larger than 2 MiB".to_string(),
        );
    }
    Ok(Some(path.to_path_buf()))
}

fn user_config_path() -> Result<Option<PathBuf>, String> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(windows)]
            let home = std::env::var_os("USERPROFILE");
            #[cfg(not(windows))]
            let home = std::env::var_os("HOME");
            home.map(|home| PathBuf::from(home).join(".codex"))
        });
    match codex_home {
        Some(codex_home) if codex_home.is_absolute() => {
            validate_user_config_path(&codex_home.join("config.toml"))
        }
        Some(_) => Err("Codex home directory must use an absolute path".to_string()),
        None => Ok(None),
    }
}

fn validate_provider_value(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_CODEX_PROVIDER_VALUE_BYTES
        || value
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err(format!(
            "Codex provider setting {name} contains an invalid value"
        ));
    }
    Ok(())
}

fn valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._/:-".contains(character))
}

fn valid_effort(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CODEX_EFFORT_BYTES
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn validate_environment_name(name: &str) -> Result<(), String> {
    let syntax_valid = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_');
    let dangerous = matches!(
        name,
        "PATH"
            | "HOME"
            | "USERPROFILE"
            | "CODEX_HOME"
            | "NODE_OPTIONS"
            | "BASH_ENV"
            | "ENV"
            | "SHELLOPTS"
            | "CDPATH"
            | "GLOBIGNORE"
            | CODEX_MCP_TOKEN_ENV
    ) || name.starts_with("LD_")
        || name.starts_with("DYLD_")
        || name.starts_with("OPEN_BUILDER_");
    if !syntax_valid || dangerous {
        return Err(
            "Codex provider configuration references an unsafe environment name".to_string(),
        );
    }
    Ok(())
}

fn validate_provider_url(value: &str) -> Result<bool, String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| "Codex provider URL is invalid".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Codex provider URL must not contain credentials, a query, or a fragment".to_string(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Codex provider URL must include a host".to_string())?;
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err("Codex provider URL must use HTTPS or loopback HTTP".to_string());
    }
    let is_openai = url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && (host.eq_ignore_ascii_case("api.openai.com")
            || host.to_ascii_lowercase().ends_with(".api.openai.com"));
    Ok(is_openai)
}

fn string_field<'a>(
    table: &'a toml::Table,
    key: &str,
    context: &str,
) -> Result<Option<&'a str>, String> {
    table
        .get(key)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("Codex {context} {key} must be a string"))
        })
        .transpose()
}

fn insert_environment(
    environment: &mut BTreeMap<String, String>,
    inherited: &BTreeMap<String, String>,
    name: &str,
) -> Result<(), String> {
    validate_environment_name(name)?;
    let value = inherited
        .get(name)
        .ok_or_else(|| "Codex provider credential environment is not configured".to_string())?;
    validate_provider_value(name, value)?;
    environment.insert(name.to_string(), value.clone());
    Ok(())
}

fn provider_override_key(provider: &str, field: &str) -> String {
    format!("model_providers.{provider}.{field}")
}

fn validate_query_params(value: &toml::Value) -> Result<toml::Value, String> {
    let table = value
        .as_table()
        .filter(|table| table.len() == 1)
        .ok_or_else(|| {
            "Codex provider query_params only supports a single api-version value".to_string()
        })?;
    let version = table
        .get("api-version")
        .and_then(toml::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
        })
        .ok_or_else(|| {
            "Codex provider query_params only supports a non-secret api-version".to_string()
        })?;
    Ok(toml::Value::Table(toml::Table::from_iter([(
        "api-version".to_string(),
        toml::Value::String(version.to_string()),
    )])))
}

fn validate_provider_table(
    provider: &str,
    table: &toml::Table,
    inherited: &BTreeMap<String, String>,
) -> Result<CodexProviderConfig, String> {
    const ALLOWED_FIELDS: &[&str] = &[
        "name",
        "base_url",
        "wire_api",
        "env_key",
        "env_key_instructions",
        "env_http_headers",
        "query_params",
        "requires_openai_auth",
        "request_max_retries",
        "stream_max_retries",
        "stream_idle_timeout_ms",
        "supports_websockets",
        "supports_standalone_web_search",
    ];
    if table.contains_key("auth") {
        return Err(
            "Codex command-backed provider authentication is not allowed in isolated runs"
                .to_string(),
        );
    }
    if table.contains_key("http_headers") || table.contains_key("experimental_bearer_token") {
        return Err(
            "Codex static provider credentials are not allowed; use env_key or env_http_headers"
                .to_string(),
        );
    }
    if let Some(requires_openai_auth) = table.get("requires_openai_auth") {
        match requires_openai_auth.as_bool() {
            Some(false) => {}
            Some(true) => return Err(
                "Codex custom providers cannot use stored OpenAI authentication in isolated runs"
                    .to_string(),
            ),
            None => return Err("Codex provider requires_openai_auth must be a boolean".to_string()),
        }
    }
    if let Some(field) = table
        .keys()
        .find(|field| !ALLOWED_FIELDS.contains(&field.as_str()))
    {
        return Err(format!(
            "Codex custom provider contains unsupported field {field}"
        ));
    }

    let base_url = string_field(table, "base_url", "provider")?
        .ok_or_else(|| "Codex custom provider must define base_url".to_string())?;
    validate_provider_url(base_url)?;
    let is_loopback = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]"));
    let mut environment = BTreeMap::new();
    let mut overrides = vec![
        (
            "model_provider".to_string(),
            toml::Value::String(provider.to_string()).to_string(),
        ),
        (
            provider_override_key(provider, "base_url"),
            toml::Value::String(base_url.to_string()).to_string(),
        ),
    ];
    if let Some(name) = string_field(table, "name", "provider")? {
        validate_provider_value("name", name)?;
        overrides.push((
            provider_override_key(provider, "name"),
            toml::Value::String(name.to_string()).to_string(),
        ));
    }
    if let Some(wire_api) = string_field(table, "wire_api", "provider")? {
        if wire_api != "responses" {
            return Err("Codex custom providers must use the responses wire API".to_string());
        }
        overrides.push((
            provider_override_key(provider, "wire_api"),
            toml::Value::String(wire_api.to_string()).to_string(),
        ));
    }
    if let Some(env_key) = string_field(table, "env_key", "provider")? {
        insert_environment(&mut environment, inherited, env_key)?;
        overrides.push((
            provider_override_key(provider, "env_key"),
            toml::Value::String(env_key.to_string()).to_string(),
        ));
    }
    if let Some(headers) = table.get("env_http_headers") {
        let headers = headers
            .as_table()
            .filter(|headers| !headers.is_empty() && headers.len() <= 32)
            .ok_or_else(|| "Codex env_http_headers must be a bounded table".to_string())?;
        let mut sanitized = toml::Table::new();
        for (header, environment_name) in headers {
            if header.len() > 128
                || reqwest::header::HeaderName::from_bytes(header.as_bytes()).is_err()
            {
                return Err("Codex provider contains an invalid HTTP header name".to_string());
            }
            let environment_name = environment_name.as_str().ok_or_else(|| {
                "Codex env_http_headers values must name environment variables".to_string()
            })?;
            validate_environment_name(environment_name)?;
            if let Some(value) = inherited.get(environment_name) {
                validate_provider_value(environment_name, value)?;
                environment.insert(environment_name.to_string(), value.clone());
            }
            sanitized.insert(
                header.clone(),
                toml::Value::String(environment_name.to_string()),
            );
        }
        overrides.push((
            provider_override_key(provider, "env_http_headers"),
            toml::Value::Table(sanitized).to_string(),
        ));
    }
    if let Some(query_params) = table.get("query_params") {
        overrides.push((
            provider_override_key(provider, "query_params"),
            validate_query_params(query_params)?.to_string(),
        ));
    }
    for (field, maximum) in [
        ("request_max_retries", 100_i64),
        ("stream_max_retries", 100_i64),
        ("stream_idle_timeout_ms", 1_800_000_i64),
    ] {
        if let Some(value) = table.get(field) {
            let value = value
                .as_integer()
                .filter(|value| *value >= 0 && *value <= maximum)
                .ok_or_else(|| format!("Codex provider {field} is outside the supported range"))?;
            overrides.push((
                provider_override_key(provider, field),
                toml::Value::Integer(value).to_string(),
            ));
        }
    }
    for field in ["supports_websockets", "supports_standalone_web_search"] {
        if let Some(value) = table.get(field) {
            let value = value
                .as_bool()
                .ok_or_else(|| format!("Codex provider {field} must be a boolean"))?;
            overrides.push((
                provider_override_key(provider, field),
                toml::Value::Boolean(value).to_string(),
            ));
        }
    }
    if !is_loopback && environment.is_empty() {
        return Err(
            "Codex remote custom provider requires an explicit environment credential".to_string(),
        );
    }
    let total_bytes = environment
        .iter()
        .try_fold(0_usize, |total, (name, value)| {
            total
                .checked_add(name.len().saturating_add(value.len()))
                .ok_or_else(|| "Codex provider environment exceeds the size limit".to_string())
        })?;
    if total_bytes > MAX_CODEX_PROVIDER_ENV_BYTES {
        return Err("Codex provider environment exceeds the size limit".to_string());
    }
    Ok(CodexProviderConfig {
        overrides,
        environment: environment.into_iter().collect(),
        custom_provider: true,
        ..CodexProviderConfig::default()
    })
}

fn provider_config_from_sources(
    config: Option<&str>,
    inherited: &BTreeMap<String, String>,
) -> Result<CodexProviderConfig, String> {
    let Some(config) = config else {
        return Ok(CodexProviderConfig::default());
    };
    let document = toml::from_str::<toml::Table>(config)
        .map_err(|_| "Codex user configuration contains malformed TOML".to_string())?;
    let default_model = string_field(&document, "model", "configuration")?
        .map(str::to_string)
        .map(|model| {
            if valid_model_id(&model) {
                Ok(model)
            } else {
                Err("Codex configured model id contains unsupported characters".to_string())
            }
        })
        .transpose()?;
    let default_effort = string_field(&document, "model_reasoning_effort", "configuration")?
        .map(str::to_string)
        .map(|effort| {
            if valid_effort(&effort) {
                Ok(effort)
            } else {
                Err("Codex configured reasoning effort is invalid".to_string())
            }
        })
        .transpose()?;
    let provider = string_field(&document, "model_provider", "configuration")?.unwrap_or("openai");

    let mut provider_config = if provider == "openai" {
        match string_field(&document, "openai_base_url", "configuration")? {
            Some(base_url) if validate_provider_url(base_url)? => CodexProviderConfig {
                overrides: vec![(
                    "openai_base_url".to_string(),
                    toml::Value::String(base_url.to_string()).to_string(),
                )],
                ..CodexProviderConfig::default()
            },
            Some(base_url) => {
                let table = toml::Table::from_iter([
                    (
                        "name".to_string(),
                        toml::Value::String("OpenAI-compatible endpoint".to_string()),
                    ),
                    (
                        "base_url".to_string(),
                        toml::Value::String(base_url.to_string()),
                    ),
                    (
                        "wire_api".to_string(),
                        toml::Value::String("responses".to_string()),
                    ),
                    (
                        "env_key".to_string(),
                        toml::Value::String(OPENAI_API_KEY_ENV.to_string()),
                    ),
                ]);
                validate_provider_table(SYNTHETIC_OPENAI_PROVIDER, &table, inherited)?
            }
            None => CodexProviderConfig::default(),
        }
    } else {
        if !valid_provider_id(provider) {
            return Err("Codex model_provider id contains unsupported characters".to_string());
        }
        if matches!(provider, "ollama" | "lmstudio" | "amazon-bedrock") {
            return Err(
                "This built-in Codex provider is not supported by Open Builder's isolated runtime"
                    .to_string(),
            );
        }
        let providers = document
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .ok_or_else(|| {
                "Codex selected a provider without model_providers configuration".to_string()
            })?;
        let selected = providers
            .get(provider)
            .and_then(toml::Value::as_table)
            .ok_or_else(|| {
                "Codex selected provider configuration is missing or invalid".to_string()
            })?;
        validate_provider_table(provider, selected, inherited)?
    };
    if provider_config.uses_custom_provider() && default_model.is_none() {
        return Err("Codex custom provider requires a top-level model".to_string());
    }
    provider_config.default_model = default_model;
    provider_config.default_effort = default_effort;
    Ok(provider_config)
}

fn load_provider_config() -> Result<CodexProviderConfig, String> {
    let config = match user_config_path()? {
        Some(path) => {
            let bytes = std::fs::read(path)
                .map_err(|_| "failed to read Codex user configuration".to_string())?;
            if bytes.len() as u64 > MAX_CODEX_CONFIG_BYTES {
                return Err(
                    "Codex user configuration must be a regular file no larger than 2 MiB"
                        .to_string(),
                );
            }
            Some(
                String::from_utf8(bytes)
                    .map_err(|_| "Codex user configuration must contain UTF-8 text".to_string())?,
            )
        }
        None => None,
    };
    let mut inherited = BTreeMap::new();
    if let Some(config) = config.as_deref() {
        let document = toml::from_str::<toml::Table>(config)
            .map_err(|_| "Codex user configuration contains malformed TOML".to_string())?;
        let provider =
            string_field(&document, "model_provider", "configuration")?.unwrap_or("openai");
        let mut referenced = BTreeSet::new();
        if provider == "openai"
            && document
                .get("openai_base_url")
                .and_then(toml::Value::as_str)
                .is_some_and(|url| validate_provider_url(url).ok() == Some(false))
        {
            referenced.insert(OPENAI_API_KEY_ENV.to_string());
        } else if let Some(selected) = document
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get(provider))
            .and_then(toml::Value::as_table)
        {
            if let Some(name) = selected.get("env_key").and_then(toml::Value::as_str) {
                referenced.insert(name.to_string());
            }
            if let Some(headers) = selected
                .get("env_http_headers")
                .and_then(toml::Value::as_table)
            {
                referenced.extend(
                    headers
                        .values()
                        .filter_map(toml::Value::as_str)
                        .map(str::to_string),
                );
            }
        }
        for name in referenced {
            if let Some(value) = std::env::var_os(&name) {
                inherited.insert(
                    name.clone(),
                    value.into_string().map_err(|_| {
                        "Codex provider environment must contain UTF-8 text".to_string()
                    })?,
                );
            }
        }
    }
    provider_config_from_sources(config.as_deref(), &inherited)
}

fn configuration_fingerprint_for(config: &CodexProviderConfig) -> String {
    let mut material = vec![
        "codex-provider-config-v1".to_string(),
        format!("custom-provider={}", config.custom_provider),
        format!(
            "model={}",
            config.default_model.as_deref().unwrap_or("<cli-default>")
        ),
        format!(
            "effort={}",
            config.default_effort.as_deref().unwrap_or("<cli-default>")
        ),
    ];
    material.extend(
        config
            .overrides
            .iter()
            .map(|(key, value)| format!("override:{key}={value}")),
    );
    material.extend(
        config
            .environment
            .iter()
            .map(|(name, _)| format!("credential:{name}=present")),
    );
    let parts = material.iter().map(String::as_str).collect::<Vec<_>>();
    crate::local_agent_runtime::hash_compatibility_material(&parts)
}

pub(crate) fn configuration_fingerprint() -> Result<String, String> {
    Ok(configuration_fingerprint_for(&load_provider_config()?))
}

fn parse_login_status(text: &str, success: bool) -> LoginStatus {
    let normalized = text.to_ascii_lowercase();
    let not_authenticated = [
        "not logged in",
        "not authenticated",
        "authentication required",
        "please log in",
        "please login",
        "run codex login",
        "no active login",
    ];
    if not_authenticated
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return LoginStatus::NotAuthenticated;
    }
    let authenticated = ["logged in", "authenticated", "chatgpt account", "api key"];
    if success
        && authenticated
            .iter()
            .any(|marker| normalized.contains(marker))
    {
        return LoginStatus::Authenticated;
    }
    LoginStatus::Unknown
}

fn parse_json_document(text: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if value.get("models").is_some() || value.is_array() {
            return Ok(value);
        }
    }
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if value.get("models").is_some() || value.is_array() {
                return Ok(value);
            }
        }
    }
    Err(MODEL_PROBE_ERROR.to_string())
}

fn model_id(value: &Value) -> Option<&str> {
    value
        .get("slug")
        .or_else(|| value.get("id"))
        .or_else(|| value.get("model"))
        .and_then(Value::as_str)
        .filter(|id| valid_model_id(id))
}

fn model_efforts(value: &Value) -> (Vec<String>, bool) {
    let mut efforts = Vec::new();
    for key in [
        "supported_reasoning_levels",
        "supportedReasoningEfforts",
        "supported_reasoning_efforts",
        "efforts",
    ] {
        let Some(raw_entries) = value.get(key) else {
            continue;
        };
        let Some(entries) = raw_entries.as_array() else {
            return (Vec::new(), false);
        };
        let mut complete = true;
        for entry in entries {
            let effort = entry
                .as_str()
                .or_else(|| entry.get("effort").and_then(Value::as_str))
                .or_else(|| entry.get("reasoningEffort").and_then(Value::as_str));
            if let Some(effort) = effort.filter(|effort| valid_effort(effort)) {
                if !efforts.iter().any(|known| known == effort) {
                    efforts.push(effort.to_string());
                }
            } else {
                complete = false;
            }
        }
        return (efforts, complete);
    }
    (efforts, true)
}

struct ParsedModelsOutput {
    models: Vec<LocalAgentModel>,
    authority: CatalogAuthority,
}

fn parse_models_output(text: &str) -> Result<ParsedModelsOutput, String> {
    let document = parse_json_document(text)?;
    let entries = document
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| document.as_array())
        .ok_or_else(|| MODEL_PROBE_ERROR.to_string())?;
    let mut models = Vec::new();
    let mut complete = true;
    for entry in entries {
        if entry
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || entry
                .get("visibility")
                .and_then(Value::as_str)
                .is_some_and(|visibility| matches!(visibility, "hidden" | "none"))
            || entry.get("supported_in_api").and_then(Value::as_bool) == Some(false)
        {
            continue;
        }
        let Some(id) = model_id(entry) else {
            complete = false;
            continue;
        };
        let (efforts, efforts_complete) = model_efforts(entry);
        complete &= efforts_complete;
        let is_default = entry
            .get("is_default")
            .or_else(|| entry.get("isDefault"))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| entry.get("priority").and_then(Value::as_u64) == Some(1));
        models.push(LocalAgentModel {
            id: id.to_string(),
            display_name: entry
                .get("display_name")
                .or_else(|| entry.get("displayName"))
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id)
                .chars()
                .take(160)
                .collect(),
            is_default,
            default_effort: entry
                .get("default_reasoning_level")
                .or_else(|| entry.get("defaultReasoningEffort"))
                .or_else(|| entry.get("default_effort"))
                .and_then(Value::as_str)
                .map(str::to_string),
            efforts,
        });
    }
    let mut seen = HashMap::new();
    models.retain(|model| seen.insert(model.id.clone(), ()).is_none());
    if models.is_empty() {
        return Err(MODEL_PROBE_ERROR.to_string());
    }
    Ok(ParsedModelsOutput {
        models,
        authority: if complete {
            CatalogAuthority::Authoritative
        } else {
            CatalogAuthority::Partial
        },
    })
}

fn aggregate_efforts(models: &[LocalAgentModel]) -> Vec<String> {
    let mut efforts = Vec::new();
    for effort in models.iter().flat_map(|model| model.efforts.iter()) {
        if !efforts.iter().any(|known| known == effort) {
            efforts.push(effort.clone());
        }
    }
    efforts
}

fn required_flags_present(help: &str, flags: &[&str]) -> bool {
    flags.iter().all(|flag| help.contains(flag))
}

fn unsupported_probe(version: Option<String>) -> AdapterProbe {
    AdapterProbe {
        availability: LocalAgentAvailability::Unsupported,
        version,
        models: Vec::new(),
        efforts: Vec::new(),
        catalog_authority: CatalogAuthority::Partial,
        verification_required: false,
        message: Some(STRUCTURED_CAPABILITY_ERROR.to_string()),
    }
}

fn error_probe(version: Option<String>, message: &str) -> AdapterProbe {
    AdapterProbe {
        availability: LocalAgentAvailability::Error,
        version,
        models: Vec::new(),
        efforts: Vec::new(),
        catalog_authority: CatalogAuthority::Partial,
        verification_required: false,
        message: Some(message.to_string()),
    }
}

async fn run_capability_command(
    executable: &Path,
    args: &[&str],
) -> Result<std::process::Output, String> {
    command_output_capped(executable, args, PROBE_TIMEOUT, MAX_PROBE_OUTPUT_BYTES).await
}

async fn run_model_capability_command(
    executable: &Path,
    args: &[&str],
) -> Result<std::process::Output, String> {
    command_output_capped(
        executable,
        args,
        PROBE_TIMEOUT,
        MAX_MODEL_PROBE_OUTPUT_BYTES,
    )
    .await
}

fn sorted_tool_names(tools: &[LocalToolSpec]) -> Vec<String> {
    tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn open_builder_mcp_config(bridge_url: &str, tool_names: &[String]) -> String {
    let enabled_tools = serde_json::to_string(tool_names).unwrap_or_else(|_| "[]".to_string());
    format!(
        "{{open_builder={{url={}, bearer_token_env_var=\"{CODEX_MCP_TOKEN_ENV}\", required=true, default_tools_approval_mode=\"approve\", enabled_tools={enabled_tools}}}}}",
        toml_string(bridge_url)
    )
}

fn mcp_approval_capability_is_present(text: &str, success: bool) -> bool {
    if !success {
        return false;
    }
    text.lines()
        .any(|line| line.trim() == "default_tools_approval_mode: approve")
        && text.lines().any(|line| {
            line.trim()
                .strip_prefix("enabled_tools:")
                .is_some_and(|tools| {
                    tools
                        .split(',')
                        .map(str::trim)
                        .any(|tool| tool == MCP_APPROVAL_CAPABILITY_TOOL)
                })
        })
}

async fn probe_mcp_approval_capability(executable: &Path) -> Result<bool, String> {
    let tool_names = vec![MCP_APPROVAL_CAPABILITY_TOOL.to_string()];
    let override_value = format!(
        "mcp_servers={}",
        open_builder_mcp_config("http://127.0.0.1:1/mcp", &tool_names)
    );
    let args = ["-c", override_value.as_str(), "mcp", "get", "open_builder"];
    run_capability_command(executable, &args)
        .await
        .map(|output| {
            mcp_approval_capability_is_present(&output_text(&output), output.status.success())
        })
}

pub(crate) async fn probe(executable: &Path) -> AdapterProbe {
    let version_output = match run_capability_command(executable, &["--version"]).await {
        Ok(output) if output.status.success() => output,
        Ok(_) => return error_probe(None, "Codex version probe failed."),
        Err(_) => return error_probe(None, "Codex version probe failed."),
    };
    let version = first_output_line(&version_output);
    let provider_config = match load_provider_config() {
        Ok(config) => config,
        Err(message) => return error_probe(version, &message),
    };

    let exec_help = match run_capability_command(executable, &["exec", "--help"]).await {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(_) => return error_probe(version, "Codex structured execution probe failed."),
        Err(_) => return error_probe(version, "Codex structured execution probe timed out."),
    };
    if !required_flags_present(
        &exec_help,
        &[
            "--json",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "--cd",
        ],
    ) {
        return unsupported_probe(version);
    }

    let resume_help = match run_capability_command(executable, &["exec", "resume", "--help"]).await
    {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(_) => return error_probe(version, "Codex session resume probe failed."),
        Err(_) => return error_probe(version, "Codex session resume probe timed out."),
    };
    if !required_flags_present(
        &resume_help,
        &["--json", "--ignore-user-config", "--ignore-rules"],
    ) {
        return unsupported_probe(version);
    }

    match probe_mcp_approval_capability(executable).await {
        Ok(true) => {}
        Ok(false) | Err(_) => return unsupported_probe(version),
    }

    let login_status = if provider_config.bypasses_login_status() {
        LoginStatus::Authenticated
    } else {
        let login_output = match run_capability_command(executable, &["login", "status"]).await {
            Ok(output) => output,
            Err(_) => return error_probe(version, LOGIN_PROBE_ERROR),
        };
        parse_login_status(&output_text(&login_output), login_output.status.success())
    };

    let (models, model_warning, catalog_authority) = if provider_config.uses_custom_provider() {
        (
            provider_config.configured_model().into_iter().collect(),
            Some(
                "Codex custom provider configuration detected; its credential will be verified by the first model request."
                    .to_string(),
            ),
            CatalogAuthority::Partial,
        )
    } else {
        match run_model_capability_command(executable, &["debug", "models", "--bundled"]).await {
            Ok(output) if output.status.success() => {
                match parse_models_output(&output_text(&output)) {
                    Ok(catalog) => (catalog.models, None, catalog.authority),
                    Err(_) => (
                        Vec::new(),
                        Some(MODEL_DISCOVERY_WARNING.to_string()),
                        CatalogAuthority::Partial,
                    ),
                }
            }
            Ok(_) | Err(_) => (
                Vec::new(),
                Some(MODEL_DISCOVERY_WARNING.to_string()),
                CatalogAuthority::Partial,
            ),
        }
    };

    match login_status {
        LoginStatus::NotAuthenticated => AdapterProbe {
            availability: LocalAgentAvailability::NeedsSetup,
            version,
            efforts: aggregate_efforts(&models),
            models,
            catalog_authority,
            verification_required: false,
            message: Some("Codex is not signed in; run codex login.".to_string()),
        },
        LoginStatus::Unknown => error_probe(version, LOGIN_PROBE_ERROR),
        LoginStatus::Authenticated => AdapterProbe {
            availability: LocalAgentAvailability::Ready,
            version,
            efforts: aggregate_efforts(&models),
            models,
            catalog_authority,
            verification_required: provider_config.uses_custom_provider(),
            message: model_warning,
        },
    }
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|_| "failed to write private Codex instructions".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure private Codex instructions".to_string())?;
    }
    Ok(())
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn push_config(args: &mut Vec<String>, key: &str, value: impl Into<String>) {
    args.push("-c".to_string());
    args.push(format!("{key}={}", value.into()));
}

fn push_isolation_config(
    args: &mut Vec<String>,
    prompt_path: &Path,
    bridge_url: &str,
    tools: &[LocalToolSpec],
    native_search: bool,
    excluded_environment_names: &[String],
) {
    push_config(
        args,
        "model_instructions_file",
        toml_string(&prompt_path.to_string_lossy()),
    );
    push_config(args, "instructions", "\"\"".to_string());
    push_config(args, "developer_instructions", "\"\"".to_string());
    push_config(
        args,
        "include_permissions_instructions",
        "false".to_string(),
    );
    push_config(args, "include_apps_instructions", "false".to_string());
    push_config(
        args,
        "include_collaboration_mode_instructions",
        "false".to_string(),
    );
    push_config(args, "include_skill_instructions", "false".to_string());
    push_config(args, "include_environment_context", "false".to_string());
    push_config(args, "project_doc_max_bytes", "0".to_string());
    let mcp_config = open_builder_mcp_config(bridge_url, &sorted_tool_names(tools));
    push_config(args, "mcp_servers", mcp_config);
    push_config(
        args,
        "web_search",
        toml_string(if native_search { "live" } else { "disabled" }),
    );
    push_config(
        args,
        "shell_environment_policy.exclude",
        serde_json::to_string(excluded_environment_names)
            .unwrap_or_else(|_| "[\"OPEN_BUILDER_MCP_TOKEN\"]".to_string()),
    );
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
        push_config(args, &format!("features.{feature}"), "false".to_string());
    }
    push_config(args, "agents.enabled", "false".to_string());
    push_config(args, "approval_policy", toml_string("never"));
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn build_exec_args(
    request: &LocalAgentStartRequest,
    run_dir: &Path,
    prompt_path: &Path,
    bridge_url: &str,
    provider_config: &CodexProviderConfig,
) -> Result<Vec<String>, String> {
    let is_resume = request
        .session_id
        .as_deref()
        .is_some_and(|id| !id.is_empty());
    if let Some(session_id) = request.session_id.as_deref().filter(|id| !id.is_empty()) {
        if !valid_session_id(session_id) {
            return Err("Codex session id contains unsupported characters".to_string());
        }
    }
    let mut args = vec!["exec".to_string()];
    if is_resume {
        args.push("resume".to_string());
    }
    args.extend([
        "--json".to_string(),
        "--ignore-user-config".to_string(),
        "--ignore-rules".to_string(),
        "--skip-git-repo-check".to_string(),
    ]);
    if is_resume {
        // Resume has no --cd/--sandbox flags. Keep the process in the empty
        // run directory and override the persisted sandbox policy instead.
        args.push("--all".to_string());
        push_config(&mut args, "sandbox_mode", toml_string("read-only"));
    } else {
        args.extend([
            "--sandbox".to_string(),
            "read-only".to_string(),
            "--cd".to_string(),
            run_dir.to_string_lossy().to_string(),
        ]);
    }
    if let Some(model) = request
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .or(provider_config.default_model.as_deref())
    {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = request
        .effort
        .as_deref()
        .filter(|effort| !effort.is_empty())
        .or(provider_config.default_effort.as_deref())
    {
        push_config(&mut args, "model_reasoning_effort", toml_string(effort));
    }
    for (key, value) in &provider_config.overrides {
        push_config(&mut args, key, value.clone());
    }
    push_isolation_config(
        &mut args,
        prompt_path,
        bridge_url,
        &request.tools,
        request.native_search,
        &provider_config.excluded_environment_names(),
    );
    if let Some(session_id) = request.session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push(session_id.to_string());
    }
    if is_resume {
        // `codex exec resume` only promises to read PROMPT from stdin when its
        // positional argument is `-`. Fresh `codex exec` reads stdin when the
        // optional PROMPT is omitted.
        args.push("-".to_string());
    }
    Ok(args)
}

fn push_image_isolation_config(args: &mut Vec<String>, provider_config: &CodexProviderConfig) {
    push_config(args, "instructions", "\"\"".to_string());
    push_config(args, "developer_instructions", "\"\"".to_string());
    push_config(
        args,
        "include_permissions_instructions",
        "false".to_string(),
    );
    push_config(args, "include_apps_instructions", "false".to_string());
    push_config(
        args,
        "include_collaboration_mode_instructions",
        "false".to_string(),
    );
    push_config(args, "include_environment_context", "false".to_string());
    push_config(args, "project_doc_max_bytes", "0".to_string());
    push_config(args, "mcp_servers", "{}".to_string());
    push_config(args, "web_search", toml_string("disabled"));
    push_config(
        args,
        "shell_environment_policy.exclude",
        serde_json::to_string(&provider_config.excluded_environment_names())
            .unwrap_or_else(|_| "[]".to_string()),
    );
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
        "in_app_browser",
        "js_repl",
        "skill_search",
        "skill_mcp_dependency_install",
        "workspace_dependencies",
        "view_image",
    ] {
        push_config(args, &format!("features.{feature}"), "false".to_string());
    }
    push_config(args, "features.image_generation", "true".to_string());
    push_config(args, "agents.enabled", "false".to_string());
    push_config(args, "approval_policy", toml_string("never"));
}

fn build_image_app_server_args(provider_config: &CodexProviderConfig) -> Vec<String> {
    let mut args = vec!["app-server".to_string(), "--stdio".to_string()];
    for (key, value) in &provider_config.overrides {
        push_config(&mut args, key, value.clone());
    }
    push_image_isolation_config(&mut args, provider_config);
    args
}

fn frozen_image_process_spec(
    executable: &Path,
    run_dir: &Path,
    provider_config: &CodexProviderConfig,
) -> Result<FrozenProcessSpec, String> {
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    provider_config.apply(&mut command);
    command
        .args(build_image_app_server_args(provider_config))
        .current_dir(run_dir);
    FrozenProcessSpec::capture(&command)
}

struct CodexAppServerIo {
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    cancellation: CancellationToken,
    output_budget: ProtocolOutputBudget,
    pending_notifications: Vec<Value>,
}

impl CodexAppServerIo {
    async fn write(&mut self, value: &Value) -> Result<(), String> {
        crate::local_agent_protocol::write_json(&mut self.stdin, value).await
    }

    async fn read_value(&mut self) -> Result<Value, String> {
        let line = tokio::select! {
            _ = self.cancellation.cancelled() => {
                return Err("local image task cancelled".to_string())
            }
            line = read_capped_line(&mut self.reader) => line?,
        }
        .ok_or_else(|| "Codex app server closed before completing the image task".to_string())?;
        self.output_budget.record(&line)?;
        serde_json::from_str(&line)
            .map_err(|_| "Codex app server emitted malformed JSON".to_string())
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.write(&json!({"id":id,"method":method,"params":params}))
            .await?;
        let response = tokio::time::timeout(APP_SERVER_HANDSHAKE_TIMEOUT, async {
            loop {
                let value = self.read_value().await?;
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    if value.get("method").is_some() {
                        return Err(
                            "Codex app server requested an unauthorized client capability"
                                .to_string(),
                        );
                    }
                    if value.get("error").is_some() {
                        return Err(format!("Codex app server rejected {method}"));
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Codex app server response omitted its result".to_string());
                }
                if value.get("id").is_some() && value.get("method").is_some() {
                    return Err(
                        "Codex app server requested an unauthorized client capability".to_string(),
                    );
                }
                if value.get("method").is_none() {
                    return Err("Codex app server emitted an invalid response".to_string());
                }
                if self.pending_notifications.len() >= APP_SERVER_MAX_PRE_RESPONSE_NOTIFICATIONS {
                    return Err(
                        "Codex app server exceeded the pre-response event limit".to_string()
                    );
                }
                self.pending_notifications.push(value);
            }
        })
        .await
        .map_err(|_| format!("Codex app server {method} handshake timed out"))??;
        Ok(response)
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "open-builder-image-worker",
                    "title": "Open Builder Image Worker",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {"experimentalApi": true}
            }),
        )
        .await?;
        self.write(&json!({"method":"initialized"})).await
    }

    async fn image_capability(&mut self) -> Result<bool, String> {
        let result = self
            .request(2, "modelProvider/capabilities/read", json!({}))
            .await
            .map_err(|_| MEDIA_UNSUPPORTED.to_string())?;
        parse_image_capability(&result)
    }
}

fn parse_image_capability(result: &Value) -> Result<bool, String> {
    result
        .get("imageGeneration")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Codex image capability response was invalid".to_string())
}

async fn stop_app_server<T>(
    supervisor: RunSupervisor,
    result: Result<T, AdapterError>,
    failure_context: &str,
) -> Result<T, AdapterError> {
    let mut output = None;
    let terminal = result.map(|value| {
        output = Some(value);
        ProtocolOutcome {
            session_id: None,
            // App Server is a daemon, so every short-lived utility task must
            // explicitly terminate it after its terminal protocol event.
            aborted: true,
        }
    });
    supervisor.finish(terminal, failure_context).await?;
    output.ok_or_else(|| "Codex app server completed without an output".into())
}

async fn read_codex_image_item(
    item: &Value,
    run_dir: &Path,
) -> Result<GeneratedImageBytes, AdapterError> {
    if let Some(failure) = item.get("failure").filter(|value| !value.is_null()) {
        if failure.get("type").and_then(Value::as_str) == Some("usageLimitExceeded") {
            return Err(AdapterError::coded(
                LocalCliFailureCode::ProcessExit,
                "Codex image generation was rate limited",
            ));
        }
        return Err(RUN_ERROR.into());
    }
    if item.get("status").and_then(Value::as_str) != Some("completed") {
        return Err(RUN_ERROR.into());
    }
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
        .ok_or_else(|| "Codex image generation item omitted its id".to_string())?;
    let saved_path = item
        .get("savedPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Codex image generation completed without an image file".to_string())?;
    let (mime_type, bytes, file_name) = read_generated_image(run_dir, &saved_path)?;
    let revised_prompt = item
        .get("revisedPrompt")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= MAX_CODEX_PROVIDER_VALUE_BYTES && !value.contains('\0'))
        .map(str::to_string);
    Ok(GeneratedImageBytes {
        id: id.to_string(),
        mime_type,
        bytes,
        revised_prompt,
        file_name: Some(file_name),
    })
}

fn passive_image_item(kind: &str) -> bool {
    matches!(
        kind,
        "userMessage" | "user_message" | "agentMessage" | "agent_message" | "reasoning" | "plan"
    )
}

async fn handle_image_notification(
    notification: Value,
    expected_thread_id: &str,
    expected_turn_id: Option<&str>,
    run_dir: &Path,
    generated: &mut Option<GeneratedImageBytes>,
) -> Result<bool, AdapterError> {
    let method = notification
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = notification.get("params").unwrap_or(&Value::Null);
    if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
        if thread_id != expected_thread_id {
            return Err("Codex image task emitted an event for another thread".into());
        }
    }
    if let (Some(expected), Some(actual)) = (
        expected_turn_id,
        params.get("turnId").and_then(Value::as_str),
    ) {
        if actual != expected {
            return Err("Codex image task emitted an event for another turn".into());
        }
    }
    if method == "thread/started"
        && params.pointer("/thread/id").and_then(Value::as_str) != Some(expected_thread_id)
    {
        return Err("Codex image task started an unexpected thread".into());
    }
    if matches!(method, "turn/started" | "turn/completed") {
        let actual = params.pointer("/turn/id").and_then(Value::as_str);
        if actual != expected_turn_id {
            return Err("Codex image task emitted an event for another turn".into());
        }
    }
    match method {
        "thread/started"
        | "turn/started"
        | "thread/tokenUsage/updated"
        | "account/rateLimits/updated"
        | "account/updated"
        | "configWarning"
        | "deprecationNotice"
        | "guardianWarning"
        | "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/summaryPartAdded"
        | "item/reasoning/textDelta"
        | "model/verification"
        | "model/safetyBuffering/updated"
        | "remoteControl/status/changed"
        | "turn/moderationMetadata"
        | "warning" => Ok(false),
        "item/started" | "item/updated" => {
            let kind = params
                .pointer("/item/type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind == "imageGeneration" || passive_image_item(kind) {
                Ok(false)
            } else {
                Err(AdapterError::coded(
                    LocalCliFailureCode::IsolationViolation,
                    "Codex image task attempted a disabled native capability",
                ))
            }
        }
        "item/completed" => {
            let item = params
                .get("item")
                .ok_or_else(|| "Codex image item completion omitted its item".to_string())?;
            let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if passive_image_item(kind) {
                return Ok(false);
            }
            if kind != "imageGeneration" {
                return Err(AdapterError::coded(
                    LocalCliFailureCode::IsolationViolation,
                    "Codex image task attempted a disabled native capability",
                ));
            }
            let image = read_codex_image_item(item, run_dir).await?;
            if let Some(previous) = generated.as_ref() {
                if previous.id == image.id {
                    return Ok(false);
                }
                return Err("Codex image task completed more than one generated image".into());
            }
            *generated = Some(image);
            Ok(false)
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match status {
                "completed" => Ok(true),
                "interrupted" => Err("local image task cancelled".into()),
                _ => Err(RUN_ERROR.into()),
            }
        }
        _ if method.starts_with("codex/event/") => Ok(false),
        _ => Err(format!("Codex image task emitted unsupported notification {method}").into()),
    }
}

async fn run_image_app_server(
    io: &mut CodexAppServerIo,
    request: &PreparedLocalImageRequest,
) -> Result<GeneratedImageBytes, AdapterError> {
    io.initialize().await?;
    io.pending_notifications.clear();
    if !io.image_capability().await? {
        return Err(MEDIA_UNSUPPORTED.into());
    }
    io.pending_notifications.clear();
    let cwd = request.run_dir.to_string_lossy().to_string();
    let thread = io
        .request(
            3,
            "thread/start",
            json!({
                "model": request.model,
                "cwd": cwd,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "baseInstructions": IMAGE_WORKER_INSTRUCTIONS,
                "developerInstructions": "",
                "dynamicTools": [],
                "ephemeral": true,
                "experimentalRawEvents": false,
                "environments": [],
                "runtimeWorkspaceRoots": [],
                "selectedCapabilityRoots": []
            }),
        )
        .await?;
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex image thread start omitted its id".to_string())?
        .to_string();
    let mut input = vec![json!({"type":"text","text":request.prompt})];
    for reference in &request.references {
        input.push(json!({
            "type":"localImage",
            "path": reference.path.to_string_lossy(),
            "detail":"original"
        }));
    }
    let turn = io
        .request(
            4,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": input,
                "model": request.model,
                "effort": request.effort,
                "cwd": cwd,
                "approvalPolicy": "never",
                "environments": [],
                "runtimeWorkspaceRoots": []
            }),
        )
        .await?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex image turn start omitted its id".to_string())?
        .to_string();
    let mut generated = None;
    let pending = std::mem::take(&mut io.pending_notifications);
    for notification in pending {
        if handle_image_notification(
            notification,
            &thread_id,
            Some(&turn_id),
            &request.run_dir,
            &mut generated,
        )
        .await?
        {
            return generated
                .ok_or_else(|| "Codex image turn completed without a generated image".into());
        }
    }
    loop {
        let notification = io.read_value().await?;
        if notification.get("id").is_some() && notification.get("method").is_some() {
            return Err(AdapterError::coded(
                LocalCliFailureCode::IsolationViolation,
                "Codex image task requested an unauthorized client capability",
            ));
        }
        if handle_image_notification(
            notification,
            &thread_id,
            Some(&turn_id),
            &request.run_dir,
            &mut generated,
        )
        .await?
        {
            return generated
                .ok_or_else(|| "Codex image turn completed without a generated image".into());
        }
    }
}

async fn run_capability_app_server(io: &mut CodexAppServerIo) -> Result<bool, AdapterError> {
    io.initialize().await?;
    Ok(io.image_capability().await?)
}

pub(crate) async fn probe_image_capabilities(executable: &Path) -> LocalAgentCapabilities {
    let mut capabilities = IDENTITY.capabilities;
    capabilities.image_generation = false;
    capabilities.image_editing = false;
    capabilities.media_capabilities_verified = false;
    let root = std::env::temp_dir().join(format!(
        "open-builder-codex-image-probe-{}",
        uuid::Uuid::new_v4()
    ));
    if std::fs::create_dir(&root).is_err() {
        return capabilities;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            return capabilities;
        }
    }
    let cancellation = CancellationToken::new();
    let result = match load_provider_config()
        .and_then(|config| frozen_image_process_spec(executable, &root, &config))
    {
        Ok(spec) => match RunSupervisor::spawn(spec, cancellation.child_token()) {
            Ok(process) => {
                let supervisor = process.supervisor;
                let mut io = CodexAppServerIo {
                    stdin: process.stdin,
                    reader: BufReader::new(process.stdout),
                    cancellation,
                    output_budget: ProtocolOutputBudget::default(),
                    pending_notifications: Vec::new(),
                };
                let result = supervisor.monitor(run_capability_app_server(&mut io)).await;
                stop_app_server(supervisor, result, "Codex image capability probe failed").await
            }
            Err(error) => Err(error.into()),
        },
        Err(error) => Err(error.into()),
    };
    let _ = std::fs::remove_dir_all(&root);
    if let Ok(enabled) = result {
        capabilities.image_generation = enabled;
        capabilities.image_editing = enabled;
        capabilities.media_capabilities_verified = true;
    }
    capabilities
}

pub(crate) async fn generate_image(
    executable: PathBuf,
    request: PreparedLocalImageRequest,
) -> Result<GeneratedImageBytes, AdapterError> {
    let provider_config = load_provider_config()?;
    generate_image_with_config(executable, request, &provider_config).await
}

async fn generate_image_with_config(
    executable: PathBuf,
    request: PreparedLocalImageRequest,
    provider_config: &CodexProviderConfig,
) -> Result<GeneratedImageBytes, AdapterError> {
    let process_spec = frozen_image_process_spec(&executable, &request.run_dir, provider_config)?;
    let cancellation = request.cancellation.clone();
    let process = RunSupervisor::spawn(process_spec, cancellation.child_token())?;
    let supervisor = process.supervisor;
    let mut io = CodexAppServerIo {
        stdin: process.stdin,
        reader: BufReader::new(process.stdout),
        cancellation,
        output_budget: ProtocolOutputBudget::default(),
        pending_notifications: Vec::new(),
    };
    let result = supervisor
        .monitor(run_image_app_server(&mut io, &request))
        .await;
    stop_app_server(supervisor, result, "Codex image app server failed").await
}

struct CodexIo {
    reader: BufReader<ChildStdout>,
    cancellation: CancellationToken,
    output_budget: ProtocolOutputBudget,
}

impl CodexIo {
    async fn read_value(&mut self) -> Result<Value, String> {
        let line = tokio::select! {
            _ = self.cancellation.cancelled() => return Err("local agent run cancelled".to_string()),
            line = read_capped_line(&mut self.reader) => line?,
        }
        .ok_or_else(|| "Codex exec closed before completing the turn".to_string())?;
        self.output_budget.record(&line)?;
        serde_json::from_str(&line).map_err(|_| "Codex exec emitted malformed JSON".to_string())
    }
}

fn item_kind(item: &Value) -> &str {
    item.get("type").and_then(Value::as_str).unwrap_or("")
}

fn item_server(item: &Value) -> Option<&str> {
    item.get("server")
        .or_else(|| item.get("server_name"))
        .or_else(|| item.get("serverName"))
        .and_then(Value::as_str)
}

fn item_tool_name(item: &Value) -> Option<&str> {
    item.get("tool")
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .and_then(|name| {
            name.strip_prefix("mcp__open_builder__")
                .or_else(|| name.strip_prefix("mcp__open-builder__"))
                .or(Some(name))
        })
        .filter(|name| !name.is_empty())
}

fn mcp_item_error_message(item: &Value) -> Option<&str> {
    item.pointer("/error/message")
        .or_else(|| item.get("error"))
        .or_else(|| item.get("message"))
        .and_then(Value::as_str)
}

fn is_provider_approval_rejection(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("approval")
        || message.contains("permission")
        || message.contains("user cancelled mcp tool call")
}

fn validate_mcp_item(item: &Value, expected_tools: &BTreeSet<String>) -> Result<(), String> {
    let server = item_server(item);
    let encoded_name = item.get("name").and_then(Value::as_str).unwrap_or_default();
    if !matches!(server, Some("open_builder" | "open-builder"))
        && !encoded_name.starts_with("mcp__open_builder__")
        && !encoded_name.starts_with("mcp__open-builder__")
    {
        return Err("Codex attempted to use an external MCP server".to_string());
    }
    let tool_name = item_tool_name(item)
        .ok_or_else(|| "Codex emitted an Open Builder MCP item without a tool name".to_string())?;
    if !expected_tools.contains(tool_name) {
        return Err("Codex attempted to use an unauthorized Open Builder tool".to_string());
    }

    if let Some(status) = item.get("status").and_then(Value::as_str) {
        if !matches!(
            status,
            "in_progress"
                | "inProgress"
                | "completed"
                | "failed"
                | "declined"
                | "cancelled"
                | "canceled"
        ) {
            return Err("Codex emitted an unsupported Open Builder MCP item status".to_string());
        }
    }

    let status_is_rejected = item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "declined" | "cancelled" | "canceled"));
    let approval_field = item.get("approval").is_some() || item.get("permission").is_some();
    let approval_message = mcp_item_error_message(item).is_some_and(is_provider_approval_rejection);
    if approval_message || status_is_rejected && approval_field {
        return Err(MCP_APPROVAL_REJECTION_ERROR.to_string());
    }
    Ok(())
}

fn validate_item_kind(
    item: &Value,
    native_search: bool,
    expected_tools: &BTreeSet<String>,
) -> Result<(), String> {
    match item_kind(item) {
        "agent_message" | "agentMessage" | "assistant_message" | "reasoning" | "plan"
        | "user_message" | "userMessage" | "context_compaction" => {
            if contains_capability_semantics(item) {
                Err(
                    "Codex attempted to use disabled native capability in a passive item"
                        .to_string(),
                )
            } else {
                Ok(())
            }
        }
        "mcp_tool_call" | "mcpToolCall" => validate_mcp_item(item, expected_tools),
        "web_search_call" | "web_search" | "webSearch" => {
            if native_search {
                Ok(())
            } else {
                Err("Codex attempted to use disabled native web search".to_string())
            }
        }
        ""
        | "command_execution"
        | "local_shell_call"
        | "shell_call"
        | "file_change"
        | "fileChange"
        | "dynamic_tool_call"
        | "dynamicToolCall"
        | "collab_agent_tool_call"
        | "collabAgentToolCall"
        | "hook_prompt"
        | "hookPrompt"
        | "image_view"
        | "imageView"
        | "image_generation"
        | "imageGeneration"
        | "computer_use"
        | "browser_use"
        | "sub_agent_activity"
        | "subAgentActivity" => Err(format!(
            "Codex attempted to use disabled native capability {}",
            item_kind(item)
        )),
        other => Err(format!("Codex emitted an unsupported thread item {other}")),
    }
}

fn cumulative_text_delta(
    item: &Value,
    state: &mut HashMap<String, String>,
    state_key: Option<String>,
) -> Result<Option<String>, String> {
    let Some(text) = item.get("text").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(key) = state_key else {
        return Err("Codex emitted a text item without an id".to_string());
    };
    let previous = state.get(&key).cloned().unwrap_or_default();
    if text == previous {
        return Ok(None);
    }
    if !previous.is_empty() && !text.starts_with(&previous) {
        return Err("Codex emitted a non-cumulative text update".to_string());
    }
    let delta = text[previous.len()..].to_string();
    state.insert(key, text.to_string());
    Ok((!delta.is_empty()).then_some(delta))
}

fn summary_text_delta(
    item: &Value,
    state: &mut HashMap<String, String>,
    item_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let Some(summary) = item.get("summary").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let Some(item_id) = item_id else {
        return Err("Codex emitted reasoning without an id".to_string());
    };
    let mut deltas = Vec::new();
    for (index, entry) in summary.iter().enumerate() {
        let text = entry
            .as_str()
            .or_else(|| entry.get("text").and_then(Value::as_str))
            .unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let key = format!("{item_id}:summary:{index}");
        let previous = state.get(&key).cloned().unwrap_or_default();
        if text == previous {
            continue;
        }
        if !previous.is_empty() && !text.starts_with(&previous) {
            return Err("Codex emitted a non-cumulative reasoning update".to_string());
        }
        let delta = text[previous.len()..].to_string();
        state.insert(key, text.to_string());
        if !delta.is_empty() {
            deltas.push(delta);
        }
    }
    Ok(deltas)
}

fn native_search_arguments(item: &Value) -> Option<Value> {
    item.get("query")
        .cloned()
        .or_else(|| item.pointer("/action/query").cloned())
        .map(|query| json!({"query": query}))
}

fn native_search_result(item: &Value) -> Option<Value> {
    item.get("results")
        .cloned()
        .or_else(|| item.pointer("/action/results").cloned())
}

fn item_events(
    method: &str,
    item: &Value,
    native_search: bool,
    expected_tools: &BTreeSet<String>,
    text_state: &mut HashMap<String, String>,
) -> Result<Vec<LocalAgentEvent>, String> {
    validate_item_kind(item, native_search, expected_tools)?;
    let kind = item_kind(item);
    let item_id = item.get("id").and_then(Value::as_str);
    let mut events = Vec::new();
    if matches!(kind, "agent_message" | "agentMessage" | "assistant_message") {
        if let Some(delta) = cumulative_text_delta(item, text_state, item_id.map(str::to_string))? {
            events.push(LocalAgentEvent::TextDelta { delta });
        }
    } else if kind == "reasoning" {
        if let Some(delta) = cumulative_text_delta(item, text_state, item_id.map(str::to_string))? {
            events.push(LocalAgentEvent::ReasoningDelta { delta });
        }
        for delta in summary_text_delta(item, text_state, item_id)? {
            events.push(LocalAgentEvent::ReasoningDelta { delta });
        }
    } else if matches!(kind, "web_search_call" | "web_search" | "webSearch")
        && matches!(
            method,
            "item.started" | "item.updated" | "item.completed" | "item/started" | "item/completed"
        )
    {
        if method == "item.updated" {
            return Ok(events);
        }
        events.push(LocalAgentEvent::NativeTool {
            call_id: item_id.unwrap_or("codex-web-search").to_string(),
            name: "web_search".to_string(),
            phase: if matches!(method, "item.started" | "item/started") {
                "started".to_string()
            } else {
                "completed".to_string()
            },
            arguments: native_search_arguments(item),
            result: matches!(method, "item.completed" | "item/completed")
                .then(|| native_search_result(item))
                .flatten(),
        });
    }
    Ok(events)
}

fn usage_event(value: &Value) -> Option<LocalAgentEvent> {
    let usage = value
        .get("usage")
        .or_else(|| value.pointer("/turn/usage"))?;
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("inputTokens"))
        .and_then(Value::as_u64);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("outputTokens"))
        .and_then(Value::as_u64);
    let cached_input_tokens = usage
        .get("cached_input_tokens")
        .or_else(|| usage.get("cachedInputTokens"))
        .and_then(Value::as_u64);
    if input_tokens.is_none() && output_tokens.is_none() && cached_input_tokens.is_none() {
        return None;
    }
    Some(LocalAgentEvent::Usage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
    })
}

fn thread_id_from_event(value: &Value) -> Option<&str> {
    value
        .get("thread_id")
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/thread/id").and_then(Value::as_str))
        .filter(|id| valid_session_id(id))
}

fn is_allowlisted_metadata_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "rate_limits.updated"
            | "rate_limit.updated"
            | "account.updated"
            | "turn.plan.updated"
            | "turn.diff.updated"
            | "telemetry"
    )
}

fn is_pre_turn_diagnostic(event_type: &str, item: &Value) -> bool {
    if event_type != "item.completed"
        || item.get("type").and_then(Value::as_str) != Some("error")
        || item.get("id").and_then(Value::as_str).is_none()
        || item.get("message").and_then(Value::as_str).is_none()
    {
        return false;
    }
    item.as_object().is_some_and(|object| {
        object
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "type" | "message"))
    })
}

fn classify_stream_failure(value: &Value, attempted_resume: bool) -> AdapterError {
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|character| !character.is_control())
        .take(2_048)
        .collect::<String>()
        .to_ascii_lowercase();
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
        "no session found",
        "no thread found",
    ]
    .iter()
    .any(|needle| message.contains(needle));
    if is_provider_approval_rejection(&message) {
        AdapterError::coded(
            LocalCliFailureCode::ProviderApprovalRejected,
            MCP_APPROVAL_REJECTION_ERROR,
        )
    } else if attempted_resume && mentions_session && unavailable {
        AdapterError::coded(
            LocalCliFailureCode::SessionUnavailable,
            "Codex session is unavailable",
        )
    } else if ["native", "tool", "capability", "mcp"]
        .iter()
        .any(|needle| message.contains(needle))
        && ["unauthorized", "unexpected", "disabled"]
            .iter()
            .any(|needle| message.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::IsolationViolation,
            "Codex attempted to use an unavailable capability",
        )
    } else if ["unauthorized", "authentication", "credential", "api key"]
        .iter()
        .any(|needle| message.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::CredentialRejected,
            "Codex credentials were rejected",
        )
    } else if ["unknown model", "model not found", "invalid model"]
        .iter()
        .any(|needle| message.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::ModelRejected,
            "Codex selected model was rejected",
        )
    } else {
        RUN_ERROR.into()
    }
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    if let Some(session_id) = request.session_id.as_deref().filter(|id| !id.is_empty()) {
        if !valid_session_id(session_id) {
            return Err("Codex session id contains unsupported characters".to_string());
        }
    }
    Ok(())
}

pub(crate) struct PreparedCodexRun {
    context: ProtocolContext,
    process_spec: FrozenProcessSpec,
    instructions_file: PreparedPrivateFile,
    configuration_fingerprint: String,
}

impl PreparedCodexRun {
    pub(crate) fn configuration_fingerprint(&self) -> &str {
        &self.configuration_fingerprint
    }
}

fn prepare_with_config(
    context: ProtocolContext,
    provider_config: CodexProviderConfig,
) -> Result<PreparedCodexRun, String> {
    let (instructions_file, process_spec) = prepare_process(&context, &provider_config)?;
    let configuration_fingerprint = configuration_fingerprint_for(&provider_config);
    Ok(PreparedCodexRun {
        context,
        process_spec,
        instructions_file,
        configuration_fingerprint,
    })
}

fn prepare_process(
    context: &ProtocolContext,
    provider_config: &CodexProviderConfig,
) -> Result<(PreparedPrivateFile, FrozenProcessSpec), String> {
    let prompt_path = context.run_dir.join("open-builder-codex-instructions.md");
    write_private_file(&prompt_path, context.request.system_prompt.as_bytes())?;
    let prompt_path = std::fs::canonicalize(&prompt_path)
        .map_err(|_| "failed to resolve private Codex instructions".to_string())?;
    let instructions_file = PreparedPrivateFile::capture(&prompt_path, &context.run_dir)
        .map_err(|_| "failed to capture private Codex instructions".to_string())?;
    let args = build_exec_args(
        &context.request,
        &context.run_dir,
        &prompt_path,
        &context.bridge_url,
        provider_config,
    )?;
    let process_spec = frozen_process_spec(context, provider_config, &args)?;
    Ok((instructions_file, process_spec))
}

pub(crate) fn prepare_run(context: ProtocolContext) -> Result<PreparedCodexRun, AdapterError> {
    let provider_config = load_provider_config()?;
    Ok(prepare_with_config(context, provider_config)?)
}

pub(crate) async fn launch_prepared(
    prepared: PreparedCodexRun,
) -> Result<ProtocolOutcome, AdapterError> {
    let PreparedCodexRun {
        context,
        process_spec,
        instructions_file,
        ..
    } = prepared;
    instructions_file
        .verify_unchanged()
        .map_err(|_| PREPARED_INSTRUCTIONS_CHANGED_ERROR.to_string())?;
    run_prepared(&context, process_spec).await
}

fn frozen_process_spec(
    context: &ProtocolContext,
    provider_config: &CodexProviderConfig,
    args: &[String],
) -> Result<FrozenProcessSpec, String> {
    let mut command = Command::new(&context.executable);
    apply_minimal_environment(&mut command);
    provider_config.apply(&mut command);
    command
        .args(args)
        .current_dir(&context.run_dir)
        .env(CODEX_MCP_TOKEN_ENV, &context.bridge_token);
    FrozenProcessSpec::capture(&command).map(|spec| spec.redact_value(&context.bridge_token))
}

#[cfg(test)]
async fn run_once(
    context: &ProtocolContext,
    provider_config: &CodexProviderConfig,
) -> Result<ProtocolOutcome, AdapterError> {
    let (instructions_file, process_spec) = prepare_process(context, provider_config)?;
    instructions_file
        .verify_unchanged()
        .map_err(|_| PREPARED_INSTRUCTIONS_CHANGED_ERROR.to_string())?;
    run_prepared(context, process_spec).await
}

async fn run_prepared(
    context: &ProtocolContext,
    process_spec: FrozenProcessSpec,
) -> Result<ProtocolOutcome, AdapterError> {
    let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
    let supervisor = process.supervisor;
    let mut stdin = process.stdin;
    let mut io = CodexIo {
        reader: BufReader::new(process.stdout),
        cancellation: context.cancellation.clone(),
        output_budget: ProtocolOutputBudget::default(),
    };
    let expected_tools = context
        .request
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<BTreeSet<_>>();

    let run_result = supervisor
        .monitor(async {
        if context.cancellation.is_cancelled() {
            return Ok(ProtocolOutcome {
                session_id: context.request.session_id.clone(),
                aborted: true,
            });
        }
        let prompt = turn_prompt(&context.request);
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|_| "failed to write the Codex request".to_string())?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|_| "failed to write the Codex request".to_string())?;
        stdin
            .shutdown()
            .await
            .map_err(|_| "failed to close the Codex request".to_string())?;
        drop(stdin);

        let mut thread_id: Option<String> = None;
        let mut saw_turn_started = false;
        let mut text_state = HashMap::new();
        let mut awaiting_thread = true;
        loop {
            let event_result: Result<Result<Value, String>, String> = if awaiting_thread {
                match tokio::time::timeout(HANDSHAKE_TIMEOUT, io.read_value()).await {
                    Ok(result) => Ok(result),
                    Err(_) => return Err(HANDSHAKE_TIMEOUT_ERROR.into()),
                }
            } else {
                Ok(io.read_value().await)
            };
            let event = match event_result {
                Ok(Ok(event)) => event,
                Ok(Err(_error)) if context.cancellation.is_cancelled() => {
                    return Ok(ProtocolOutcome {
                        session_id: thread_id,
                        aborted: true,
                    });
                }
                Ok(Err(error)) => return Err(error.into()),
                Err(error) => return Err(error.into()),
            };
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            match event_type {
                "thread.started" => {
                    let id = thread_id_from_event(&event).ok_or_else(|| {
                        "Codex exec did not return a valid session id".to_string()
                    })?;
                    if thread_id.is_some() {
                        return Err("Codex emitted duplicate session start events".into());
                    }
                    if let Some(expected) = context
                        .request
                        .session_id
                        .as_deref()
                        .filter(|expected| !expected.is_empty())
                    {
                        if expected != id {
                            return Err("Codex resumed an unexpected session".into());
                        }
                    }
                    thread_id = Some(id.to_string());
                    awaiting_thread = false;
                    context
                        .channel
                        .send(LocalAgentEvent::Session {
                            session_id: id.to_string(),
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
                }
                "turn.started" => {
                    if thread_id.is_none() {
                        return Err("Codex emitted a turn before starting a session".into());
                    }
                    saw_turn_started = true;
                }
                "item.started" | "item.updated" | "item.completed" => {
                    let item = event
                        .get("item")
                        .ok_or_else(|| "Codex emitted an item event without an item".to_string())?;
                    if item.get("type").and_then(Value::as_str) == Some("error")
                        && mcp_item_error_message(item)
                            .is_some_and(is_provider_approval_rejection)
                    {
                        return Err(AdapterError::coded(
                            LocalCliFailureCode::ProviderApprovalRejected,
                            MCP_APPROVAL_REJECTION_ERROR,
                        ));
                    }
                    if thread_id.is_some()
                        && !saw_turn_started
                        && is_pre_turn_diagnostic(event_type, item)
                    {
                        context
                            .channel
                            .send(LocalAgentEvent::Warning {
                                message: "Codex reported a redacted startup diagnostic before the turn began.".to_string(),
                            })
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                        continue;
                    }
                    if thread_id.is_none() || !saw_turn_started {
                        let item_kind = event
                            .pointer("/item/type")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        return Err(format!(
                            "Codex emitted a {item_kind} item before the turn started"
                        )
                        .into());
                    }
                    for item_event in item_events(
                        event_type,
                        item,
                        context.request.native_search,
                        &expected_tools,
                        &mut text_state,
                    )? {
                        context
                            .channel
                            .send(item_event)
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                "turn.completed" => {
                    let id = thread_id
                        .clone()
                        .ok_or_else(|| "Codex completed a turn without a session".to_string())?;
                    if let Some(usage) = usage_event(&event) {
                        context
                            .channel
                            .send(usage)
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                    let status = event
                        .pointer("/turn/status")
                        .or_else(|| event.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    return match status {
                        "completed" => Ok(ProtocolOutcome {
                            session_id: Some(id),
                            aborted: false,
                        }),
                        "interrupted" | "cancelled" | "canceled" => Ok(ProtocolOutcome {
                            session_id: Some(id),
                            aborted: true,
                        }),
                        _ => Err(RUN_ERROR.into()),
                    };
                }
                "turn.failed" | "error" => {
                    return Err(classify_stream_failure(
                        &event,
                        context.request.session_id.is_some(),
                    ))
                }
                "usage" | "turn.usage" => {
                    if let Some(usage) = usage_event(&event) {
                        context
                            .channel
                            .send(usage)
                            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
                    }
                }
                metadata
                    if is_allowlisted_metadata_event(metadata)
                        && !contains_capability_semantics(&event) => {}
                _ => return Err("Codex emitted an unsupported event type".into()),
            }
        }
        })
        .await;

    supervisor
        .finish(run_result, "Codex exec exited unsuccessfully")
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_agent::{LocalAgentProvider, LocalToolResolution};
    use crate::local_agent_bridge::ToolBridge;
    use tauri::ipc::InvokeResponseBody;
    use tokio::sync::mpsc;

    const CONTRACT_HOST_TOOL: &str = "host_write_probe";
    const CONTRACT_HOST_RESULT: &str = "host-resolution-ok:codex";

    fn compile_contract_cli(mode: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "open-builder-codex-contract-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            format!("open-builder-codex-contract-{mode}.exe")
        } else {
            format!("open-builder-codex-contract-{mode}")
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
            "fake Codex CLI failed to compile: {}",
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
            cli_version: "0.151.0-test".to_string(),
        }
    }

    fn request() -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider: LocalAgentProvider::Codex,
            model: Some("gpt-test".to_string()),
            effort: Some("high".to_string()),
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: None,
            session_id: None,
            session_compatibility_key: None,
            scope: crate::local_agent::LocalAgentRunScope {
                kind: crate::local_agent::LocalAgentRunScopeKind::Conversation,
                id: "test-conversation".to_string(),
            },
            tools: Vec::new(),
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        }
    }

    fn tool(name: &str) -> LocalToolSpec {
        LocalToolSpec {
            name: name.to_string(),
            description: format!("{name} description"),
            input_schema: json!({"type":"object"}),
            annotations: Default::default(),
            host_approval: Default::default(),
        }
    }

    fn prepared_artifact_test_run(system_prompt: &str) -> (PathBuf, PathBuf, PreparedCodexRun) {
        let root = std::env::temp_dir().join(format!(
            "open-builder-codex-prepared-artifact-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let (channel, _events) = event_channel();
        let mut request = request();
        request.system_prompt = system_prompt.to_string();
        let context = protocol_context(&root, root.join("must-not-spawn"), request, channel);
        let instructions_path = context.run_dir.join("open-builder-codex-instructions.md");
        let prepared = prepare_with_config(context, CodexProviderConfig::default()).unwrap();
        (root, instructions_path, prepared)
    }

    #[test]
    fn new_exec_args_are_structured_and_isolated() {
        let mut request = request();
        request.tools = vec![tool("write_file"), tool("read_files")];
        let args = build_exec_args(
            &request,
            Path::new("/private/run"),
            Path::new("/private/run/instructions"),
            "http://127.0.0.1:43123/mcp",
            &CodexProviderConfig::default(),
        )
        .unwrap();
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--ignore-user-config".to_string()));
        assert!(args.contains(&"--ignore-rules".to_string()));
        assert!(args.contains(&"--sandbox".to_string()));
        assert!(args.contains(&"read-only".to_string()));
        assert!(!args
            .iter()
            .any(|arg| arg == "app-server" || arg == "--strict-config"));
        assert!(!args.iter().any(|arg| arg == "-"));
        assert!(args.windows(2).any(|pair| pair == ["--model", "gpt-test"]));
        assert!(args
            .iter()
            .any(|arg| arg.contains("mcp_servers={open_builder=")));
        let mcp_config = args
            .iter()
            .find(|arg| arg.starts_with("mcp_servers={open_builder="))
            .expect("Codex args must contain the isolated MCP config");
        assert!(mcp_config.contains("default_tools_approval_mode=\"approve\""));
        assert!(mcp_config.contains("enabled_tools=[\"read_files\",\"write_file\"]"));
        assert!(!mcp_config.contains("secret-bridge-token"));
        assert!(args.iter().any(|arg| arg == "approval_policy=\"never\""));
        assert!(args
            .iter()
            .any(|arg| { arg == "shell_environment_policy.exclude=[\"OPEN_BUILDER_MCP_TOKEN\"]" }));
    }

    #[test]
    fn image_app_server_args_enable_only_the_media_capability() {
        let args = build_image_app_server_args(&CodexProviderConfig::default());
        assert_eq!(args[0..2], ["app-server", "--stdio"]);
        assert!(!args.iter().any(|arg| arg == "--strict-config"));
        assert!(args.iter().any(|arg| arg == "mcp_servers={}"));
        assert!(args
            .iter()
            .any(|arg| arg == "features.image_generation=true"));
        for feature in [
            "features.shell_tool=false",
            "features.unified_exec=false",
            "features.multi_agent=false",
            "features.apps=false",
            "features.plugins=false",
            "features.browser_use=false",
            "features.view_image=false",
        ] {
            assert!(args.iter().any(|arg| arg == feature), "missing {feature}");
        }
        assert!(args.iter().any(|arg| arg == "approval_policy=\"never\""));
    }

    #[test]
    fn image_capability_response_requires_an_explicit_boolean() {
        assert!(parse_image_capability(&json!({
            "namespaceTools": true,
            "imageGeneration": true,
            "webSearch": true
        }))
        .unwrap());
        assert!(!parse_image_capability(&json!({"imageGeneration":false})).unwrap());
        assert!(parse_image_capability(&json!({})).is_err());
        assert!(parse_image_capability(&json!({"imageGeneration":"yes"})).is_err());
    }

    #[tokio::test]
    async fn structured_image_completion_copies_only_a_private_valid_file() {
        const PNG: &[u8] =
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRpayload\x00\x00\x00\x00IEND\xaeB`\x82";
        let root = std::env::temp_dir().join(format!(
            "open-builder-codex-image-item-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("generated.png");
        std::fs::write(&path, PNG).unwrap();
        let image = read_codex_image_item(
            &json!({
                "id":"image-1",
                "type":"imageGeneration",
                "status":"completed",
                "result":"completed",
                "savedPath":path,
                "revisedPrompt":"A red fox"
            }),
            &root,
        )
        .await
        .unwrap();
        assert_eq!(image.id, "image-1");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.bytes, PNG);
        assert_eq!(image.revised_prompt.as_deref(), Some("A red fox"));

        let quota = read_codex_image_item(
            &json!({
                "id":"image-2",
                "type":"imageGeneration",
                "status":"failed",
                "result":"",
                "savedPath":null,
                "failure":{"type":"usageLimitExceeded","limitId":"images","resetsAt":null}
            }),
            &root,
        )
        .await
        .unwrap_err();
        assert_eq!(quota.code, Some(LocalCliFailureCode::ProcessExit));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_app_server_proves_the_structured_image_protocol() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "open-builder-codex-image-protocol-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("fake-codex");
        let script = r#"#!/bin/sh
IFS= read -r _line || exit 1
echo '{"id":1,"result":{"userAgent":"fake-codex"}}'
IFS= read -r _line || exit 1
IFS= read -r _line || exit 1
echo '{"id":2,"result":{"namespaceTools":false,"imageGeneration":true,"webSearch":false}}'
IFS= read -r _line || exit 1
echo '{"id":3,"result":{"thread":{"id":"thread-1"},"model":"gpt-test","modelProvider":"openai"}}'
IFS= read -r _line || exit 1
echo '{"id":4,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[],"error":null}}}'
printf '\211PNG\r\n\032\n\000\000\000\rIHDRpayload\000\000\000\000IEND\256B`\202' > "$PWD/generated.png"
echo "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-1\",\"turnId\":\"turn-1\",\"completedAtMs\":1,\"item\":{\"id\":\"image-1\",\"type\":\"imageGeneration\",\"status\":\"completed\",\"result\":\"completed\",\"savedPath\":\"$PWD/generated.png\",\"revisedPrompt\":\"A red fox\",\"failure\":null,\"transparentBackground\":null}}}"
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[],"error":null}}}'
"#;
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();

        let cancellation = CancellationToken::new();
        let result = generate_image_with_config(
            executable,
            PreparedLocalImageRequest {
                model: Some("gpt-test".to_string()),
                effort: Some("high".to_string()),
                prompt: "Draw a red fox".to_string(),
                references: Vec::new(),
                run_dir: root.clone(),
                cancellation: cancellation.clone(),
            },
            &CodexProviderConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.id, "image-1");
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.revised_prompt.as_deref(), Some("A red fox"));
        assert_eq!(result.file_name.as_deref(), Some("generated.png"));
        assert!(result.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(!cancellation.is_cancelled());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn image_notifications_reject_disabled_native_tools() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-codex-image-notification-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let error = handle_image_notification(
            json!({
                "method":"item/started",
                "params":{
                    "threadId":"thread-1",
                    "turnId":"turn-1",
                    "item":{"id":"command-1","type":"commandExecution"}
                }
            }),
            "thread-1",
            Some("turn-1"),
            &root,
            &mut None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, Some(LocalCliFailureCode::IsolationViolation));

        let mut generated = None;
        assert!(handle_image_notification(
            json!({
                "method":"turn/completed",
                "params":{
                    "threadId":"thread-1",
                    "turn":{"id":"turn-1","status":"completed","items":[],"error":null}
                }
            }),
            "thread-1",
            Some("turn-1"),
            &root,
            &mut generated,
        )
        .await
        .unwrap());
        assert!(generated.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_approval_capability_probe_requires_approval_and_allowlist_echoes() {
        let supported = "open_builder\n  enabled: true\n  enabled_tools: open_builder_capability_probe\n  default_tools_approval_mode: approve\n";
        assert!(mcp_approval_capability_is_present(supported, true));
        assert!(!mcp_approval_capability_is_present(
            "open_builder\n  enabled_tools: open_builder_capability_probe\n",
            true
        ));
        assert!(!mcp_approval_capability_is_present(supported, false));
    }

    #[test]
    fn resume_exec_args_read_stdin_after_the_session_id() {
        let mut request = request();
        request.session_id = Some("thread-123".to_string());
        let args = build_exec_args(
            &request,
            Path::new("/private/run"),
            Path::new("/private/run/instructions"),
            "http://127.0.0.1:43123/mcp",
            &CodexProviderConfig::default(),
        )
        .unwrap();
        assert_eq!(args[0..2], ["exec", "resume"]);
        assert!(args.contains(&"--all".to_string()));
        assert_eq!(
            args[args.len() - 2..],
            ["thread-123".to_string(), "-".to_string()]
        );
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-").count(), 1);
    }

    #[test]
    fn login_probe_distinguishes_explicit_auth_failure() {
        assert_eq!(
            parse_login_status("Not logged in", false),
            LoginStatus::NotAuthenticated
        );
        assert_eq!(
            parse_login_status("Logged in using ChatGPT", true),
            LoginStatus::Authenticated
        );
        assert_eq!(
            parse_login_status("unexpected output", true),
            LoginStatus::Unknown
        );
    }

    #[test]
    fn model_fixture_parses_default_and_efforts() {
        let catalog = parse_models_output(
            r#"{"models":[{"slug":"gpt-test","display_name":"GPT Test","priority":1,"default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}]}"#,
        )
        .unwrap();
        assert_eq!(catalog.authority, CatalogAuthority::Authoritative);
        let models = catalog.models;
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-test");
        assert!(models[0].is_default);
        assert_eq!(models[0].efforts, ["low", "high"]);
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn model_discovery_failure_is_safe_and_non_authoritative() {
        assert!(parse_models_output("{\"unexpected\":true}").is_err());
        let mixed = parse_models_output(
            r#"[{"slug":"gpt-test","supported_reasoning_levels":["high"]},{"display_name":"broken"}]"#,
        )
        .unwrap();
        assert_eq!(mixed.models.len(), 1);
        assert_eq!(mixed.authority, CatalogAuthority::Partial);
        assert!(MODEL_DISCOVERY_WARNING.contains("unverified"));
    }

    #[test]
    fn configured_effort_accepts_catalog_driven_and_future_safe_values() {
        for effort in ["max", "ultra", "future-safe"] {
            let config = format!("model = \"gpt-test\"\nmodel_reasoning_effort = \"{effort}\"\n");
            let provider = provider_config_from_sources(Some(&config), &BTreeMap::new()).unwrap();
            assert_eq!(provider.default_effort.as_deref(), Some(effort));
        }

        for effort in ["", "../high", "high\nunsafe"] {
            let config = format!("model = \"gpt-test\"\nmodel_reasoning_effort = \"{effort}\"\n");
            assert!(provider_config_from_sources(Some(&config), &BTreeMap::new()).is_err());
        }
    }

    #[test]
    fn custom_provider_is_sanitized_without_putting_secrets_in_argv() {
        let config = r#"
model = "proxy-model"
model_reasoning_effort = "high"
model_provider = "proxy"

[model_providers.proxy]
name = "Private proxy"
base_url = "https://gateway.example/v1"
wire_api = "responses"
env_key = "PROXY_TOKEN"
env_http_headers = { "X-Proxy-Feature" = "PROXY_FEATURE" }
request_max_retries = 3
stream_max_retries = 4
stream_idle_timeout_ms = 120000
supports_websockets = false
supports_standalone_web_search = true
"#;
        let inherited = BTreeMap::from([
            ("PROXY_TOKEN".to_string(), "secret-token".to_string()),
            ("PROXY_FEATURE".to_string(), "secret-feature".to_string()),
            (
                "NODE_OPTIONS".to_string(),
                "--require attacker.js".to_string(),
            ),
        ]);
        let provider = provider_config_from_sources(Some(config), &inherited).unwrap();
        assert!(provider.uses_custom_provider());
        assert!(provider.bypasses_login_status());
        assert_eq!(provider.default_model.as_deref(), Some("proxy-model"));
        assert_eq!(provider.default_effort.as_deref(), Some("high"));
        assert!(provider
            .overrides
            .iter()
            .all(|(_, value)| value.parse::<toml::Value>().is_ok()));
        assert_eq!(
            provider
                .environment
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["PROXY_FEATURE", "PROXY_TOKEN"]
        );

        let mut request = request();
        request.model = None;
        request.effort = None;
        let args = build_exec_args(
            &request,
            Path::new("/private/run"),
            Path::new("/private/run/instructions"),
            "http://127.0.0.1:43123/mcp",
            &provider,
        )
        .unwrap();
        let command_line = args.join(" ");
        assert!(command_line.contains("model_provider=\"proxy\""));
        assert!(command_line.contains("model_providers.proxy.base_url="));
        assert!(command_line.contains("model_providers.proxy.env_key="));
        assert!(command_line.contains("model_providers.proxy.env_http_headers="));
        assert!(command_line.contains("--model proxy-model"));
        assert!(command_line.contains("model_reasoning_effort=\"high\""));
        assert!(command_line.contains("PROXY_FEATURE"));
        assert!(command_line.contains("PROXY_TOKEN"));
        assert!(!command_line.contains("secret-token"));
        assert!(!command_line.contains("secret-feature"));
        assert!(!command_line.contains("NODE_OPTIONS"));
    }

    #[test]
    fn third_party_openai_base_url_requires_and_isolates_an_explicit_api_key() {
        let config = "model = \"proxy-model\"\nopenai_base_url = \"https://gateway.example/v1\"\n";
        assert!(provider_config_from_sources(Some(config), &BTreeMap::new()).is_err());

        let inherited = BTreeMap::from([(
            "OPENAI_API_KEY".to_string(),
            "secret-openai-key".to_string(),
        )]);
        let provider = provider_config_from_sources(Some(config), &inherited).unwrap();
        assert!(provider.uses_custom_provider());
        assert!(provider.bypasses_login_status());
        assert_eq!(provider.environment.len(), 1);
        assert_eq!(provider.environment[0].0, "OPENAI_API_KEY");
        assert!(provider
            .overrides
            .iter()
            .any(|(key, _)| key == "model_providers.open_builder_proxy.base_url"));
        assert!(!provider
            .overrides
            .iter()
            .any(|(key, _)| key == "openai_base_url"));
        assert!(!provider
            .overrides
            .iter()
            .any(|(_, value)| value.contains("secret-openai-key")));
    }

    #[test]
    fn optional_provider_header_environment_can_be_absent() {
        let config = r#"
model = "proxy-model"
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://gateway.example/v1"
env_key = "PROXY_TOKEN"
env_http_headers = { "X-Proxy-Feature" = "OPTIONAL_PROXY_FEATURE" }
"#;
        let inherited = BTreeMap::from([("PROXY_TOKEN".to_string(), "secret-token".to_string())]);
        let provider = provider_config_from_sources(Some(config), &inherited).unwrap();

        assert_eq!(
            provider
                .environment
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["PROXY_TOKEN"]
        );
        assert!(provider.overrides.iter().any(|(key, value)| {
            key == "model_providers.proxy.env_http_headers"
                && value.contains("OPTIONAL_PROXY_FEATURE")
        }));
        assert!(provider
            .overrides
            .iter()
            .all(|(_, value)| !value.contains("secret-token")));
    }

    #[test]
    fn custom_provider_requires_a_top_level_model() {
        let config = r#"
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://gateway.example/v1"
env_key = "PROXY_TOKEN"
"#;
        let inherited = BTreeMap::from([("PROXY_TOKEN".to_string(), "secret-token".to_string())]);
        let error = provider_config_from_sources(Some(config), &inherited)
            .err()
            .unwrap();

        assert_eq!(error, "Codex custom provider requires a top-level model");
    }

    #[test]
    fn custom_provider_rejects_unsafe_or_executable_auth_configuration() {
        let inherited = BTreeMap::from([("PROXY_TOKEN".to_string(), "secret".to_string())]);
        let unsafe_url = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "http://gateway.example/v1"
env_key = "PROXY_TOKEN"
"#;
        let static_headers = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
http_headers = { Authorization = "secret" }
"#;
        let static_token = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
experimental_bearer_token = "secret"
"#;
        let stored_auth = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
requires_openai_auth = true
"#;
        let dangerous_environment = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
env_key = "NODE_OPTIONS"
"#;
        let missing_environment = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
env_key = "MISSING_TOKEN"
"#;
        let command_auth = r#"
model_provider = "proxy"
[model_providers.proxy]
base_url = "https://gateway.example/v1"
[model_providers.proxy.auth]
command = "/usr/bin/security"
args = ["find-generic-password"]
"#;
        for config in [
            unsafe_url,
            static_headers,
            static_token,
            stored_auth,
            dangerous_environment,
            missing_environment,
            command_auth,
        ] {
            assert!(provider_config_from_sources(Some(config), &inherited).is_err());
        }
    }

    #[test]
    fn custom_provider_allows_only_non_secret_azure_api_version_query() {
        let inherited = BTreeMap::from([("AZURE_KEY".to_string(), "secret".to_string())]);
        let valid = r#"
model = "azure-model"
model_provider = "azure"
[model_providers.azure]
base_url = "https://example.openai.azure.com/openai"
env_key = "AZURE_KEY"
query_params = { api-version = "2025-04-01-preview" }
"#;
        assert!(provider_config_from_sources(Some(valid), &inherited).is_ok());

        let secret_query = valid.replace(
            "api-version = \"2025-04-01-preview\"",
            "api-key = \"secret\"",
        );
        assert!(provider_config_from_sources(Some(&secret_query), &inherited).is_err());
    }

    #[test]
    fn default_provider_ignores_unrelated_user_execution_configuration() {
        let config = r#"
model = "gpt-safe"
model_reasoning_effort = "medium"
notify = ["/tmp/untrusted-notifier"]

[mcp_servers.untrusted]
command = "/tmp/untrusted-mcp"

[hooks]
enabled = true

[plugins.untrusted]
enabled = true
"#;
        let provider = provider_config_from_sources(Some(config), &BTreeMap::new()).unwrap();
        assert!(!provider.uses_custom_provider());
        assert!(provider.overrides.is_empty());
        assert!(provider.environment.is_empty());
        assert_eq!(provider.default_model.as_deref(), Some("gpt-safe"));
        assert_eq!(provider.default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn user_config_path_accepts_only_bounded_regular_files() {
        let directory = std::env::temp_dir().join(format!(
            "open-builder-codex-config-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let config = directory.join("config.toml");
        std::fs::write(&config, b"model = \"gpt-test\"").unwrap();
        assert_eq!(
            validate_user_config_path(&config).unwrap(),
            Some(config.clone())
        );

        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_user_config_path(&nested).is_err());

        let oversized = directory.join("oversized.toml");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_CODEX_CONFIG_BYTES + 1).unwrap();
        assert!(validate_user_config_path(&oversized).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unauthorized_native_items_fail_closed() {
        let expected = BTreeSet::from(["write_file".to_string()]);
        assert!(
            validate_item_kind(&json!({"type":"command_execution"}), false, &expected).is_err()
        );
        assert!(validate_item_kind(&json!({"type":"file_change"}), false, &expected).is_err());
        assert!(
            validate_item_kind(&json!({"type":"dynamic_tool_call"}), false, &expected).is_err()
        );
        assert!(validate_item_kind(
            &json!({"type":"mcp_tool_call","server":"external","tool":"write_file"}),
            false,
            &expected
        )
        .is_err());
        assert!(validate_item_kind(&json!({"type":"web_search_call"}), false, &expected).is_err());
        assert!(validate_item_kind(&json!({"type":"web_search_call"}), true, &expected).is_ok());
        assert!(validate_item_kind(
            &json!({"type":"mcp_tool_call","server":"open_builder","tool":"write_file","status":"completed"}),
            false,
            &expected
        )
        .is_ok());
        assert!(validate_item_kind(
            &json!({"type":"mcp_tool_call","server":"open_builder","tool":"unknown","status":"completed"}),
            false,
            &expected
        )
        .is_err());
    }

    #[test]
    fn passive_items_reject_nested_capability_semantics() {
        let expected = BTreeSet::new();
        for item in [
            json!({"type":"agent_message","text":"ok","tool":{"name":"write_file"}}),
            json!({"type":"reasoning","summary":[{"permission_request":{"kind":"write"}}]}),
            json!({"type":"plan","command":"touch file"}),
        ] {
            assert!(validate_item_kind(&item, false, &expected).is_err());
        }
        for item in [
            json!({"type":"agent_message","text":"normal response"}),
            json!({"type":"reasoning","summary":[{"text":"normal summary"}]}),
        ] {
            assert!(validate_item_kind(&item, false, &expected).is_ok());
        }
    }

    #[test]
    fn mcp_approval_and_permission_rejections_are_terminal_and_redacted() {
        let expected = BTreeSet::from(["write_file".to_string()]);
        for message in [
            "MCP tool call requires approval, but approval policy is never",
            "permission denied for write tool secret-sentinel",
            "user cancelled MCP tool call",
        ] {
            let error = validate_item_kind(
                &json!({
                    "type":"mcp_tool_call",
                    "server":"open_builder",
                    "tool":"write_file",
                    "status":"failed",
                    "error":{"message":message}
                }),
                false,
                &expected,
            )
            .expect_err("provider approval failures must terminate the run");
            assert_eq!(error, MCP_APPROVAL_REJECTION_ERROR);
            assert!(!error.contains("secret-sentinel"));
        }
    }

    #[test]
    fn native_search_completion_keeps_results_for_both_event_spellings() {
        let item = json!({
            "id":"search-1",
            "type":"web_search_call",
            "query":"verified run",
            "results":[{"url":"https://example.test"}]
        });
        let expected = BTreeSet::new();
        for method in ["item.completed", "item/completed"] {
            let events = item_events(method, &item, true, &expected, &mut HashMap::new()).unwrap();
            let Some(LocalAgentEvent::NativeTool { result, phase, .. }) = events.first() else {
                panic!("expected completed native search event")
            };
            assert_eq!(phase, "completed");
            assert_eq!(result.as_ref(), item.get("results"));
        }
    }

    #[test]
    fn only_explicit_codex_metadata_events_are_ignored() {
        assert!(is_allowlisted_metadata_event("rate_limits.updated"));
        assert!(is_allowlisted_metadata_event("telemetry"));
        assert!(!is_allowlisted_metadata_event("future_noncritical_event"));
        assert!(!is_allowlisted_metadata_event("permission_request"));
        assert!(!is_allowlisted_metadata_event("write_file"));
        assert!(!contains_capability_semantics(&json!({
            "type":"telemetry",
            "latency_ms":12
        })));
        assert!(contains_capability_semantics(&json!({
            "type":"telemetry",
            "tool":"write_file"
        })));
    }

    #[test]
    fn allows_only_shape_proven_pre_turn_diagnostics() {
        assert!(is_pre_turn_diagnostic(
            "item.completed",
            &json!({"id":"item_0","type":"error","message":"configuration warning"})
        ));
        assert!(!is_pre_turn_diagnostic(
            "item.started",
            &json!({"id":"item_0","type":"error","message":"configuration warning"})
        ));
        assert!(!is_pre_turn_diagnostic(
            "item.completed",
            &json!({"id":"item_0","type":"error","message":"warning","permission":"write"})
        ));
        assert!(!is_pre_turn_diagnostic(
            "item.completed",
            &json!({"id":"item_0","type":"agent_message","message":"warning"})
        ));
    }

    #[test]
    fn classifies_only_explicit_stream_failure_categories() {
        let approval = classify_stream_failure(
            &json!({"type":"error","message":"MCP tool call requires approval, but approval policy is never"}),
            false,
        );
        assert_eq!(
            approval.code,
            Some(LocalCliFailureCode::ProviderApprovalRejected)
        );
        assert_eq!(approval.message, MCP_APPROVAL_REJECTION_ERROR);

        let session = classify_stream_failure(
            &json!({"type":"turn.failed","error":{"message":"Thread not found"}}),
            true,
        );
        assert_eq!(session.code, Some(LocalCliFailureCode::SessionUnavailable));
        assert_eq!(session.message, "Codex session is unavailable");

        let credential = classify_stream_failure(
            &json!({"type":"error","message":"HTTP 401 unauthorized"}),
            false,
        );
        assert_eq!(
            credential.code,
            Some(LocalCliFailureCode::CredentialRejected)
        );

        let isolation = classify_stream_failure(
            &json!({"type":"error","message":"attempted an unauthorized native tool"}),
            false,
        );
        assert_eq!(
            isolation.code,
            Some(LocalCliFailureCode::IsolationViolation)
        );

        let model = classify_stream_failure(
            &json!({"type":"error","message":"invalid model selection"}),
            false,
        );
        assert_eq!(model.code, Some(LocalCliFailureCode::ModelRejected));
        assert_eq!(model.message, "Codex selected model was rejected");

        for value in [
            json!({"type":"error","message":"thread not found"}),
            json!({"type":"error","message":"secret-sentinel"}),
        ] {
            let generic = classify_stream_failure(&value, false);
            assert_eq!(generic.code, None);
            assert_eq!(generic.message, RUN_ERROR);
        }
    }

    #[test]
    fn cumulative_text_parser_rejects_non_cumulative_updates() {
        let mut state = HashMap::new();
        let item = json!({"id":"item-1","type":"agent_message","text":"hello"});
        assert_eq!(
            cumulative_text_delta(&item, &mut state, Some("item-1".to_string())).unwrap(),
            Some("hello".to_string())
        );
        let item = json!({"id":"item-1","type":"agent_message","text":"hello world"});
        assert_eq!(
            cumulative_text_delta(&item, &mut state, Some("item-1".to_string())).unwrap(),
            Some(" world".to_string())
        );
        let item = json!({"id":"item-1","type":"agent_message","text":"reset"});
        assert!(cumulative_text_delta(&item, &mut state, Some("item-1".to_string())).is_err());
    }

    #[test]
    fn malformed_json_and_output_budget_are_reported_without_raw_output() {
        assert!(parse_json_document("not-json").is_err());
        let mut budget = ProtocolOutputBudget::exhausted_for_test();
        assert!(budget.record("fixture").is_err());
        assert!(!RUN_ERROR.contains("fixture"));
    }

    #[test]
    fn handshake_timeout_is_single_attempt_and_not_replayed() {
        assert_eq!(HANDSHAKE_TIMEOUT, Duration::from_secs(120));
        assert_eq!(HANDSHAKE_TIMEOUT_ERROR, "Codex exec handshake timed out");
    }

    #[tokio::test]
    async fn prepared_run_rejects_tampered_instructions_before_spawn() {
        let secret = "original-system-prompt-secret";
        let (root, instructions_path, prepared) = prepared_artifact_test_run(secret);
        std::fs::write(&instructions_path, b"tampered-system-prompt-secret").unwrap();

        let error = launch_prepared(prepared)
            .await
            .expect_err("tampered instructions must fail before spawn");

        assert_eq!(error.message, PREPARED_INSTRUCTIONS_CHANGED_ERROR);
        assert!(!error.message.contains(secret));
        assert!(!error.message.contains("tampered-system-prompt-secret"));
        assert!(!error
            .message
            .contains(instructions_path.to_string_lossy().as_ref()));
        assert!(!root.join("provider-invocation.log").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn prepared_run_rejects_replaced_instructions_before_spawn() {
        let (root, instructions_path, prepared) =
            prepared_artifact_test_run("replacement-original-secret");
        let original_path = instructions_path.with_extension("original.md");
        std::fs::rename(&instructions_path, &original_path).unwrap();
        std::fs::write(&instructions_path, b"replacement-system-prompt-secret").unwrap();

        let error = launch_prepared(prepared)
            .await
            .expect_err("replaced instructions must fail before spawn");

        assert_eq!(error.message, PREPARED_INSTRUCTIONS_CHANGED_ERROR);
        assert!(!error.message.contains("replacement-original-secret"));
        assert!(!error.message.contains("replacement-system-prompt-secret"));
        assert!(!error
            .message
            .contains(instructions_path.to_string_lossy().as_ref()));
        assert!(!root.join("provider-invocation.log").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_proves_fresh_and_resume_codex_contracts() {
        for resumed in [false, true] {
            let (root, executable) = compile_contract_cli("success");
            let (channel, mut events) = event_channel();
            let mut request = request();
            request.native_search = true;
            request.tools = vec![tool(CONTRACT_HOST_TOOL)];
            request.session_id = resumed.then(|| "resume-codex-thread".to_string());
            let expected_session = request
                .session_id
                .clone()
                .unwrap_or_else(|| "fake-codex-thread".to_string());
            let run_id = format!("codex-contract-{resumed}");
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

            let provider_config = CodexProviderConfig::default();
            let run = run_once(&context, &provider_config);
            tokio::pin!(run);
            let mut recorded = Vec::new();
            let mut host_request_index = None;
            let outcome = loop {
                tokio::select! {
                    result = &mut run => break result.unwrap(),
                    event = events.recv() => {
                        let event = event.expect("Codex contract event channel closed");
                        let event_index = recorded.len();
                        if event.get("type").and_then(Value::as_str) == Some("toolRequest") {
                            assert!(host_request_index.replace(event_index).is_none());
                            assert_eq!(event["runId"], run_id);
                            assert_eq!(event["name"], CONTRACT_HOST_TOOL);
                            assert_eq!(event["arguments"]["provider"], "codex");
                            bridge.resolve(
                                event["runId"].as_str().unwrap(),
                                event["callId"].as_str().unwrap(),
                                LocalToolResolution {
                                    text: CONTRACT_HOST_RESULT.to_string(),
                                    is_error: Some(false),
                                    structured_content: Some(json!({"provider":"codex","resolved":true})),
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
                .expect("missing Codex text after Host resolution");
            assert!(text_index > host_request_index);

            let invocation = std::fs::read_to_string(root.join("provider-invocation.log")).unwrap();
            assert!(invocation.contains("stdin=prompt\n"));
            assert!(invocation.contains("args=exec"));
            assert_eq!(invocation.contains("\u{1f}resume\u{1f}"), resumed);
            assert_eq!(
                invocation.ends_with("\u{1f}resume-codex-thread\u{1f}-\nstdin=prompt\n"),
                resumed
            );
            assert!(!invocation.contains("secret-bridge-token"));
            let environment = invocation
                .lines()
                .find_map(|line| line.strip_prefix("env="))
                .expect("fake CLI must record environment names")
                .split(',')
                .collect::<BTreeSet<_>>();
            assert!(environment.contains(CODEX_MCP_TOKEN_ENV));
            assert!(!environment.contains("PWD"));
            assert!(!environment.contains("AWS_SECRET_ACCESS_KEY"));
            bridge.unregister(&run_id, "Codex contract complete");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn real_fake_process_rejects_unknown_codex_capability_event() {
        let (root, executable) = compile_contract_cli("unknown");
        let (channel, _events) = event_channel();
        let mut request = request();
        request.native_search = true;
        let context = protocol_context(&root, executable, request, channel);
        let error = match run_once(&context, &CodexProviderConfig::default()).await {
            Ok(_) => panic!("unknown Codex capability event must fail closed"),
            Err(error) => error,
        };
        assert!(error.message.contains("unsupported event type"), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_covers_codex_failure_contracts() {
        for mode in [
            "malformed",
            "oversized",
            "nonzero",
            "stderr-approval",
            "stdout-approval",
        ] {
            let (root, executable) = compile_contract_cli(mode);
            let (channel, _events) = event_channel();
            let context = protocol_context(&root, executable, request(), channel);
            let error = run_once(&context, &CodexProviderConfig::default())
                .await
                .expect_err("Codex failure fixture must not complete");
            match mode {
                "malformed" => assert!(error.message.contains("malformed JSON"), "{error}"),
                "oversized" => assert!(error.message.contains("line limit"), "{error}"),
                "stderr-approval" => {
                    assert!(
                        error.message.contains("provider approval rejected"),
                        "{error}"
                    )
                }
                "stdout-approval" => assert_eq!(error.message, MCP_APPROVAL_REJECTION_ERROR),
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
