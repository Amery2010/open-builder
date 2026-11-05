use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::response_stream::forward_response_stream;
use crate::timeouts::wait_with_timeout_retries;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

const MAX_ACTIVE_CONNECTIONS: usize = 64;
const MAX_SERVER_POLICIES: usize = 64;
const MAX_ID_CHARS: usize = 64;
const MAX_URL_BYTES: usize = 4 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENT_CHUNK_BYTES: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 5;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_IN_FLIGHT_EVENTS: usize = 4;
const EVENT_ACK_TIMEOUT: Duration = Duration::from_secs(30);
static NEXT_REMOTE_GENERATION: AtomicU64 = AtomicU64::new(1);
const FORBIDDEN_REQUEST_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "host",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const CREDENTIAL_FREE_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "content-type",
    "last-event-id",
    "mcp-protocol-version",
    "pragma",
    "user-agent",
];

async fn build_remote_http_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
    let pinned = crate::proxy::resolve_and_validate_target(url).await?;
    let mut builder =
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many MCP redirects");
            }

            let Some(previous) = attempt.previous().last() else {
                return attempt.error("MCP redirect has no source URL");
            };
            if same_origin(previous, attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));
    if let (Some(host), Some(address)) = (url.host_str(), pinned) {
        builder = builder.resolve(host, address);
    }
    builder
        .build()
        .map_err(|_| "failed to create MCP remote HTTP client".to_string())
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum McpRemotePayload {
    Connected {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        sequence: u64,
        data: Vec<u8>,
    },
    Done,
    Error {
        message: String,
    },
}

pub struct McpRemoteState {
    policies: Arc<Mutex<HashMap<String, RemoteServerPolicy>>>,
    connections: Arc<Mutex<HashMap<String, ActiveRemoteConnection>>>,
    policy_epoch: AtomicU64,
}

struct RemoteServerPolicy {
    origins: HashSet<String>,
    credentials_configured: bool,
}

struct ActiveRemoteConnection {
    server_id: String,
    generation: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    flow: Arc<McpEventFlow>,
}

struct RemoteConnectionAuthorization<'a> {
    expected_epoch: u64,
    origin: &'a str,
    insecure_http: bool,
    request_has_credentials: bool,
}

