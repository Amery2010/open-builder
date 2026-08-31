use std::path::Path;
use std::time::Duration;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentModel, LocalAgentStartRequest,
};
use crate::local_agent_adapter::{AdapterIdentity, AdapterProbe};
use crate::local_agent_protocol::{command_output_capped, ProtocolContext, ProtocolOutcome};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const ISOLATION_ERROR: &str = "This Claude CLI cannot prove tool and configuration isolation before receiving user content. Upgrade to a Claude CLI that provides a pre-input structured isolation handshake.";

pub(crate) const IDENTITY: AdapterIdentity = AdapterIdentity {
    command_name: "claude",
    setup_command: "claude auth login",
    capabilities: LocalAgentCapabilities {
        sessions: true,
        reasoning: true,
        tools: true,
        native_search: true,
    },
    probe_timeout: PROBE_TIMEOUT,
    unix_home_directories: &[".claude/local"],
    windows_home_directories: &[],
    windows_local_directories: &["Programs\\Claude"],
    windows_program_directories: &["Claude"],
    require_empty_workspace: false,
};

pub(crate) fn isolation_error() -> String {
    ISOLATION_ERROR.to_string()
}

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
                message: Some(message),
            }
        }
    };
    let version = first_output_line(&version_output);
    let help = match command_output_capped(
        executable,
        &["--help"],
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
    let required = [
        "--input-format",
        "--output-format",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--system-prompt-file",
        "--setting-sources",
        "--permission-mode",
        "--allowedTools",
        "--tools",
        "--resume",
    ];
    let message = if required.iter().any(|flag| !help.contains(flag)) {
        "Claude is missing required structured-agent capabilities.".to_string()
    } else {
        isolation_error()
    };
    AdapterProbe {
        availability: LocalAgentAvailability::Unsupported,
        version,
        models: Vec::new(),
        efforts: Vec::new(),
        message: Some(message),
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

pub(crate) async fn run(_context: ProtocolContext) -> Result<ProtocolOutcome, String> {
    Err(isolation_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remains_fail_closed_without_pre_input_attestation() {
        assert!(isolation_error().contains("pre-input structured isolation handshake"));
    }
}
