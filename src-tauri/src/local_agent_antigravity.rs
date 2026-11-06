use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tokio::io::BufReader;
use tokio::process::Command;

#[cfg(test)]
use crate::local_agent::LocalToolSpec;
use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentEvent, LocalAgentModel,
    LocalAgentRunScopeKind, LocalAgentStartRequest,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_content::snapshot_suffix;
use crate::local_agent_media::{
    read_generated_image, GeneratedImageBytes, PreparedLocalImageRequest,
};
use crate::local_agent_models::CatalogAuthority;
use crate::local_agent_protocol::{
    apply_minimal_environment, command_output_capped, command_output_capped_with_env,
    contains_capability_semantics, read_capped_line, turn_prompt, write_json, FrozenProcessSpec,
    LocalCliRunState, PreparedPrivateFile, ProtocolContext, ProtocolOutcome, RunSupervisor,
};
use crate::local_agent_runtime::{AdapterError, LocalCliFailureCode};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_ANTIGRAVITY_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ANTIGRAVITY_PROVIDER_VALUE_BYTES: usize = 64 * 1024;
const MAX_ANTIGRAVITY_PROVIDER_ENV_BYTES: usize = 128 * 1024;
const GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
const GEMINI_BASE_URL_ENV: &str = "GOOGLE_GEMINI_BASE_URL";
const AGENT_NAME: &str = "open-builder";
const MCP_SERVER_NAME: &str = "open_builder";
const DEFAULT_EFFORTS: &[&str] = &["low", "medium", "high"];
// Explicit zero avoids older CLI versions' finite default print timeout.
const PRINT_TIMEOUT: &str = "0s";
const NATIVE_SEARCH_TOOL: &str = "search_web";
const NATIVE_URL_TOOL: &str = "read_url_content";
const LEGACY_NATIVE_URL_TOOL: &str = "read_url";
const IMAGE_AGENT_NAME: &str = "open-builder-image";
const IMAGE_TOOL: &str = "generate_image";
const MAX_IMAGE_OUTPUT_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_VALUE_BYTES: usize = 64 * 1024;
const IMAGE_RUN_ERROR: &str = "Antigravity image generation failed.";

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "agy",
    setup_command: "agy",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: true,
        image_generation: true,
        image_editing: false,
        media_capabilities_verified: false,
    },
    probe_timeout: Duration::from_secs(30),
    unix_home_directories: &[".local/bin"],
    windows_home_directories: &[".local\\bin"],
    windows_local_directories: &["agy\\bin"],
    windows_program_directories: &["Antigravity", "Google\\Antigravity"],
    require_empty_workspace: true,
};

#[derive(Debug, PartialEq, Eq)]
struct InstallationInspection {
    version: String,
}

#[derive(Debug, PartialEq, Eq)]
struct InitAttestation {
    conversation_id: String,
    native_tools: BTreeSet<String>,
}

#[derive(Debug, PartialEq)]
enum RuntimeEvent {
    Text(String),
    Reasoning(String),
    Tool {
        call_id: String,
        name: String,
        phase: String,
        arguments: Option<Value>,
        result: Option<Value>,
        native: bool,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cached_input_tokens: Option<u64>,
    },
    Ignore,
}

struct RunFiles {
    home: PathBuf,
    workspace: PathBuf,
    expected_cwd: PathBuf,
    expected_tools: BTreeSet<String>,
}

pub(crate) struct PreparedAntigravityRun {
    context: ProtocolContext,
    provider_environment: AntigravityProviderEnvironment,
    files: RunFiles,
    process_spec: FrozenProcessSpec,
    private_files: Vec<PreparedPrivateFile>,
    configuration_fingerprint: String,
}

impl PreparedAntigravityRun {
    pub(crate) fn configuration_fingerprint(&self) -> &str {
        &self.configuration_fingerprint
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AntigravityProviderEnvironment {
    values: Vec<(String, String)>,
    model_provider: Option<String>,
    custom_endpoint: bool,
}

struct LoadedAntigravityConfiguration {
    environment: AntigravityProviderEnvironment,
    fingerprint: String,
}

impl AntigravityProviderEnvironment {
    fn apply(&self, command: &mut Command) {
        command.envs(self.values.iter().cloned());
    }

    fn model_provider(&self) -> Option<&str> {
        self.model_provider.as_deref()
    }

    fn uses_gemini_api_key(&self) -> bool {
        self.model_provider.as_deref() == Some("gemini")
    }

    fn uses_custom_endpoint(&self) -> bool {
        self.custom_endpoint
    }
}

fn validate_user_settings_path(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("failed to inspect Antigravity user settings".to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_ANTIGRAVITY_SETTINGS_BYTES {
        return Err(
            "Antigravity user settings must be a regular file no larger than 2 MiB".to_string(),
        );
    }
    Ok(Some(path.to_path_buf()))
}

fn user_settings_path() -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    match home.map(PathBuf::from) {
        Some(home) if home.is_absolute() => validate_user_settings_path(
            &home
                .join(".gemini")
                .join("antigravity-cli")
                .join("settings.json"),
        ),
        Some(_) => Err("Antigravity home directory must use an absolute path".to_string()),
        None => Ok(None),
    }
}

fn validate_provider_value(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_ANTIGRAVITY_PROVIDER_VALUE_BYTES
        || value.contains(['\0', '\r', '\n'])
    {
        return Err(format!(
            "Antigravity provider setting {name} contains an invalid value"
        ));
    }
    Ok(())
}

fn validate_provider_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| "Antigravity Gemini endpoint URL is invalid".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(
            "Antigravity Gemini endpoint must not contain credentials, a query, or a fragment"
                .to_string(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Antigravity Gemini endpoint must include a host".to_string())?;
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err("Antigravity Gemini endpoint must use HTTPS or loopback HTTP".to_string());
    }
    Ok(())
}

fn provider_environment_from_sources(
    settings: Option<&Value>,
    inherited: &BTreeMap<String, String>,
) -> Result<AntigravityProviderEnvironment, String> {
    let model_provider = match settings {
        Some(settings) => {
            let settings = settings.as_object().ok_or_else(|| {
                "Antigravity user settings must contain a JSON object".to_string()
            })?;
            match settings.get("modelProvider") {
                Some(Value::String(provider)) if provider == "gemini" => Some(provider.to_string()),
                Some(Value::String(provider)) if provider.is_empty() => None,
                Some(Value::String(_)) => {
                    return Err(
                        "Antigravity user settings contain an unsupported modelProvider"
                            .to_string(),
                    )
                }
                Some(_) => {
                    return Err(
                        "Antigravity user settings modelProvider must be a string".to_string()
                    )
                }
                None => None,
            }
        }
        None => None,
    };
    if model_provider.is_none() {
        return Ok(AntigravityProviderEnvironment::default());
    }

    let api_key = inherited
        .get(GEMINI_API_KEY_ENV)
        .ok_or_else(|| "Antigravity Gemini API-key mode requires GEMINI_API_KEY".to_string())?;
    validate_provider_value(GEMINI_API_KEY_ENV, api_key)?;
    let mut values = BTreeMap::from([(GEMINI_API_KEY_ENV.to_string(), api_key.clone())]);
    let custom_endpoint = if let Some(base_url) = inherited.get(GEMINI_BASE_URL_ENV) {
        validate_provider_value(GEMINI_BASE_URL_ENV, base_url)?;
        validate_provider_url(base_url)?;
        values.insert(GEMINI_BASE_URL_ENV.to_string(), base_url.clone());
        true
    } else {
        false
    };
    let total_bytes = values.iter().try_fold(0_usize, |total, (name, value)| {
        total
            .checked_add(name.len().saturating_add(value.len()))
            .ok_or_else(|| "Antigravity provider settings exceed the size limit".to_string())
    })?;
    if total_bytes > MAX_ANTIGRAVITY_PROVIDER_ENV_BYTES {
        return Err("Antigravity provider settings exceed the size limit".to_string());
    }
    Ok(AntigravityProviderEnvironment {
        values: values.into_iter().collect(),
        model_provider,
        custom_endpoint,
    })
}

fn configuration_fingerprint_from_environment(
    source: &str,
    environment: &AntigravityProviderEnvironment,
) -> String {
    let mut material = vec![
        "antigravity-provider-config-v1".to_string(),
        source.to_string(),
        format!(
            "provider={}",
            environment
                .model_provider
                .as_deref()
                .unwrap_or("native-login")
        ),
        format!("custom-endpoint={}", environment.custom_endpoint),
    ];
    for (name, value) in &environment.values {
        if name == GEMINI_BASE_URL_ENV {
            material.push(format!("setting:{name}={value}"));
        } else {
            material.push(format!("setting:{name}=present"));
        }
    }
    let parts = material.iter().map(String::as_str).collect::<Vec<_>>();
    crate::local_agent_runtime::hash_compatibility_material(&parts)
}

fn load_provider_configuration() -> Result<LoadedAntigravityConfiguration, String> {
    let settings_path = user_settings_path()?;
    let source = if settings_path.is_some() {
        "user-settings"
    } else {
        "defaults"
    };
    let settings = match settings_path {
        Some(path) => {
            let bytes = std::fs::read(path)
                .map_err(|_| "failed to read Antigravity user settings".to_string())?;
            if bytes.len() as u64 > MAX_ANTIGRAVITY_SETTINGS_BYTES {
                return Err(
                    "Antigravity user settings must be a regular file no larger than 2 MiB"
                        .to_string(),
                );
            }
            Some(
                serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| "Antigravity user settings contain malformed JSON".to_string())?,
            )
        }
        None => None,
    };
    let mut inherited = BTreeMap::new();
    for name in [GEMINI_API_KEY_ENV, GEMINI_BASE_URL_ENV] {
        if let Some(value) = std::env::var_os(name) {
            inherited.insert(
                name.to_string(),
                value.into_string().map_err(|_| {
                    format!("Antigravity provider setting {name} must contain UTF-8 text")
                })?,
            );
        }
    }
    let environment = provider_environment_from_sources(settings.as_ref(), &inherited)?;
    let fingerprint = configuration_fingerprint_from_environment(source, &environment);
    Ok(LoadedAntigravityConfiguration {
        environment,
        fingerprint,
    })
}

fn load_provider_environment() -> Result<AntigravityProviderEnvironment, String> {
    Ok(load_provider_configuration()?.environment)
}

pub(crate) fn configuration_fingerprint() -> Result<String, String> {
    Ok(load_provider_configuration()?.fingerprint)
}

fn first_output_line(output: &std::process::Output) -> Option<String> {
    // Stderr may contain authentication or configuration diagnostics and is
    // never promoted into renderer-visible version metadata.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn combined_output(output: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn has_required_help(help: &str) -> Result<(), String> {
    for required in [
        "--print",
        "--print-timeout",
        "--input-format",
        "--output-format",
        "--agent",
        "--model",
        "--effort",
        "--conversation",
        "--sandbox",
    ] {
        if !help.contains(required) {
            return Err(format!(
                "Antigravity is missing required structured-agent option {required}; upgrade agy."
            ));
        }
    }
    Ok(())
}

async fn inspect_installation(executable: &Path) -> Result<InstallationInspection, AdapterProbe> {
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
            return Err(AdapterProbe {
                availability: LocalAgentAvailability::Unsupported,
                version: None,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(
                    "The selected Antigravity executable failed to report its version.".to_string(),
                ),
                missing_environment: Vec::new(),
            })
        }
        Err(message) => {
            return Err(AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version: None,
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
                missing_environment: Vec::new(),
            })
        }
    };
    let Some(version) = first_output_line(&version_output) else {
        return Err(AdapterProbe {
            availability: LocalAgentAvailability::Unsupported,
            version: None,
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some("Antigravity returned an empty version response.".to_string()),
            missing_environment: Vec::new(),
        });
    };
    let help_output = match command_output_capped(
        executable,
        &["--help"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) => output,
        Err(message) => {
            return Err(AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version: Some(version),
                models: Vec::new(),
                efforts: Vec::new(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
                missing_environment: Vec::new(),
            })
        }
    };
    let help = combined_output(&help_output);
    if !help_output.status.success() {
        return Err(AdapterProbe {
            availability: LocalAgentAvailability::Unsupported,
            version: Some(version),
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some("Antigravity did not expose its structured CLI interface.".to_string()),
            missing_environment: Vec::new(),
        });
    }
    if let Err(message) = has_required_help(&help) {
        return Err(AdapterProbe {
            availability: LocalAgentAvailability::Unsupported,
            version: Some(version),
            models: Vec::new(),
            efforts: Vec::new(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some(message),
            missing_environment: Vec::new(),
        });
    }
    Ok(InstallationInspection { version })
}

fn model_from_value(value: &Value, index: usize) -> Option<LocalAgentModel> {
    let (id, display_name, is_default, default_effort, efforts) = match value {
        Value::String(id) => (
            id.clone(),
            id.clone(),
            index == 0,
            None,
            DEFAULT_EFFORTS
                .iter()
                .map(|value| value.to_string())
                .collect(),
        ),
        Value::Object(object) => {
            let id = object
                .get("id")
                .or_else(|| object.get("slug"))
                .or_else(|| object.get("model"))
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            let display_name = object
                .get("display_name")
                .or_else(|| object.get("displayName"))
                .or_else(|| object.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .trim()
                .to_string();
            let is_default = object
                .get("is_default")
                .or_else(|| object.get("isDefault"))
                .or_else(|| object.get("default"))
                .and_then(Value::as_bool)
                .unwrap_or(index == 0);
            let default_effort = object
                .get("default_effort")
                .or_else(|| object.get("defaultEffort"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let efforts = object
                .get("efforts")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|value| DEFAULT_EFFORTS.contains(value))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|values| !values.is_empty())
                .unwrap_or_else(|| {
                    DEFAULT_EFFORTS
                        .iter()
                        .map(|value| value.to_string())
                        .collect()
                });
            (id, display_name, is_default, default_effort, efforts)
        }
        _ => return None,
    };
    is_safe_option(&id).then_some(LocalAgentModel {
        id,
        display_name,
        is_default,
        default_effort,
        efforts,
    })
}

fn is_safe_option(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._/-".contains(character))
}

struct ParsedModelCatalog {
    models: Vec<LocalAgentModel>,
    authority: CatalogAuthority,
}

fn parse_model_catalog(output: &[u8]) -> ParsedModelCatalog {
    let text = String::from_utf8_lossy(output);
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        let values = value
            .as_array()
            .or_else(|| value.get("models").and_then(Value::as_array));
        if let Some(values) = values {
            let mut seen = HashSet::new();
            let parsed = values
                .iter()
                .enumerate()
                .map(|(index, value)| model_from_value(value, index))
                .collect::<Vec<_>>();
            let complete = parsed.iter().all(Option::is_some);
            let models = parsed
                .into_iter()
                .flatten()
                .filter(|model| seen.insert(model.id.clone()))
                .collect();
            return ParsedModelCatalog {
                models,
                authority: if complete && !values.is_empty() {
                    CatalogAuthority::Authoritative
                } else {
                    CatalogAuthority::Partial
                },
            };
        }
        return ParsedModelCatalog {
            models: Vec::new(),
            authority: CatalogAuthority::Partial,
        };
    }

    let mut ids = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let line = line.trim_start_matches(['*', '-', '•']).trim_start();
        let candidate = line
            .split(['\t', ' ', '|'])
            .map(|value| value.trim_matches(['`', '*', '[', ']', '(', ')', ',']))
            .find(|value| {
                is_safe_option(value)
                    && (value.contains('-') || value.contains('/'))
                    && !value.starts_with("--")
            });
        if let Some(candidate) = candidate {
            if !ids.iter().any(|existing| existing == candidate) {
                ids.push(candidate.to_string());
            }
        }
    }
    let models = ids
        .into_iter()
        .enumerate()
        .filter_map(|(index, id)| model_from_value(&Value::String(id), index))
        .collect::<Vec<_>>();
    ParsedModelCatalog {
        // Text output is useful as a best-effort chooser, but it cannot prove
        // that the CLI emitted a complete catalog rather than a truncated table
        // or diagnostic. It must never authorize rejection of a saved model.
        authority: CatalogAuthority::Partial,
        models,
    }
}

