use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::local_agent::{
    LocalAgentAvailability, LocalAgentCapabilities, LocalAgentModel, LocalAgentPreference,
    LocalAgentPreferenceDecision, LocalAgentProvider, LocalAgentStartRequest,
};
use crate::local_agent_bridge::canonical_tool_digest;
use crate::local_agent_models::{
    CatalogAuthority, ClaudeGatewayCatalog, LaunchValidation, ModelCandidate, ModelPreference,
    ModelResolutionRequest, ModelStrategy, PreferenceDecision,
};
use crate::local_agent_protocol::{ProtocolContext, ProtocolOutcome};
use crate::local_agent_runtime::{
    compatibility_key, AdapterError, CompatibilityKeyMaterial, InstallationIdentity,
};

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
    pub catalog_authority: CatalogAuthority,
    pub verification_required: bool,
    pub message: Option<String>,
}

pub(crate) struct PreparedCliRun {
    installation: InstallationIdentity,
    provider_run: PreparedProviderRun,
    cli_version: String,
    warning: Option<String>,
    compatibility_key: String,
    configuration_fingerprint: String,
    actual_model: Option<String>,
    actual_effort: Option<String>,
    resumed: bool,
    session_id: Option<String>,
}

pub(crate) struct PreparedRunResources {
    pub run_dir: PathBuf,
    pub session_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub bridge_url: String,
    pub bridge_token: String,
    pub cancellation: tokio_util::sync::CancellationToken,
    pub channel: crate::local_agent::TrackedChannel,
}

enum PreparedProviderRun {
    Codex(crate::local_agent_codex::PreparedCodexRun),
    Claude(crate::local_agent_claude::PreparedClaudeRun),
    Pi(crate::local_agent_pi::PreparedPiRun),
    Antigravity(crate::local_agent_antigravity::PreparedAntigravityRun),
}

impl PreparedProviderRun {
    fn configuration_fingerprint(&self) -> &str {
        match self {
            Self::Codex(prepared) => prepared.configuration_fingerprint(),
            Self::Claude(prepared) => prepared.configuration_fingerprint(),
            Self::Pi(prepared) => prepared.configuration_fingerprint(),
            Self::Antigravity(prepared) => prepared.configuration_fingerprint(),
        }
    }

    async fn launch(self) -> Result<ProtocolOutcome, AdapterError> {
        match self {
            Self::Codex(prepared) => crate::local_agent_codex::launch_prepared(prepared).await,
            Self::Claude(prepared) => crate::local_agent_claude::launch_prepared(prepared).await,
            Self::Pi(prepared) => crate::local_agent_pi::launch_prepared(prepared).await,
            Self::Antigravity(prepared) => {
                crate::local_agent_antigravity::launch_prepared(prepared).await
            }
        }
    }
}

impl PreparedCliRun {
    pub(crate) fn cli_version(&self) -> &str {
        &self.cli_version
    }

    pub(crate) fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    pub(crate) fn compatibility_key(&self) -> &str {
        &self.compatibility_key
    }

    pub(crate) fn installation_fingerprint(&self) -> &str {
        self.installation.fingerprint()
    }

    pub(crate) fn actual_model(&self) -> Option<&str> {
        self.actual_model.as_deref()
    }

    pub(crate) fn actual_effort(&self) -> Option<&str> {
        self.actual_effort.as_deref()
    }

    pub(crate) fn resumed(&self) -> bool {
        self.resumed
    }

    pub(crate) fn session_id(&self) -> Option<String> {
        self.session_id.clone()
    }

    pub(crate) async fn launch(self) -> Result<ProtocolOutcome, AdapterError> {
        self.installation.verify_unchanged()?;
        let current_configuration = provider_configuration_fingerprint(self.provider())?;
        if current_configuration != self.configuration_fingerprint {
            return Err("local CLI configuration changed during preparation".into());
        }
        self.provider_run.launch().await
    }

    fn provider(&self) -> LocalAgentProvider {
        match &self.provider_run {
            PreparedProviderRun::Codex(_) => LocalAgentProvider::Codex,
            PreparedProviderRun::Claude(_) => LocalAgentProvider::Claude,
            PreparedProviderRun::Pi(_) => LocalAgentProvider::Pi,
            PreparedProviderRun::Antigravity(_) => LocalAgentProvider::Antigravity,
        }
    }
}

