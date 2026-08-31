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
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::{
    streamable_http_server::session::local::LocalSessionManager, StreamableHttpServerConfig,
    StreamableHttpService,
};
use rmcp::{ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{LocalAgentEvent, LocalToolContent, LocalToolResolution, LocalToolSpec};

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
    Ok(Tool::new_with_raw(
        Cow::Owned(tool.name),
        Some(Cow::Owned(tool.description)),
        Arc::new(schema),
    ))
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
        let router = axum::Router::new()
            .route("/pi/tools", get(pi_tools))
            .route("/pi/call", post(pi_call))
            .nest_service("/mcp", service)
            .layer(DefaultBodyLimit::max(MAX_ARGUMENT_BYTES + 64 * 1024))
            .with_state(self.broker.clone());
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
        channel: tauri::ipc::Channel<LocalAgentEvent>,
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

    fn tool(name: &str) -> LocalToolSpec {
        LocalToolSpec {
            name: name.to_string(),
            description: format!("{name} description"),
            input_schema: json!({"type": "object"}),
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
    fn mcp_adapter_preserves_tool_and_result_shapes() {
        let broker_tool = BrokerTool {
            name: "read".to_string(),
            description: "Read a value".to_string(),
            input_schema: json!({"type": "object", "required": ["key"]}),
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
    async fn pi_transport_requires_bearer_and_round_trips_calls() {
        let bridge = ToolBridge::default();
        let (channel, mut events) = channel();
        let (mcp_url, token) = bridge
            .register(
                "pi-run".to_string(),
                vec![tool("allowed")],
                2,
                CancellationToken::new(),
                channel,
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
                channel,
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
