use std::env;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const HOST_TOOL: &str = "host_write_probe";
const HOST_RESULT: &str = "host-resolution-ok";

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn executable_mode() -> String {
    env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn json_string_field(value: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let mut start = value.find(&needle)? + needle.len();
    let bytes = value.as_bytes();
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    if bytes.get(start) != Some(&b':') {
        return None;
    }
    start += 1;
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    start += 1;
    let mut index = start;
    let mut result = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return Some(result),
            b'\\' => {
                index += 1;
                let escaped = *bytes.get(index)?;
                match escaped {
                    b'"' => result.push('"'),
                    b'\\' => result.push('\\'),
                    b'/' => result.push('/'),
                    b'n' => result.push('\n'),
                    b'r' => result.push('\r'),
                    b't' => result.push('\t'),
                    _ => return None,
                }
            }
            byte if byte.is_ascii() => result.push(byte as char),
            _ => return None,
        }
        index += 1;
    }
    None
}

fn argument_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
}

fn parse_loopback_url(url: &str) -> (String, String) {
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .expect("tool bridge URL must use isolated loopback HTTP");
    let (port, suffix) = rest
        .split_once('/')
        .expect("tool bridge URL must include a route");
    assert!(port.parse::<u16>().is_ok(), "tool bridge port is invalid");
    (format!("127.0.0.1:{port}"), format!("/{suffix}"))
}

fn decode_chunked(mut bytes: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::new();
    loop {
        let Some(line_end) = bytes.windows(2).position(|window| window == b"\r\n") else {
            panic!("tool bridge returned malformed chunked HTTP");
        };
        let size_text = std::str::from_utf8(&bytes[..line_end])
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let size = usize::from_str_radix(size_text.trim(), 16).unwrap();
        bytes = &bytes[line_end + 2..];
        if size == 0 {
            break;
        }
        assert!(bytes.len() >= size + 2, "tool bridge chunk was truncated");
        decoded.extend_from_slice(&bytes[..size]);
        assert_eq!(&bytes[size..size + 2], b"\r\n");
        bytes = &bytes[size + 2..];
    }
    decoded
}

fn http_request(
    method: &str,
    url: &str,
    bearer_token: &str,
    session: Option<&str>,
    body: Option<&str>,
) -> HttpResponse {
    let (authority, path) = parse_loopback_url(url);
    let body = body.unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {bearer_token}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(session) = session {
        request.push_str(&format!(
            "mcp-session-id: {session}\r\nmcp-protocol-version: 2025-06-18\r\n"
        ));
    }
    request.push_str("\r\n");
    request.push_str(body);

    let mut stream = TcpStream::connect(&authority).expect("tool bridge must be reachable");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    stream.flush().unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("tool bridge returned malformed HTTP");
    let header_text = std::str::from_utf8(&bytes[..header_end]).unwrap();
    let mut lines = header_text.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .expect("tool bridge returned no HTTP status");
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<Vec<_>>();
    let raw_body = &bytes[header_end + 4..];
    let body_bytes = if headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked(raw_body)
    } else {
        raw_body.to_vec()
    };
    HttpResponse {
        status,
        headers,
        body: String::from_utf8(body_bytes).unwrap(),
    }
}

fn require_success(response: &HttpResponse) {
    assert!(
        (200..300).contains(&response.status),
        "tool bridge returned HTTP {}",
        response.status
    );
}