#[cfg(test)]
fn parse_models(output: &[u8]) -> Vec<LocalAgentModel> {
    parse_model_catalog(output).models
}

fn looks_like_auth_failure(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    [
        "authentication required",
        "not authenticated",
        "not signed in",
        "sign in",
        "log in",
        "login required",
        "unauthorized",
    ]
    .iter()
    .any(|needle| output.contains(needle))
}

pub(crate) async fn probe(executable: &Path) -> AdapterProbe {
    let installation = match inspect_installation(executable).await {
        Ok(installation) => installation,
        Err(probe) => return probe,
    };
    let provider_environment = match load_provider_environment() {
        Ok(environment) => environment,
        Err(message) => {
            return AdapterProbe {
                availability: LocalAgentAvailability::Error,
                version: Some(installation.version),
                models: Vec::new(),
                efforts: DEFAULT_EFFORTS
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                catalog_authority: CatalogAuthority::Partial,
                verification_required: false,
                message: Some(message),
                missing_environment: Vec::new(),
            }
        }
    };
    match command_output_capped_with_env(
        executable,
        &["models"],
        &provider_environment.values,
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT_BYTES,
    )
    .await
    {
        Ok(output) if output.status.success() => {
            let catalog = parse_model_catalog(&output.stdout);
            let models = catalog.models;
            let message = if models.is_empty() {
                Some(
                    "Antigravity model discovery was unavailable; the CLI default model remains usable."
                        .to_string(),
                )
            } else if provider_environment.uses_custom_endpoint() {
                Some(
                    "Antigravity Gemini-compatible endpoint detected; its credential will be verified by the first model request."
                        .to_string(),
                )
            } else if provider_environment.uses_gemini_api_key() {
                Some(
                    "Antigravity Gemini API-key mode detected; its credential will be verified by the first model request."
                        .to_string(),
                )
            } else {
                None
            };
            AdapterProbe {
                availability: LocalAgentAvailability::Ready,
                version: Some(installation.version),
                models,
                efforts: DEFAULT_EFFORTS
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                catalog_authority: catalog.authority,
                verification_required: provider_environment.uses_gemini_api_key()
                    || provider_environment.uses_custom_endpoint(),
                message,
                missing_environment: Vec::new(),
            }
        }
        Ok(output) if looks_like_auth_failure(&combined_output(&output)) => AdapterProbe {
            availability: LocalAgentAvailability::NeedsSetup,
            version: Some(installation.version),
            models: Vec::new(),
            efforts: DEFAULT_EFFORTS
                .iter()
                .map(|value| value.to_string())
                .collect(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: false,
            message: Some(if provider_environment.uses_gemini_api_key() {
                "Antigravity Gemini API authentication is not ready; check GEMINI_API_KEY."
                    .to_string()
            } else {
                "Antigravity is not signed in; run agy and complete login.".to_string()
            }),
            missing_environment: Vec::new(),
        },
        Ok(_) | Err(_) => AdapterProbe {
            availability: LocalAgentAvailability::Ready,
            version: Some(installation.version),
            models: Vec::new(),
            efforts: DEFAULT_EFFORTS
                .iter()
                .map(|value| value.to_string())
                .collect(),
            catalog_authority: CatalogAuthority::Partial,
            verification_required: true,
            message: Some(
                "Antigravity model discovery failed; the CLI default model remains usable."
                    .to_string(),
            ),
            missing_environment: Vec::new(),
        },
    }
}

fn validate_tool_name(name: &str) -> Result<(), String> {
    if !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
    {
        Ok(())
    } else {
        Err(
            "Antigravity tool names must use only letters, digits, dot, dash, or underscore"
                .to_string(),
        )
    }
}

fn validate_session_id(value: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| "Antigravity conversation id must be a canonical UUID".to_string())?;
    if parsed.hyphenated().to_string() != value {
        return Err("Antigravity conversation id must be a canonical UUID".to_string());
    }
    Ok(())
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        validate_session_id(session_id)?;
    }
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        if !is_safe_option(model) {
            return Err("Antigravity model id contains unsupported characters".to_string());
        }
    }
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        if !DEFAULT_EFFORTS.contains(&effort) {
            return Err("Antigravity effort must be low, medium, or high".to_string());
        }
    }
    let mut names = HashSet::new();
    for tool in &request.tools {
        validate_tool_name(&tool.name)?;
        if !names.insert(tool.name.as_str()) {
            return Err("Antigravity tool names must be unique".to_string());
        }
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|_| "failed to create private Antigravity directory".to_string())?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "failed to inspect private Antigravity directory".to_string())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("private Antigravity directory is not a real directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure private Antigravity directory".to_string())?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("private Antigravity configuration path is unsafe".to_string());
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|_| "failed to write private Antigravity configuration".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to write private Antigravity configuration".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure private Antigravity configuration".to_string())?;
    }
    Ok(())
}

fn bridge_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| "Open Builder returned an invalid Antigravity bridge URL".to_string())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/mcp"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Antigravity bridge URL is not an isolated loopback endpoint".to_string());
    }
    Ok(url.to_string())
}

fn mcp_tool_name(name: &str) -> String {
    format!("mcp__{MCP_SERVER_NAME}__{name}")
}

fn agent_source(request: &LocalAgentStartRequest) -> Result<String, String> {
    let mut tool_names = request
        .tools
        .iter()
        .map(|tool| mcp_tool_name(&tool.name))
        .collect::<Vec<_>>();
    if request.native_search {
        tool_names.extend([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string()]);
    }
    let mut source = String::from(
        "---\nname: open-builder\ndescription: Isolated Open Builder local-agent runtime.\nmainAgent: true\nsubagent: false\ntools:\n",
    );
    if tool_names.is_empty() {
        source.push_str("  []\n");
    } else {
        for name in tool_names {
            let name = serde_json::to_string(&name)
                .map_err(|_| "failed to serialize Antigravity agent tools".to_string())?;
            source.push_str("  - ");
            source.push_str(&name);
            source.push('\n');
        }
    }
    source.push_str(
        "---\nYou run inside Open Builder's isolated local-agent environment. Do not access files, execute commands, drive browsers, load skills, create agents, or use any MCP server other than open_builder. Use only the tools explicitly listed above.\n\n",
    );
    source.push_str(&request.system_prompt);
    source.push('\n');
    Ok(source)
}

fn permission_settings(request: &LocalAgentStartRequest, model_provider: Option<&str>) -> Value {
    let mut allow = request
        .tools
        .iter()
        .map(|tool| format!("mcp({MCP_SERVER_NAME}/{})", tool.name))
        .collect::<Vec<_>>();
    let mut deny = vec![
        "read_file(*)".to_string(),
        "write_file(*)".to_string(),
        "execute_url(*)".to_string(),
        "command(*)".to_string(),
        "unsandboxed(*)".to_string(),
    ];
    let native_search_permissions = [
        format!("{NATIVE_SEARCH_TOOL}(*)"),
        format!("{NATIVE_URL_TOOL}(*)"),
        format!("{LEGACY_NATIVE_URL_TOOL}(*)"),
    ];
    if request.native_search {
        allow.extend(native_search_permissions);
    } else {
        deny.extend(native_search_permissions);
    }
    let mut settings = json!({
        "toolPermission": "strict",
        "artifactReviewPolicy": "asks-for-review",
        "enableTerminalSandbox": true,
        "allowNonWorkspaceAccess": false,
        "enableTelemetry": false,
        "permissions": {
            "allow": allow,
            "deny": deny,
            "ask": []
        }
    });
    if let Some(model_provider) = model_provider {
        settings["modelProvider"] = json!(model_provider);
    }
    settings
}

fn mcp_config(context: &ProtocolContext) -> Result<Value, String> {
    Ok(json!({
        "mcpServers": {
            "open_builder": {
                "serverUrl": bridge_url(&context.bridge_url)?,
                "headers": {
                    "Authorization": format!("Bearer {}", context.bridge_token)
                }
            }
        }
    }))
}

fn reject_private_customizations(home: &Path) -> Result<(), String> {
    let config = home.join(".gemini").join("config");
    for relative in [
        "mcp_config.json",
        "agents",
        "skills",
        "rules",
        "plugins",
        "hooks",
    ] {
        if config.join(relative).exists() {
            return Err(
                "the private Antigravity home contains an unexpected customization".to_string(),
            );
        }
    }
    let runtime = home.join(".gemini").join("antigravity-cli");
    for relative in [
        "mcp_config.json",
        "agents",
        "skills",
        "rules",
        "plugins",
        "hooks",
    ] {
        if runtime.join(relative).exists() {
            return Err(
                "the private Antigravity home contains an unexpected customization".to_string(),
            );
        }
    }
    Ok(())
}

fn isolated_home(context: &ProtocolContext) -> Result<PathBuf, String> {
    let home = match context.request.scope.kind {
        LocalAgentRunScopeKind::Conversation => {
            let scope_key = crate::local_agent_runtime::hash_compatibility_material(&[
                "antigravity-scope-home-v1",
                &context.request.scope.id,
            ]);
            let roots = context.session_dir.join("antigravity-scope-homes-v1");
            ensure_private_directory(&roots)?;
            let scope = roots.join(scope_key);
            ensure_private_directory(&scope)?;
            scope.join("home")
        }
        LocalAgentRunScopeKind::Utility => context.run_dir.join("antigravity-home"),
    };
    ensure_private_directory(&home)?;
    project_platform_credentials(&home)?;
    Ok(home)
}

#[cfg(target_os = "macos")]
fn project_platform_credentials(home: &Path) -> Result<(), String> {
    let source_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "the macOS user home is unavailable for Antigravity auth".to_string())?;
    project_macos_keychains(&source_home, home)
}

#[cfg(target_os = "macos")]
fn project_macos_keychains(source_home: &Path, home: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let source = source_home.join("Library").join("Keychains");
    if !source.is_dir() {
        return Ok(());
    }
    let source = std::fs::canonicalize(source)
        .map_err(|_| "failed to resolve the macOS keychain directory".to_string())?;
    let library = home.join("Library");
    ensure_private_directory(&library)?;
    let projected = library.join("Keychains");
    match std::fs::symlink_metadata(&projected) {
        Ok(metadata) => {
            if !metadata.file_type().is_symlink()
                || std::fs::canonicalize(&projected).ok().as_ref() != Some(&source)
            {
                return Err("the private Antigravity keychain projection changed".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            symlink(&source, &projected).map_err(|_| {
                "failed to project the macOS keychain for Antigravity auth".to_string()
            })?;
        }
        Err(_) => return Err("failed to inspect the Antigravity keychain projection".to_string()),
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn project_platform_credentials(_home: &Path) -> Result<(), String> {
    Ok(())
}

fn prepare_run_files(
    context: &ProtocolContext,
    provider_environment: &AntigravityProviderEnvironment,
) -> Result<RunFiles, String> {
    // Agy keeps its native conversation database and resume cache below HOME.
    // Conversation runs therefore reuse a scope-specific private home, while
    // utility runs remain disposable. The supervisor already serializes the
    // same (conversation, provider) scope, so request-specific permission
    // settings cannot race; different scopes retain independent writable state.
    // Native login remains in the platform keyring rather than being copied
    // from an unverified file path.
    let home = isolated_home(context)?;
    reject_private_customizations(&home)?;

    let gemini_dir = home.join(".gemini");
    ensure_private_directory(&gemini_dir)?;
    let settings_dir = gemini_dir.join("antigravity-cli");
    ensure_private_directory(&settings_dir)?;
    let settings = serde_json::to_vec_pretty(&permission_settings(
        &context.request,
        provider_environment.model_provider(),
    ))
    .map_err(|_| "failed to serialize Antigravity permissions".to_string())?;
    write_private_file(&settings_dir.join("settings.json"), &settings)?;

    let workspace = context.run_dir.join("workspace");
    if workspace.exists() {
        return Err("the private Antigravity workspace is not fresh".to_string());
    }
    ensure_private_directory(&workspace)?;
    let agents = workspace.join(".agents").join("agents").join(AGENT_NAME);
    ensure_private_directory(&agents)?;
    let agent = agent_source(&context.request)?;
    write_private_file(&agents.join("agent.md"), agent.as_bytes())?;
    let config = serde_json::to_vec_pretty(&mcp_config(context)?)
        .map_err(|_| "failed to serialize Antigravity MCP configuration".to_string())?;
    write_private_file(&workspace.join(".agents").join("mcp_config.json"), &config)?;

    let expected_cwd = std::fs::canonicalize(&workspace)
        .map_err(|_| "failed to resolve the private Antigravity workspace".to_string())?;
    let expected_tools = context
        .request
        .tools
        .iter()
        .map(|tool| mcp_tool_name(&tool.name))
        .collect();
    Ok(RunFiles {
        home,
        workspace,
        expected_cwd,
        expected_tools,
    })
}

fn prepared_private_files(files: &RunFiles) -> Result<Vec<PreparedPrivateFile>, String> {
    let settings = files
        .home
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");
    let agent = files
        .workspace
        .join(".agents")
        .join("agents")
        .join(AGENT_NAME)
        .join("agent.md");
    let mcp_config = files.workspace.join(".agents").join("mcp_config.json");
    Ok(vec![
        PreparedPrivateFile::capture(&settings, &files.home)?,
        PreparedPrivateFile::capture(&agent, &files.workspace)?,
        PreparedPrivateFile::capture(&mcp_config, &files.workspace)?,
    ])
}

fn frozen_process_spec(
    context: &ProtocolContext,
    provider_environment: &AntigravityProviderEnvironment,
    files: &RunFiles,
    args: &[String],
) -> Result<FrozenProcessSpec, String> {
    let mut command = Command::new(&context.executable);
    apply_minimal_environment(&mut command);
    apply_private_environment(&mut command, &files.home);
    provider_environment.apply(&mut command);
    command.args(args).current_dir(&files.workspace);
    FrozenProcessSpec::capture(&command).map(|spec| spec.redact_value(&context.bridge_token))
}

fn process_args(request: &LocalAgentStartRequest) -> Vec<String> {
    let mut args = vec![
        // `--print` accepts an optional positional prompt. Keep the empty
        // value attached so the following flag is never consumed as prompt;
        // the real prompt arrives through stream-json stdin.
        "--print=".to_string(),
        "--print-timeout".to_string(),
        PRINT_TIMEOUT.to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--agent".to_string(),
        AGENT_NAME.to_string(),
        "--sandbox".to_string(),
    ];
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.extend(["--conversation".to_string(), session_id.to_string()]);
    }
    args
}

fn normalized_path(value: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(value)
        .map_err(|_| "Antigravity init reported an unresolved working directory".to_string())
}

fn is_subagent_capability(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("subagent")
        || matches!(
            name.as_str(),
            "invoke_agent"
                | "invoke_subagent"
                | "define_agent"
                | "define_subagent"
                | "spawn_agent"
                | "send_message"
                | "manage_task"
        )
}

fn native_search_tools_from_inventory(
    inventory: &BTreeSet<String>,
    expected_tools: &BTreeSet<String>,
    enabled: bool,
) -> Result<BTreeSet<String>, String> {
    if !expected_tools.is_subset(inventory) {
        return Err("Antigravity did not expose the exact approved tool inventory".to_string());
    }

    let native_tools = inventory
        .difference(expected_tools)
        .cloned()
        .collect::<BTreeSet<_>>();
    if !enabled {
        if native_tools.is_empty() {
            return Ok(native_tools);
        }
        return Err("Antigravity exposed native search while it was disabled".to_string());
    }

    if native_tools == BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string()])
    {
        return Ok(native_tools);
    }

    // Antigravity versions that predate read_url_content may still expose the
    // same search tool and report the URL reader using its old name. Keep this
    // compatibility path narrow: read_url by itself cannot prove web search.
    if native_tools
        == BTreeSet::from([
            NATIVE_SEARCH_TOOL.to_string(),
            LEGACY_NATIVE_URL_TOOL.to_string(),
        ])
    {
        return Ok(native_tools);
    }

    Err(
        "Antigravity native search requires search_web and read_url_content (or verified legacy read_url)"
            .to_string(),
    )
}

fn attest_init(
    value: &Value,
    files: &RunFiles,
    request: &LocalAgentStartRequest,
) -> Result<InitAttestation, String> {
    if value.get("event").and_then(Value::as_str) != Some("init") {
        return Err("Antigravity did not emit init before requesting user content".to_string());
    }
    let init = value
        .get("init")
        .and_then(Value::as_object)
        .ok_or_else(|| "Antigravity emitted a malformed init event".to_string())?;
    let cwd = init
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity init omitted its working directory".to_string())?;
    if normalized_path(cwd)? != files.expected_cwd {
        return Err("Antigravity started outside the private workspace".to_string());
    }
    let permission_mode = init
        .get("permission_mode")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity init omitted its permission mode".to_string())?;
    if permission_mode != "strict" {
        return Err("Antigravity did not activate strict permission mode".to_string());
    }
    if init.get("agent").and_then(Value::as_str) != Some(AGENT_NAME) {
        return Err("Antigravity did not activate the Open Builder agent".to_string());
    }
    if let Some(expected_model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        if init.get("model").and_then(Value::as_str) != Some(expected_model) {
            return Err("Antigravity did not activate the selected model".to_string());
        }
    }
    let tools = init
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| tools.len() <= 512)
        .ok_or_else(|| "Antigravity init omitted its tool inventory".to_string())?;
    let expected_inventory = files.expected_tools.clone();
    let mut inventory = BTreeSet::new();
    for tool in tools {
        let name = tool
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= 256)
            .ok_or_else(|| "Antigravity init returned a malformed tool inventory".to_string())?;
        if !(expected_inventory.contains(name)
            || request.native_search
                && matches!(
                    name,
                    NATIVE_SEARCH_TOOL | NATIVE_URL_TOOL | LEGACY_NATIVE_URL_TOOL
                ))
        {
            return Err("Antigravity exposed an unauthorized native or MCP capability".to_string());
        }
        if !inventory.insert(name.to_string()) {
            return Err("Antigravity init repeated a tool capability".to_string());
        }
    }
    let native_tools =
        native_search_tools_from_inventory(&inventory, &expected_inventory, request.native_search)?;
    let conversation_id = value
        .get("conversation_id")
        .or_else(|| init.get("conversation_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity init omitted its conversation id".to_string())?;
    validate_session_id(conversation_id)?;
    if let Some(expected) = request
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if conversation_id != expected {
            return Err("Antigravity resumed a different conversation".to_string());
        }
    }
    Ok(InitAttestation {
        conversation_id: conversation_id.to_string(),
        native_tools,
    })
}