pub(crate) struct ResolvedAdapterProbe {
    pub probe: AdapterProbe,
    pub preference_decision: LocalAgentPreferenceDecision,
    pub launch_validation: LaunchValidation,
}

fn protocol_version(provider: LocalAgentProvider) -> &'static str {
    match provider {
        LocalAgentProvider::Codex => "codex-exec-json-v2",
        LocalAgentProvider::Claude => "claude-stream-json-v2",
        LocalAgentProvider::Pi => "pi-rpc-v2",
        LocalAgentProvider::Antigravity => "antigravity-stream-json-v2",
    }
}

fn provider_configuration_fingerprint(provider: LocalAgentProvider) -> Result<String, String> {
    match provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::configuration_fingerprint(),
        LocalAgentProvider::Claude => crate::local_agent_claude::configuration_fingerprint(),
        LocalAgentProvider::Pi => crate::local_agent_pi::configuration_fingerprint(),
        LocalAgentProvider::Antigravity => {
            crate::local_agent_antigravity::configuration_fingerprint()
        }
    }
}

fn apply_session_compatibility(request: &mut LocalAgentStartRequest, key: &str) -> bool {
    let resumed =
        request.session_id.is_some() && request.session_compatibility_key.as_deref() == Some(key);
    if resumed {
        request.bootstrap_context = None;
    } else {
        request.session_id = None;
        request.session_compatibility_key = None;
    }
    resumed
}

pub(crate) fn identity(provider: LocalAgentProvider) -> AdapterIdentity {
    match provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::IDENTITY,
        LocalAgentProvider::Claude => crate::local_agent_claude::IDENTITY,
        LocalAgentProvider::Pi => crate::local_agent_pi::IDENTITY,
        LocalAgentProvider::Antigravity => crate::local_agent_antigravity::IDENTITY,
    }
}

async fn provider_probe(provider: LocalAgentProvider, executable: &Path) -> AdapterProbe {
    match provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::probe(executable).await,
        LocalAgentProvider::Claude => crate::local_agent_claude::probe(executable).await,
        LocalAgentProvider::Pi => crate::local_agent_pi::probe(executable).await,
        LocalAgentProvider::Antigravity => crate::local_agent_antigravity::probe(executable).await,
    }
}

fn strategy_preference(preference: &LocalAgentPreference) -> ModelPreference {
    ModelPreference {
        model: (!preference.model.is_empty()).then(|| preference.model.clone()),
        effort: (!preference.effort.is_empty()).then(|| preference.effort.clone()),
    }
}

fn wire_decision(decision: PreferenceDecision) -> LocalAgentPreferenceDecision {
    match decision {
        PreferenceDecision::Keep { unverified } => {
            LocalAgentPreferenceDecision::Keep { unverified }
        }
        PreferenceDecision::Replace { preference } => LocalAgentPreferenceDecision::Replace {
            preference: LocalAgentPreference {
                model: preference.model.unwrap_or_default(),
                effort: preference.effort.unwrap_or_default(),
            },
        },
    }
}

struct ModelContext {
    candidates: Vec<ModelCandidate>,
    authority: CatalogAuthority,
    configured: ModelPreference,
    gateway: Option<ClaudeGatewayCatalog>,
}

fn provider_model_context(
    provider: LocalAgentProvider,
    models: Vec<LocalAgentModel>,
    catalog_authority: CatalogAuthority,
) -> Result<ModelContext, String> {
    match provider {
        LocalAgentProvider::Codex => {
            let (candidates, configured) = crate::local_agent_codex::model_catalog_context(models)?;
            Ok(ModelContext {
                candidates,
                authority: catalog_authority,
                configured,
                gateway: None,
            })
        }
        LocalAgentProvider::Claude => {
            let (candidates, configured, gateway) =
                crate::local_agent_claude::model_catalog_context()?;
            Ok(ModelContext {
                candidates,
                authority: catalog_authority,
                configured,
                gateway,
            })
        }
        LocalAgentProvider::Pi | LocalAgentProvider::Antigravity => {
            let candidates = models
                .into_iter()
                .map(|model| {
                    let efforts = model.efforts.clone();
                    ModelCandidate::known(model, efforts)
                })
                .collect();
            Ok(ModelContext {
                candidates,
                authority: catalog_authority,
                configured: ModelPreference::default(),
                gateway: None,
            })
        }
    }
}

