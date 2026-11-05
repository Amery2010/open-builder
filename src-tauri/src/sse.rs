use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::proxy::build_validated_http_client;
use crate::response_stream::forward_response_stream;
use crate::timeouts::wait_with_timeout_retries;
const MAX_ACTIVE_SSE_CONNECTIONS: usize = 8;
const MAX_SSE_ID_CHARS: usize = 128;
const MAX_SSE_HEADERS: usize = 80;
const MAX_SSE_HEADER_CHARS: usize = 8 * 1024;
const MAX_SSE_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_SSE_EVENT_CHUNK_BYTES: usize = 256 * 1024;
const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_SSE_IN_FLIGHT_EVENTS: usize = 4;
const SSE_ACK_TIMEOUT: Duration = Duration::from_secs(30);
static NEXT_SSE_GENERATION: AtomicU64 = AtomicU64::new(1);

// ─── Event Payload ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum SsePayload {
    /// Connection established — carries HTTP status code and response headers.
    Connected {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// A chunk of bytes from the response body.
    Chunk { sequence: u64, bytes: Vec<u8> },
    /// Stream completed normally.
    Done,
    /// An error occurred.
    Error { message: String },
}

// ─── Connection State ────────────────────────────────────────────────────────

pub struct SseState {
    /// Active connections: id → JoinHandle (for abort on disconnect).
    /// Uses std::sync::Mutex because the lock is never held across .await.
    connections: Arc<Mutex<HashMap<String, ActiveSseConnection>>>,
}

struct ActiveSseConnection {
    generation: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    flow: Arc<SseEventFlow>,
}

fn remove_sse_connection(
    connections: &Mutex<HashMap<String, ActiveSseConnection>>,
    id: &str,
    generation: u64,
) -> Option<ActiveSseConnection> {
    let mut active = connections.lock().ok()?;
    if active
        .get(id)
        .is_some_and(|connection| connection.generation == generation)
    {
        active.remove(id)
    } else {
        None
    }
}

struct SseEventFlow {
    permits: Semaphore,
    next_sequence: AtomicU64,
    in_flight: Mutex<HashSet<u64>>,
}

