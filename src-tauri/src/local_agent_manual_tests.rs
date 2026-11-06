//! Explicit real-account acceptance. Kept ignored during ordinary test runs.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::ipc::InvokeResponseBody;
use tokio_util::sync::CancellationToken;

use crate::local_agent::{LocalAgentEvent, LocalAgentProvider, LocalAgentStartRequest};
use crate::local_agent_adapter::{prepare_run, PreparedRunResources};
use crate::local_agent_bridge::ToolBridge;
use crate::local_agent_models::ModelStrategy;

struct StopRunResources {
    root: PathBuf,
    bridge: ToolBridge,
    cancellation: CancellationToken,
}

impl Drop for StopRunResources {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.bridge.shutdown_now();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct ObservedOutput {
    text: bool,
    reasoning: bool,
    stopped_at: Option<Instant>,
}

#[tokio::test]
#[ignore = "explicitly sends a real model request, cancelling on the first readable output"]
async fn manual_real_cli_stop_during_output() {
    let provider_name = std::env::var("OPEN_BUILDER_MANUAL_CLI_PROVIDER")
        .expect("set OPEN_BUILDER_MANUAL_CLI_PROVIDER");
    let provider: LocalAgentProvider = serde_json::from_value(json!(provider_name)).unwrap();
    let executable = PathBuf::from(
        std::env::var("OPEN_BUILDER_MANUAL_CLI_EXECUTABLE")
            .expect("set OPEN_BUILDER_MANUAL_CLI_EXECUTABLE"),
    );
    let resources = StopRunResources {
        root: std::env::temp_dir()
            .join(format!("open-builder-manual-stop-{}", uuid::Uuid::new_v4())),
        bridge: ToolBridge::default(),
        cancellation: CancellationToken::new(),
    };
    let run_dir = resources.root.join("run");
    let session_dir = resources.root.join("sessions");
    let workspace_dir = resources.root.join("workspace");
    for directory in [&run_dir, &session_dir, &workspace_dir] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let observed = Arc::new(Mutex::new(ObservedOutput::default()));
    let observer = observed.clone();
    let cancellation = resources.cancellation.clone();
    let channel = tauri::ipc::Channel::<LocalAgentEvent>::new(move |body| {
        if let InvokeResponseBody::Json(encoded) = body {
            let event: serde_json::Value = serde_json::from_str(&encoded).unwrap();
            if event
                .get("delta")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|delta| !delta.trim().is_empty())
            {
                let kind = event.get("type").and_then(serde_json::Value::as_str);
                if matches!(kind, Some("textDelta" | "reasoningDelta")) {
                    let mut state = observer.lock().unwrap();
                    state.text |= kind == Some("textDelta");
                    state.reasoning |= kind == Some("reasoningDelta");
                    state.stopped_at.get_or_insert_with(Instant::now);
                    cancellation.cancel();
                }
            }
        }
        Ok(())
    });
    let run_id = format!("manual-stop-{}", uuid::Uuid::new_v4());
    let (bridge_url, bridge_token) = resources
        .bridge
        .register(
            run_id.clone(),
            Vec::new(),
            0,
            resources.cancellation.clone(),
            channel.clone().into(),
        )
        .await
        .unwrap();
    let request: LocalAgentStartRequest = serde_json::from_value(json!({
        "provider": provider,
        "model": std::env::var("OPEN_BUILDER_MANUAL_CLI_MODEL").ok(),
        "effort": std::env::var("OPEN_BUILDER_MANUAL_CLI_EFFORT").ok(),
        "systemPrompt": "You are testing event streaming. Answer directly without calling any tools.",
        "prompt": "Explain event streaming and cancellation in five short paragraphs.",
        "scope": {"kind":"utility", "id":run_id},
        "tools": [], "nativeSearch":false, "maxToolCalls":0, "mode":"chat"
    })).unwrap();
    let prepared = prepare_run(
        executable,
        request,
        &ModelStrategy::default(),
        PreparedRunResources {
            run_dir,
            session_dir,
            workspace_dir: workspace_dir.clone(),
            bridge_url,
            bridge_token,
            cancellation: resources.cancellation.clone(),
            channel: channel.into(),
        },
    )
    .await
    .expect("the real local CLI must prepare");
    let output_capabilities = prepared.output_capabilities();
    let outcome = tokio::time::timeout(Duration::from_secs(180), prepared.launch())
        .await
        .expect("the explicit acceptance request must finish or stop within its test deadline")
        .expect("the real CLI must propagate the requested cancellation");
    resources
        .bridge
        .unregister(&run_id, "manual cancellation acceptance finished");
    let state = observed.lock().unwrap();
    assert!(
        state.text || state.reasoning,
        "cancellation must follow readable output"
    );
    assert!(
        outcome.aborted,
        "Stop must remain distinguishable from normal completion"
    );
    assert!(std::fs::read_dir(&workspace_dir).unwrap().next().is_none());
    println!(
        "manual CLI stop {}",
        json!({
            "provider":provider, "outputCapabilities":output_capabilities,
            "textReceived":state.text, "reasoningReceived":state.reasoning,
            "stopCleanupMs":state.stopped_at.unwrap().elapsed().as_millis(), "aborted":outcome.aborted,
        })
    );
}