fn usage(value: &Value) -> Option<RuntimeEvent> {
    value.as_object().map(|usage| RuntimeEvent::Usage {
        input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        cached_input_tokens: usage.get("cache_read_tokens").and_then(Value::as_u64),
    })
}

fn generic_mcp_target(parameters: &Value) -> Option<(&str, &str)> {
    let server = parameters
        .get("ServerName")
        .or_else(|| parameters.get("server_name"))
        .or_else(|| parameters.get("server"))
        .and_then(Value::as_str)?;
    let tool = parameters
        .get("ToolName")
        .or_else(|| parameters.get("tool_name"))
        .or_else(|| parameters.get("tool"))
        .and_then(Value::as_str)?;
    Some((server, tool))
}

fn contains_permission_signal(value: &Value) -> bool {
    let text = match value {
        Value::String(text) => text.clone(),
        value => serde_json::to_string(value).unwrap_or_default(),
    };
    let normalized = text.to_ascii_lowercase().replace(['_', '-'], " ");
    ["permission", "approval", "not authorized", "unauthorized"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

fn validate_runtime_tool(
    name: &str,
    info: &Value,
    expected_tools: &BTreeSet<String>,
    request: &LocalAgentStartRequest,
) -> Result<bool, String> {
    if is_subagent_capability(name) {
        return Err("Antigravity attempted to use an external-agent capability".to_string());
    }
    if matches!(
        name,
        NATIVE_SEARCH_TOOL | NATIVE_URL_TOOL | LEGACY_NATIVE_URL_TOOL
    ) {
        return if request.native_search && expected_tools.contains(name) {
            Ok(true)
        } else {
            Err(format!(
                "Antigravity attempted to use disabled or unattested native capability {name}"
            ))
        };
    }
    if name == "call_mcp_tool" {
        let parameters = info
            .get("parameters")
            .ok_or_else(|| "Antigravity MCP tool event omitted its target".to_string())?;
        let (server, tool) = generic_mcp_target(parameters)
            .ok_or_else(|| "Antigravity MCP tool event omitted its target".to_string())?;
        if server != MCP_SERVER_NAME || !expected_tools.contains(&mcp_tool_name(tool)) {
            return Err("Antigravity attempted to use an external MCP tool".to_string());
        }
        return Ok(false);
    }
    if name.starts_with("mcp__") {
        if expected_tools.contains(name) {
            return Ok(false);
        }
        return Err("Antigravity attempted to use an external MCP tool".to_string());
    }
    Err(format!(
        "Antigravity attempted to use disabled native capability {name}"
    ))
}

#[derive(Default)]
struct ResponseSteps {
    text: BTreeMap<u64, String>,
    completed: BTreeMap<(u64, String), Value>,
}

impl ResponseSteps {
    fn accept(&mut self, value: &Value) -> Result<bool, String> {
        let step = &value["step_update"];
        let index = step.get("step_index").and_then(Value::as_u64).unwrap_or(0);
        let kind = step.get("step_type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "agent_response" | "thinking" | "reasoning") {
            return Ok(true);
        }
        let key = (index, kind.to_string());
        if let Some(completed) = self.completed.get(&key) {
            if completed == step {
                return Ok(false);
            }
            return Err("Antigravity protocol changed a completed step".to_string());
        }
        if kind == "agent_response" {
            let text = self.text.entry(index).or_default();
            if let Some(delta) = step.get("text_delta").and_then(Value::as_str) {
                text.push_str(delta);
            }
        }
        if step.get("state").and_then(Value::as_str) == Some("DONE") {
            self.completed.insert(key, step.clone());
        }
        Ok(true)
    }

    fn finish(&self, text: &str) -> Result<String, String> {
        let previous = self
            .text
            .last_key_value()
            .map(|(_, text)| text.as_str())
            .unwrap_or("");
        snapshot_suffix(previous, text)
    }
}

fn decode_step(
    value: &Value,
    expected_conversation: &str,
    expected_tools: &BTreeSet<String>,
    request: &LocalAgentStartRequest,
) -> Result<Vec<RuntimeEvent>, String> {
    let step = value
        .get("step_update")
        .and_then(Value::as_object)
        .ok_or_else(|| "Antigravity emitted a malformed step update".to_string())?;
    if step.get("conversation_id").and_then(Value::as_str) != Some(expected_conversation) {
        return Err("Antigravity step update changed conversation ids".to_string());
    }
    if step
        .get("subagent_info")
        .is_some_and(|value| !value.is_null())
    {
        return Err("Antigravity attempted to start a subagent".to_string());
    }
    let step_type = step
        .get("step_type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity step update omitted its type".to_string())?;
    let mut events = Vec::new();
    if let Some(event) = step.get("usage").and_then(usage) {
        events.push(event);
    }
    match step_type {
        "agent_response" => {
            if let Some(delta) = step.get("text_delta").and_then(Value::as_str) {
                events.push(RuntimeEvent::Text(delta.to_string()));
            }
        }
        "thinking" | "reasoning" => {
            let delta = step
                .get("thinking_delta")
                .or_else(|| step.get("reasoning_delta"))
                .or_else(|| step.get("text_delta"))
                .and_then(Value::as_str);
            if let Some(delta) = delta {
                events.push(RuntimeEvent::Reasoning(delta.to_string()));
            }
        }
        "tool" => {
            let name = step
                .get("tool_name")
                .and_then(Value::as_str)
                .ok_or_else(|| "Antigravity tool update omitted its name".to_string())?;
            let info = step.get("tool_info").cloned().unwrap_or_else(|| json!({}));
            if info.get("error").is_some_and(contains_permission_signal) {
                return Err(
                    "Antigravity provider approval rejected the Open Builder tool (permission/approval denied)"
                        .to_string(),
                );
            }
            let native = validate_runtime_tool(name, &info, expected_tools, request)?;
            let state = step
                .get("state")
                .and_then(Value::as_str)
                .ok_or_else(|| "Antigravity tool update omitted its state".to_string())?;
            let phase = match state {
                "ACTIVE" | "RUNNING" => "started",
                "DONE" | "SUCCESS" | "FAILED" | "ERROR" => "completed",
                _ => return Err("Antigravity emitted an unsupported tool state".to_string()),
            }
            .to_string();
            let call_id = step
                .get("step_index")
                .and_then(Value::as_u64)
                .map(|index| format!("agy-step-{index}"))
                .unwrap_or_else(|| "agy-tool".to_string());
            if let Some(info_name) = info.get("name").and_then(Value::as_str) {
                if info_name != name {
                    return Err("Antigravity tool update changed its canonical tool name".to_string());
                }
            }
            let arguments = info
                .get("parameters")
                .cloned()
                .or_else(|| info.get("action").cloned());
            let result = (phase == "completed")
                .then(|| {
                    info.get("output")
                        .cloned()
                        .or_else(|| info.get("result").cloned())
                        .or_else(|| info.get("error").cloned())
                })
                .flatten();
            events.push(RuntimeEvent::Tool {
                call_id,
                name: name.to_string(),
                phase,
                arguments,
                result,
                native,
            });
        }
        "checkpoint" => {}
        "user_input" | "permission" => {
            return Err(format!(
                "Antigravity provider approval rejected an interactive {step_type} request in headless mode"
            ))
        }
        other if other.contains("subagent") => {
            return Err("Antigravity attempted to start a subagent".to_string())
        }
        other if contains_permission_signal(&Value::String(other.to_string())) => {
            return Err(
                "Antigravity provider approval rejected an interactive permission request"
                    .to_string(),
            )
        }
        other => return Err(format!("Antigravity emitted unsupported step type {other}")),
    }
    if events.is_empty() {
        events.push(RuntimeEvent::Ignore);
    }
    Ok(events)
}

fn classify_result_error(
    result: &Value,
    uses_gemini_api_key: bool,
    attempted_resume: bool,
) -> AdapterError {
    let message = result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let mentions_session = message.contains("session") || message.contains("conversation");
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
    .any(|needle| message.contains(needle));
    if attempted_resume && mentions_session && unavailable {
        AdapterError::coded(
            LocalCliFailureCode::SessionUnavailable,
            "Antigravity session is unavailable.",
        )
    } else if ["permission", "approval", "denied"]
        .iter()
        .any(|needle| message.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::ProviderApprovalRejected,
            "Antigravity provider approval rejected the isolated run (permission/approval denied).",
        )
    } else if ["native", "tool", "capability", "mcp"]
        .iter()
        .any(|needle| message.contains(needle))
        && ["not authorized", "unauthorized", "unexpected", "disabled"]
            .iter()
            .any(|needle| message.contains(needle))
    {
        AdapterError::coded(
            LocalCliFailureCode::IsolationViolation,
            "Antigravity attempted to use an unavailable capability.",
        )
    } else if looks_like_auth_failure(&message) {
        AdapterError::coded(
            LocalCliFailureCode::CredentialRejected,
            if uses_gemini_api_key {
                "Antigravity Gemini API authentication failed; check GEMINI_API_KEY."
            } else {
                "Antigravity is not signed in; run agy and complete login."
            },
        )
    } else if message.contains("model") || message.contains("effort") {
        AdapterError::coded(
            LocalCliFailureCode::ModelRejected,
            "Antigravity rejected the selected model or reasoning effort.",
        )
    } else if message.contains("not eligible") || message.contains("eligibility") {
        "Antigravity account eligibility check failed.".into()
    } else {
        "Antigravity run failed.".into()
    }
}

fn validate_result_status(status: &str) -> Result<(), String> {
    match status {
        "WAITING" | "RUNNING" => {
            Err("Antigravity returned a nonterminal result status in headless mode".to_string())
        }
        "" => Err("Antigravity result omitted its status".to_string()),
        _ => Ok(()),
    }
}

async fn read_value(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Value, String> {
    let line = tokio::select! {
        _ = cancellation.cancelled() => return Err("local agent run cancelled".to_string()),
        line = read_capped_line(reader) => line?,
    }
    .ok_or_else(|| "Antigravity protocol closed unexpectedly".to_string())?;
    parse_stream_line(&line)
}

fn parse_stream_line(line: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| "Antigravity emitted malformed stream JSON".to_string())?;
    if !value.is_object() {
        return Err("Antigravity emitted a non-object stream event".to_string());
    }
    Ok(value)
}

fn send_runtime_event(context: &ProtocolContext, event: RuntimeEvent) -> Result<bool, String> {
    let mut text = false;
    let event = match event {
        RuntimeEvent::Text(delta) => {
            text = !delta.is_empty();
            (!delta.is_empty()).then_some(LocalAgentEvent::TextDelta { delta })
        }
        RuntimeEvent::Reasoning(delta) if !delta.is_empty() => {
            Some(LocalAgentEvent::ReasoningDelta { delta })
        }
        RuntimeEvent::Reasoning(_) => None,
        RuntimeEvent::Tool {
            call_id,
            name,
            phase,
            arguments,
            result,
            native,
        } if native => Some(LocalAgentEvent::NativeTool {
            call_id,
            name,
            phase,
            arguments,
            result,
        }),
        RuntimeEvent::Usage {
            input_tokens,
            output_tokens,
            cached_input_tokens,
        } => Some(LocalAgentEvent::Usage {
            input_tokens,
            output_tokens,
            cached_input_tokens,
        }),
        RuntimeEvent::Tool { .. } | RuntimeEvent::Ignore => None,
    };
    if let Some(event) = event {
        context
            .channel
            .send(event)
            .map_err(|_| "local agent event consumer is unavailable".to_string())?;
    }
    Ok(text)
}

fn is_allowlisted_stream_metadata_event(event: &str) -> bool {
    matches!(event, "progress" | "telemetry")
}

fn pre_init_event(
    value: Value,
    uses_gemini_api_key: bool,
    attempted_resume: bool,
) -> Result<Option<Value>, AdapterError> {
    match value.get("event").and_then(Value::as_str) {
        Some("init") => Ok(Some(value)),
        Some("result") => {
            let result = value
                .get("result")
                .filter(|result| result.is_object())
                .ok_or_else(|| "Antigravity emitted a malformed result before init".to_string())?;
            Err(classify_result_error(
                result,
                uses_gemini_api_key,
                attempted_resume,
            ))
        }
        Some(event)
            if is_allowlisted_stream_metadata_event(event)
                && !contains_capability_semantics(&value) =>
        {
            Ok(None)
        }
        _ => Err("Antigravity did not emit init before requesting user content".into()),
    }
}

async fn run_protocol(
    context: &ProtocolContext,
    files: &RunFiles,
    uses_gemini_api_key: bool,
    stdin: &mut tokio::process::ChildStdin,
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<ProtocolOutcome, AdapterError> {
    let init = crate::timeouts::wait_with_timeout_retries(
        async {
            loop {
                let value = read_value(reader, &context.cancellation).await?;
                if let Some(init) = pre_init_event(
                    value,
                    uses_gemini_api_key,
                    context.request.session_id.is_some(),
                )? {
                    return Ok::<Value, AdapterError>(init);
                }
            }
        },
        HANDSHAKE_TIMEOUT,
    )
    .await
    .map_err(|_| "Antigravity init timed out before user content was sent".to_string())??;
    let attestation = attest_init(&init, files, &context.request)?;
    let expected_runtime_tools = files
        .expected_tools
        .union(&attestation.native_tools)
        .cloned()
        .collect::<BTreeSet<_>>();
    context
        .channel
        .send(LocalAgentEvent::Session {
            session_id: attestation.conversation_id.clone(),
            cli_version: context.cli_version.clone(),
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;

    write_json(
        stdin,
        &json!({
            "event": "user",
            "message": {"content": turn_prompt(&context.request)}
        }),
    )
    .await?;
    context
        .channel
        .send(LocalAgentEvent::Status {
            state: LocalCliRunState::Streaming,
            message: None,
        })
        .map_err(|_| "local agent event consumer is unavailable".to_string())?;

    let mut responses = ResponseSteps::default();
    loop {
        let value = match read_value(reader, &context.cancellation).await {
            Ok(value) => value,
            Err(_) if context.cancellation.is_cancelled() => {
                return Ok(ProtocolOutcome {
                    session_id: Some(attestation.conversation_id),
                    aborted: true,
                })
            }
            Err(error) => return Err(error.into()),
        };
        match value.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                let events = decode_step(
                    &value,
                    &attestation.conversation_id,
                    &expected_runtime_tools,
                    &context.request,
                )?;
                if responses.accept(&value)? {
                    for event in events {
                        send_runtime_event(context, event)?;
                    }
                }
            }
            Some("result") => {
                let result = value
                    .get("result")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Antigravity emitted a malformed result".to_string())?;
                let status = result.get("status").and_then(Value::as_str).unwrap_or("");
                let conversation_id = result
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if status == "SUCCESS" || matches!(status, "CANCELED" | "INTERRUPTED") {
                    if conversation_id.is_empty() {
                        return Err("Antigravity result omitted its conversation id".into());
                    }
                    if conversation_id != attestation.conversation_id {
                        return Err("Antigravity result changed conversation ids".into());
                    }
                } else if !conversation_id.is_empty()
                    && conversation_id != attestation.conversation_id
                {
                    return Err("Antigravity result changed conversation ids".into());
                }
                if let Some(event) = result.get("usage").and_then(usage) {
                    send_runtime_event(context, event)?;
                }
                validate_result_status(status)?;
                if status == "SUCCESS"
                    && result.get("error").is_some_and(contains_permission_signal)
                {
                    return Err(AdapterError::coded(
                        LocalCliFailureCode::ProviderApprovalRejected,
                        "Antigravity provider approval rejected the Open Builder tool (permission/approval denied)",
                    ));
                }
                match status {
                    "SUCCESS" => {
                        if let Some(response) = result
                            .get("response")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            let delta = responses.finish(response)?;
                            if !delta.is_empty() {
                                send_runtime_event(context, RuntimeEvent::Text(delta))?;
                            }
                        }
                        return Ok(ProtocolOutcome {
                            session_id: Some(attestation.conversation_id),
                            aborted: false,
                        });
                    }
                    "CANCELED" | "INTERRUPTED" => {
                        return Ok(ProtocolOutcome {
                            session_id: Some(attestation.conversation_id),
                            aborted: true,
                        })
                    }
                    _ => {
                        return Err(classify_result_error(
                            &Value::Object(result.clone()),
                            uses_gemini_api_key,
                            context.request.session_id.is_some(),
                        ))
                    }
                }
            }
            Some("init") => return Err("Antigravity emitted init more than once".into()),
            Some(event)
                if is_allowlisted_stream_metadata_event(event)
                    && !contains_capability_semantics(&value) => {}
            Some(_) | None => return Err("Antigravity emitted an unsupported stream event".into()),
        }
    }
}

fn image_agent_source() -> &'static str {
    "---\nname: open-builder-image\ndescription: Isolated Open Builder image-generation worker.\nmainAgent: true\nsubagent: false\ntools:\n  - \"generate_image\"\n---\nYou are an isolated image generation worker. Use the built-in generate_image capability exactly once for the user's text-to-image request. Do not use files, shell commands, browsers, MCP servers, web search, URL readers, subagents, skills, plugins, or any other capability. A text-only answer is not a successful result."
}

