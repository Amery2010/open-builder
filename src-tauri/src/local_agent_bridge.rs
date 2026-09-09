use std::borrow::Cow;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header::AUTHORIZATION, request::Parts, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
    PaginatedRequestParams, Resource, ResourceContents, ServerCapabilities, ServerInfo, Tool,
    ToolAnnotations as McpToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::{
    streamable_http_server::session::local::LocalSessionManager, StreamableHttpServerConfig,
    StreamableHttpService,
};
use rmcp::{ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::local_agent::TrackedChannel;
use crate::local_agent::{LocalToolContent, LocalToolResolution, LocalToolSpec};

#[path = "local_agent_bridge_broker.rs"]
mod broker;

use broker::{BrokerError, BrokerErrorKind, BrokerTool, ToolBroker, MAX_ARGUMENT_BYTES};

pub(crate) use broker::canonical_tool_digest;

#[derive(Clone)]
struct OpenBuilderToolServer {
    broker: ToolBroker,
}

impl ServerHandler for OpenBuilderToolServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Open Builder host tools for the current isolated run")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let authorization = authorization_from_context(&context)?;
        let catalog = self
            .broker
            .catalog(Some(&authorization))
            .map_err(broker_error_to_mcp)?;
        let tools = catalog
            .tools
            .into_iter()
            .map(broker_tool_to_mcp)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let authorization = authorization_from_context(&context)?;
        let arguments = serde_json::Value::Object(request.arguments.unwrap_or_default());
        match self
            .broker
            .call(Some(&authorization), request.name.into_owned(), arguments)
            .await
        {
            Ok(resolution) => Ok(resolution_to_mcp(resolution).into()),
            Err(error) if error.is_tool_result_error() => {
                Ok(
                    CallToolResult::error(vec![ContentBlock::text(error.message().to_string())])
                        .into(),
                )
            }
            Err(error) => Err(broker_error_to_mcp(error)),
        }
    }
}

fn authorization_from_context(context: &RequestContext<RoleServer>) -> Result<String, ErrorData> {
    let parts = context
        .extensions
        .get::<Parts>()
        .ok_or_else(|| ErrorData::invalid_request("missing HTTP request context", None))?;
    parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| ErrorData::invalid_request("missing tool broker credentials", None))
}

fn broker_tool_to_mcp(tool: BrokerTool) -> Result<Tool, ErrorData> {
    let schema = tool
        .input_schema
        .as_object()
        .cloned()
        .ok_or_else(|| ErrorData::internal_error("invalid registered tool schema", None))?;
    let annotations = McpToolAnnotations::from_raw(
        None,
        tool.annotations.read_only_hint,
        tool.annotations.destructive_hint,
        tool.annotations.idempotent_hint,
        tool.annotations.open_world_hint,
    );
    Ok(Tool::new_with_raw(
        Cow::Owned(tool.name),
        Some(Cow::Owned(tool.description)),
        Arc::new(schema),
    )
    .with_annotations(annotations))
}

fn broker_error_to_mcp(error: BrokerError) -> ErrorData {
    match error.kind() {
        BrokerErrorKind::UnknownTool
        | BrokerErrorKind::InvalidArguments
        | BrokerErrorKind::ArgumentsTooLarge => {
            ErrorData::invalid_params(error.message().to_string(), None)
        }
        BrokerErrorKind::Internal | BrokerErrorKind::ConsumerUnavailable => {
            ErrorData::internal_error(error.message().to_string(), None)
        }
        _ => ErrorData::invalid_request(error.message().to_string(), None),
    }
}

fn resolution_to_mcp(resolution: LocalToolResolution) -> CallToolResult {
    let mut content = resolution
        .content
        .unwrap_or_default()
        .into_iter()
        .map(content_block)
        .collect::<Vec<_>>();
    if content.is_empty() {
        content.push(ContentBlock::text(resolution.text));
    }
    let mut result = if resolution.is_error.unwrap_or(false) {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    };
    result.structured_content = resolution.structured_content;
    result
}