fn combine_messages(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) if left == right => Some(left),
        (Some(left), Some(right)) => Some(format!("{left} {right}")),
        (Some(message), None) | (None, Some(message)) => Some(message),
        (None, None) => None,
    }
}

pub(crate) async fn probe(
    provider: LocalAgentProvider,
    executable: &Path,
    strategy: &ModelStrategy,
    preference: LocalAgentPreference,
    force_refresh: bool,
) -> ResolvedAdapterProbe {
    let mut probe = provider_probe(provider, executable).await;
    if !matches!(
        probe.availability,
        LocalAgentAvailability::Ready | LocalAgentAvailability::NeedsSetup
    ) {
        let message = probe
            .message
            .clone()
            .unwrap_or_else(|| "the local CLI is unavailable".to_string());
        return ResolvedAdapterProbe {
            probe,
            preference_decision: LocalAgentPreferenceDecision::default(),
            launch_validation: LaunchValidation::Rejected { message },
        };
    }

    let catalog_authority = probe.catalog_authority;
    let model_context = match provider_model_context(
        provider,
        std::mem::take(&mut probe.models),
        catalog_authority,
    ) {
        Ok(context) => context,
        Err(message) => {
            probe.availability = LocalAgentAvailability::Error;
            probe.efforts.clear();
            probe.message = Some(message.clone());
            return ResolvedAdapterProbe {
                probe,
                preference_decision: LocalAgentPreferenceDecision::default(),
                launch_validation: LaunchValidation::Rejected { message },
            };
        }
    };
    let resolution = strategy
        .resolve(ModelResolutionRequest {
            provider,
            candidates: model_context.candidates,
            authority: model_context.authority,
            preference: strategy_preference(&preference),
            configured: model_context.configured,
            gateway: model_context.gateway,
            force_refresh,
        })
        .await;
    probe.models = resolution.models;
    if !probe.models.is_empty() || !resolution.efforts.is_empty() {
        probe.efforts = resolution.efforts;
    }
    probe.message = combine_messages(probe.message, resolution.warning);
    ResolvedAdapterProbe {
        probe,
        preference_decision: wire_decision(resolution.preference_decision),
        launch_validation: resolution.launch_validation,
    }
}

pub(crate) fn validate_request(request: &LocalAgentStartRequest) -> Result<(), AdapterError> {
    Ok(match request.provider {
        LocalAgentProvider::Codex => crate::local_agent_codex::validate_request(request),
        LocalAgentProvider::Claude => crate::local_agent_claude::validate_request(request),
        LocalAgentProvider::Pi => crate::local_agent_pi::validate_request(request),
        LocalAgentProvider::Antigravity => {
            crate::local_agent_antigravity::validate_request(request)
        }
    }?)
}