fn image_permission_settings(model_provider: Option<&str>) -> Value {
    let mut settings = json!({
        "toolPermission": "strict",
        "artifactReviewPolicy": "asks-for-review",
        "enableTerminalSandbox": true,
        "allowNonWorkspaceAccess": false,
        "enableTelemetry": false,
        "permissions": {
            "allow": ["generate_image(*)"],
            "deny": [
                "read_file(*)",
                "write_file(*)",
                "edit_file(*)",
                "list_directory(*)",
                "glob(*)",
                "command(*)",
                "shell(*)",
                "execute_url(*)",
                "browser(*)",
                "browser_use(*)",
                "mcp(*)",
                "search_web(*)",
                "read_url_content(*)",
                "read_url(*)",
                "subagent(*)",
                "invoke_agent(*)",
                "invoke_subagent(*)",
                "start_subagent(*)",
                "unsandboxed(*)"
            ],
            "ask": []
        }
    });
    if let Some(model_provider) = model_provider {
        settings["modelProvider"] = json!(model_provider);
    }
    settings
}

fn image_process_args(request: &PreparedLocalImageRequest) -> Result<Vec<String>, String> {
    if request.prompt.is_empty()
        || request.prompt.len() > 128 * 1024
        || request.prompt.contains('\0')
    {
        return Err("Antigravity image prompt is invalid".to_string());
    }
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        if !is_safe_option(model) {
            return Err("Antigravity image model id contains unsupported characters".to_string());
        }
    }
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        if !DEFAULT_EFFORTS.contains(&effort) {
            return Err("Antigravity image effort is unsupported".to_string());
        }
    }
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--print-timeout".to_string(),
        PRINT_TIMEOUT.to_string(),
        "--agent".to_string(),
        IMAGE_AGENT_NAME.to_string(),
        "--sandbox".to_string(),
    ];
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    // Keep the prompt as the final positional argument. This makes every
    // preceding option unambiguous even when a prompt begins with a dash.
    args.push(request.prompt.clone());
    Ok(args)
}

fn prepare_image_files(
    request: &PreparedLocalImageRequest,
    provider_environment: &AntigravityProviderEnvironment,
) -> Result<(PathBuf, PathBuf, Vec<PreparedPrivateFile>), String> {
    ensure_private_directory(&request.run_dir)?;
    let home = request.run_dir.join("antigravity-home");
    if home.exists() {
        return Err("the private Antigravity image home is not fresh".to_string());
    }
    ensure_private_directory(&home)?;
    project_platform_credentials(&home)?;
    reject_private_customizations(&home)?;

    let gemini_dir = home.join(".gemini");
    ensure_private_directory(&gemini_dir)?;
    let settings_dir = gemini_dir.join("antigravity-cli");
    ensure_private_directory(&settings_dir)?;
    let settings = serde_json::to_vec_pretty(&image_permission_settings(
        provider_environment.model_provider(),
    ))
    .map_err(|_| "failed to serialize Antigravity image permissions".to_string())?;
    write_private_file(&settings_dir.join("settings.json"), &settings)?;

    let workspace = request.run_dir.join("workspace");
    if workspace.exists() {
        return Err("the private Antigravity image workspace is not fresh".to_string());
    }
    ensure_private_directory(&workspace)?;
    let agent_directory = workspace
        .join(".agents")
        .join("agents")
        .join(IMAGE_AGENT_NAME);
    ensure_private_directory(&agent_directory)?;
    write_private_file(
        &agent_directory.join("agent.md"),
        image_agent_source().as_bytes(),
    )?;

    let private_files = vec![
        PreparedPrivateFile::capture(&settings_dir.join("settings.json"), &home)?,
        PreparedPrivateFile::capture(&agent_directory.join("agent.md"), &workspace)?,
    ];
    Ok((home, workspace, private_files))
}

fn frozen_image_process_spec(
    executable: &Path,
    request: &PreparedLocalImageRequest,
    provider_environment: &AntigravityProviderEnvironment,
    home: &Path,
    workspace: &Path,
) -> Result<FrozenProcessSpec, String> {
    let args = image_process_args(request)?;
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    apply_private_environment(&mut command, home);
    provider_environment.apply(&mut command);
    command.args(args).current_dir(workspace);
    FrozenProcessSpec::capture(&command)
}

#[derive(Debug, PartialEq, Eq)]
enum ImagePayload {
    Path(String),
    Encoded(String),
}

fn locate_image_payload(value: &Value, depth: usize) -> Option<ImagePayload> {
    if depth > 4 {
        return None;
    }
    match value {
        Value::Object(object) => {
            for key in [
                "data",
                "base64",
                "image_data",
                "imageData",
                "encoded",
                "encoded_data",
                "encodedData",
            ] {
                if let Some(data) = object.get(key).and_then(Value::as_str) {
                    return Some(ImagePayload::Encoded(data.to_string()));
                }
            }
            for key in [
                "path",
                "file_path",
                "filePath",
                "saved_path",
                "savedPath",
                "output_path",
                "outputPath",
            ] {
                if let Some(path) = object.get(key).and_then(Value::as_str) {
                    return Some(ImagePayload::Path(path.to_string()));
                }
            }
            for key in ["image", "result", "output", "artifact", "content", "images"] {
                let Some(nested) = object.get(key) else {
                    continue;
                };
                if let Some(payload) = locate_image_payload(nested, depth + 1) {
                    return Some(payload);
                }
            }
        }
        Value::Array(values) => {
            for nested in values.iter().take(8) {
                if let Some(payload) = locate_image_payload(nested, depth + 1) {
                    return Some(payload);
                }
            }
        }
        _ => {}
    }
    None
}

fn image_metadata_string(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(text) = object.get(*key).and_then(Value::as_str) {
                return Some(text.to_string());
            }
        }
        for key in ["image", "result", "output", "artifact", "content", "images"] {
            if let Some(nested) = object.get(key) {
                if let Some(text) = image_metadata_string(nested, keys, depth + 1) {
                    return Some(text);
                }
            }
        }
    } else if let Some(values) = value.as_array() {
        for nested in values.iter().take(8) {
            if let Some(text) = image_metadata_string(nested, keys, depth + 1) {
                return Some(text);
            }
        }
    }
    None
}

fn image_mime_type(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() >= 20
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && &bytes[12..16] == b"IHDR"
        && bytes.ends_with(b"\x00\x00\x00\x00IEND\xaeB`\x82")
    {
        return Ok("image/png");
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9])
    {
        return Ok("image/jpeg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if declared.checked_add(8) == Some(bytes.len()) {
            return Ok("image/webp");
        }
    }
    Err("Antigravity image output has an invalid or unsupported signature".to_string())
}

fn image_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "bin",
    }
}

fn decode_image_data(value: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let value = value.trim();
    let (encoded, declared_mime) = if let Some((header, encoded)) = value.split_once(',') {
        let header_lower = header.to_ascii_lowercase();
        if !header_lower.starts_with("data:image/") || !header_lower.contains(";base64") {
            return Err("Antigravity image output data URL is unsupported".to_string());
        }
        let declared = header
            .strip_prefix("data:")
            .and_then(|value| value.split(';').next())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        (encoded, declared)
    } else {
        (value, None)
    };
    let bytes = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| "Antigravity image output was not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_OUTPUT_BYTES {
        return Err("Antigravity image output exceeds the size limit".to_string());
    }
    Ok((bytes, declared_mime))
}

fn safe_image_file_name(value: Option<String>, mime_type: &str) -> String {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_IMAGE_VALUE_BYTES
                && Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
                && !value.chars().any(char::is_control)
        })
        .unwrap_or_else(|| format!("generated.{}", image_extension(mime_type)))
}