fn remove_remote_connection(
    connections: &Mutex<HashMap<String, ActiveRemoteConnection>>,
    id: &str,
    generation: u64,
) -> Option<ActiveRemoteConnection> {
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

struct McpEventFlow {
    permits: Semaphore,
    next_sequence: AtomicU64,
    in_flight: Mutex<HashSet<u64>>,
}

impl McpEventFlow {
    fn new() -> Self {
        Self {
            permits: Semaphore::new(MAX_IN_FLIGHT_EVENTS),
            next_sequence: AtomicU64::new(1),
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    async fn reserve(&self) -> Result<u64, String> {
        let permit = wait_with_timeout_retries(self.permits.acquire(), EVENT_ACK_TIMEOUT)
            .await
            .map_err(|_| "MCP remote consumer acknowledgement timeout".to_string())?
            .map_err(|_| "MCP remote consumer flow control closed".to_string())?;
        permit.forget();
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        self.in_flight
            .lock()
            .map_err(|_| "MCP remote flow-control lock poisoned".to_string())?
            .insert(sequence);
        Ok(sequence)
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        let removed = self
            .in_flight
            .lock()
            .map_err(|_| "MCP remote flow-control lock poisoned".to_string())?
            .remove(&sequence);
        if !removed {
            return Err("unknown or duplicate MCP remote event acknowledgement".to_string());
        }
        self.permits.add_permits(1);
        Ok(())
    }
}

impl Default for McpRemoteState {
    fn default() -> Self {
        Self {
            policies: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            policy_epoch: AtomicU64::new(0),
        }
    }
}

impl McpRemoteState {
    pub fn shutdown_now(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            for (_, connection) in connections.drain() {
                if let Some(task) = connection.task {
                    task.abort();
                }
            }
        }
    }

    fn clear_policies_and_connections(&self) -> Result<u64, String> {
        let mut policies = self
            .policies
            .lock()
            .map_err(|_| "MCP remote policy lock poisoned".to_string())?;
        let mut active = self
            .connections
            .lock()
            .map_err(|_| "MCP remote connection lock poisoned".to_string())?;
        let next_epoch = self.policy_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        policies.clear();
        for (_, connection) in active.drain() {
            if let Some(task) = connection.task {
                task.abort();
            }
        }
        Ok(next_epoch)
    }

    fn reserve_connection(
        &self,
        id: &str,
        server_id: &str,
        authorization: RemoteConnectionAuthorization<'_>,
        flow: Arc<McpEventFlow>,
    ) -> Result<u64, String> {
        let policies = self
            .policies
            .lock()
            .map_err(|_| "MCP remote policy lock poisoned".to_string())?;
        if self.policy_epoch.load(Ordering::Acquire) != authorization.expected_epoch {
            return Err("stale MCP remote connection epoch".to_string());
        }
        let policy = policies
            .get(server_id)
            .filter(|policy| policy.origins.contains(authorization.origin))
            .ok_or_else(|| "MCP remote origin is not approved for this server".to_string())?;
        if authorization.insecure_http
            && (policy.credentials_configured || authorization.request_has_credentials)
        {
            return Err(
                "credential-bearing MCP requests must use HTTPS, including loopback targets"
                    .to_string(),
            );
        }

        let mut active = self
            .connections
            .lock()
            .map_err(|_| "MCP remote connection lock poisoned".to_string())?;
        if active.len() >= MAX_ACTIVE_CONNECTIONS && !active.contains_key(id) {
            return Err(format!(
                "too many active MCP remote connections (max {MAX_ACTIVE_CONNECTIONS})"
            ));
        }
        if active.contains_key(id) {
            return Err("MCP remote connection id is already active".to_string());
        }
        let generation = NEXT_REMOTE_GENERATION.fetch_add(1, Ordering::Relaxed);
        active.insert(
            id.to_string(),
            ActiveRemoteConnection {
                server_id: server_id.to_string(),
                generation,
                task: None,
                flow,
            },
        );
        Ok(generation)
    }
}

impl Drop for McpRemoteState {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

fn validate_id(label: &str, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{label} is required"));
    }
    if id.len() > MAX_ID_CHARS {
        return Err(format!("{label} exceeds {MAX_ID_CHARS} characters"));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(format!("{label} contains invalid characters"));
    }
    Ok(())
}

fn canonical_origin(url: &reqwest::Url) -> Result<String, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("MCP remote URLs must use http or https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("MCP remote URLs must not contain credentials".to_string());
    }
    if url.host_str().is_none() {
        return Err("MCP remote URL has no host".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    match (canonical_origin(left), canonical_origin(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_loopback_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn parse_remote_url(value: &str) -> Result<(reqwest::Url, String), String> {
    if value.len() > MAX_URL_BYTES {
        return Err("MCP remote URL is too long".to_string());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "invalid MCP remote URL".to_string())?;
    let origin = canonical_origin(&url)?;
    if url.scheme() == "http" && !is_loopback_host(&url) {
        return Err(
            "MCP remote URLs must use HTTPS; HTTP is allowed only for loopback hosts".to_string(),
        );
    }
    Ok((url, origin))
}

fn validate_request(
    id: &str,
    server_id: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&[u8]>,
) -> Result<reqwest::Method, String> {
    validate_id("MCP remote connection id", id)?;
    validate_id("MCP server id", server_id)?;
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|_| "invalid MCP remote HTTP method".to_string())?;
    if headers.len() > MAX_HEADERS {
        return Err(format!("too many MCP remote headers (max {MAX_HEADERS})"));
    }
    if headers.iter().any(|(name, value)| {
        name.len() > MAX_HEADER_NAME_BYTES || value.len() > MAX_HEADER_VALUE_BYTES
    }) {
        return Err("MCP remote header name or value exceeds its size limit".to_string());
    }
    if headers.keys().any(|name| {
        FORBIDDEN_REQUEST_HEADERS
            .iter()
            .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
    }) {
        return Err("MCP remote request contains a forbidden transport header".to_string());
    }
    if body.map(<[u8]>::len).unwrap_or(0) > MAX_BODY_BYTES {
        return Err(format!(
            "MCP remote request body exceeds {MAX_BODY_BYTES} bytes"
        ));
    }
    Ok(method)
}

fn request_carries_credentials(headers: &HashMap<String, String>, body: Option<&[u8]>) -> bool {
    if headers.keys().any(|name| {
        !CREDENTIAL_FREE_REQUEST_HEADERS
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
    }) {
        return true;
    }
    let Some(body) = body else {
        return false;
    };
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    [
        "client_secret",
        "clientsecret",
        "access_token",
        "accesstoken",
        "refresh_token",
        "refreshtoken",
        "code_verifier",
        "codeverifier",
        "password",
        "api_key",
        "apikey",
    ]
    .iter()
    .any(|marker| body.contains(marker))
}

fn classify_reqwest_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "MCP remote request timed out".to_string()
    } else if error.is_redirect() {
        "MCP remote redirect was rejected".to_string()
    } else if error.is_connect() {
        "MCP remote connection failed".to_string()
    } else if error.is_body() || error.is_decode() {
        "MCP remote response could not be read".to_string()
    } else {
        "MCP remote request failed".to_string()
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn response_headers(response: &reqwest::Response) -> HashMap<String, String> {
    response
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != "set-cookie")
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| {
                let value = truncate_utf8(value, MAX_HEADER_VALUE_BYTES);
                (name.as_str().to_string(), value.to_string())
            })
        })
        .take(MAX_HEADERS)
        .collect()
}

async fn emit_chunked(
    app: &AppHandle,
    event_name: &str,
    bytes: &[u8],
    flow: &McpEventFlow,
) -> Result<(), String> {
    for chunk in bytes.chunks(MAX_EVENT_CHUNK_BYTES) {
        let sequence = flow.reserve().await?;
        if app
            .emit(
                event_name,
                McpRemotePayload::Chunk {
                    sequence,
                    data: chunk.to_vec(),
                },
            )
            .is_err()
        {
            let _ = flow.acknowledge(sequence);
            return Err("MCP remote consumer is unavailable".to_string());
        }
    }
    Ok(())
}

fn set_remote_policy(
    state: &McpRemoteState,
    server_id: String,
    origins: Vec<String>,
    credentials_configured: bool,
    expected_epoch: u64,
) -> Result<(), String> {
    validate_id("MCP server id", &server_id)?;
    if origins.len() > 16 {
        return Err("too many approved MCP origins (max 16)".to_string());
    }

    let mut approved_origins = HashSet::new();
    for configured in origins {
        let (_, origin) = parse_remote_url(configured.trim())?;
        approved_origins.insert(origin);
    }

    let mut policies = state
        .policies
        .lock()
        .map_err(|_| "MCP remote policy lock poisoned".to_string())?;
    if state.policy_epoch.load(Ordering::Acquire) != expected_epoch {
        return Err("stale MCP remote policy epoch".to_string());
    }
    if !approved_origins.is_empty()
        && !policies.contains_key(&server_id)
        && policies.len() >= MAX_SERVER_POLICIES
    {
        return Err(format!(
            "too many MCP remote server policies (max {MAX_SERVER_POLICIES})"
        ));
    }
    let policy_restricted = policies.get(&server_id).is_some_and(|current| {
        !current.origins.is_subset(&approved_origins)
            || current.credentials_configured != credentials_configured
    });
    if approved_origins.is_empty() {
        policies.remove(&server_id);
    } else {
        policies.insert(
            server_id.clone(),
            RemoteServerPolicy {
                origins: approved_origins,
                credentials_configured,
            },
        );
    }

    if policy_restricted {
        let mut active = state
            .connections
            .lock()
            .map_err(|_| "MCP remote connection lock poisoned".to_string())?;
        let connection_ids = active
            .iter()
            .filter(|(_, connection)| connection.server_id == server_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in connection_ids {
            if let Some(connection) = active.remove(&id) {
                if let Some(task) = connection.task {
                    task.abort();
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_remote_set_policy(
    state: tauri::State<'_, McpRemoteState>,
    server_id: String,
    origins: Vec<String>,
    credentials_configured: bool,
    expected_epoch: u64,
) -> Result<(), String> {
    set_remote_policy(
        &state,
        server_id,
        origins,
        credentials_configured,
        expected_epoch,
    )
}

#[tauri::command]
pub fn mcp_remote_policy_epoch(state: tauri::State<'_, McpRemoteState>) -> u64 {
    state.policy_epoch.load(Ordering::Acquire)
}

#[tauri::command]
pub fn mcp_remote_clear_policies(state: tauri::State<'_, McpRemoteState>) -> Result<u64, String> {
    state.clear_policies_and_connections()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mcp_remote_connect(
    app: AppHandle,
    state: tauri::State<'_, McpRemoteState>,
    id: String,
    server_id: String,
    expected_epoch: u64,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Result<(), String> {
    let method = validate_request(&id, &server_id, &method, &headers, body.as_deref())?;
    let (url, origin) = parse_remote_url(&url)?;
    let event_name = format!("mcp-remote://{id}");
    let connections = state.connections.clone();
    let cleanup_id = id.clone();
    let flow = Arc::new(McpEventFlow::new());
    let generation = state.reserve_connection(
        &id,
        &server_id,
        RemoteConnectionAuthorization {
            expected_epoch,
            origin: &origin,
            insecure_http: url.scheme() == "http",
            request_has_credentials: request_carries_credentials(&headers, body.as_deref()),
        },
        flow.clone(),
    )?;

    let remote_client = match build_remote_http_client(&url).await {
        Ok(client) => client,
        Err(error) => {
            let _ = remove_remote_connection(&connections, &id, generation);
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
        let mut request = remote_client.request(method, url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }

        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let headers = response_headers(&response);
                let _ = app.emit(&event_name, McpRemotePayload::Connected { status, headers });

                let stream = response
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(|error| classify_reqwest_error(&error)));
                let result = forward_response_stream(
                    stream,
                    STREAM_IDLE_TIMEOUT,
                    "MCP remote stream idle timeout",
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
                        let _ = app.emit(&event_name, McpRemotePayload::Done);
                    }
                    Err(message) => {
                        let _ = app.emit(&event_name, McpRemotePayload::Error { message });
                    }
                }
            }
            Err(error) => {
                let _ = app.emit(
                    &event_name,
                    McpRemotePayload::Error {
                        message: classify_reqwest_error(&error),
                    },
                );
            }
        }

        let _ = remove_remote_connection(&cleanup_connections, &cleanup_id, generation);
    });

    let mut active = state
        .connections
        .lock()
        .map_err(|_| "MCP remote connection lock poisoned".to_string())?;
    let Some(connection) = active
        .get_mut(&id)
        .filter(|connection| connection.generation == generation)
    else {
        task.abort();
        return Err("MCP remote connection was cancelled during setup".to_string());
    };
    connection.task = Some(task);
    drop(active);
    let _ = start_tx.send(());
    Ok(())
}

#[tauri::command]
pub async fn mcp_remote_disconnect(
    state: tauri::State<'_, McpRemoteState>,
    id: String,
) -> Result<(), String> {
    validate_id("MCP remote connection id", &id)?;
    if let Some(connection) = state
        .connections
        .lock()
        .map_err(|_| "MCP remote connection lock poisoned".to_string())?
        .remove(&id)
    {
        if let Some(task) = connection.task {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_remote_ack(
    state: tauri::State<'_, McpRemoteState>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    validate_id("MCP remote connection id", &id)?;
    let connections = state
        .connections
        .lock()
        .map_err(|_| "MCP remote connection lock poisoned".to_string())?;
    let connection = connections
        .get(&id)
        .ok_or_else(|| "MCP remote connection is not active".to_string())?;
    connection.flow.acknowledge(sequence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_origin_preserves_explicit_scheme_and_normalizes_default_port() {
        let https = reqwest::Url::parse("https://example.com:443/mcp").unwrap();
        let http = reqwest::Url::parse("http://example.com:8080/mcp").unwrap();

        assert_eq!(canonical_origin(&https).unwrap(), "https://example.com");
        assert_eq!(canonical_origin(&http).unwrap(), "http://example.com:8080");
        assert!(!same_origin(&https, &http));
        assert!(same_origin(
            &reqwest::Url::parse("https://example.com/start").unwrap(),
            &reqwest::Url::parse("https://example.com/redirected").unwrap(),
        ));
    }

    #[test]
    fn remote_urls_reject_credentials_and_non_http_schemes() {
        assert!(parse_remote_url("https://user:secret@example.com/mcp").is_err());
        assert!(parse_remote_url("file:///tmp/server").is_err());
        assert!(parse_remote_url("https://example.com/mcp").is_ok());
        assert!(parse_remote_url("http://example.com/mcp").is_err());
        assert!(parse_remote_url("http://127.0.0.2:8787/mcp").is_ok());
    }

    #[tokio::test]
    async fn remote_client_rejects_private_and_special_literals_before_network() {
        for value in [
            "https://10.0.0.1/mcp",
            "https://100.64.0.1/mcp",
            "https://169.254.169.254/mcp",
            "https://192.0.2.1/mcp",
            "https://[fe80::1]/mcp",
            "https://[2001:db8::1]/mcp",
        ] {
            let url = reqwest::Url::parse(value).unwrap();
            assert!(build_remote_http_client(&url).await.is_err(), "{value}");
        }

        // Credential-free local MCP remains a supported, explicitly approved
        // workflow; only the exact loopback origin receives this exception.
        let loopback = reqwest::Url::parse("http://127.0.0.1:8787/mcp").unwrap();
        assert!(build_remote_http_client(&loopback).await.is_ok());
    }

    #[test]
    fn loopback_http_rejects_headers_and_oauth_secrets() {
        let mut authorization = HashMap::new();
        authorization.insert("Authorization".to_string(), "Bearer secret".to_string());
        assert!(request_carries_credentials(&authorization, None));

        let mut custom = HashMap::new();
        custom.insert("X-Custom-Token".to_string(), "secret".to_string());
        assert!(request_carries_credentials(&custom, None));

        let safe = HashMap::from([
            ("Accept".to_string(), "application/json".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ]);
        assert!(!request_carries_credentials(
            &safe,
            Some(br#"{"jsonrpc":"2.0"}"#)
        ));
        assert!(request_carries_credentials(
            &safe,
            Some(b"grant_type=client_credentials&client_secret=secret"),
        ));
        assert!(request_carries_credentials(
            &safe,
            Some(b"grant_type=authorization_code&code_verifier=secret"),
        ));
        for body in [
            br#"{"clientSecret":"secret"}"#.as_slice(),
            br#"{"password":"secret"}"#.as_slice(),
            br#"{"apiKey":"secret"}"#.as_slice(),
        ] {
            assert!(request_carries_credentials(&safe, Some(body)));
        }
    }

    #[test]
    fn server_policy_rejects_credential_config_on_loopback_http() {
        let state = McpRemoteState::default();
        state.policies.lock().unwrap().insert(
            "server".to_string(),
            RemoteServerPolicy {
                origins: HashSet::from(["http://127.0.0.1:8787".to_string()]),
                credentials_configured: true,
            },
        );
        assert!(state
            .reserve_connection(
                "request",
                "server",
                RemoteConnectionAuthorization {
                    expected_epoch: 0,
                    origin: "http://127.0.0.1:8787",
                    insecure_http: true,
                    request_has_credentials: false,
                },
                Arc::new(McpEventFlow::new()),
            )
            .is_err());
        assert!(state.connections.lock().unwrap().is_empty());
    }

    #[test]
    fn request_validation_enforces_budgets() {
        let headers = HashMap::new();
        assert!(validate_request("request-1", "server-1", "POST", &headers, Some(b"{}"),).is_ok());
        assert!(validate_request("bad/id", "server-1", "POST", &headers, None).is_err());
        assert!(validate_request("request-1", "server-1", "BAD METHOD", &headers, None).is_err());
        let mut forbidden_headers = HashMap::new();
        forbidden_headers.insert("Host".to_string(), "attacker.invalid".to_string());
        assert!(
            validate_request("request-1", "server-1", "POST", &forbidden_headers, None).is_err()
        );
        assert!(validate_request(
            "request-1",
            "server-1",
            "POST",
            &headers,
            Some(&vec![b'x'; MAX_BODY_BYTES + 1]),
        )
        .is_err());
    }

    #[test]
    fn request_errors_do_not_expose_sensitive_details() {
        let message = classify_reqwest_error(
            &reqwest::Client::new()
                .get("not-a-url")
                .build()
                .expect_err("invalid URL should fail"),
        );
        assert!(!message.contains("not-a-url"));
        assert!(!message.to_lowercase().contains("token"));
    }

    #[test]
    fn full_clear_revokes_all_native_origin_policies() {
        let state = McpRemoteState::default();
        state.policies.lock().unwrap().insert(
            "server".to_string(),
            RemoteServerPolicy {
                origins: HashSet::from(["https://example.com".to_string()]),
                credentials_configured: false,
            },
        );
        let epoch = state.clear_policies_and_connections().unwrap();
        assert!(state.policies.lock().unwrap().is_empty());
        assert_eq!(epoch, 1);
    }

    #[test]
    fn stale_policy_epoch_cannot_restore_a_policy_after_clear() {
        let state = McpRemoteState::default();
        set_remote_policy(
            &state,
            "server".to_string(),
            vec!["https://example.com".to_string()],
            false,
            0,
        )
        .unwrap();
        assert_eq!(state.clear_policies_and_connections().unwrap(), 1);

        assert!(set_remote_policy(
            &state,
            "server".to_string(),
            vec!["https://example.com".to_string()],
            false,
            0,
        )
        .unwrap_err()
        .contains("stale"));
        assert!(state.policies.lock().unwrap().is_empty());

        set_remote_policy(
            &state,
            "server".to_string(),
            vec!["https://example.com".to_string()],
            false,
            1,
        )
        .unwrap();
        assert!(state
            .reserve_connection(
                "stale-request",
                "server",
                RemoteConnectionAuthorization {
                    expected_epoch: 0,
                    origin: "https://example.com",
                    insecure_http: false,
                    request_has_credentials: false,
                },
                Arc::new(McpEventFlow::new()),
            )
            .unwrap_err()
            .contains("stale"));
        assert!(state.connections.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_setup_generation_cannot_remove_a_replacement_connection() {
        let connections = Mutex::new(HashMap::new());
        let flow = Arc::new(McpEventFlow::new());
        connections.lock().unwrap().insert(
            "request".to_string(),
            ActiveRemoteConnection {
                server_id: "server".to_string(),
                generation: 2,
                task: None,
                flow,
            },
        );
        assert!(remove_remote_connection(&connections, "request", 1).is_none());
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
    fn policy_clear_is_atomic_with_connection_reservation() {
        for index in 0..32 {
            let state = Arc::new(McpRemoteState::default());
            state.policies.lock().unwrap().insert(
                "server".to_string(),
                RemoteServerPolicy {
                    origins: HashSet::from(["https://example.com".to_string()]),
                    credentials_configured: false,
                },
            );
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let clear_state = state.clone();
            let clear_barrier = barrier.clone();
            let clear = std::thread::spawn(move || {
                clear_barrier.wait();
                clear_state.clear_policies_and_connections().unwrap();
            });
            barrier.wait();
            let _ = state.reserve_connection(
                &format!("request-{index}"),
                "server",
                RemoteConnectionAuthorization {
                    expected_epoch: 0,
                    origin: "https://example.com",
                    insecure_http: false,
                    request_has_credentials: false,
                },
                Arc::new(McpEventFlow::new()),
            );
            clear.join().unwrap();
            assert!(state.policies.lock().unwrap().is_empty());
            assert!(state.connections.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn flow_control_bounds_unacknowledged_events_and_rejects_duplicate_acks() {
        let flow = McpEventFlow::new();
        let sequences =
            futures_util::future::join_all((0..MAX_IN_FLIGHT_EVENTS).map(|_| flow.reserve()))
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
}