fn mcp_tool_round_trip(url: &str, bearer_token: &str, provider: &str) {
    let initialize = http_request(
        "POST",
        url,
        bearer_token,
        None,
        Some(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"open-builder-fake-cli","version":"1"}}}"#,
        ),
    );
    require_success(&initialize);
    assert!(initialize.body.contains("2025-06-18"));
    let session = initialize
        .headers
        .iter()
        .find_map(|(name, value)| (name == "mcp-session-id").then_some(value.as_str()))
        .expect("MCP initialize must return a session id")
        .to_string();

    let initialized = http_request(
        "POST",
        url,
        bearer_token,
        Some(&session),
        Some(r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#),
    );
    require_success(&initialized);

    let listed = http_request(
        "POST",
        url,
        bearer_token,
        Some(&session),
        Some(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#),
    );
    require_success(&listed);
    assert!(
        listed.body.contains(&format!(r#""name":"{HOST_TOOL}""#)),
        "private MCP catalog omitted the exact host tool"
    );

    let call_body = format!(
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"{HOST_TOOL}","arguments":{{"provider":"{}"}}}}}}"#,
        json_escape(provider)
    );
    let called = http_request("POST", url, bearer_token, Some(&session), Some(&call_body));
    require_success(&called);
    assert!(
        called.body.contains(HOST_RESULT),
        "private MCP call did not receive the Host resolution"
    );
}