fn parse_image_tool_output(
    output: &Value,
    run_dir: &Path,
    workspace_dir: &Path,
    call_id: &str,
) -> Result<GeneratedImageBytes, String> {
    if output.is_null() {
        return Err("Antigravity image tool completed without an image output".to_string());
    }
    if let Some(error) = output.get("error").filter(|value| !value.is_null()) {
        return Err(if let Some(error) = error.as_str() {
            format!("Antigravity image tool failed: {error}")
        } else {
            IMAGE_RUN_ERROR.to_string()
        });
    }
    let payload = match output {
        Value::String(value) if value.trim_start().starts_with("data:image/") => {
            ImagePayload::Encoded(value.clone())
        }
        Value::String(value) => ImagePayload::Path(value.clone()),
        _ => locate_image_payload(output, 0)
            .ok_or_else(|| "Antigravity image tool completed without an image file".to_string())?,
    };
    let declared_mime = image_metadata_string(
        output,
        &["mime_type", "mimeType", "content_type", "contentType"],
        0,
    );
    let id = image_metadata_string(output, &["id", "image_id", "imageId"], 0)
        .unwrap_or_else(|| call_id.to_string());
    if id.is_empty() || id.len() > MAX_IMAGE_VALUE_BYTES || id.chars().any(char::is_control) {
        return Err("Antigravity image output id is invalid".to_string());
    }
    let revised_prompt = image_metadata_string(output, &["revised_prompt", "revisedPrompt"], 0)
        .filter(|value| {
            value.len() <= MAX_IMAGE_VALUE_BYTES && !value.chars().any(char::is_control)
        });

    let (mime_type, bytes, file_name) = match payload {
        ImagePayload::Path(path) => {
            if path.is_empty() || path.contains('\0') {
                return Err("Antigravity image output path is invalid".to_string());
            }
            let path = PathBuf::from(path);
            let path = if path.is_absolute() {
                path
            } else {
                workspace_dir.join(path)
            };
            let (mime_type, bytes, file_name) = read_generated_image(run_dir, &path)?;
            if let Some(declared_mime) = declared_mime.as_deref() {
                if declared_mime != mime_type {
                    return Err("Antigravity image output MIME type does not match its file".into());
                }
            }
            (mime_type.to_string(), bytes, file_name)
        }
        ImagePayload::Encoded(value) => {
            let (bytes, data_url_mime) = decode_image_data(&value)?;
            let mime_type = image_mime_type(&bytes)?;
            for declared in [data_url_mime.as_deref(), declared_mime.as_deref()]
                .into_iter()
                .flatten()
            {
                if declared != mime_type {
                    return Err(
                        "Antigravity image output MIME type does not match its bytes".into(),
                    );
                }
            }
            let file_name = safe_image_file_name(
                image_metadata_string(output, &["file_name", "fileName"], 0),
                mime_type,
            );
            (mime_type.to_string(), bytes, file_name)
        }
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_OUTPUT_BYTES {
        return Err("Antigravity image output exceeds the size limit".to_string());
    }
    Ok(GeneratedImageBytes {
        id,
        mime_type: mime_type.to_string(),
        bytes,
        revised_prompt,
        file_name: Some(file_name),
    })
}

fn image_result_error(result: &Value, uses_gemini_api_key: bool) -> AdapterError {
    let error = result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if [
        "quota",
        "rate limit",
        "rate_limit",
        "usage limit",
        "limit exceeded",
    ]
    .iter()
    .any(|needle| error.contains(needle))
    {
        return AdapterError::coded(
            LocalCliFailureCode::ProcessExit,
            "Antigravity image generation quota was exhausted.",
        );
    }
    classify_result_error(result, uses_gemini_api_key, false)
}

fn attest_image_init(
    value: &Value,
    expected_cwd: &Path,
    request: &PreparedLocalImageRequest,
) -> Result<String, AdapterError> {
    if value.get("event").and_then(Value::as_str) != Some("init") {
        return Err("Antigravity image task did not emit init".into());
    }
    let init = value
        .get("init")
        .and_then(Value::as_object)
        .ok_or_else(|| "Antigravity image init event was malformed".to_string())?;
    let cwd = init
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity image init omitted its working directory".to_string())?;
    if normalized_path(cwd)? != expected_cwd {
        return Err("Antigravity image task started outside its private workspace".into());
    }
    if init.get("permission_mode").and_then(Value::as_str) != Some("strict") {
        return Err("Antigravity image task did not activate strict permission mode".into());
    }
    if init.get("agent").and_then(Value::as_str) != Some(IMAGE_AGENT_NAME) {
        return Err("Antigravity image task did not activate its isolated agent".into());
    }
    if let Some(expected_model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        if init.get("model").and_then(Value::as_str) != Some(expected_model) {
            return Err("Antigravity image task did not activate the selected model".into());
        }
    }
    let tools = init
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "Antigravity image init omitted its tool inventory".to_string())?;
    if tools.len() != 1 || tools.first().and_then(Value::as_str) != Some(IMAGE_TOOL) {
        return Err("Antigravity image task exposed a capability other than generate_image".into());
    }
    let conversation_id = value
        .get("conversation_id")
        .or_else(|| init.get("conversation_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity image init omitted its conversation id".to_string())?;
    validate_session_id(conversation_id)?;
    Ok(conversation_id.to_string())
}

fn image_tool_error(info: &Value) -> Option<AdapterError> {
    let error = info.get("error").filter(|value| !value.is_null())?;
    if contains_permission_signal(error) {
        Some(AdapterError::coded(
            LocalCliFailureCode::ProviderApprovalRejected,
            "Antigravity image generation permission was rejected.",
        ))
    } else {
        Some(IMAGE_RUN_ERROR.into())
    }
}

async fn run_image_protocol(
    request: &PreparedLocalImageRequest,
    expected_cwd: &Path,
    uses_gemini_api_key: bool,
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<GeneratedImageBytes, AdapterError> {
    let conversation_id = crate::timeouts::wait_with_timeout_retries(
        async {
            loop {
                let value = read_value(reader, &request.cancellation).await?;
                if let Some(event) = value.get("event").and_then(Value::as_str) {
                    if event == "init" {
                        return attest_image_init(&value, expected_cwd, request);
                    }
                    if is_allowlisted_stream_metadata_event(event)
                        && !contains_capability_semantics(&value)
                    {
                        continue;
                    }
                }
                if value.get("event").and_then(Value::as_str) == Some("result") {
                    let result = value
                        .get("result")
                        .filter(|result| result.is_object())
                        .ok_or_else(|| {
                            "Antigravity image result before init was malformed".to_string()
                        })?;
                    return Err(image_result_error(result, uses_gemini_api_key));
                }
                return Err("Antigravity image task emitted capability data before init".into());
            }
        },
        HANDSHAKE_TIMEOUT,
    )
    .await
    .map_err(|_| "Antigravity image init timed out".to_string())??;

    let mut generated = None;
    loop {
        let value = read_value(reader, &request.cancellation).await?;
        match value.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                let step = value
                    .get("step_update")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Antigravity image step update was malformed".to_string())?;
                if step.get("conversation_id").and_then(Value::as_str)
                    != Some(conversation_id.as_str())
                {
                    return Err("Antigravity image step changed conversation ids".into());
                }
                if step
                    .get("subagent_info")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(AdapterError::coded(
                        LocalCliFailureCode::IsolationViolation,
                        "Antigravity image task attempted to start a subagent",
                    ));
                }
                match step.get("step_type").and_then(Value::as_str) {
                    Some("tool") => {
                        let name =
                            step.get("tool_name")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    "Antigravity image tool update omitted its name".to_string()
                                })?;
                        if name != IMAGE_TOOL {
                            return Err(AdapterError::coded(
                                LocalCliFailureCode::IsolationViolation,
                                format!("Antigravity image task attempted unauthorized capability {name}"),
                            ));
                        }
                        let info = step
                            .get("tool_info")
                            .and_then(Value::as_object)
                            .ok_or_else(|| {
                                "Antigravity image tool update omitted tool_info".to_string()
                            })?;
                        if let Some(info_name) = info.get("name").and_then(Value::as_str) {
                            if info_name != IMAGE_TOOL {
                                return Err(
                                    "Antigravity image tool changed its canonical name".into()
                                );
                            }
                        }
                        let state = step.get("state").and_then(Value::as_str).ok_or_else(|| {
                            "Antigravity image tool update omitted its state".to_string()
                        })?;
                        match state {
                            "ACTIVE" | "RUNNING" => {
                                if info.get("output").is_some() || info.get("result").is_some() {
                                    return Err(
                                        "Antigravity image tool exposed output before completion"
                                            .into(),
                                    );
                                }
                            }
                            "DONE" | "SUCCESS" => {
                                if let Some(error) = image_tool_error(&Value::Object(info.clone()))
                                {
                                    return Err(error);
                                }
                                if generated.is_some() {
                                    return Err(
                                        "Antigravity image task completed more than one image"
                                            .into(),
                                    );
                                }
                                let output = info
                                    .get("output")
                                    .or_else(|| info.get("result"))
                                    .ok_or_else(|| {
                                        "Antigravity image tool completed without output"
                                            .to_string()
                                    })?;
                                let call_id = step
                                    .get("step_index")
                                    .and_then(Value::as_u64)
                                    .map(|index| format!("agy-image-step-{index}"))
                                    .unwrap_or_else(|| "agy-image-tool".to_string());
                                generated = Some(parse_image_tool_output(
                                    output,
                                    &request.run_dir,
                                    expected_cwd,
                                    &call_id,
                                )?);
                            }
                            "FAILED" | "ERROR" => {
                                if let Some(error) = image_tool_error(&Value::Object(info.clone()))
                                {
                                    return Err(error);
                                }
                                return Err(IMAGE_RUN_ERROR.into());
                            }
                            _ => {
                                return Err(
                                    "Antigravity image tool emitted an unsupported state".into()
                                )
                            }
                        }
                    }
                    Some("agent_response")
                    | Some("thinking")
                    | Some("reasoning")
                    | Some("checkpoint") => {}
                    Some(step_type) => {
                        return Err(AdapterError::coded(
                            LocalCliFailureCode::IsolationViolation,
                            format!(
                                "Antigravity image task emitted unsupported step type {step_type}"
                            ),
                        ));
                    }
                    None => return Err("Antigravity image step update omitted its type".into()),
                }
            }
            Some("result") => {
                let result = value
                    .get("result")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Antigravity image result was malformed".to_string())?;
                let status = result
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let actual_conversation = result
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if actual_conversation != conversation_id {
                    return Err("Antigravity image result changed conversation ids".into());
                }
                match status {
                    "SUCCESS" => {
                        if let Some(error) = result.get("error").filter(|value| !value.is_null()) {
                            if contains_permission_signal(error) {
                                return Err(AdapterError::coded(
                                    LocalCliFailureCode::ProviderApprovalRejected,
                                    "Antigravity image generation permission was rejected.",
                                ));
                            }
                            return Err(image_result_error(
                                &Value::Object(result.clone()),
                                uses_gemini_api_key,
                            ));
                        }
                        return generated.ok_or_else(|| {
                            "Antigravity image task completed without a generated image".into()
                        });
                    }
                    "CANCELED" | "INTERRUPTED" => {
                        return Err(AdapterError::coded(
                            LocalCliFailureCode::Cancelled,
                            "local image task cancelled",
                        ));
                    }
                    _ => {
                        return Err(image_result_error(
                            &Value::Object(result.clone()),
                            uses_gemini_api_key,
                        ))
                    }
                }
            }
            Some("init") => return Err("Antigravity image task emitted init more than once".into()),
            Some(event)
                if is_allowlisted_stream_metadata_event(event)
                    && !contains_capability_semantics(&value) => {}
            Some(_) | None => {
                return Err(AdapterError::coded(
                    LocalCliFailureCode::IsolationViolation,
                    "Antigravity image task emitted an unsupported stream event",
                ));
            }
        }
    }
}

async fn stop_image_process(
    supervisor: RunSupervisor,
    result: Result<GeneratedImageBytes, AdapterError>,
    failure_context: &str,
) -> Result<GeneratedImageBytes, AdapterError> {
    let mut output = None;
    let terminal = result.map(|value| {
        output = Some(value);
        ProtocolOutcome {
            session_id: None,
            aborted: true,
        }
    });
    supervisor.finish(terminal, failure_context).await?;
    output.ok_or_else(|| "Antigravity image process completed without an output".into())
}

pub(crate) async fn generate_image(
    executable: PathBuf,
    request: PreparedLocalImageRequest,
) -> Result<GeneratedImageBytes, AdapterError> {
    if !request.references.is_empty() {
        return Err(AdapterError::coded(
            LocalCliFailureCode::CliUnsupported,
            "Antigravity local image editing is unsupported",
        ));
    }
    if request.cancellation.is_cancelled() {
        return Err(AdapterError::coded(
            LocalCliFailureCode::Cancelled,
            "local image task cancelled",
        ));
    }
    let provider_environment = load_provider_environment()?;
    let (home, workspace, private_files) = prepare_image_files(&request, &provider_environment)?;
    for private_file in &private_files {
        private_file.verify_unchanged()?;
    }
    let process_spec = frozen_image_process_spec(
        &executable,
        &request,
        &provider_environment,
        &home,
        &workspace,
    )?;
    let process = RunSupervisor::spawn(process_spec, request.cancellation.child_token())?;
    let supervisor = process.supervisor;
    // The image prompt is a command-line argument. Closing stdin prevents a
    // headless CLI from waiting for an unrelated stream-json user message.
    drop(process.stdin);
    let mut reader = BufReader::new(process.stdout);
    let expected_cwd = std::fs::canonicalize(&workspace)
        .map_err(|_| "failed to resolve the private Antigravity image workspace".to_string())?;
    let result = supervisor
        .monitor(run_image_protocol(
            &request,
            &expected_cwd,
            provider_environment.uses_gemini_api_key(),
            &mut reader,
        ))
        .await;
    stop_image_process(
        supervisor,
        result,
        "Antigravity image process exited unsuccessfully",
    )
    .await
}