pub(crate) async fn prepare_run(
    executable: PathBuf,
    mut request: LocalAgentStartRequest,
    strategy: &ModelStrategy,
    resources: PreparedRunResources,
) -> Result<PreparedCliRun, AdapterError> {
    let installation = InstallationIdentity::capture(&executable)?;
    let preference = LocalAgentPreference {
        model: request.model.clone().unwrap_or_default(),
        effort: request.effort.clone().unwrap_or_default(),
    };
    let resolved = probe(
        request.provider,
        installation.canonical_path(),
        strategy,
        preference,
        false,
    )
    .await;
    let probe = resolved.probe;
    if probe.availability != LocalAgentAvailability::Ready {
        let message = probe
            .message
            .unwrap_or_else(|| "the local CLI did not provide a setup diagnostic".to_string());
        return Err(match probe.availability {
            LocalAgentAvailability::NeedsSetup => format!(
                "{} needs setup; {message}; run {}",
                identity(request.provider).command_name,
                identity(request.provider).setup_command
            ),
            LocalAgentAvailability::Unsupported => {
                format!("the installed local CLI is unsupported: {message}")
            }
            _ => format!("the local CLI is unavailable: {message}"),
        }
        .into());
    }
    let actual = match resolved.launch_validation {
        LaunchValidation::Allowed {
            preference: _,
            actual,
            ..
        } => {
            // Pin the same resolved selection used by the compatibility key.
            // This prevents a provider default from drifting between probe and
            // launch while preserving an empty UI preference between runs.
            request.model = actual.model.clone();
            request.effort = actual.effort.clone();
            actual
        }
        LaunchValidation::Rejected { message } => return Err(message.into()),
    };
    installation.verify_unchanged()?;
    let configuration_fingerprint = provider_configuration_fingerprint(request.provider)?;
    let tool_digest = canonical_tool_digest(&request.tools)?;
    let compatibility_key = compatibility_key(CompatibilityKeyMaterial {
        provider: request.provider,
        protocol_version: protocol_version(request.provider),
        installation_fingerprint: installation.fingerprint(),
        configuration_fingerprint: &configuration_fingerprint,
        model: actual.model.as_deref(),
        effort: actual.effort.as_deref(),
        mode: &request.mode,
        tool_digest: &tool_digest,
    });
    let resumed = apply_session_compatibility(&mut request, &compatibility_key);
    let session_id = request.session_id.clone();
    let provider_run = prepare_provider_run(ProtocolContext {
        executable: installation.canonical_path().to_path_buf(),
        request,
        run_dir: resources.run_dir,
        session_dir: resources.session_dir,
        workspace_dir: resources.workspace_dir,
        bridge_url: resources.bridge_url,
        bridge_token: resources.bridge_token,
        cancellation: resources.cancellation,
        channel: resources.channel,
        cli_version: probe
            .version
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
    })?;
    if provider_run.configuration_fingerprint() != configuration_fingerprint {
        return Err("local CLI configuration changed during preparation".into());
    }
    installation.verify_unchanged()?;
    Ok(PreparedCliRun {
        installation,
        provider_run,
        cli_version: probe.version.unwrap_or_else(|| "unknown".to_string()),
        warning: probe.message,
        compatibility_key,
        configuration_fingerprint,
        actual_model: actual.model,
        actual_effort: actual.effort,
        resumed,
        session_id,
    })
}