fn pi_tool_round_trip(tools_url: &str, call_url: &str, bearer_token: &str) {
    let listed = http_request("GET", tools_url, bearer_token, None, None);
    require_success(&listed);
    assert!(
        listed.body.contains(&format!(r#""name":"{HOST_TOOL}""#)),
        "private Pi catalog omitted the exact host tool"
    );
    let call_body = format!(r#"{{"name":"{HOST_TOOL}","arguments":{{"provider":"pi"}}}}"#);
    let called = http_request("POST", call_url, bearer_token, None, Some(&call_body));
    require_success(&called);
    assert!(
        called.body.contains(HOST_RESULT),
        "private Pi call did not receive the Host resolution"
    );
}

fn write_invocation_log(args: &[String], stdin: &str) {
    let Some(root) = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
    else {
        return;
    };
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut environment_names = env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    environment_names.sort();
    let _ = fs::write(
        root.join("provider-invocation.log"),
        format!(
            "cwd={}\nenv={}\nargs={}\nstdin={}",
            cwd.display(),
            environment_names.join(","),
            args.join("\u{1f}"),
            stdin
        ),
    );
}

fn write_fragmented(stdout: &mut impl Write, value: &str) {
    let split = value.len().max(2) / 2;
    stdout.write_all(&value.as_bytes()[..split]).unwrap();
    stdout.flush().unwrap();
    thread::sleep(Duration::from_millis(2));
    stdout.write_all(&value.as_bytes()[split..]).unwrap();
    stdout.flush().unwrap();
}

fn emit_contract_failure(mode: &str, stdout: &mut impl Write) -> bool {
    if mode.contains("stderr-approval") {
        eprintln!("MCP tool call requires approval, but approval policy is never");
        thread::sleep(Duration::from_millis(50));
        return true;
    }
    if mode.contains("nonzero") {
        std::process::exit(17);
    }
    if mode.contains("malformed") {
        stdout.write_all(b"not-json\n").unwrap();
        stdout.flush().unwrap();
        return true;
    }
    if mode.contains("oversized") {
        stdout.write_all(&vec![b'x'; 4 * 1024 * 1024 + 1]).unwrap();
        stdout.flush().unwrap();
        return true;
    }
    false
}

fn resume_value(args: &[String], flag: &str, fallback: &str) -> String {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
        .unwrap_or_else(|| fallback.to_string())
}

fn run_codex(mode: &str, args: &[String]) {
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin).unwrap();
    write_invocation_log(args, &stdin);
    let session = if args.get(1).is_some_and(|value| value == "resume") {
        args.iter()
            .rev()
            .find(|value| value.as_str() != "-")
            .cloned()
            .unwrap_or_else(|| "fake-codex-thread".to_string())
    } else {
        "fake-codex-thread".to_string()
    };
    let mut stdout = io::stdout().lock();
    if emit_contract_failure(mode, &mut stdout) {
        return;
    }
    write_fragmented(
        &mut stdout,
        &format!(
            "{{\"type\":\"thread.started\",\"thread_id\":\"{}\"}}\n",
            json_escape(&session)
        ),
    );
    if mode.contains("stdout-approval") {
        stdout
            .write_all(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"approval-1\",\"type\":\"error\",\"message\":\"MCP tool call requires approval, but approval policy is never\"}}\n")
            .unwrap();
        stdout.flush().unwrap();
        return;
    }
    stdout
        .write_all(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"diagnostic-1\",\"type\":\"error\",\"message\":\"redacted startup diagnostic\"}}\n")
        .unwrap();
    stdout.write_all(b"{\"type\":\"turn.started\"}\n").unwrap();
    if mode.contains("unknown") {
        stdout
            .write_all(b"{\"type\":\"permission_request\",\"command\":\"write_file\"}\n")
            .unwrap();
        stdout.flush().unwrap();
        return;
    }
    if mode.contains("resource-discovery") {
        for (tool, key) in [("list_mcp_resources", "resources"), ("list_mcp_resource_templates", "resourceTemplates")] {
            let payload = json_escape(&format!("{{\"{key}\":[]}}"));
            writeln!(stdout, "{{\"type\":\"item.started\",\"item\":{{\"id\":\"{tool}\",\"type\":\"mcp_tool_call\",\"server\":\"codex\",\"tool\":\"{tool}\",\"arguments\":{{}},\"result\":null,\"error\":null,\"status\":\"in_progress\"}}}}").unwrap();
            writeln!(stdout, "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"{tool}\",\"type\":\"mcp_tool_call\",\"server\":\"codex\",\"tool\":\"{tool}\",\"arguments\":{{}},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{payload}\"}}],\"structured_content\":null}},\"error\":null,\"status\":\"completed\"}}}}").unwrap();
        }
        stdout.flush().unwrap();
    }
    if args.iter().any(|arg| arg.contains(HOST_TOOL)) {
        let mcp_config = args
            .iter()
            .find(|arg| arg.starts_with("mcp_servers={open_builder="))
            .expect("Codex fake contract omitted its MCP configuration");
        let url = mcp_config
            .split_once("url=\"")
            .and_then(|(_, value)| value.split_once('"').map(|(url, _)| url))
            .expect("Codex fake contract omitted its MCP URL");
        let token = env::var("OPEN_BUILDER_MCP_TOKEN").unwrap();
        stdout
            .write_all(
                format!(
                    "{{\"type\":\"item.started\",\"item\":{{\"id\":\"host-1\",\"type\":\"mcp_tool_call\",\"server\":\"open_builder\",\"tool\":\"{HOST_TOOL}\",\"status\":\"in_progress\"}}}}\n"
                )
                .as_bytes(),
            )
            .unwrap();
        stdout.flush().unwrap();
        mcp_tool_round_trip(url, &token, "codex");
        stdout
            .write_all(
                format!(
                    "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"host-1\",\"type\":\"mcp_tool_call\",\"server\":\"open_builder\",\"tool\":\"{HOST_TOOL}\",\"status\":\"completed\",\"result\":\"{HOST_RESULT}\"}}}}\n"
                )
                .as_bytes(),
            )
            .unwrap();
    }
    stdout
        .write_all(b"{\"type\":\"item.started\",\"item\":{\"id\":\"search-1\",\"type\":\"web_search_call\",\"query\":\"verified run\"}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"search-1\",\"type\":\"web_search_call\",\"results\":[{\"url\":\"https://example.test\"}]}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"reason-1\",\"type\":\"reasoning\",\"text\":\"checked\"}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"text-1\",\"type\":\"agent_message\",\"text\":\"codex answer\"}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"turn.completed\",\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"cached_input_tokens\":1}}\n")
        .unwrap();
    stdout.flush().unwrap();
}

fn run_claude(mode: &str, args: &[String]) {
    let mut input = String::new();
    io::stdin().lock().read_line(&mut input).unwrap();
    write_invocation_log(args, &input);
    let cwd = env::current_dir().unwrap();
    let session = resume_value(args, "--resume", "fake-claude-session");
    let has_host_tool = args
        .iter()
        .any(|arg| arg == "mcp__open_builder__host_write_probe");
    let mut stdout = io::stdout().lock();
    if emit_contract_failure(mode, &mut stdout) {
        return;
    }
    write_fragmented(
        &mut stdout,
        &format!(
            "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\",\"cwd\":\"{}\",\"permissionMode\":\"dontAsk\",\"tools\":[\"WebSearch\",\"WebFetch\"{}],\"mcp_servers\":{}}}\n",
            json_escape(&session),
            json_escape(&cwd.to_string_lossy()),
            if has_host_tool {
                ",\"mcp__open_builder__host_write_probe\""
            } else {
                ""
            },
            if has_host_tool {
                "[{\"name\":\"open_builder\",\"status\":\"connected\"}]"
            } else {
                "[]"
            }
        ),
    );
    if mode.contains("unknown") {
        stdout
            .write_all(b"{\"type\":\"permission_request\",\"name\":\"Bash\"}\n")
            .unwrap();
        stdout.flush().unwrap();
        return;
    }
    if has_host_tool {
        let config_path = argument_value(args, "--mcp-config")
            .expect("Claude fake contract omitted --mcp-config");
        let config = fs::read_to_string(config_path).unwrap();
        let url = json_string_field(&config, "url").unwrap();
        let token = env::var("OPEN_BUILDER_MCP_TOKEN").unwrap();
        stdout
            .write_all(
                format!(
                    "{{\"type\":\"tool_use\",\"id\":\"host-1\",\"name\":\"mcp__open_builder__{HOST_TOOL}\",\"input\":{{\"provider\":\"claude\"}}}}\n"
                )
                .as_bytes(),
            )
            .unwrap();
        stdout.flush().unwrap();
        mcp_tool_round_trip(&url, &token, "claude");
        stdout
            .write_all(
                format!(
                    "{{\"type\":\"tool_result\",\"tool_use_id\":\"host-1\",\"content\":\"{HOST_RESULT}\"}}\n"
                )
                .as_bytes(),
            )
            .unwrap();
    }
    stdout
        .write_all(b"{\"type\":\"system\",\"subtype\":\"api_retry\",\"attempt\":1,\"error\":\"rate_limit\",\"retry_delay_ms\":1}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"checked\"}}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"server_tool_use\",\"id\":\"search-1\",\"name\":\"WebSearch\",\"input\":{\"query\":\"verified run\"}}}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"web_search_tool_result\",\"tool_use_id\":\"search-1\",\"content\":[{\"url\":\"https://example.test\"}]}}}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"text_delta\",\"text\":\"claude answer\"}}}\n")
        .unwrap();
    stdout
        .write_all(
            format!(
                "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"{}\",\"result\":\"done\",\"usage\":{{\"input_tokens\":4,\"output_tokens\":2}}}}\n",
                json_escape(&session)
            )
            .as_bytes(),
        )
        .unwrap();
    stdout.flush().unwrap();
}

fn response(id: &str, command: &str, data: &str) -> String {
    format!(
        "{{\"type\":\"response\",\"id\":\"{}\",\"command\":\"{}\",\"success\":true,\"data\":{data}}}\n",
        json_escape(id),
        json_escape(command)
    )
}

fn run_pi(mode: &str, args: &[String]) {
    if mode.ends_with("-installation") {
        let executable = env::current_exe().unwrap();
        let root = executable.parent().unwrap();
        if args == ["--version"] {
            print!("{}", fs::read_to_string(root.join("version.txt")).unwrap());
        } else if args == ["--help"] {
            println!("--mode --session-dir --session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve");
            if !root.join("missing-isolation").exists() {
                println!("--no-builtin-tools");
            }
        } else if args == ["auth", "check", "--help"] {
            println!("--json");
            if !root.join("missing-auth-option").exists() {
                println!("--no-refresh");
            }
        } else {
            panic!("unexpected installation probe arguments: {args:?}");
        }
        return;
    }
    let config_path = env::var("OPEN_BUILDER_PI_CONFIG").unwrap();
    let config = fs::read_to_string(config_path).unwrap();
    let attestation_nonce = json_string_field(&config, "attestationNonce").unwrap();
    let system_prompt_nonce = json_string_field(&config, "systemPromptNonce").unwrap();
    let expected_cwd = json_string_field(&config, "expectedCwd").unwrap();
    let extension_path = json_string_field(&config, "extensionPath").unwrap();
    let tool_digest = json_string_field(&config, "toolDigest").unwrap();
    let has_host_tool = config.contains(&format!("\"{HOST_TOOL}\""));
    let session = resume_value(args, "--session", "123e4567-e89b-12d3-a456-426614174000");
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();
    if emit_contract_failure(mode, &mut stdout) {
        return;
    }
    let mut transcript = String::new();
    let mut prompt_count = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            break;
        }
        transcript.push_str(&line);
        let id = json_string_field(&line, "id").unwrap_or_default();
        let command = json_string_field(&line, "type").unwrap_or_default();
        let data = match command.as_str() {
            "get_available_models" => {
                "{\"models\":[{\"provider\":\"openai\",\"id\":\"gpt-test\",\"name\":\"GPT Test\"}]}".to_string()
            }
            "get_state" => format!(
                "{{\"model\":{{\"provider\":\"openai\",\"id\":\"gpt-test\"}},\"thinkingLevel\":\"high\",\"sessionId\":\"{}\"}}",
                json_escape(&session)
            ),
            "get_available_thinking_levels" => {
                "{\"levels\":[\"low\",\"medium\",\"high\"]}".to_string()
            }
            _ => "{}".to_string(),
        };
        write_fragmented(&mut stdout, &response(&id, &command, &data));
        if command == "prompt" {
            prompt_count += 1;
            if prompt_count == 1 {
                let active_tools = if has_host_tool {
                    format!("[\"{HOST_TOOL}\"]")
                } else {
                    "[]".to_string()
                };
                let host_tool_inventory = if has_host_tool {
                    format!(
                        ",{{\"name\":\"{HOST_TOOL}\",\"sourceInfo\":{{\"path\":\"{}\",\"source\":\"cli\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}}",
                        json_escape(&extension_path)
                    )
                } else {
                    String::new()
                };
                let attestation = format!(
                    "{{\"type\":\"open_builder_pi_attestation\",\"version\":1,\"attestationNonce\":\"{}\",\"systemPromptNonce\":\"{}\",\"extensionPath\":\"{}\",\"cwd\":\"{}\",\"model\":{{\"provider\":\"openai\",\"id\":\"gpt-test\"}},\"providerAuth\":{{\"configured\":true,\"source\":\"stored\"}},\"thinkingLevel\":\"high\",\"activeTools\":{},\"allTools\":[{{\"name\":\"read\",\"sourceInfo\":{{\"path\":\"<builtin:read>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"bash\",\"sourceInfo\":{{\"path\":\"<builtin:bash>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"powershell\",\"sourceInfo\":{{\"path\":\"<builtin:powershell>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"edit\",\"sourceInfo\":{{\"path\":\"<builtin:edit>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"write\",\"sourceInfo\":{{\"path\":\"<builtin:write>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"grep\",\"sourceInfo\":{{\"path\":\"<builtin:grep>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"find\",\"sourceInfo\":{{\"path\":\"<builtin:find>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"ls\",\"sourceInfo\":{{\"path\":\"<builtin:ls>\",\"source\":\"builtin\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}}{}],\"extensions\":[{{\"path\":\"{}\",\"source\":\"cli\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}],\"contextFiles\":[],\"skills\":[],\"promptTemplates\":[],\"violations\":[],\"commands\":[{{\"name\":\"open-builder-attest\",\"sourceInfo\":{{\"path\":\"{}\",\"source\":\"cli\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}},{{\"name\":\"llama\",\"sourceInfo\":{{\"path\":\"<inline:llama.cpp>\",\"source\":\"inline\",\"scope\":\"temporary\",\"origin\":\"top-level\"}}}}],\"computedToolDigest\":\"{}\"}}",
                    json_escape(&attestation_nonce),
                    json_escape(&system_prompt_nonce),
                    json_escape(&extension_path),
                    json_escape(&expected_cwd),
                    active_tools,
                    host_tool_inventory,
                    json_escape(&extension_path),
                    json_escape(&extension_path),
                    json_escape(&tool_digest),
                );
                let notification = format!(
                    "{{\"type\":\"extension_ui_request\",\"method\":\"notify\",\"notifyType\":\"info\",\"message\":\"{}\"}}\n",
                    json_escape(&attestation)
                );
                write_fragmented(&mut stdout, &notification);
            } else if mode.contains("unknown") {
                write_fragmented(
                    &mut stdout,
                    "{\"type\":\"permission_request\",\"name\":\"bash\"}\n",
                );
            } else {
                stdout.write_all(b"{\"type\":\"agent_start\"}\n").unwrap();
                stdout
                    .write_all(
                        b"{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\"}}\n",
                    )
                    .unwrap();
                if has_host_tool {
                    stdout
                        .write_all(
                            format!(
                                "{{\"type\":\"message_update\",\"assistantMessageEvent\":{{\"type\":\"toolcall_start\",\"contentIndex\":0,\"toolName\":\"{HOST_TOOL}\"}}}}\n"
                            )
                            .as_bytes(),
                        )
                        .unwrap();
                    stdout
                        .write_all(
                            format!(
                                "{{\"type\":\"message_update\",\"assistantMessageEvent\":{{\"type\":\"toolcall_delta\",\"contentIndex\":0,\"toolName\":\"{HOST_TOOL}\",\"delta\":\"{{\\\"provider\\\":\\\"pi\\\"}}\"}}}}\n"
                            )
                            .as_bytes(),
                        )
                        .unwrap();
                    stdout.flush().unwrap();
                    let tools_url = json_string_field(&config, "toolsUrl").unwrap();
                    let call_url = json_string_field(&config, "callUrl").unwrap();
                    let token = json_string_field(&config, "bearerToken").unwrap();
                    pi_tool_round_trip(&tools_url, &call_url, &token);
                    stdout
                        .write_all(
                            format!(
                                "{{\"type\":\"message_update\",\"assistantMessageEvent\":{{\"type\":\"toolcall_end\",\"contentIndex\":0,\"toolCall\":{{\"name\":\"{HOST_TOOL}\"}}}}}}\n"
                            )
                            .as_bytes(),
                        )
                        .unwrap();
                }
                stdout
                    .write_all(b"{\"type\":\"message_update\",\"usage\":{\"input\":5,\"output\":1,\"cacheRead\":2},\"assistantMessageEvent\":{\"type\":\"thinking_delta\",\"delta\":\"checked\"}}\n")
                    .unwrap();
                stdout
                    .write_all(b"{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"pi answer\"}}\n")
                    .unwrap();
                stdout
                    .write_all(b"{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"pi answer\"}],\"stopReason\":\"stop\",\"usage\":{\"input\":5,\"output\":1,\"cacheRead\":2}}}\n")
                    .unwrap();
                stdout.write_all(b"{\"type\":\"agent_settled\"}\n").unwrap();
                stdout.flush().unwrap();
                break;
            }
        }
        if command == "abort" {
            break;
        }
    }
    write_invocation_log(args, &transcript);
}