fn content_block(content: LocalToolContent) -> ContentBlock {
    match content {
        LocalToolContent::Text { text } => ContentBlock::text(text),
        LocalToolContent::Image { data, mime_type } => ContentBlock::image(data, mime_type),
        LocalToolContent::Audio { data, mime_type } => ContentBlock::audio(data, mime_type),
        LocalToolContent::Resource {
            uri,
            mime_type,
            text,
            blob,
        } => {
            let resource = if let Some(text) = text {
                ResourceContents::text(text, uri)
            } else {
                ResourceContents::blob(blob.unwrap_or_default(), uri)
            };
            ContentBlock::resource(match mime_type {
                Some(mime_type) => resource.with_mime_type(mime_type),
                None => resource,
            })
        }
        LocalToolContent::ResourceLink {
            uri,
            name,
            title,
            description,
            mime_type,
            size,
        } => {
            let mut resource = Resource::new(uri, name);
            if let Some(title) = title {
                resource = resource.with_title(title);
            }
            if let Some(description) = description {
                resource = resource.with_description(description);
            }
            if let Some(mime_type) = mime_type {
                resource = resource.with_mime_type(mime_type);
            }
            if let Some(size) = size {
                resource = resource.with_size(size);
            }
            ContentBlock::resource_link(resource)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiToolCatalogResponse {
    version: u8,
    run_id: String,
    tools: Vec<BrokerTool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiCallRequest {
    name: String,
    arguments: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PiCallResponse {
    version: u8,
    result: LocalToolResolution,
}

#[derive(Serialize)]
struct PiErrorEnvelope {
    error: PiErrorBody,
}

#[derive(Serialize)]
struct PiErrorBody {
    code: &'static str,
    message: String,
}

async fn pi_tools(State(broker): State<ToolBroker>, headers: HeaderMap) -> Response {
    let authorization = authorization_from_headers(&headers);
    match broker.catalog(authorization) {
        Ok(catalog) => Json(PiToolCatalogResponse {
            version: 1,
            run_id: catalog.run_id,
            tools: catalog.tools,
        })
        .into_response(),
        Err(error) => pi_error_response(error),
    }
}

async fn pi_call(
    State(broker): State<ToolBroker>,
    headers: HeaderMap,
    Json(request): Json<PiCallRequest>,
) -> Response {
    let authorization = authorization_from_headers(&headers);
    match broker
        .call(authorization, request.name, request.arguments)
        .await
    {
        Ok(result) => Json(PiCallResponse { version: 1, result }).into_response(),
        Err(error) => pi_error_response(error),
    }
}

fn authorization_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

fn pi_error_response(error: BrokerError) -> Response {
    let status = match error.kind() {
        BrokerErrorKind::MissingBearer | BrokerErrorKind::InvalidBearer => StatusCode::UNAUTHORIZED,
        BrokerErrorKind::UnknownTool => StatusCode::FORBIDDEN,
        BrokerErrorKind::InvalidArguments => StatusCode::BAD_REQUEST,
        BrokerErrorKind::ArgumentsTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        BrokerErrorKind::BudgetExhausted => StatusCode::TOO_MANY_REQUESTS,
        BrokerErrorKind::RunCancelled | BrokerErrorKind::PendingCancelled => StatusCode::CONFLICT,
        BrokerErrorKind::TimedOut => StatusCode::GATEWAY_TIMEOUT,
        BrokerErrorKind::ResultTooLarge => StatusCode::BAD_GATEWAY,
        BrokerErrorKind::ConsumerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        BrokerErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let body = PiErrorEnvelope {
        error: PiErrorBody {
            code: error.code(),
            message: error.message().to_string(),
        },
    };
    (status, Json(body)).into_response()
}

struct BridgeRuntime {
    mcp_url: String,
    cancellation: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

pub struct ToolBridge {
    broker: ToolBroker,
    runtime: tokio::sync::Mutex<Option<BridgeRuntime>>,
}

impl Default for ToolBridge {
    fn default() -> Self {
        Self {
            broker: ToolBroker::default(),
            runtime: tokio::sync::Mutex::new(None),
        }
    }
}

/// Only requests addressed to the bridge's own loopback authority are served,
/// so a bearer token that leaks into a browser or DNS-rebinding context cannot
/// be replayed against it.
fn require_loopback_host(headers: &HeaderMap, uri: &axum::http::Uri, port: u16) -> bool {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            uri.authority()
                .map(|authority| authority.as_str().to_owned())
        });
    host.is_some_and(|host| {
        host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
    })
}

impl ToolBridge {
    async fn ensure_started(&self) -> Result<String, String> {
        let mut runtime = self.runtime.lock().await;
        if let Some(runtime) = runtime.as_ref() {
            return Ok(runtime.mcp_url.clone());
        }

        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("failed to bind local tool bridge: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("failed to read local tool bridge address: {error}"))?;
        let cancellation = CancellationToken::new();
        let service_broker = self.broker.clone();
        let service: StreamableHttpService<OpenBuilderToolServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || {
                    Ok(OpenBuilderToolServer {
                        broker: service_broker.clone(),
                    })
                },
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_sse_keep_alive(None)
                    .with_cancellation_token(cancellation.child_token()),
            );
        let port = address.port();
        let router = axum::Router::new()
            .route("/pi/tools", get(pi_tools))
            .route("/pi/call", post(pi_call))
            .nest_service("/mcp", service)
            .layer(DefaultBodyLimit::max(MAX_ARGUMENT_BYTES + 64 * 1024))
            .with_state(self.broker.clone())
            .layer(axum::middleware::from_fn(
                move |request: axum::extract::Request, next: axum::middleware::Next| async move {
                    if require_loopback_host(request.headers(), request.uri(), port) {
                        next.run(request).await
                    } else {
                        StatusCode::FORBIDDEN.into_response()
                    }
                },
            ));
        let server_cancellation = cancellation.clone();
        let task = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    server_cancellation.cancelled_owned().await;
                })
                .await;
        });
        let mcp_url = format!("http://127.0.0.1:{}/mcp", address.port());
        *runtime = Some(BridgeRuntime {
            mcp_url: mcp_url.clone(),
            cancellation,
            task,
        });
        Ok(mcp_url)
    }

    pub async fn register(
        &self,
        run_id: String,
        tools: Vec<LocalToolSpec>,
        max_tool_calls: usize,
        cancellation: CancellationToken,
        channel: TrackedChannel,
    ) -> Result<(String, String), String> {
        let mcp_url = self.ensure_started().await?;
        let token = self
            .broker
            .register(run_id, tools, max_tool_calls, cancellation, channel)?;
        Ok((mcp_url, token))
    }

    pub fn resolve(
        &self,
        run_id: &str,
        call_id: &str,
        result: LocalToolResolution,
    ) -> Result<(), String> {
        self.broker.resolve(run_id, call_id, result)
    }

    pub fn claim_pending_tool(
        &self,
        run_id: &str,
        call_id: &str,
        expected_name: &str,
    ) -> Result<CancellationToken, String> {
        self.broker
            .claim_pending_tool(run_id, call_id, expected_name)
    }

    pub fn unregister(&self, run_id: &str, reason: &str) {
        self.broker.unregister(run_id, reason);
    }

    pub fn shutdown_now(&self) {
        self.broker.shutdown("application exiting");
        if let Ok(mut runtime) = self.runtime.try_lock() {
            if let Some(runtime) = runtime.take() {
                runtime.cancellation.cancel();
                runtime.task.abort();
            }
        }
    }
}

impl Drop for ToolBridge {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::ipc::InvokeResponseBody;
    use tokio::sync::mpsc;

    use super::*;
    use crate::local_agent::LocalAgentEvent;

    fn tool(name: &str) -> LocalToolSpec {
        LocalToolSpec {
            name: name.to_string(),
            description: format!("{name} description"),
            input_schema: json!({"type": "object"}),
            annotations: Default::default(),
            host_approval: Default::default(),
        }
    }

    fn channel() -> (
        tauri::ipc::Channel<LocalAgentEvent>,
        mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
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

    #[test]
    fn publishes_host_authority_annotations_to_mcp_clients() {
        let mut spec = tool("write_file");
        spec.annotations = crate::local_agent::LocalToolAnnotations {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            idempotent_hint: Some(false),
            open_world_hint: Some(false),
        };
        spec.host_approval = crate::local_agent::LocalToolHostApproval::PerCall;
        let tool = broker_tool_to_mcp(BrokerTool::from(spec)).unwrap();
        let annotations = tool.annotations.expect("annotations must be projected");
        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.destructive_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }

    #[test]
    fn mcp_adapter_preserves_tool_and_result_shapes() {
        let broker_tool = BrokerTool {
            name: "read".to_string(),
            description: "Read a value".to_string(),
            input_schema: json!({"type": "object", "required": ["key"]}),
            annotations: Default::default(),
            host_approval: Default::default(),
        };
        let mcp_tool = broker_tool_to_mcp(broker_tool).unwrap();
        assert_eq!(mcp_tool.name, "read");
        assert_eq!(mcp_tool.input_schema["required"], json!(["key"]));

        let result = resolution_to_mcp(LocalToolResolution {
            text: "fallback".to_string(),
            is_error: Some(false),
            structured_content: Some(json!({"value": 1})),
            content: Some(vec![LocalToolContent::Text {
                text: "done".to_string(),
            }]),
        });
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.structured_content, Some(json!({"value": 1})));
        assert_eq!(result.content.len(), 1);
    }

    #[tokio::test]
    async fn bridge_rejects_requests_for_foreign_hosts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let bridge = ToolBridge::default();
        let (channel, _events) = channel();
        let (mcp_url, token) = bridge
            .register(
                "host-run".to_string(),
                vec![tool("allowed")],
                2,
                CancellationToken::new(),
                channel.into(),
            )
            .await
            .unwrap();
        let authority = mcp_url
            .strip_prefix("http://")
            .and_then(|rest| rest.strip_suffix("/mcp"))
            .unwrap();

        let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /pi/tools HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    }

    #[tokio::test]
    async fn pi_transport_requires_bearer_and_round_trips_calls() {
        let bridge = ToolBridge::default();
        let (channel, mut events) = channel();
        let (mcp_url, token) = bridge
            .register(
                "pi-run".to_string(),
                vec![tool("allowed")],
                2,
                CancellationToken::new(),
                channel.into(),
            )
            .await
            .unwrap();
        let origin = mcp_url.strip_suffix("/mcp").unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        let unauthorized = client
            .get(format!("{origin}/pi/tools"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let catalog_response = client
            .get(format!("{origin}/pi/tools"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let catalog: serde_json::Value =
            serde_json::from_str(&catalog_response.text().await.unwrap()).unwrap();
        assert_eq!(catalog["version"], 1);
        assert_eq!(catalog["runId"], "pi-run");
        assert_eq!(catalog["tools"][0]["name"], "allowed");

        let call = {
            let client = client.clone();
            let url = format!("{origin}/pi/call");
            let token = token.clone();
            tokio::spawn(async move {
                client
                    .post(url)
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(json!({"name": "allowed", "arguments": {"value": 1}}).to_string())
                    .send()
                    .await
                    .unwrap()
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["type"], "toolRequest");
        bridge
            .resolve(
                event["runId"].as_str().unwrap(),
                event["callId"].as_str().unwrap(),
                LocalToolResolution {
                    text: "ok".to_string(),
                    is_error: Some(false),
                    structured_content: Some(json!({"answer": 42})),
                    content: None,
                },
            )
            .unwrap();
        let response = call.await.unwrap().error_for_status().unwrap();
        let response: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(response["result"]["text"], "ok");
        assert_eq!(response["result"]["structuredContent"]["answer"], 42);
    }

    async fn mcp_json(response: reqwest::Response) -> serde_json::Value {
        let text = response.error_for_status().unwrap().text().await.unwrap();
        if let Ok(value) = serde_json::from_str(&text) {
            return value;
        }
        text.lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(str::trim)
                    .filter(|data| !data.is_empty())
            })
            .find_map(|data| serde_json::from_str(data).ok())
            .expect("MCP response must contain JSON or a JSON SSE data event")
    }

    #[tokio::test]
    async fn streamable_http_mcp_round_trips_host_tool_authority() {
        let bridge = ToolBridge::default();
        let (channel, mut events) = channel();
        let mut allowed = tool("write_file");
        allowed.annotations = crate::local_agent::LocalToolAnnotations {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            idempotent_hint: Some(false),
            open_world_hint: Some(false),
        };
        let (mcp_url, token) = bridge
            .register(
                "mcp-run".to_string(),
                vec![allowed],
                1,
                CancellationToken::new(),
                channel.into(),
            )
            .await
            .unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let initialize = client
            .post(&mcp_url)
            .bearer_auth(&token)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(
                json!({
                    "jsonrpc":"2.0",
                    "id":1,
                    "method":"initialize",
                    "params":{
                        "protocolVersion":"2025-06-18",
                        "capabilities":{},
                        "clientInfo":{"name":"open-builder-contract","version":"1"}
                    }
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap();
        let session = initialize
            .headers()
            .get("mcp-session-id")
            .expect("stateful MCP initialize must return a session id")
            .to_str()
            .unwrap()
            .to_string();
        let initialized = mcp_json(initialize).await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");

        client
            .post(&mcp_url)
            .bearer_auth(&token)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header("mcp-session-id", &session)
            .header("mcp-protocol-version", "2025-06-18")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(
                json!({
                    "jsonrpc":"2.0",
                    "method":"notifications/initialized",
                    "params":{}
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();

        let listed = mcp_json(
            client
                .post(&mcp_url)
                .bearer_auth(&token)
                .header(
                    reqwest::header::ACCEPT,
                    "application/json, text/event-stream",
                )
                .header("mcp-session-id", &session)
                .header("mcp-protocol-version", "2025-06-18")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}).to_string())
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(listed["result"]["tools"][0]["name"], "write_file");
        assert_eq!(
            listed["result"]["tools"][0]["annotations"]["destructiveHint"],
            true
        );

        let call = {
            let client = client.clone();
            let mcp_url = mcp_url.clone();
            let token = token.clone();
            let session = session.clone();
            tokio::spawn(async move {
                mcp_json(
                    client
                        .post(mcp_url)
                        .bearer_auth(token)
                        .header(
                            reqwest::header::ACCEPT,
                            "application/json, text/event-stream",
                        )
                        .header("mcp-session-id", session)
                        .header("mcp-protocol-version", "2025-06-18")
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(
                            json!({
                                "jsonrpc":"2.0",
                                "id":3,
                                "method":"tools/call",
                                "params":{"name":"write_file","arguments":{"path":"safe.txt"}}
                            })
                            .to_string(),
                        )
                        .send()
                        .await
                        .unwrap(),
                )
                .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["type"], "toolRequest");
        assert_eq!(event["name"], "write_file");
        bridge
            .resolve(
                event["runId"].as_str().unwrap(),
                event["callId"].as_str().unwrap(),
                LocalToolResolution {
                    text: "written by Host".to_string(),
                    is_error: Some(false),
                    structured_content: Some(json!({"written":true})),
                    content: None,
                },
            )
            .unwrap();
        let called = call.await.unwrap();
        assert_eq!(called["result"]["isError"], false);
        assert_eq!(called["result"]["structuredContent"]["written"], true);
        bridge.unregister("mcp-run", "contract complete");
    }

    #[tokio::test]
    async fn pi_transport_rejects_unknown_tools() {
        let bridge = ToolBridge::default();
        let (channel, _) = channel();
        let (mcp_url, token) = bridge
            .register(
                "pi-run".to_string(),
                vec![tool("allowed")],
                1,
                CancellationToken::new(),
                channel.into(),
            )
            .await
            .unwrap();
        let origin = mcp_url.strip_suffix("/mcp").unwrap();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{origin}/pi/call"))
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(json!({"name": "forbidden", "arguments": {}}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "unknown_tool");
    }
}