fn prepare_provider_run(context: ProtocolContext) -> Result<PreparedProviderRun, AdapterError> {
    match context.request.provider {
        LocalAgentProvider::Codex => {
            crate::local_agent_codex::prepare_run(context).map(PreparedProviderRun::Codex)
        }
        LocalAgentProvider::Claude => {
            crate::local_agent_claude::prepare_run(context).map(PreparedProviderRun::Claude)
        }
        LocalAgentProvider::Pi => {
            crate::local_agent_pi::prepare_run(context).map(PreparedProviderRun::Pi)
        }
        LocalAgentProvider::Antigravity => crate::local_agent_antigravity::prepare_run(context)
            .map(PreparedProviderRun::Antigravity),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_agent::{
        LocalAgentRunScope, LocalAgentRunScopeKind, LocalToolAnnotations, LocalToolHostApproval,
        LocalToolResolution, LocalToolSpec,
    };
    use crate::local_agent_bridge::ToolBridge;
    use tauri::ipc::InvokeResponseBody;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn maps_strategy_replacements_to_the_wire_contract() {
        assert_eq!(
            wire_decision(PreferenceDecision::Replace {
                preference: ModelPreference {
                    model: Some("model".to_string()),
                    effort: None,
                },
            }),
            LocalAgentPreferenceDecision::Replace {
                preference: LocalAgentPreference {
                    model: "model".to_string(),
                    effort: String::new(),
                },
            }
        );
    }

    fn request() -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider: LocalAgentProvider::Codex,
            model: Some("gpt-test".to_string()),
            effort: Some("high".to_string()),
            system_prompt: "system".to_string(),
            prompt: "prompt".to_string(),
            bootstrap_context: Some("history".to_string()),
            session_id: Some("thread-existing".to_string()),
            session_compatibility_key: None,
            scope: LocalAgentRunScope {
                kind: LocalAgentRunScopeKind::Conversation,
                id: "conversation-test".to_string(),
            },
            tools: Vec::<LocalToolSpec>::new(),
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        }
    }

    #[test]
    fn legacy_or_incompatible_sessions_are_lazily_reseeded() {
        let mut legacy = request();
        assert!(!apply_session_compatibility(&mut legacy, "new-key"));
        assert!(legacy.session_id.is_none());
        assert_eq!(legacy.bootstrap_context.as_deref(), Some("history"));

        let mut compatible = request();
        compatible.session_compatibility_key = Some("new-key".to_string());
        assert!(apply_session_compatibility(&mut compatible, "new-key"));
        assert_eq!(compatible.session_id.as_deref(), Some("thread-existing"));
        assert!(compatible.bootstrap_context.is_none());
    }

    fn manual_provider(value: &str) -> LocalAgentProvider {
        match value {
            "codex" => LocalAgentProvider::Codex,
            "claude" => LocalAgentProvider::Claude,
            "pi" => LocalAgentProvider::Pi,
            "antigravity" => LocalAgentProvider::Antigravity,
            _ => panic!("OPEN_BUILDER_MANUAL_CLI_PROVIDER must name a supported provider"),
        }
    }

    fn manual_request(
        provider: LocalAgentProvider,
        prompt: &str,
        session_id: Option<String>,
        session_compatibility_key: Option<String>,
    ) -> LocalAgentStartRequest {
        LocalAgentStartRequest {
            provider,
            model: std::env::var("OPEN_BUILDER_MANUAL_CLI_MODEL")
                .ok()
                .filter(|value| !value.is_empty()),
            effort: std::env::var("OPEN_BUILDER_MANUAL_CLI_EFFORT")
                .ok()
                .filter(|value| !value.is_empty()),
            system_prompt: "You are a local CLI protocol smoke-test assistant. Call the provided host_write_probe tool exactly once, then reply only with the requested token.".to_string(),
            prompt: prompt.to_string(),
            bootstrap_context: None,
            session_id,
            session_compatibility_key,
            scope: LocalAgentRunScope {
                kind: LocalAgentRunScopeKind::Conversation,
                id: "manual-smoke-conversation".to_string(),
            },
            tools: vec![LocalToolSpec {
                name: "host_write_probe".to_string(),
                description: "Ask the Open Builder Host to write one marker in the isolated smoke-test directory.".to_string(),
                input_schema: serde_json::json!({
                    "type":"object",
                    "properties":{"token":{"type":"string"}},
                    "required":["token"],
                    "additionalProperties":false
                }),
                annotations: LocalToolAnnotations {
                    read_only_hint: Some(false),
                    destructive_hint: Some(false),
                    idempotent_hint: Some(true),
                    open_world_hint: Some(false),
                },
                host_approval: LocalToolHostApproval::PerCall,
            }],
            max_tool_calls: 1,
            native_search: false,
            mode: "chat".to_string(),
        }
    }

    fn manual_channel() -> (
        tauri::ipc::Channel<crate::local_agent::LocalAgentEvent>,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str(&json) {
                    let _ = sender.send(event);
                }
            }
            Ok(())
        });
        (channel, receiver)
    }

    fn manual_text(events: &[serde_json::Value]) -> String {
        events
            .iter()
            .filter(|event| {
                event.get("type").and_then(serde_json::Value::as_str) == Some("textDelta")
            })
            .filter_map(|event| event.get("delta").and_then(serde_json::Value::as_str))
            .collect()
    }

    struct ManualSmokeRoot(PathBuf);

    impl Drop for ManualSmokeRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn manual_turn(
        bridge: &ToolBridge,
        strategy: &ModelStrategy,
        executable: &Path,
        root: &Path,
        turn: usize,
        request: LocalAgentStartRequest,
    ) -> (ProtocolOutcome, String, Vec<serde_json::Value>, bool) {
        let run_id = format!("manual-smoke-{}", uuid::Uuid::new_v4());
        let cancellation = CancellationToken::new();
        let (channel, mut event_receiver) = manual_channel();
        let (bridge_url, bridge_token) = bridge
            .register(
                run_id.clone(),
                request.tools.clone(),
                1,
                cancellation.clone(),
                channel.clone().into(),
            )
            .await
            .expect("the manual smoke bridge must start");
        let run_dir = root.join(format!("run-{turn}"));
        let session_dir = root.join("sessions");
        let workspace_dir = root.join(format!("workspace-{turn}"));
        for directory in [&run_dir, &session_dir, &workspace_dir] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let prepared = prepare_run(
            executable.to_path_buf(),
            request,
            strategy,
            PreparedRunResources {
                run_dir,
                session_dir,
                workspace_dir,
                bridge_url,
                bridge_token,
                cancellation,
                channel: channel.into(),
            },
        )
        .await
        .expect("the real local CLI must prepare");
        let compatibility_key = prepared.compatibility_key().to_string();
        let resumed = prepared.resumed();
        let marker = root.join(format!("host-write-probe-{turn}.txt"));
        let mut launch = Box::pin(prepared.launch());
        let mut captured_events = Vec::new();
        let outcome = loop {
            tokio::select! {
                result = &mut launch => break result.expect("the real local CLI turn must complete"),
                event = event_receiver.recv() => {
                    let event = event.expect("manual CLI event channel closed early");
                    if event.get("type").and_then(serde_json::Value::as_str) == Some("toolRequest") {
                        assert_eq!(event.get("name").and_then(serde_json::Value::as_str), Some("host_write_probe"));
                        std::fs::write(&marker, b"host-authorized").unwrap();
                        bridge.resolve(
                            event.get("runId").and_then(serde_json::Value::as_str).unwrap(),
                            event.get("callId").and_then(serde_json::Value::as_str).unwrap(),
                            LocalToolResolution {
                                text: "Host write probe completed.".to_string(),
                                is_error: Some(false),
                                structured_content: Some(serde_json::json!({"written":true})),
                                content: None,
                            },
                        ).unwrap();
                    }
                    captured_events.push(event);
                }
            }
        };
        while let Ok(event) = event_receiver.try_recv() {
            captured_events.push(event);
        }
        bridge.unregister(&run_id, "manual smoke turn completed");
        assert!(
            marker.is_file(),
            "the provider did not call host_write_probe: {captured_events:?}"
        );
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "host-authorized");
        (outcome, compatibility_key, captured_events, resumed)
    }

    #[tokio::test]
    #[ignore = "explicitly sends two small requests through a locally signed-in model CLI"]
    async fn manual_real_cli_fresh_and_resume() {
        let provider_name = std::env::var("OPEN_BUILDER_MANUAL_CLI_PROVIDER")
            .expect("set OPEN_BUILDER_MANUAL_CLI_PROVIDER");
        let executable = PathBuf::from(
            std::env::var("OPEN_BUILDER_MANUAL_CLI_EXECUTABLE")
                .expect("set OPEN_BUILDER_MANUAL_CLI_EXECUTABLE"),
        );
        let provider = manual_provider(&provider_name);
        let root = ManualSmokeRoot(std::env::temp_dir().join(format!(
            "open-builder-manual-cli-smoke-{}",
            uuid::Uuid::new_v4()
        )));
        std::fs::create_dir_all(&root.0).unwrap();
        let bridge = ToolBridge::default();
        let strategy = ModelStrategy::default();

        let (fresh, compatibility_key, first_events, fresh_resumed) = manual_turn(
            &bridge,
            &strategy,
            &executable,
            &root.0,
            1,
            manual_request(
                provider,
                "Call host_write_probe exactly once with token OPEN_BUILDER_SMOKE_1. After the Host result arrives, reply exactly: OPEN_BUILDER_SMOKE_1",
                None,
                None,
            ),
        )
        .await;
        assert!(!fresh.aborted);
        assert!(!fresh_resumed);
        let session_id = fresh
            .session_id
            .expect("fresh run must return a session id");
        let first_text = manual_text(&first_events);
        assert!(!first_text.trim().is_empty(), "fresh run must stream text");

        let (resumed, resumed_key, second_events, did_resume) = manual_turn(
            &bridge,
            &strategy,
            &executable,
            &root.0,
            2,
            manual_request(
                provider,
                "Call host_write_probe exactly once with token OPEN_BUILDER_SMOKE_2. After the Host result arrives, reply exactly: OPEN_BUILDER_SMOKE_2",
                Some(session_id.clone()),
                Some(compatibility_key.clone()),
            ),
        )
        .await;
        assert!(!resumed.aborted);
        assert!(
            did_resume,
            "the second prepared run must accept the compatibility key"
        );
        assert_eq!(resumed_key, compatibility_key);
        assert_eq!(resumed.session_id.as_deref(), Some(session_id.as_str()));
        let second_text = manual_text(&second_events);
        assert!(
            !second_text.trim().is_empty(),
            "resumed run must stream text"
        );
        for turn in [1, 2] {
            assert!(
                std::fs::read_dir(root.0.join(format!("workspace-{turn}")))
                    .unwrap()
                    .next()
                    .is_none(),
                "the real CLI wrote into the private blank workspace"
            );
        }

        println!(
            "manual {provider_name} smoke passed: fresh={:?}, resumed={:?}",
            first_text.trim(),
            second_text.trim()
        );
        bridge.shutdown_now();
    }
}