fn run_antigravity(mode: &str, args: &[String]) {
    let cwd = env::current_dir().unwrap();
    let session = resume_value(
        args,
        "--conversation",
        "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
    );
    let model = resume_value(args, "--model", "gemini-3.5-flash-medium");
    let workspace = env::current_dir().unwrap();
    let agent = fs::read_to_string(
        workspace
            .join(".agents")
            .join("agents")
            .join("open-builder")
            .join("agent.md"),
    )
    .unwrap();
    let has_host_tool = agent.contains(HOST_TOOL);
    let mut stdout = io::stdout().lock();
    if emit_contract_failure(mode, &mut stdout) {
        return;
    }
    write_fragmented(
        &mut stdout,
        &format!(
            "{{\"event\":\"init\",\"conversation_id\":\"{}\",\"init\":{{\"cwd\":\"{}\",\"tools\":[\"{}\"],\"permission_mode\":\"strict\",\"model\":\"{}\",\"agent\":\"open-builder\"}}}}\n",
            json_escape(&session),
            json_escape(&cwd.to_string_lossy()),
            if has_host_tool {
                "mcp__open_builder__host_write_probe"
            } else {
                "read_url"
            },
            json_escape(&model)
        ),
    );
    let mut input = String::new();
    io::stdin().lock().read_line(&mut input).unwrap();
    write_invocation_log(args, &input);
    if mode.contains("unknown") {
        stdout
            .write_all(
                format!(
                    "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"permission_request\"}}}}\n",
                    json_escape(&session)
                )
                .as_bytes(),
            )
            .unwrap();
        stdout.flush().unwrap();
        return;
    }
    if has_host_tool {
        let config = fs::read_to_string(workspace.join(".agents").join("mcp_config.json")).unwrap();
        let url = json_string_field(&config, "serverUrl").unwrap();
        let authorization = json_string_field(&config, "Authorization").unwrap();
        let token = authorization
            .strip_prefix("Bearer ")
            .expect("Antigravity MCP authorization must use bearer auth");
        stdout
            .write_all(
                format!(
                    "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"tool\",\"tool_name\":\"mcp__open_builder__{HOST_TOOL}\",\"state\":\"ACTIVE\",\"step_index\":1,\"tool_info\":{{\"parameters\":{{\"provider\":\"antigravity\"}}}}}}}}\n",
                    json_escape(&session)
                )
                .as_bytes(),
            )
            .unwrap();
        stdout.flush().unwrap();
        mcp_tool_round_trip(&url, token, "antigravity");
        stdout
            .write_all(
                format!(
                    "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"tool\",\"tool_name\":\"mcp__open_builder__{HOST_TOOL}\",\"state\":\"DONE\",\"step_index\":1,\"tool_info\":{{\"parameters\":{{\"provider\":\"antigravity\"}},\"output\":{{\"text\":\"{HOST_RESULT}\"}}}}}}}}\n",
                    json_escape(&session)
                )
                .as_bytes(),
            )
            .unwrap();
    }
    stdout
        .write_all(
            format!(
                "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"thinking\",\"thinking_delta\":\"checked\"}}}}\n",
                json_escape(&session)
            )
            .as_bytes(),
        )
        .unwrap();
    if !has_host_tool {
        stdout
            .write_all(
                format!(
                    "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"tool\",\"tool_name\":\"read_url\",\"state\":\"DONE\",\"step_index\":1,\"tool_info\":{{\"parameters\":{{\"url\":\"https://example.test\"}},\"output\":{{\"ok\":true}}}}}}}}\n",
                    json_escape(&session)
                )
                .as_bytes(),
            )
            .unwrap();
    }
    stdout
        .write_all(
            format!(
                "{{\"event\":\"step_update\",\"step_update\":{{\"conversation_id\":\"{}\",\"step_type\":\"agent_response\",\"text_delta\":\"antigravity answer\"}}}}\n",
                json_escape(&session)
            )
            .as_bytes(),
        )
        .unwrap();
    stdout
        .write_all(
            format!(
                "{{\"event\":\"result\",\"result\":{{\"status\":\"SUCCESS\",\"conversation_id\":\"{}\",\"response\":\"done\",\"usage\":{{\"input_tokens\":6,\"output_tokens\":2,\"cache_read_tokens\":1}}}}}}\n",
                json_escape(&session)
            )
            .as_bytes(),
        )
        .unwrap();
    stdout.flush().unwrap();
}