fn apply_private_environment(command: &mut Command, home: &Path) {
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local").join("share"))
        .env("APPDATA", home.join("AppData").join("Roaming"))
        .env("LOCALAPPDATA", home.join("AppData").join("Local"))
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    for name in ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn prepare_run_with_configuration(
    context: ProtocolContext,
    configuration: LoadedAntigravityConfiguration,
) -> Result<PreparedAntigravityRun, String> {
    if context.cancellation.is_cancelled() {
        return Err("local agent run cancelled".to_string());
    }
    let process_args = process_args(&context.request);
    let files = prepare_run_files(&context, &configuration.environment)?;
    let private_files = prepared_private_files(&files)?;
    let process_spec =
        frozen_process_spec(&context, &configuration.environment, &files, &process_args)?;
    Ok(PreparedAntigravityRun {
        context,
        provider_environment: configuration.environment,
        files,
        process_spec,
        private_files,
        configuration_fingerprint: configuration.fingerprint,
    })
}

pub(crate) fn prepare_run(
    context: ProtocolContext,
) -> Result<PreparedAntigravityRun, AdapterError> {
    let configuration = load_provider_configuration()?;
    Ok(prepare_run_with_configuration(context, configuration)?)
}

async fn launch_prepared_with_prelaunch<F, Fut>(
    prepared: PreparedAntigravityRun,
    prelaunch: F,
) -> Result<ProtocolOutcome, AdapterError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if prepared.configuration_fingerprint().is_empty() {
        return Err("Antigravity prepared configuration fingerprint is unavailable".into());
    }
    let PreparedAntigravityRun {
        context,
        provider_environment,
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
    prelaunch().await;
    if context.cancellation.is_cancelled() {
        return Ok(ProtocolOutcome {
            session_id: context.request.session_id.clone(),
            aborted: true,
        });
    }
    // The runtime lock, when present, is owned by the common supervisor. Keep
    // provider material frozen while that lock is acquired instead of writing
    // a second copy at launch.
    for private_file in &private_files {
        private_file.verify_unchanged()?;
    }
    let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
    let supervisor = process.supervisor;
    let mut stdin = process.stdin;
    let mut reader = BufReader::new(process.stdout);
    let run_result = supervisor
        .monitor(run_protocol(
            &context,
            &files,
            provider_environment.uses_gemini_api_key(),
            &mut stdin,
            &mut reader,
        ))
        .await;
    drop(stdin);
    supervisor
        .finish(
            run_result,
            "Antigravity structured session exited unsuccessfully",
        )
        .await
}

pub(crate) async fn launch_prepared(
    prepared: PreparedAntigravityRun,
) -> Result<ProtocolOutcome, AdapterError> {
    launch_prepared_with_prelaunch(prepared, || std::future::ready(())).await
}

#[cfg(test)]
mod tests {
    use crate::local_agent::LocalToolResolution;
    use crate::local_agent_bridge::ToolBridge;
    use crate::local_agent_models::{
        LaunchValidation, ModelPreference, ModelResolutionRequest, ModelStrategy,
        PreferenceDecision,
    };
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    use tokio::sync::{mpsc, Barrier};
    use tokio_util::sync::CancellationToken;

    use super::*;

    const CONTRACT_HOST_TOOL: &str = "host_write_probe";
    const CONTRACT_HOST_RESULT: &str = "host-resolution-ok:antigravity";

    fn compile_contract_cli(mode: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "open-builder-antigravity-contract-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            format!("open-builder-antigravity-contract-{mode}.exe")
        } else {
            format!("open-builder-antigravity-contract-{mode}")
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
            "fake Antigravity CLI failed to compile: {}",
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
        let workspace_dir = root.join("workspace authority");
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
            cli_version: "1.1.23-test".to_string(),
        }
    }

    async fn execute_contract(context: &ProtocolContext) -> Result<ProtocolOutcome, AdapterError> {
        let provider_environment = AntigravityProviderEnvironment::default();
        let files = prepare_run_files(context, &provider_environment)?;
        let process_args = process_args(&context.request);
        let private_files = prepared_private_files(&files)?;
        for private_file in &private_files {
            private_file.verify_unchanged()?;
        }
        let process_spec =
            frozen_process_spec(context, &provider_environment, &files, &process_args)?;
        let process = RunSupervisor::spawn(process_spec, context.cancellation.clone())?;
        let supervisor = process.supervisor;
        let mut stdin = process.stdin;
        let mut reader = BufReader::new(process.stdout);
        let result = supervisor
            .monitor(run_protocol(
                context,
                &files,
                false,
                &mut stdin,
                &mut reader,
            ))
            .await;
        drop(stdin);
        supervisor
            .finish(
                result,
                "Antigravity fake contract process exited unsuccessfully",
            )
            .await
    }

    fn request() -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            utility_effort_policy: None,
            provider: crate::local_agent::LocalAgentProvider::Antigravity,
            model: Some("gemini-3.5-flash-medium".to_string()),
            effort: Some("medium".to_string()),
            system_prompt: "Answer carefully.".to_string(),
            prompt: "Hello".to_string(),
            bootstrap_context: None,
            session_id: None,
            session_compatibility_key: None,
            scope: crate::local_agent::LocalAgentRunScope {
                kind: crate::local_agent::LocalAgentRunScopeKind::Conversation,
                id: "test-conversation".to_string(),
            },
            tools: vec![LocalToolSpec {
                name: "search_docs".to_string(),
                description: "Search docs".to_string(),
                input_schema: json!({"type":"object"}),
                annotations: Default::default(),
                host_approval: Default::default(),
            }],
            max_tool_calls: 4,
            native_search: false,
            mode: "chat".to_string(),
        }
    }

    fn files(cwd: &Path) -> RunFiles {
        RunFiles {
            home: cwd.join("home"),
            workspace: cwd.to_path_buf(),
            expected_cwd: std::fs::canonicalize(cwd).unwrap(),
            expected_tools: BTreeSet::from(["mcp__open_builder__search_docs".to_string()]),
        }
    }

    fn init_fixture(cwd: &Path) -> Value {
        json!({
            "event":"init",
            "conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a",
            "init":{
                "cwd":cwd,
                "tools":["mcp__open_builder__search_docs"],
                "permission_mode":"strict",
                "model":"gemini-3.5-flash-medium",
                "agent":"open-builder"
            }
        })
    }

    fn image_request(run_dir: &Path) -> PreparedLocalImageRequest {
        PreparedLocalImageRequest {
            model: None,
            effort: None,
            prompt: "Draw a small fox".to_string(),
            references: Vec::new(),
            run_dir: run_dir.to_path_buf(),
            cancellation: CancellationToken::new(),
        }
    }

    const TEST_IMAGE_PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRpayload\x00\x00\x00\x00IEND\xaeB`\x82";

    #[test]
    fn identity_discovers_official_install_locations() {
        assert_eq!(IDENTITY.command_name, "agy");
        assert!(IDENTITY.unix_home_directories.contains(&".local/bin"));
        assert!(IDENTITY.windows_local_directories.contains(&"agy\\bin"));
        const { assert!(IDENTITY.require_empty_workspace) };
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_home_projects_only_the_native_keychain_directory() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-keychain-test-{}",
            uuid::Uuid::new_v4()
        ));
        let source_home = root.join("source");
        let keychains = source_home.join("Library").join("Keychains");
        let private_home = root.join("private");
        std::fs::create_dir_all(&keychains).unwrap();
        std::fs::create_dir_all(&private_home).unwrap();

        project_macos_keychains(&source_home, &private_home).unwrap();
        let projected = private_home.join("Library").join("Keychains");
        assert!(std::fs::symlink_metadata(&projected)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::canonicalize(&projected).unwrap(),
            std::fs::canonicalize(&keychains).unwrap()
        );

        std::fs::remove_file(&projected).unwrap();
        std::fs::create_dir(&projected).unwrap();
        assert!(project_macos_keychains(&source_home, &private_home).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gates_every_structured_and_isolation_flag() {
        let help = "--print --print-timeout --input-format --output-format --agent --model --effort --conversation --sandbox";
        assert!(has_required_help(help).is_ok());
        assert!(has_required_help(&help.replace("--print", "")).is_err());
        assert!(has_required_help(&help.replace("--print-timeout", "")).is_err());
        assert!(has_required_help(&help.replace("--agent", "")).is_err());
        assert!(has_required_help(&help.replace("--input-format", "")).is_err());
    }

    #[test]
    fn parses_json_and_text_model_inventories() {
        let json_models = parse_models(
            br#"{"models":[{"id":"gemini-3.5-flash-medium","display_name":"Gemini Flash","is_default":true}]}"#,
        );
        assert_eq!(json_models.len(), 1);
        assert_eq!(json_models[0].display_name, "Gemini Flash");
        assert!(json_models[0].is_default);

        let partial = parse_model_catalog(
            br#"{"models":[{"id":"gemini-3.5-flash-medium"},{"id":"unsafe model"}]}"#,
        );
        assert_eq!(partial.authority, CatalogAuthority::Partial);
        assert_eq!(partial.models.len(), 1);

        let text_models = parse_models(
            b"Model | Id\n--- | ---\n* gemini-3.5-flash-medium\n  claude-sonnet-4-6\n",
        );
        assert_eq!(
            text_models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["gemini-3.5-flash-medium", "claude-sonnet-4-6"]
        );
        assert_eq!(
            parse_model_catalog(
                b"Model | Id\n--- | ---\n* gemini-3.5-flash-medium\n  claude-sonnet-4-6\n"
            )
            .authority,
            CatalogAuthority::Partial
        );
    }

    #[tokio::test]
    async fn empty_json_catalog_keeps_a_saved_model_unverified() {
        let catalog = parse_model_catalog(br#"{"models":[]}"#);
        assert_eq!(catalog.authority, CatalogAuthority::Partial);

        let resolution = ModelStrategy::default()
            .resolve(ModelResolutionRequest {
                provider: crate::local_agent::LocalAgentProvider::Antigravity,
                candidates: Vec::new(),
                authority: catalog.authority,
                preference: ModelPreference {
                    model: Some("gemini-saved".to_string()),
                    effort: Some("high".to_string()),
                },
                configured: ModelPreference::default(),
                gateway: None,
                force_refresh: false,
            })
            .await;

        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: true }
        );
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Allowed {
                unverified: true,
                ..
            }
        ));
    }

    #[test]
    fn runtime_args_are_structured_only_and_support_preferences() {
        let mut request = request();
        request.session_id = Some("055a398f-db14-4c5f-abbb-1bf03f8120a7".to_string());
        let args = process_args(&request);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--input-format", "stream-json"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--agent", "open-builder"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--print-timeout", "0s"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model", "gemini-3.5-flash-medium"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "medium"]));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--conversation", "055a398f-db14-4c5f-abbb-1bf03f8120a7",] }));
        assert!(args.iter().any(|arg| arg == "--print="));
        assert!(!args.iter().any(|arg| arg == "-p" || arg == "-"));
    }

    #[test]
    fn private_agent_and_permissions_only_grant_requested_capabilities() {
        let request = request();
        let agent = agent_source(&request).unwrap();
        assert!(agent.contains("mcp__open_builder__search_docs"));
        assert!(agent.contains("subagent: false"));
        assert!(!agent.contains(NATIVE_SEARCH_TOOL));
        assert!(!agent.contains(NATIVE_URL_TOOL));
        assert!(!agent.contains(LEGACY_NATIVE_URL_TOOL));

        let settings = permission_settings(&request, None);
        assert_eq!(settings["toolPermission"], "strict");
        assert_eq!(settings["enableTerminalSandbox"], json!(true));
        assert_eq!(settings["allowNonWorkspaceAccess"], json!(false));
        assert_eq!(
            settings["permissions"]["allow"],
            json!(["mcp(open_builder/search_docs)"])
        );
        let denied = settings["permissions"]["deny"].as_array().unwrap();
        for permission in ["search_web(*)", "read_url_content(*)", "read_url(*)"] {
            assert!(
                denied.contains(&json!(permission)),
                "missing deny: {permission}"
            );
        }
    }

    #[test]
    fn image_worker_exposes_only_generate_image_and_denies_other_capabilities() {
        let agent = image_agent_source();
        assert!(agent.contains("name: open-builder-image"));
        assert!(agent.contains("subagent: false"));
        assert!(agent.contains("generate_image"));
        for denied in [
            "files",
            "shell commands",
            "browsers",
            "MCP servers",
            "web search",
            "URL readers",
            "subagents",
        ] {
            assert!(
                agent.contains(denied),
                "missing worker prohibition: {denied}"
            );
        }

        let settings = image_permission_settings(None);
        assert_eq!(settings["toolPermission"], "strict");
        assert_eq!(
            settings["permissions"]["allow"],
            json!(["generate_image(*)"])
        );
        let denied = settings["permissions"]["deny"].as_array().unwrap();
        for capability in [
            "read_file(*)",
            "write_file(*)",
            "command(*)",
            "browser(*)",
            "mcp(*)",
            "search_web(*)",
            "read_url_content(*)",
            "subagent(*)",
        ] {
            assert!(
                denied.contains(&json!(capability)),
                "missing deny: {capability}"
            );
        }
    }

    #[test]
    fn image_process_args_use_stream_json_and_reject_unsafe_preferences() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-image-args-{}",
            uuid::Uuid::new_v4()
        ));
        let request = image_request(&root);
        let args = image_process_args(&request).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--print-timeout", "0s"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--agent", IMAGE_AGENT_NAME]));
        assert!(args.iter().any(|arg| arg == "--print"));
        assert_eq!(args.last().map(String::as_str), Some("Draw a small fox"));

        let mut invalid = request;
        invalid.model = Some("unsafe model".to_string());
        assert!(image_process_args(&invalid).is_err());
    }

    #[test]
    fn image_init_requires_exact_generate_image_inventory() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-image-init-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let request = image_request(&root);
        let expected_cwd = std::fs::canonicalize(&root).unwrap();
        let conversation_id = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
        let init = json!({
            "event":"init",
            "conversation_id":conversation_id,
            "init":{
                "cwd":expected_cwd,
                "tools":[IMAGE_TOOL],
                "permission_mode":"strict",
                "agent":IMAGE_AGENT_NAME
            }
        });
        assert_eq!(
            attest_image_init(&init, &expected_cwd, &request).unwrap(),
            conversation_id
        );

        for tools in [
            json!([IMAGE_TOOL, NATIVE_SEARCH_TOOL]),
            json!([NATIVE_SEARCH_TOOL]),
            json!([]),
        ] {
            let mut invalid = init.clone();
            invalid["init"]["tools"] = tools;
            assert!(attest_image_init(&invalid, &expected_cwd, &request).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_output_accepts_nested_images_and_strictly_validates_bytes() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-image-output-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let encoded = BASE64.encode(TEST_IMAGE_PNG);
        let output = json!({
            "images":[{
                "id":"image-nested",
                "mimeType":"image/png",
                "data":encoded,
                "revisedPrompt":"A small fox"
            }]
        });
        let image = parse_image_tool_output(&output, &root, &root, "agy-image-step-1").unwrap();
        assert_eq!(image.id, "image-nested");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.bytes, TEST_IMAGE_PNG);
        assert_eq!(image.revised_prompt.as_deref(), Some("A small fox"));

        let invalid = json!({"data":BASE64.encode(b"not an image")});
        assert!(parse_image_tool_output(&invalid, &root, &root, "agy-image-step-2").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_output_paths_are_confined_to_the_task_directory() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-image-path-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = std::env::temp_dir().join(format!(
            "open-builder-agy-image-outside-{}.png",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("generated.png"), TEST_IMAGE_PNG).unwrap();
        std::fs::write(&outside, TEST_IMAGE_PNG).unwrap();
        let inside = parse_image_tool_output(
            &json!({"path":"generated.png", "id":"image-path"}),
            &root,
            &root,
            "agy-image-step-3",
        )
        .unwrap();
        assert_eq!(inside.file_name.as_deref(), Some("generated.png"));
        assert!(parse_image_tool_output(
            &json!({"path":outside}),
            &root,
            &root,
            "agy-image-step-4",
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_file(outside).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn image_protocol_requires_completed_tool_event_before_success() {
        use tokio::process::Command;

        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-image-protocol-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let request = image_request(&root);
        let conversation_id = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
        let output = BASE64.encode(TEST_IMAGE_PNG);
        let events = [
            json!({"event":"init","conversation_id":conversation_id,"init":{"cwd":std::fs::canonicalize(&root).unwrap(),"tools":[IMAGE_TOOL],"permission_mode":"strict","agent":IMAGE_AGENT_NAME}}),
            json!({"event":"step_update","step_update":{"conversation_id":conversation_id,"step_type":"tool","tool_name":IMAGE_TOOL,"state":"ACTIVE","step_index":1,"tool_info":{"name":IMAGE_TOOL}}}),
            json!({"event":"step_update","step_update":{"conversation_id":conversation_id,"step_type":"tool","tool_name":IMAGE_TOOL,"state":"DONE","step_index":1,"tool_info":{"name":IMAGE_TOOL,"output":{"images":[{"id":"image-protocol","mimeType":"image/png","data":output}]}}}}),
            json!({"event":"result","result":{"status":"SUCCESS","conversation_id":conversation_id}}),
        ];
        let lines = events
            .iter()
            .map(|event| serde_json::to_string(event).unwrap())
            .collect::<Vec<_>>();
        let script = "printf '%s\\n' \"$1\" \"$2\" \"$3\" \"$4\"";
        let mut child = Command::new("sh")
            .args(["-c", script, "fake"])
            .args(&lines)
            .current_dir(&root)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let image = run_image_protocol(
            &request,
            &std::fs::canonicalize(&root).unwrap(),
            false,
            &mut reader,
        )
        .await
        .unwrap();
        assert_eq!(image.id, "image-protocol");
        assert_eq!(image.bytes, TEST_IMAGE_PNG);
        assert!(child.wait().await.unwrap().success());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_search_permissions_allow_canonical_and_legacy_read_only_tools() {
        let mut request = request();
        request.native_search = true;
        let settings = permission_settings(&request, None);
        let allow = settings["permissions"]["allow"].as_array().unwrap();
        let deny = settings["permissions"]["deny"].as_array().unwrap();
        for permission in ["search_web(*)", "read_url_content(*)", "read_url(*)"] {
            assert!(
                allow.contains(&json!(permission)),
                "missing allow: {permission}"
            );
            assert!(!deny.contains(&json!(permission)));
        }
        let agent = agent_source(&request).unwrap();
        assert!(agent.contains(&format!("\"{NATIVE_SEARCH_TOOL}\"")));
        assert!(agent.contains(&format!("\"{NATIVE_URL_TOOL}\"")));
        assert!(!agent.contains(&format!("\"{LEGACY_NATIVE_URL_TOOL}\"")));
    }

    #[test]
    fn native_search_requires_search_and_url_tools_in_the_attested_inventory() {
        let expected = BTreeSet::new();
        assert_eq!(
            native_search_tools_from_inventory(
                &BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string(),]),
                &expected,
                true,
            )
            .unwrap(),
            BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string(),])
        );
        assert_eq!(
            native_search_tools_from_inventory(
                &BTreeSet::from([
                    NATIVE_SEARCH_TOOL.to_string(),
                    LEGACY_NATIVE_URL_TOOL.to_string(),
                ]),
                &expected,
                true,
            )
            .unwrap(),
            BTreeSet::from([
                NATIVE_SEARCH_TOOL.to_string(),
                LEGACY_NATIVE_URL_TOOL.to_string(),
            ])
        );
        let url_only = native_search_tools_from_inventory(
            &BTreeSet::from([LEGACY_NATIVE_URL_TOOL.to_string()]),
            &expected,
            true,
        )
        .expect_err("URL access alone must not advertise native search");
        assert!(url_only.contains(NATIVE_SEARCH_TOOL));
    }

    #[test]
    fn native_search_inventory_is_rejected_when_disabled() {
        let error = native_search_tools_from_inventory(
            &BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string()]),
            &BTreeSet::new(),
            false,
        )
        .expect_err("disabled native search must reject provider inventory");
        assert!(error.contains("disabled"));
    }

    #[test]
    fn gemini_provider_imports_only_the_documented_environment() {
        let settings = json!({
            "modelProvider": "gemini",
            "permissions": {"allow": ["command(*)"]}
        });
        let inherited = BTreeMap::from([
            ("GEMINI_API_KEY".to_string(), "secret-key".to_string()),
            (
                "GOOGLE_GEMINI_BASE_URL".to_string(),
                "https://gateway.example/v1".to_string(),
            ),
            (
                "NODE_OPTIONS".to_string(),
                "--require attacker.js".to_string(),
            ),
        ]);

        let provider = provider_environment_from_sources(Some(&settings), &inherited).unwrap();
        assert!(provider.uses_gemini_api_key());
        assert!(provider.uses_custom_endpoint());
        assert_eq!(
            provider
                .values
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]
        );

        let private_settings = permission_settings(&request(), provider.model_provider());
        assert_eq!(private_settings["modelProvider"], "gemini");
        let serialized = serde_json::to_string(&private_settings).unwrap();
        assert!(!serialized.contains("secret-key"));
        assert!(!serialized.contains("gateway.example"));
        assert!(!serialized.contains("NODE_OPTIONS"));
    }

    #[test]
    fn gemini_provider_requires_an_explicit_key_and_safe_endpoint() {
        let settings = json!({"modelProvider": "gemini"});
        assert!(provider_environment_from_sources(Some(&settings), &BTreeMap::new()).is_err());

        for endpoint in [
            "http://gateway.example/v1",
            "https://user:secret@gateway.example/v1",
            "https://gateway.example/v1#fragment",
        ] {
            let inherited = BTreeMap::from([
                ("GEMINI_API_KEY".to_string(), "secret-key".to_string()),
                ("GOOGLE_GEMINI_BASE_URL".to_string(), endpoint.to_string()),
            ]);
            assert!(
                provider_environment_from_sources(Some(&settings), &inherited).is_err(),
                "{endpoint}"
            );
        }

        let loopback = BTreeMap::from([
            ("GEMINI_API_KEY".to_string(), "secret-key".to_string()),
            (
                "GOOGLE_GEMINI_BASE_URL".to_string(),
                "http://127.0.0.1:8080/v1".to_string(),
            ),
        ]);
        assert!(
            provider_environment_from_sources(Some(&settings), &loopback)
                .unwrap()
                .uses_custom_endpoint()
        );
    }

    #[test]
    fn default_antigravity_auth_does_not_inherit_gemini_credentials() {
        let inherited = BTreeMap::from([
            ("GEMINI_API_KEY".to_string(), "secret-key".to_string()),
            (
                "GOOGLE_GEMINI_BASE_URL".to_string(),
                "https://gateway.example/v1".to_string(),
            ),
        ]);
        let provider = provider_environment_from_sources(None, &inherited).unwrap();
        assert!(!provider.uses_gemini_api_key());
        assert!(!provider.uses_custom_endpoint());
        assert!(provider.values.is_empty());
        assert!(permission_settings(&request(), provider.model_provider())
            .get("modelProvider")
            .is_none());
    }

    #[test]
    fn prepared_run_freezes_files_and_a_secret_free_configuration_fingerprint() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-prepared-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let (channel, _events) = event_channel();
        let request = request();
        let context = protocol_context(
            &root,
            root.join(if cfg!(windows) { "agy.exe" } else { "agy" }),
            request,
            channel,
        );
        let environment = AntigravityProviderEnvironment {
            values: vec![
                (GEMINI_API_KEY_ENV.to_string(), "secret-key-one".to_string()),
                (
                    GEMINI_BASE_URL_ENV.to_string(),
                    "https://gateway.example/v1".to_string(),
                ),
            ],
            model_provider: Some("gemini".to_string()),
            custom_endpoint: true,
        };
        let expected_fingerprint =
            configuration_fingerprint_from_environment("user-settings", &environment);
        let prepared = prepare_run_with_configuration(
            context,
            LoadedAntigravityConfiguration {
                environment,
                fingerprint: expected_fingerprint.clone(),
            },
        )
        .unwrap();

        assert_eq!(prepared.private_files.len(), 3);
        let settings_path = prepared
            .files
            .home
            .join(".gemini/antigravity-cli/settings.json");
        let settings = std::fs::read(&settings_path).unwrap();
        std::fs::write(&settings_path, b"tampered").unwrap();
        assert!(prepared.private_files[0].verify_unchanged().is_err());
        std::fs::write(&settings_path, settings).unwrap();
        assert_eq!(prepared.configuration_fingerprint(), expected_fingerprint);
        assert!(!prepared
            .configuration_fingerprint()
            .contains("secret-key-one"));

        let same_identity_with_rotated_secret = AntigravityProviderEnvironment {
            values: vec![
                (GEMINI_API_KEY_ENV.to_string(), "secret-key-two".to_string()),
                (
                    GEMINI_BASE_URL_ENV.to_string(),
                    "https://gateway.example/v1".to_string(),
                ),
            ],
            model_provider: Some("gemini".to_string()),
            custom_endpoint: true,
        };
        assert_eq!(
            prepared.configuration_fingerprint(),
            configuration_fingerprint_from_environment(
                "user-settings",
                &same_identity_with_rotated_secret,
            )
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_settings_path_accepts_only_bounded_regular_files() {
        let directory = std::env::temp_dir().join(format!(
            "open-builder-agy-settings-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let settings = directory.join("settings.json");
        std::fs::write(&settings, br#"{"modelProvider":"gemini"}"#).unwrap();
        assert_eq!(
            validate_user_settings_path(&settings).unwrap(),
            Some(settings.clone())
        );

        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_user_settings_path(&nested).is_err());

        let oversized = directory.join("oversized.json");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_ANTIGRAVITY_SETTINGS_BYTES + 1).unwrap();
        assert!(validate_user_settings_path(&oversized).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_exact_init_capabilities_before_prompt() {
        let directory = std::env::temp_dir().join(format!(
            "open-builder-agy-init-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let attestation = attest_init(&init_fixture(&directory), &files(&directory), &request())
            .expect("valid init must attest");
        assert_eq!(
            attestation.conversation_id,
            "c3b66b04-872b-4fbe-a3a4-058a026ef20a"
        );

        let mut external = init_fixture(&directory);
        external["init"]["tools"]
            .as_array_mut()
            .unwrap()
            .push(json!("mcp__external__steal"));
        assert!(attest_init(&external, &files(&directory), &request()).is_err());

        let mut permissive = init_fixture(&directory);
        permissive["init"]["permission_mode"] = json!("always-proceed");
        assert!(attest_init(&permissive, &files(&directory), &request()).is_err());

        let mut unknown_mode = init_fixture(&directory);
        unknown_mode["init"]["permission_mode"] = json!("bypassPermissions");
        assert!(attest_init(&unknown_mode, &files(&directory), &request()).is_err());

        let mut wrong_agent = init_fixture(&directory);
        wrong_agent["init"]["agent"] = json!("default");
        assert!(attest_init(&wrong_agent, &files(&directory), &request()).is_err());

        let mut subagent = init_fixture(&directory);
        subagent["init"]["tools"]
            .as_array_mut()
            .unwrap()
            .push(json!("invoke_subagent"));
        assert!(attest_init(&subagent, &files(&directory), &request()).is_err());

        for native_tool in ["ask_permission", "run_command", "write_to_file"] {
            let mut native = init_fixture(&directory);
            native["init"]["tools"]
                .as_array_mut()
                .unwrap()
                .push(json!(native_tool));
            assert!(attest_init(&native, &files(&directory), &request()).is_err());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_missing_bridge_tool_and_wrong_cwd() {
        let directory = std::env::temp_dir().join(format!(
            "open-builder-agy-init-test-{}",
            uuid::Uuid::new_v4()
        ));
        let other = std::env::temp_dir().join(format!(
            "open-builder-agy-init-other-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&other).unwrap();

        let mut missing = init_fixture(&directory);
        missing["init"]["tools"] = json!(["run_command"]);
        assert!(attest_init(&missing, &files(&directory), &request()).is_err());

        let wrong_cwd = init_fixture(&other);
        assert!(attest_init(&wrong_cwd, &files(&directory), &request()).is_err());
        std::fs::remove_dir_all(directory).unwrap();
        std::fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn decodes_text_reasoning_usage_and_read_url_activity() {
        let request = request();
        let text = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_index":2,
                "state":"ACTIVE",
                "step_type":"agent_response",
                "text_delta":"hello",
                "usage":{"input_tokens":4,"output_tokens":2,"cache_read_tokens":1}
            }
        });
        let events = decode_step(
            &text,
            "id",
            &BTreeSet::from(["mcp__open_builder__search_docs".to_string()]),
            &request,
        )
        .unwrap();
        assert!(events.contains(&RuntimeEvent::Text("hello".to_string())));
        assert!(events.contains(&RuntimeEvent::Usage {
            input_tokens: Some(4),
            output_tokens: Some(2),
            cached_input_tokens: Some(1),
        }));

        let reasoning = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_type":"thinking",
                "thinking_delta":"considering"
            }
        });
        assert!(decode_step(&reasoning, "id", &BTreeSet::new(), &request)
            .unwrap()
            .contains(&RuntimeEvent::Reasoning("considering".to_string())));

        let mut native_request = request.clone();
        native_request.native_search = true;
        let native_tools =
            BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string()]);
        let started = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_index":3,
                "step_type":"tool",
                "tool_name":NATIVE_SEARCH_TOOL,
                "state":"ACTIVE",
                "tool_info":{
                    "name":NATIVE_SEARCH_TOOL,
                    "parameters":{"query":"verified run"},
                    "output":{"ignored":true}
                }
            }
        });
        assert!(matches!(
            decode_step(&started, "id", &native_tools, &native_request)
                .unwrap()
                .as_slice(),
            [RuntimeEvent::Tool {
                native: true,
                name,
                phase,
                arguments: Some(Value::Object(_)),
                result: None,
                ..
            }] if name == NATIVE_SEARCH_TOOL && phase == "started"
        ));
        let completed = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_index":3,
                "step_type":"tool",
                "tool_name":NATIVE_SEARCH_TOOL,
                "state":"DONE",
                "tool_info":{
                    "name":NATIVE_SEARCH_TOOL,
                    "parameters":{"query":"verified run"},
                    "output":{"results":[{"url":"https://example.test"}]}
                }
            }
        });
        assert!(matches!(
            decode_step(&completed, "id", &native_tools, &native_request)
                .unwrap()
                .as_slice(),
            [RuntimeEvent::Tool {
                native: true,
                name,
                phase,
                result: Some(Value::Object(_)),
                ..
            }] if name == NATIVE_SEARCH_TOOL && phase == "completed"
        ));
    }

    #[test]
    fn rejects_every_unauthorized_runtime_tool() {
        let expected = BTreeSet::from(["mcp__open_builder__search_docs".to_string()]);
        let request = request();
        assert!(validate_runtime_tool("run_command", &json!({}), &expected, &request).is_err());
        assert!(
            validate_runtime_tool("mcp__external__steal", &json!({}), &expected, &request).is_err()
        );
        assert!(validate_runtime_tool(
            "call_mcp_tool",
            &json!({"parameters":{"ServerName":"external","ToolName":"steal"}}),
            &expected,
            &request
        )
        .is_err());
        assert!(validate_runtime_tool("read_url", &json!({}), &expected, &request).is_err());
        assert!(
            validate_runtime_tool(NATIVE_SEARCH_TOOL, &json!({}), &expected, &request).is_err()
        );

        let mut native_request = request.clone();
        native_request.native_search = true;
        let native_expected =
            BTreeSet::from([NATIVE_SEARCH_TOOL.to_string(), NATIVE_URL_TOOL.to_string()]);
        assert!(validate_runtime_tool(
            NATIVE_SEARCH_TOOL,
            &json!({}),
            &native_expected,
            &native_request
        )
        .unwrap());
        assert!(validate_runtime_tool(
            NATIVE_URL_TOOL,
            &json!({}),
            &native_expected,
            &native_request
        )
        .unwrap());
        assert!(validate_runtime_tool(
            LEGACY_NATIVE_URL_TOOL,
            &json!({}),
            &native_expected,
            &native_request
        )
        .is_err());

        assert!(!validate_runtime_tool(
            "call_mcp_tool",
            &json!({"parameters":{"ServerName":"open_builder","ToolName":"search_docs"}}),
            &expected,
            &request
        )
        .unwrap());
    }

    #[test]
    fn rejects_explicit_permission_and_approval_failures_but_preserves_host_errors() {
        for value in [
            json!("permission denied"),
            json!("approval required"),
            json!("not-authorized by Antigravity"),
            json!({"message":"permission denied"}),
        ] {
            assert!(contains_permission_signal(&value));
        }
        for value in [
            json!("host tool returned no matches"),
            json!({"code":"NO_MATCH"}),
        ] {
            assert!(!contains_permission_signal(&value));
        }

        let expected = BTreeSet::from(["mcp__open_builder__search_docs".to_string()]);
        let mut denied = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_type":"tool",
                "tool_name":"mcp__open_builder__search_docs",
                "state":"DONE",
                "tool_info":{"error":"approval required for mcp(open_builder/search_docs)"}
            }
        });
        assert!(decode_step(&denied, "id", &expected, &request()).is_err());

        denied["step_update"]["tool_info"]["error"] = json!("host tool returned no matches");
        let decoded = decode_step(&denied, "id", &expected, &request()).unwrap();
        assert!(matches!(
            decoded.as_slice(),
            [RuntimeEvent::Tool {
                native: false,
                result: Some(Value::String(error)),
                ..
            }] if error == "host tool returned no matches"
        ));
    }

    #[test]
    fn rejects_unknown_and_subagent_step_types() {
        let expected = BTreeSet::from(["mcp__open_builder__search_docs".to_string()]);
        let request = request();
        for step_type in ["future_step", "subagent_activity"] {
            let event = json!({
                "event":"step_update",
                "step_update":{
                    "conversation_id":"id",
                    "step_type":step_type
                }
            });
            assert!(decode_step(&event, "id", &expected, &request).is_err());
        }

        for state in [None, Some("FUTURE")] {
            let mut event = json!({
                "event":"step_update",
                "step_update":{
                    "conversation_id":"id",
                    "step_type":"tool",
                    "tool_name":"mcp__open_builder__search_docs",
                    "tool_info":{}
                }
            });
            if let Some(state) = state {
                event["step_update"]["state"] = json!(state);
            }
            assert!(decode_step(&event, "id", &expected, &request).is_err());
        }
    }

    #[test]
    fn ignores_only_allowlisted_antigravity_metadata() {
        assert!(is_allowlisted_stream_metadata_event("progress"));
        assert!(is_allowlisted_stream_metadata_event("telemetry"));
        assert!(!is_allowlisted_stream_metadata_event("permission_request"));
        assert!(!is_allowlisted_stream_metadata_event("write_file"));
        assert!(!contains_capability_semantics(&json!({
            "event":"telemetry",
            "latency_ms":12
        })));
        assert!(contains_capability_semantics(&json!({
            "event":"telemetry",
            "permission_request":{"tool":"write_file"}
        })));

        let event = json!({
            "event":"step_update",
            "step_update":{
                "conversation_id":"id",
                "step_type":"checkpoint"
            }
        });
        let decoded = decode_step(&event, "id", &BTreeSet::new(), &request()).unwrap();
        assert!(matches!(decoded.as_slice(), [RuntimeEvent::Ignore]));

        for step_type in ["user_input", "permission", "permission_request"] {
            let event = json!({
                "event":"step_update",
                "step_update":{
                    "conversation_id":"id",
                    "step_type":step_type
                }
            });
            assert!(decode_step(&event, "id", &BTreeSet::new(), &request()).is_err());
        }
    }

    #[test]
    fn pre_init_result_is_classified_without_waiting_for_handshake_timeout() {
        let error = pre_init_event(
            json!({
                "event":"result",
                "result":{
                    "status":"ERROR",
                    "error":"Eligibility check failed: account is not eligible"
                }
            }),
            false,
            false,
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "Antigravity account eligibility check failed."
        );

        assert!(pre_init_event(
            json!({"event":"telemetry","tool":"write_file"}),
            false,
            false
        )
        .is_err());
    }

    #[test]
    fn terminal_result_statuses_are_not_accepted_as_success() {
        for status in ["WAITING", "RUNNING"] {
            assert!(validate_result_status(status)
                .expect_err("nonterminal status must not be accepted")
                .contains("nonterminal"));
        }
        assert!(validate_result_status("SUCCESS").is_ok());
        assert!(validate_result_status("").is_err());
    }

    #[test]
    fn permission_stderr_is_detected_without_exposing_its_contents() {
        for value in [
            json!("permission denied; Authorization: Bearer secret-sentinel"),
            json!("approval required; token=secret-sentinel"),
            json!("not-authorized by Antigravity; secret-sentinel"),
        ] {
            assert!(contains_permission_signal(&value));
        }
    }

    #[test]
    fn rejects_malformed_stream_records() {
        assert!(parse_stream_line("not-json").is_err());
        assert!(parse_stream_line("[]").is_err());
        assert!(parse_stream_line("{}").is_ok());
    }

    #[test]
    fn validates_conversation_and_option_inputs() {
        let mut invalid_session = request();
        invalid_session.session_id = Some("not-a-session".to_string());
        assert!(validate_request(&invalid_session).is_err());

        let mut invalid_effort = request();
        invalid_effort.effort = Some("ultra".to_string());
        assert!(validate_request(&invalid_effort).is_err());

        let mut invalid_tool = request();
        invalid_tool.tools[0].name = "unsafe)".to_string();
        assert!(validate_request(&invalid_tool).is_err());
    }

    #[test]
    fn redacts_provider_errors_by_category() {
        let credential = classify_result_error(
            &json!({"error":"authentication required: token abc"}),
            false,
            false,
        );
        assert_eq!(
            credential.code,
            Some(LocalCliFailureCode::CredentialRejected)
        );
        assert_eq!(
            credential.message,
            "Antigravity is not signed in; run agy and complete login."
        );

        let model =
            classify_result_error(&json!({"error":"invalid model secret-model"}), false, false);
        assert_eq!(model.code, Some(LocalCliFailureCode::ModelRejected));

        let generic = classify_result_error(&json!({"error":"raw sensitive detail"}), false, false);
        assert_eq!(generic.code, None);
        assert_eq!(generic.message, "Antigravity run failed.");

        let gemini =
            classify_result_error(&json!({"error":"unauthorized secret-key"}), true, false);
        assert_eq!(gemini.code, Some(LocalCliFailureCode::CredentialRejected));
        assert_eq!(
            gemini.message,
            "Antigravity Gemini API authentication failed; check GEMINI_API_KEY."
        );

        let session =
            classify_result_error(&json!({"error":"conversation not found"}), false, true);
        assert_eq!(session.code, Some(LocalCliFailureCode::SessionUnavailable));
        assert_eq!(session.message, "Antigravity session is unavailable.");

        let approval = classify_result_error(&json!({"error":"approval required"}), false, false);
        assert_eq!(
            approval.code,
            Some(LocalCliFailureCode::ProviderApprovalRejected)
        );
        assert_eq!(
            approval.message,
            "Antigravity provider approval rejected the isolated run (permission/approval denied)."
        );

        let isolation = classify_result_error(
            &json!({"error":"attempted an unauthorized native capability"}),
            false,
            false,
        );
        assert_eq!(
            isolation.code,
            Some(LocalCliFailureCode::IsolationViolation)
        );
    }

    #[tokio::test]
    async fn real_fake_process_proves_fresh_and_resume_antigravity_contracts() {
        let resumed_session = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
        for resumed in [false, true] {
            let (root, executable) = compile_contract_cli("success");
            let (channel, mut events) = event_channel();
            let mut request = request();
            request.tools[0].name = CONTRACT_HOST_TOOL.to_string();
            request.native_search = false;
            request.session_id = resumed.then(|| resumed_session.to_string());
            let run_id = format!("antigravity-contract-{resumed}");
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
                        let event = event.expect("Antigravity contract event channel closed");
                        let event_index = recorded.len();
                        if event.get("type").and_then(Value::as_str) == Some("toolRequest") {
                            assert!(host_request_index.replace(event_index).is_none());
                            assert_eq!(event["runId"], run_id);
                            assert_eq!(event["name"], CONTRACT_HOST_TOOL);
                            assert_eq!(event["arguments"]["provider"], "antigravity");
                            bridge.resolve(
                                event["runId"].as_str().unwrap(),
                                event["callId"].as_str().unwrap(),
                                LocalToolResolution {
                                    text: CONTRACT_HOST_RESULT.to_string(),
                                    is_error: Some(false),
                                    structured_content: Some(json!({"provider":"antigravity","resolved":true})),
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
                .expect("missing Antigravity text after Host resolution");
            assert!(text_index > host_request_index);

            let invocation = std::fs::read_to_string(root.join("provider-invocation.log")).unwrap();
            assert!(invocation.contains("\"event\":\"user\""));
            assert!(invocation.contains("Hello"));
            assert!(invocation.contains("args=--print=\u{1f}"));
            assert!(invocation.contains("--input-format\u{1f}stream-json"));
            assert_eq!(invocation.contains("\u{1f}--conversation\u{1f}"), resumed);
            assert!(!invocation.contains("secret-bridge-token"));
            bridge.unregister(&run_id, "Antigravity contract complete");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn independent_runs_prepare_without_a_provider_wide_lock() {
        let (first_root, first_executable) = compile_contract_cli("success-concurrent-first");
        let (second_root, second_executable) = compile_contract_cli("success-concurrent-second");
        let shared_session_dir = first_root.join("shared-session-state");
        std::fs::create_dir(&shared_session_dir).unwrap();

        let (first_channel, _first_events) = event_channel();
        let mut first_request = request();
        first_request.tools.clear();
        first_request.native_search = false;
        first_request.scope.id = "conversation-one".to_string();
        let mut first_context =
            protocol_context(&first_root, first_executable, first_request, first_channel);
        first_context.session_dir = shared_session_dir.clone();

        let (second_channel, _second_events) = event_channel();
        let mut second_request = request();
        second_request.tools.clear();
        second_request.native_search = false;
        second_request.scope.id = "conversation-two".to_string();
        let mut second_context = protocol_context(
            &second_root,
            second_executable,
            second_request,
            second_channel,
        );
        second_context.session_dir = shared_session_dir;

        let first_home = isolated_home(&first_context).unwrap();
        let second_home = isolated_home(&second_context).unwrap();
        let rendezvous = Arc::new(Barrier::new(2));
        let first_rendezvous = rendezvous.clone();
        let second_rendezvous = rendezvous.clone();

        let first_prelaunch = async move {
            first_rendezvous.wait().await;
            prepare_run_files(&first_context, &AntigravityProviderEnvironment::default())
        };
        let second_prelaunch = async move {
            second_rendezvous.wait().await;
            prepare_run_files(&second_context, &AntigravityProviderEnvironment::default())
        };
        let runs = tokio::time::timeout(Duration::from_secs(10), async move {
            tokio::join!(first_prelaunch, second_prelaunch)
        })
        .await
        .expect("independent runs must both reach the prelaunch rendezvous");

        assert!(runs.0.is_ok());
        assert!(runs.1.is_ok());
        assert_ne!(first_home, second_home);
        assert!(first_home
            .join(".gemini/antigravity-cli/settings.json")
            .is_file());
        assert!(second_home
            .join(".gemini/antigravity-cli/settings.json")
            .is_file());

        std::fs::remove_dir_all(first_root).unwrap();
        std::fs::remove_dir_all(second_root).unwrap();
    }

    #[test]
    fn conversation_home_persists_native_state_but_utility_home_is_disposable() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-scope-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let shared_session_dir = root.join("shared-session-state");
        std::fs::create_dir(&shared_session_dir).unwrap();

        let (first_channel, _first_events) = event_channel();
        let first_context = protocol_context(
            &root.join("first"),
            root.join("agy"),
            request(),
            first_channel,
        );
        let mut first_context = first_context;
        first_context.session_dir = shared_session_dir.clone();
        let first_files =
            prepare_run_files(&first_context, &AntigravityProviderEnvironment::default()).unwrap();
        let conversation_state = first_files
            .home
            .join(".gemini/antigravity-cli/conversations/native-session.db");
        ensure_private_directory(conversation_state.parent().unwrap()).unwrap();
        write_private_file(&conversation_state, b"native-session-state").unwrap();

        let (resume_channel, _resume_events) = event_channel();
        let mut resume_request = request();
        resume_request.session_id = Some("c3b66b04-872b-4fbe-a3a4-058a026ef20a".to_string());
        let mut resume_context = protocol_context(
            &root.join("resume"),
            root.join("agy"),
            resume_request,
            resume_channel,
        );
        resume_context.session_dir = shared_session_dir.clone();
        let resume_files =
            prepare_run_files(&resume_context, &AntigravityProviderEnvironment::default()).unwrap();
        assert_eq!(resume_files.home, first_files.home);
        assert_eq!(
            std::fs::read(
                resume_files
                    .home
                    .join(".gemini/antigravity-cli/conversations/native-session.db")
            )
            .unwrap(),
            b"native-session-state"
        );
        assert!(!resume_files
            .home
            .to_string_lossy()
            .contains("test-conversation"));
        assert!(!resume_files.home.join(".gemini/oauth_creds.json").exists());

        let (utility_channel, _utility_events) = event_channel();
        let mut utility_request = request();
        utility_request.scope.kind = LocalAgentRunScopeKind::Utility;
        utility_request.scope.id = "utility-one".to_string();
        utility_request.mode = "auto_qa".to_string();
        let mut utility_context = protocol_context(
            &root.join("utility"),
            root.join("agy"),
            utility_request,
            utility_channel,
        );
        utility_context.session_dir = shared_session_dir;
        let utility_files =
            prepare_run_files(&utility_context, &AntigravityProviderEnvironment::default())
                .unwrap();
        assert_eq!(
            utility_files.home,
            utility_context.run_dir.join("antigravity-home")
        );
        assert_ne!(utility_files.home, resume_files.home);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_config_lives_inside_the_run_directory_and_leaves_with_it() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-agy-lifetime-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let (channel, _events) = event_channel();
        let context = protocol_context(&root, root.join("agy"), request(), channel);

        let files =
            prepare_run_files(&context, &AntigravityProviderEnvironment::default()).unwrap();
        let mcp_config = files.workspace.join(".agents").join("mcp_config.json");

        assert!(files.workspace.starts_with(&context.run_dir));
        assert!(mcp_config.is_file());
        std::fs::remove_dir_all(&context.run_dir).unwrap();
        assert!(!mcp_config.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_rejects_unverified_native_search_inventory() {
        let (root, executable) = compile_contract_cli("unknown");
        let (channel, _events) = event_channel();
        let mut request = request();
        request.tools.clear();
        request.native_search = true;
        let context = protocol_context(&root, executable, request, channel);
        let error = match execute_contract(&context).await {
            Ok(_) => panic!("URL-only Antigravity inventory must fail closed"),
            Err(error) => error,
        };
        assert!(error.message.contains(NATIVE_SEARCH_TOOL), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn real_fake_process_covers_antigravity_failure_contracts() {
        for mode in ["malformed", "oversized", "nonzero", "stderr-approval"] {
            let (root, executable) = compile_contract_cli(mode);
            let (channel, _events) = event_channel();
            let context = protocol_context(&root, executable, request(), channel);
            let error = execute_contract(&context)
                .await
                .expect_err("Antigravity failure fixture must not complete");
            match mode {
                "malformed" => assert!(error.message.contains("malformed stream JSON"), "{error}"),
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
                        || error.message.contains("did not emit init"),
                    "{error}"
                ),
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn response_steps_complete_only_the_last_answer_and_preserve_equal_deltas() {
        let mut state = ResponseSteps::default();
        let step = |index, text, status| json!({"step_update":{"step_index":index,"step_type":"agent_response","state":status,"text_delta":text}});
        assert!(state.accept(&step(1, "Commentary", "DONE")).unwrap());
        assert!(state.accept(&step(3, "好", "ACTIVE")).unwrap());
        assert!(state.accept(&step(3, "好", "ACTIVE")).unwrap());
        let final_step = step(3, "!", "DONE");
        assert!(state.accept(&final_step).unwrap());
        assert!(!state.accept(&final_step).unwrap());
        assert_eq!(state.finish("好好!🦀").unwrap(), "🦀");
        assert!(state.finish("Commentary好好!").is_err());
        assert!(state.accept(&step(3, "changed", "DONE")).is_err());
    }
}
