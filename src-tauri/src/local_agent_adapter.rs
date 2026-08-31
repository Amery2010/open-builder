use std::path::Path;
use std::time::Duration;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentModel, LocalAgentProvider,
    LocalAgentStartRequest,
};
use crate::local_agent_protocol::{ProtocolContext, ProtocolOutcome};

#[derive(Clone, Copy)]
pub(crate) struct AdapterIdentity {
    pub command_name: &'static str,
    pub setup_command: &'static str,
    pub capabilities: LocalAgentCapabilities,
    pub probe_timeout: Duration,
    #[cfg_attr(windows, allow(dead_code))]
    pub unix_home_directories: &'static [&'static str],
    #[cfg_attr(not(windows), allow(dead_code))]
    pub windows_home_directories: &'static [&'static str],
    #[cfg_attr(not(windows), allow(dead_code))]
    pub windows_local_directories: &'static [&'static str],
    #[cfg_attr(not(windows), allow(dead_code))]
    pub windows_program_directories: &'static [&'static str],
    pub require_empty_workspace: bool,
}

impl AdapterIdentity {
    pub(crate) fn executable_file_name(self, windows: bool) -> String {
        if windows {
            format!("{}.exe", self.command_name)
        } else {
            self.command_name.to_string()
        }
    }

    pub(crate) fn accepts_executable_file_name(self, name: &str, windows: bool) -> bool {
        if windows {
            name.eq_ignore_ascii_case(&self.executable_file_name(true))
        } else {
            name == self.command_name
        }
    }
}

pub(crate) struct AdapterProbe {
    pub availability: LocalAgentAvailability,
    pub version: Option<String>,
    pub models: Vec<LocalAgentModel>,
    pub efforts: Vec<String>,
    pub message: Option<String>,
}

pub(crate) struct AdapterStart {
    pub cli_version: String,
}

pub(crate) fn identity(provider: LocalAgentProvider) -> AdapterIdentity {
    match provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::IDENTITY,
        LocalAgentProvider::Claude => crate::local_agent_claude::IDENTITY,
        LocalAgentProvider::Pi => crate::local_agent_pi::IDENTITY,
    }
}

pub(crate) async fn probe(provider: LocalAgentProvider, executable: &Path) -> AdapterProbe {
    match provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::probe(executable).await,
        LocalAgentProvider::Claude => crate::local_agent_claude::probe(executable).await,
        LocalAgentProvider::Pi => crate::local_agent_pi::probe(executable).await,
    }
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), String> {
    match request.provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::validate_request(request),
        LocalAgentProvider::Claude => crate::local_agent_claude::validate_request(request),
        LocalAgentProvider::Pi => crate::local_agent_pi::validate_request(request),
    }
}

fn prepare_request(
    request: &mut LocalAgentStartRequest,
    models: &[LocalAgentModel],
) -> Result<(), String> {
    match request.provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::prepare_request(request, models),
        LocalAgentProvider::Claude => crate::local_agent_claude::prepare_request(request, models),
        LocalAgentProvider::Pi => crate::local_agent_pi::prepare_request(request, models),
    }
}

fn validate_preferences(
    request: &LocalAgentStartRequest,
    probe: &AdapterProbe,
) -> Result<(), String> {
    let selected_model = request.model.as_deref().filter(|value| !value.is_empty());
    let model = selected_model
        .map(|id| {
            probe
                .models
                .iter()
                .find(|model| model.id == id)
                .ok_or_else(|| "the selected model is not reported by the local CLI".to_string())
        })
        .transpose()?;
    if let Some(effort) = request.effort.as_deref().filter(|value| !value.is_empty()) {
        let supported = model
            .or_else(|| probe.models.iter().find(|model| model.is_default))
            .map(|model| model.efforts.as_slice())
            .unwrap_or(probe.efforts.as_slice());
        if !supported.iter().any(|supported| supported == effort) {
            return Err(
                "the selected reasoning effort is not reported by the local CLI".to_string(),
            );
        }
    }
    Ok(())
}

pub(crate) async fn prepare_start(
    executable: &Path,
    request: &mut LocalAgentStartRequest,
) -> Result<AdapterStart, String> {
    if request.provider == LocalAgentProvider::Pi {
        return crate::local_agent_pi::preflight(executable)
            .await
            .map(|cli_version| AdapterStart { cli_version });
    }

    let probe = probe(request.provider, executable).await;
    if probe.availability != LocalAgentAvailability::Ready {
        return Err(probe.message.unwrap_or_else(|| match probe.availability {
            LocalAgentAvailability::NeedsSetup => format!(
                "{} needs setup; run {}",
                identity(request.provider).command_name,
                identity(request.provider).setup_command
            ),
            LocalAgentAvailability::Unsupported => {
                "the installed local CLI is unsupported".to_string()
            }
            _ => "the local CLI is unavailable".to_string(),
        }));
    }
    prepare_request(request, &probe.models)?;
    validate_preferences(request, &probe)?;
    Ok(AdapterStart {
        cli_version: probe.version.unwrap_or_else(|| "unknown".to_string()),
    })
}

pub(crate) async fn run(context: ProtocolContext) -> Result<ProtocolOutcome, String> {
    match context.request.provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::run(context).await,
        LocalAgentProvider::Claude => crate::local_agent_claude::run(context).await,
        LocalAgentProvider::Pi => crate::local_agent_pi::run(context).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_preferences_against_probe_models() {
        let request = LocalAgentStartRequest {
            provider: LocalAgentProvider::Codex,
            model: Some("codex-model".to_string()),
            effort: Some("high".to_string()),
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: None,
            session_id: None,
            tools: Vec::new(),
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        };
        let probe = AdapterProbe {
            availability: LocalAgentAvailability::Ready,
            version: Some("1".to_string()),
            models: vec![LocalAgentModel {
                id: "codex-model".to_string(),
                display_name: "Codex".to_string(),
                is_default: true,
                default_effort: Some("medium".to_string()),
                efforts: vec!["medium".to_string(), "high".to_string()],
            }],
            efforts: Vec::new(),
            message: None,
        };
        assert!(validate_preferences(&request, &probe).is_ok());

        let mut invalid = request;
        invalid.effort = Some("unsupported".to_string());
        assert!(validate_preferences(&invalid, &probe).is_err());
    }
}