fn run_legacy() {
    let mode = env::var("OPEN_BUILDER_FAKE_MODE").unwrap_or_else(|_| "success".to_string());
    if mode == "close-stdin" {
        return;
    }
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin).unwrap();

    if let Ok(log_path) = env::var("OPEN_BUILDER_FAKE_LOG") {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let args = env::args().skip(1).collect::<Vec<_>>().join("\u{1f}");
        fs::write(
            log_path,
            format!("cwd={}\nargs={}\nstdin={}", cwd.display(), args, stdin),
        )
        .unwrap();
    }

    eprintln!("Authorization: Bearer secret-stderr-sentinel");
    if mode == "delayed-exit" {
        thread::sleep(Duration::from_millis(200));
        return;
    }
    if mode == "wait" {
        thread::sleep(Duration::from_secs(30));
        return;
    }

    let mut stdout = io::stdout().lock();
    if mode == "malformed" {
        stdout.write_all(b"not-json\n").unwrap();
        stdout.flush().unwrap();
        return;
    }
    if mode == "oversized" {
        stdout.write_all(&vec![b'x'; 4 * 1024 * 1024 + 1]).unwrap();
        stdout.flush().unwrap();
        return;
    }
    stdout.write_all(b"{\"type\":\"thread.").unwrap();
    stdout.flush().unwrap();
    thread::sleep(Duration::from_millis(10));
    stdout
        .write_all(b"started\",\"thread_id\":\"fake-thread\"}\n")
        .unwrap();
    stdout
        .write_all(b"{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1}}\n")
        .unwrap();
    stdout.flush().unwrap();

    if mode == "nonzero" {
        std::process::exit(17);
    }
}

