//! Same-process WebView recovery. Provider work outlives a page, but Host
//! execution belongs to one leased page and is never replayed after dispatch.
use crate::local_agent::{
    LocalAgentEvent, LocalAgentStartRequest, LocalAgentState, LocalToolResolution,
};
use crate::local_agent_runtime::RunCancellation;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRegistration {
    pub owner: String,
    pub context: serde_json::Value,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryLease {
    pub owner: String,
    pub epoch: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEnvelope {
    pub run_id: String,
    pub sequence: u64,
    pub event: LocalAgentEvent,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub run_id: String,
    pub request: LocalAgentStartRequest,
    pub context: serde_json::Value,
    pub terminal: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    #[serde(flatten)]
    pub summary: RecoverySummary,
    pub lease: RecoveryLease,
    pub events: Vec<RecoveryEnvelope>,
    pub resolutions: HashMap<String, LocalToolResolution>,
    pub uncertain: bool,
    pub stale_call_ids: Vec<String>,
}
#[derive(Clone)]
enum ToolState {
    Queued,
    Claimed(u64),
    Resolved(LocalToolResolution),
}
#[derive(Default)]
struct ToolLedger {
    calls: HashMap<String, ToolState>,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ToolClaim {
    Execute,
    Resolved { resolution: LocalToolResolution },
}
impl ToolLedger {
    fn queued(&mut self, id: &str) {
        self.calls.entry(id.into()).or_insert(ToolState::Queued);
    }
    fn claim(&mut self, id: &str, epoch: u64) -> Result<ToolClaim, String> {
        match self.calls.get_mut(id) {
            Some(state @ ToolState::Queued) => {
                *state = ToolState::Claimed(epoch);
                Ok(ToolClaim::Execute)
            }
            Some(ToolState::Resolved(resolution)) => Ok(ToolClaim::Resolved {
                resolution: resolution.clone(),
            }),
            Some(ToolState::Claimed(_)) => Err(
                "This Host call was already dispatched; its outcome must not be replayed.".into(),
            ),
            None => Err("The Host call is not queued for this run.".into()),
        }
    }
    fn has_uncertain(&self, epoch: u64) -> bool {
        self.calls
            .values()
            .any(|state| matches!(state, ToolState::Claimed(owner) if *owner != epoch))
    }
    fn resolved(&mut self, id: &str, resolution: LocalToolResolution) {
        self.calls
            .insert(id.into(), ToolState::Resolved(resolution));
    }
}
enum Subscriber {
    Initial(tauri::ipc::Channel<LocalAgentEvent>),
    Recovered(tauri::ipc::Channel<RecoveryEnvelope>),
}
pub(crate) struct RecoverableRun {
    summary: RecoverySummary,
    lease: RecoveryLease,
    events: Vec<RecoveryEnvelope>,
    tools: ToolLedger,
    subscriber: Option<Subscriber>,
    cancellation: RunCancellation,
    authority_cutoff: u64,
}
pub(crate) type RecoveryRun = Arc<Mutex<RecoverableRun>>;
impl RecoverableRun {
    pub(crate) fn new(
        run_id: String,
        request: LocalAgentStartRequest,
        registration: RecoveryRegistration,
        channel: tauri::ipc::Channel<LocalAgentEvent>,
        cancellation: RunCancellation,
    ) -> RecoveryRun {
        Arc::new(Mutex::new(Self {
            summary: RecoverySummary {
                run_id,
                request,
                context: registration.context,
                terminal: false,
            },
            lease: RecoveryLease {
                owner: registration.owner,
                epoch: 1,
            },
            events: Vec::new(),
            tools: ToolLedger::default(),
            authority_cutoff: 0,
            subscriber: Some(Subscriber::Initial(channel)),
            cancellation,
        }))
    }
    pub(crate) fn send(&mut self, event: LocalAgentEvent) {
        if let LocalAgentEvent::ToolRequest { call_id, .. } = &event {
            self.tools.queued(call_id);
        }
        if matches!(event, LocalAgentEvent::Done { .. }) {
            self.summary.terminal = true;
        }
        let envelope = RecoveryEnvelope {
            run_id: self.summary.run_id.clone(),
            sequence: self.events.len() as u64 + 1,
            event,
        };
        self.events.push(envelope.clone());
        let failed = match &self.subscriber {
            Some(Subscriber::Initial(channel)) => channel.send(envelope.event.clone()).is_err(),
            Some(Subscriber::Recovered(channel)) => channel.send(envelope).is_err(),
            None => false,
        };
        if failed {
            self.subscriber = None;
        }
    }
    fn attach(
        &mut self,
        owner: String,
        channel: tauri::ipc::Channel<RecoveryEnvelope>,
    ) -> RecoverySnapshot {
        if self.lease.owner != owner {
            self.lease = RecoveryLease {
                owner,
                epoch: self.lease.epoch + 1,
            };
        }
        let uncertain = self.tools.has_uncertain(self.lease.epoch);
        self.subscriber = Some(Subscriber::Recovered(channel));
        if uncertain {
            self.cancellation.request_stop();
        }
        RecoverySnapshot {
            summary: self.summary.clone(),
            lease: self.lease.clone(),
            events: self.events.clone(),
            stale_call_ids: self
                .events
                .iter()
                .filter_map(|envelope| match &envelope.event {
                    LocalAgentEvent::ToolRequest { call_id, .. }
                        if envelope.sequence <= self.authority_cutoff
                            && !matches!(
                                self.tools.calls.get(call_id),
                                Some(ToolState::Resolved(_))
                            ) =>
                    {
                        Some(call_id.clone())
                    }
                    _ => None,
                })
                .collect(),
            resolutions: self
                .tools
                .calls
                .iter()
                .filter_map(|(id, state)| match state {
                    ToolState::Resolved(result) => Some((id.clone(), result.clone())),
                    _ => None,
                })
                .collect(),
            uncertain,
        }
    }
    fn verify(&self, lease: &RecoveryLease) -> Result<(), String> {
        if &self.lease != lease {
            Err("The local CLI page lease is no longer current.".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn resolve(
        &mut self,
        call_id: &str,
        result: &LocalToolResolution,
        lease: Option<&RecoveryLease>,
        context: Option<serde_json::Value>,
        deliver: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        self.verify(lease.ok_or("A page lease is required for this local CLI run.")?)?;
        match self.tools.calls.get(call_id) {
            Some(ToolState::Resolved(previous)) => {
                if serde_json::to_value(previous).ok() == serde_json::to_value(result).ok() {
                    return Ok(false);
                }
                return Err("A different result was already recorded for this Host call.".into());
            }
            Some(ToolState::Claimed(epoch)) if *epoch == self.lease.epoch => {}
            _ => return Err("The Host call is not claimed by this page.".into()),
        }
        // Broker validation/delivery and journal publication share this lock.
        // A failed ACK must never become a successful cached result.
        deliver()?;
        self.tools.resolved(call_id, result.clone());
        if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&result.text) {
            if envelope["kind"] == "open_builder_user_updates"
                && envelope["version"] == 1
                && envelope["openBuilderUserUpdates"]
                    .as_array()
                    .is_some_and(|updates| !updates.is_empty())
            {
                self.authority_cutoff = self.events.len() as u64;
            }
        }
        if let Some(context) = context {
            self.summary.context = context;
        }
        Ok(true)
    }
}
fn find(state: &LocalAgentState, id: &str) -> Result<RecoveryRun, String> {
    state
        .recovery
        .lock()
        .map_err(|_| "Recovery registry unavailable.")?
        .get(id)
        .cloned()
        .ok_or_else(|| "The local CLI run is no longer recoverable.".into())
}
#[tauri::command]
pub fn local_agent_list_recoverable(
    state: tauri::State<'_, LocalAgentState>,
    owner: Option<String>,
) -> Result<Vec<RecoverySummary>, String> {
    if let Some(owner) = owner {
        state.cancel_stale_page_utilities(&owner);
    }
    state
        .recovery
        .lock()
        .map_err(|_| "Recovery registry unavailable.")?
        .values()
        .map(|run| {
            run.lock()
                .map(|run| run.summary.clone())
                .map_err(|_| "Recovery journal unavailable.".into())
        })
        .collect()
}
#[tauri::command]
pub fn local_agent_attach(
    state: tauri::State<'_, LocalAgentState>,
    run_id: String,
    owner: String,
    on_event: tauri::ipc::Channel<RecoveryEnvelope>,
) -> Result<RecoverySnapshot, String> {
    if owner.is_empty() || owner.len() > 128 {
        return Err("Invalid page owner.".into());
    }
    let run = find(&state, &run_id)?;
    let mut run = run.lock().map_err(|_| "Recovery journal unavailable.")?;
    Ok(run.attach(owner, on_event))
}
#[tauri::command]
pub fn local_agent_claim_tool(
    state: tauri::State<'_, LocalAgentState>,
    run_id: String,
    call_id: String,
    lease: RecoveryLease,
) -> Result<ToolClaim, String> {
    let run = find(&state, &run_id)?;
    let mut run = run.lock().map_err(|_| "Recovery journal unavailable.")?;
    run.verify(&lease)?;
    if run.cancellation.stop_requested() || run.summary.terminal {
        return Err("The local CLI run has ended.".into());
    }
    run.tools.claim(&call_id, lease.epoch)
}
#[tauri::command]
pub fn local_agent_acknowledge_terminal(
    state: tauri::State<'_, LocalAgentState>,
    run_id: String,
    lease: RecoveryLease,
) -> Result<(), String> {
    let mut runs = state
        .recovery
        .lock()
        .map_err(|_| "Recovery registry unavailable.")?;
    if let Some(run) = runs.get(&run_id) {
        let run = run.lock().map_err(|_| "Recovery journal unavailable.")?;
        run.verify(&lease)?;
        if !run.summary.terminal {
            return Err("The local CLI run has not ended.".into());
        }
    }
    runs.remove(&run_id);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovered_owner_cannot_repeat_a_claimed_host_operation() {
        let mut ledger = ToolLedger::default();
        ledger.queued("write");
        assert!(matches!(
            ledger.claim("write", 1).unwrap(),
            ToolClaim::Execute
        ));
        assert!(ledger.has_uncertain(2));
        assert!(ledger.claim("write", 2).is_err());
    }
    #[test]
    fn resolved_tool_replays_its_result_without_execution() {
        let mut ledger = ToolLedger::default();
        ledger.queued("write");
        ledger.claim("write", 1).unwrap();
        let result = LocalToolResolution {
            text: "written".into(),
            is_error: None,
            structured_content: None,
            content: None,
        };
        ledger.resolved("write", result);
        assert!(matches!(
            ledger.claim("write", 2).unwrap(),
            ToolClaim::Resolved { .. }
        ));
    }
    fn fixture_request() -> LocalAgentStartRequest {
        serde_json::from_value(serde_json::json!({
            "provider":"codex", "systemPrompt":"system", "prompt":"task",
            "scope":{"kind":"conversation","id":"conversation"}, "nativeSearch":false, "mode":"chat",
            "tools":[{"name":"write_file","description":"write","inputSchema":{"type":"object"}}]
        })).unwrap()
    }
    #[tokio::test]
    async fn reloaded_page_completes_the_original_broker_call_once() {
        use crate::local_agent::{LocalAgentEvent, TrackedChannel};
        use crate::local_agent_bridge::ToolBridge;
        let cancellation = RunCancellation::new();
        let old_channel =
            tauri::ipc::Channel::new(|_| Err(std::io::Error::other("page closed").into()));
        let request = fixture_request();
        let recovery = RecoverableRun::new(
            "run".into(),
            request.clone(),
            RecoveryRegistration {
                owner: "old-page".into(),
                context: serde_json::json!({"version":1}),
            },
            old_channel.clone(),
            cancellation.clone(),
        );
        let bridge = ToolBridge::default();
        let (url, token) = bridge
            .register(
                "run".into(),
                request.tools,
                0,
                cancellation.authority_token(),
                TrackedChannel::from(old_channel).with_recovery(recovery.clone()),
            )
            .await
            .unwrap();
        let url = format!("{}/pi/call", url.strip_suffix("/mcp").unwrap());
        let pending = tokio::spawn(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(url)
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(
                    serde_json::json!({"name":"write_file","arguments":{"path":"styles.css"}})
                        .to_string(),
                )
                .send()
                .await
                .unwrap()
        });
        let call_id = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(id) = recovery.lock().unwrap().events.iter().find_map(|envelope| {
                    match &envelope.event {
                        LocalAgentEvent::ToolRequest { call_id, .. } => Some(call_id.clone()),
                        _ => None,
                    }
                }) {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let lease = {
            let mut run = recovery.lock().unwrap();
            let snapshot = run.attach("new-page".into(), tauri::ipc::Channel::new(|_| Ok(())));
            assert!(!snapshot.uncertain);
            assert_eq!(snapshot.events.len(), 1);
            assert!(run
                .verify(&RecoveryLease {
                    owner: "old-page".into(),
                    epoch: 1
                })
                .is_err());
            assert!(matches!(
                run.tools.claim(&call_id, snapshot.lease.epoch).unwrap(),
                ToolClaim::Execute
            ));
            // Reattaching the same page is idempotent even during its Host call.
            let again = run.attach("new-page".into(), tauri::ipc::Channel::new(|_| Ok(())));
            assert_eq!(snapshot.lease, again.lease);
            assert!(!again.uncertain);
            snapshot.lease
        };
        let result = LocalToolResolution {
            text: "written once".into(),
            is_error: None,
            structured_content: None,
            content: None,
        };
        {
            let mut run = recovery.lock().unwrap();
            assert!(run
                .resolve(&call_id, &result, Some(&lease), None, || bridge.resolve(
                    "run",
                    &call_id,
                    result.clone()
                ))
                .unwrap());
            assert!(!run
                .resolve(&call_id, &result, Some(&lease), None, || panic!(
                    "duplicate delivery"
                ))
                .unwrap());
            let snapshot = run.attach("third-page".into(), tauri::ipc::Channel::new(|_| Ok(())));
            assert!(!snapshot.uncertain);
            assert_eq!(snapshot.resolutions[&call_id].text, "written once");
        }
        let response = pending.await.unwrap();
        assert!(response.status().is_success());
        assert!(response.text().await.unwrap().contains("written once"));
        bridge.shutdown_now();
    }
    #[test]
    fn failed_broker_delivery_does_not_publish_a_resolved_result() {
        let recovery = RecoverableRun::new(
            "run".into(),
            fixture_request(),
            RecoveryRegistration {
                owner: "page".into(),
                context: serde_json::Value::Null,
            },
            tauri::ipc::Channel::new(|_| Ok(())),
            RunCancellation::new(),
        );
        let mut run = recovery.lock().unwrap();
        run.tools.queued("call");
        run.tools.claim("call", 1).unwrap();
        let lease = run.lease.clone();
        let result = LocalToolResolution {
            text: "not delivered".into(),
            is_error: None,
            structured_content: None,
            content: None,
        };
        assert!(run
            .resolve("call", &result, Some(&lease), None, || Err(
                "broker rejected result".into()
            ))
            .is_err());
        let snapshot = run.attach("new-page".into(), tauri::ipc::Channel::new(|_| Ok(())));
        assert!(snapshot.uncertain);
        assert!(snapshot.resolutions.is_empty());
        assert!(run.cancellation.stop_requested());
    }
}