impl SseEventFlow {
    fn new() -> Self {
        Self {
            permits: Semaphore::new(MAX_SSE_IN_FLIGHT_EVENTS),
            next_sequence: AtomicU64::new(1),
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    async fn reserve(&self) -> Result<u64, String> {
        let permit = wait_with_timeout_retries(self.permits.acquire(), SSE_ACK_TIMEOUT)
            .await
            .map_err(|_| "SSE consumer acknowledgement timeout".to_string())?
            .map_err(|_| "SSE consumer flow control closed".to_string())?;
        permit.forget();
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        self.in_flight
            .lock()
            .map_err(|_| "SSE flow-control lock poisoned".to_string())?
            .insert(sequence);
        Ok(sequence)
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        let removed = self
            .in_flight
            .lock()
            .map_err(|_| "SSE flow-control lock poisoned".to_string())?
            .remove(&sequence);
        if !removed {
            return Err("unknown or duplicate SSE event acknowledgement".to_string());
        }
        self.permits.add_permits(1);
        Ok(())
    }
}

impl Default for SseState {
    fn default() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl SseState {
    fn cancel_all(&self) -> Result<usize, String> {
        let mut active = self
            .connections
            .lock()
            .map_err(|_| "SSE connection lock poisoned".to_string())?;
        let count = active.len();
        for (_, connection) in active.drain() {
            if let Some(task) = connection.task {
                task.abort();
            }
        }
        Ok(count)
    }

    pub fn shutdown_now(&self) {
        let _ = self.cancel_all();
    }
}

impl Drop for SseState {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

fn validate_sse_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("SSE connection id is required".to_string());
    }
    if id.len() > MAX_SSE_ID_CHARS {
        return Err(format!(
            "SSE connection id exceeds {} characters",
            MAX_SSE_ID_CHARS
        ));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("SSE connection id contains invalid characters".to_string());
    }
    Ok(())
}

fn validate_sse_request(
    id: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Result<reqwest::Method, String> {
    validate_sse_id(id)?;
    let http_method: reqwest::Method = method
        .parse()
        .map_err(|_| format!("invalid SSE HTTP method: {method}"))?;
    if headers.len() > MAX_SSE_HEADERS {
        return Err(format!("too many SSE headers (max {MAX_SSE_HEADERS})"));
    }
    for (key, value) in headers {
        if key.len() > MAX_SSE_HEADER_CHARS || value.len() > MAX_SSE_HEADER_CHARS {
            return Err(format!(
                "SSE header names and values must be <= {} bytes",
                MAX_SSE_HEADER_CHARS
            ));
        }
    }
    if body.map(|text| text.len()).unwrap_or(0) > MAX_SSE_BODY_BYTES {
        return Err(format!(
            "SSE request body exceeds {} bytes",
            MAX_SSE_BODY_BYTES
        ));
    }
    Ok(http_method)
}

async fn emit_chunked(
    app: &AppHandle,
    event_name: &str,
    bytes: &[u8],
    flow: &SseEventFlow,
) -> Result<(), String> {
    for chunk in bytes.chunks(MAX_SSE_EVENT_CHUNK_BYTES) {
        let sequence = flow.reserve().await?;
        if app
            .emit(
                event_name,
                SsePayload::Chunk {
                    sequence,
                    bytes: chunk.to_vec(),
                },
            )
            .is_err()
        {
            let _ = flow.acknowledge(sequence);
            return Err("SSE consumer is unavailable".to_string());
        }
    }
    Ok(())
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Start an SSE streaming connection.
///
/// The command returns immediately. Actual data is delivered via Tauri events
/// on the channel `sse://{id}`.
#[tauri::command]
pub async fn sse_connect(
    app: AppHandle,
    state: tauri::State<'_, SseState>,
    id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<(), String> {
    let http_method = validate_sse_request(&id, &method, &headers, body.as_deref())?;
    let target_url = reqwest::Url::parse(&url).map_err(|_| "invalid SSE target URL".to_string())?;
    let event_name = format!("sse://{id}");
    let connections = state.connections.clone();
    let id_for_cleanup = id.clone();
    let generation = NEXT_SSE_GENERATION.fetch_add(1, Ordering::Relaxed);
    let flow = Arc::new(SseEventFlow::new());

    {
        let mut active = connections
            .lock()
            .map_err(|_| "SSE connection lock poisoned".to_string())?;
        if active.len() >= MAX_ACTIVE_SSE_CONNECTIONS && !active.contains_key(&id) {
            return Err(format!(
                "too many active SSE connections (max {MAX_ACTIVE_SSE_CONNECTIONS})"
            ));
        }
        if active.contains_key(&id) {
            return Err("SSE connection id is already active".to_string());
        }
        active.insert(
            id.clone(),
            ActiveSseConnection {
                generation,
                task: None,
                flow: flow.clone(),
            },
        );
    }

    // No absolute response timeout: long model streams remain supported. DNS
    // is pinned and redirect policy is still enforced by this client.
    let client = match build_validated_http_client(&target_url, None).await {
        Ok(client) => client,
        Err(error) => {
            let _ = remove_sse_connection(&connections, &id, generation);
            return Err(error);
        }
    };
    let cleanup_connections = connections.clone();
    let task_flow = flow.clone();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        let mut builder = client.request(http_method, target_url);

        for (k, v) in &headers {
            builder = builder.header(k.as_str(), v.as_str());
        }

        if let Some(b) = body {
            builder = builder.body(b);
        }

        // Send the request
        match builder.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();

                // Collect response headers
                let mut resp_headers = HashMap::new();
                for (key, value) in resp.headers().iter() {
                    if let Ok(v) = value.to_str() {
                        resp_headers.insert(key.as_str().to_string(), v.to_string());
                    }
                }

                // Emit Connected event
                let _ = app.emit(
                    &event_name,
                    SsePayload::Connected {
                        status,
                        headers: resp_headers,
                    },
                );

                // Stream body chunks
                let stream = resp
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(|_| "SSE response stream failed".to_string()));
                let result = forward_response_stream(
                    stream,
                    SSE_IDLE_TIMEOUT,
                    "SSE stream idle timeout",
                    |bytes| {
                        let app = &app;
                        let event_name = &event_name;
                        let flow = &task_flow;
                        async move { emit_chunked(app, event_name, &bytes, flow).await }
                    },
                )
                .await;
                match result {
                    Ok(()) => {
                        let _ = app.emit(&event_name, SsePayload::Done);
                    }
                    Err(message) => {
                        let _ = app.emit(&event_name, SsePayload::Error { message });
                    }
                }
            }
            Err(_) => {
                let _ = app.emit(
                    &event_name,
                    SsePayload::Error {
                        message: "SSE connection failed".to_string(),
                    },
                );
            }
        }
        let _ = remove_sse_connection(&cleanup_connections, &id_for_cleanup, generation);
    });