fn run_codex_probe(args: &[String]) {
    let root = env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let kind = if args == ["--version"] {
        "version"
    } else if args == ["exec", "--help"] {
        "exec-help"
    } else if args == ["exec", "resume", "--help"] {
        "resume-help"
    } else if args
        .windows(3)
        .any(|args| args == ["mcp", "get", "open_builder"])
    {
        "mcp"
    } else if args == ["login", "status"] {
        "login"
    } else if args == ["debug", "models", "--bundled"] {
        "models"
    } else {
        panic!("unexpected Codex probe arguments: {args:?}");
    };
    writeln!(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("probe-commands"))
            .unwrap(),
        "{kind}"
    )
    .unwrap();
    if fs::read_to_string(root.join("probe-fail")).ok().as_deref() == Some(kind) {
        std::process::exit(1);
    }
    match kind {
        "version" => println!(
            "{}",
            fs::read_to_string(root.join("probe-version"))
                .unwrap_or_else(|_| "codex 0.151.0-test".to_string())
        ),
        "exec-help" => println!("--json --ignore-user-config --ignore-rules --sandbox --cd"),
        "resume-help" => println!("--json --ignore-user-config --ignore-rules"),
        "mcp" => println!(
            "default_tools_approval_mode: approve\nenabled_tools: open_builder_capability_probe"
        ),
        "login" if root.join("probe-logged-out").exists() => {
            println!("Not logged in");
            std::process::exit(1);
        }
        "login" => println!("Logged in using ChatGPT"),
        "models" => println!(
            "{}",
            fs::read_to_string(root.join("probe-models")).unwrap_or_else(|_| {
                r#"{"models":[{"slug":"gpt-test","supported_reasoning_levels":["high"]}]}"#
                    .to_string()
            })
        ),
        _ => unreachable!(),
    }
}

fn main() {
    let mode = executable_mode();
    let args = env::args().skip(1).collect::<Vec<_>>();
    if mode.contains("codex-contract-probe") {
        run_codex_probe(&args);
    } else if mode.contains("codex-contract") {
        run_codex(&mode, &args);
    } else if mode.contains("claude-contract") {
        run_claude(&mode, &args);
    } else if mode.contains("pi-contract") {
        run_pi(&mode, &args);
    } else if mode.contains("antigravity-contract") {
        run_antigravity(&mode, &args);
    } else {
        run_legacy();
    }
}