    let mut active = state
        .connections
        .lock()
        .map_err(|_| "SSE connection lock poisoned".to_string())?;
    let Some(connection) = active
        .get_mut(&id)
        .filter(|connection| connection.generation == generation)
    else {
        task.abort();
        return Err("SSE connection was cancelled during setup".to_string());
    };
    connection.task = Some(task);
    drop(active);
    let _ = start_tx.send(());

    Ok(())
}

/// Cancel an active SSE connection.
#[tauri::command]
pub async fn sse_disconnect(state: tauri::State<'_, SseState>, id: String) -> Result<(), String> {
    validate_sse_id(&id)?;
    if let Some(connection) = state
        .connections
        .lock()
        .map_err(|_| "SSE connection lock poisoned".to_string())?
        .remove(&id)
    {
        if let Some(task) = connection.task {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn sse_disconnect_all(state: tauri::State<'_, SseState>) -> Result<usize, String> {
    state.cancel_all()
}

#[tauri::command]
pub fn sse_ack(state: tauri::State<'_, SseState>, id: String, sequence: u64) -> Result<(), String> {
    validate_sse_id(&id)?;
    let connections = state
        .connections
        .lock()
        .map_err(|_| "SSE connection lock poisoned".to_string())?;
    let connection = connections
        .get(&id)
        .ok_or_else(|| "SSE connection is not active".to_string())?;
    connection.flow.acknowledge(sequence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_sse_connection_id() {
        assert!(validate_sse_id("a-valid_id-123").is_ok());
        assert!(validate_sse_id("").is_err());
        assert!(validate_sse_id("bad/id").is_err());
        assert!(validate_sse_id(&"x".repeat(MAX_SSE_ID_CHARS + 1)).is_err());
    }

    #[test]
    fn validates_sse_request_budget() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer token".to_string());

        assert!(validate_sse_request("id-1", "POST", &headers, Some("{}")).is_ok());
        assert!(validate_sse_request("id-1", "BAD METHOD", &headers, None).is_err());

        let too_many_headers = (0..=MAX_SSE_HEADERS)
            .map(|i| (format!("x-{i}"), "v".to_string()))
            .collect::<HashMap<_, _>>();
        assert!(validate_sse_request("id-1", "POST", &too_many_headers, None).is_err());

        let huge_body = "x".repeat(MAX_SSE_BODY_BYTES + 1);
        assert!(validate_sse_request("id-1", "POST", &headers, Some(&huge_body)).is_err());
    }

    #[tokio::test]
    async fn flow_control_bounds_unacknowledged_events_and_rejects_duplicate_acks() {
        let flow = SseEventFlow::new();
        let sequences =
            futures_util::future::join_all((0..MAX_SSE_IN_FLIGHT_EVENTS).map(|_| flow.reserve()))
                .await
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
        assert_eq!(flow.permits.available_permits(), 0);
        flow.acknowledge(sequences[0]).unwrap();
        assert!(flow.acknowledge(sequences[0]).is_err());
        assert!(flow.reserve().await.is_ok());
        assert_eq!(flow.permits.available_permits(), 0);
    }

    #[test]
    fn stale_setup_generation_cannot_remove_a_replacement_connection() {
        let connections = Mutex::new(HashMap::new());
        let flow = Arc::new(SseEventFlow::new());
        connections.lock().unwrap().insert(
            "request".to_string(),
            ActiveSseConnection {
                generation: 2,
                task: None,
                flow,
            },
        );
        assert!(remove_sse_connection(&connections, "request", 1).is_none());
        assert_eq!(
            connections
                .lock()
                .unwrap()
                .get("request")
                .map(|connection| connection.generation),
            Some(2),
        );
    }

    #[test]
    fn disconnect_all_aborts_and_removes_every_native_stream() {
        let state = SseState::default();
        let flow = Arc::new(SseEventFlow::new());
        state.connections.lock().unwrap().insert(
            "request-1".to_string(),
            ActiveSseConnection {
                generation: 1,
                task: None,
                flow: flow.clone(),
            },
        );
        state.connections.lock().unwrap().insert(
            "request-2".to_string(),
            ActiveSseConnection {
                generation: 2,
                task: None,
                flow,
            },
        );

        assert_eq!(state.cancel_all().unwrap(), 2);
        assert!(state.connections.lock().unwrap().is_empty());
    }
}
