#!/usr/bin/env python3
"""Main-transport fixture; never performs a model request or touches user state."""
import json, os, sys, time
mode = "FIXTURE_MODE"
args = sys.argv[1:]
if mode == "utility":
    probe_output = None
    if args == ["--version"]: probe_output = "codex 0.163.0-fixture"
    elif args == ["exec", "--help"]: probe_output = "--json --ignore-user-config --ignore-rules --sandbox --cd"
    elif args == ["exec", "resume", "--help"]: probe_output = "--json --ignore-user-config --ignore-rules"
    elif "mcp" in args and "get" in args: probe_output = "default_tools_approval_mode: approve\nenabled_tools: open_builder_capability_probe"
    elif args == ["login", "status"]: probe_output = "Logged in using ChatGPT"
    elif args == ["debug", "models", "--bundled"]:
        probe_output = json.dumps({"models":[
            {"slug":"default-model", "is_default":True, "default_reasoning_level":"high", "supported_reasoning_levels":["high","low","medium"]},
            {"slug":"chosen-model", "default_reasoning_level":"high", "supported_reasoning_levels":["high","medium"]}
        ]})
    if probe_output is not None:
        print(probe_output); sys.exit(0)
if "--help" in args:
    if mode == "old":
        print("error: unrecognized subcommand 'app-server'"); sys.exit(2)
    if mode == "permission":
        print("permission denied"); sys.exit(1)
    if mode == "unknown-failure":
        print("unexpected failure"); sys.exit(1)
    print("--stdio" if mode == "unsupported-help" else "--stdio --strict-config generate-json-schema"); sys.exit(0)
if "generate-json-schema" in args:
    if mode == "schema-failure": sys.exit(1)
    directory=args[args.index("--out")+1]
    def methods(names): return [{"properties":{"method":{"enum":[name]}}} for name in names]
    def fields(names): return {"properties":{name:{} for name in names}}
    requests={"oneOf":methods(["initialize","config/read","thread/start","thread/resume","turn/start"]),"definitions":{
        "ThreadStartParams":fields(["model","approvalPolicy","sandbox","baseInstructions","developerInstructions","config","dynamicTools","experimentalRawEvents"]),
        "ThreadResumeParams":fields(["threadId","model","approvalPolicy","sandbox","baseInstructions","developerInstructions","config"]),
        "TurnStartParams":fields(["threadId","input","model","effort","summary","sandboxPolicy"])}}
    notifications={"oneOf":methods(["thread/started","turn/started","turn/completed","item/started","item/completed","item/agentMessage/delta","item/reasoning/summaryTextDelta"]),"definitions":{
        "AgentMessageDeltaNotification":fields(["threadId","turnId","itemId","delta"]),
        "ReasoningSummaryTextDeltaNotification":fields(["threadId","turnId","itemId","summaryIndex","delta"])}}
    if mode == "missing-summary": del requests["definitions"]["TurnStartParams"]["properties"]["summary"]
    for name,value in [("ClientRequest.json",requests),("ServerNotification.json",notifications)]:
        with open(os.path.join(directory,name),"w") as handle:json.dump(value,handle)
    sys.exit(0)
if args and args[0] == "exec":
    open("exec-started", "w").close(); sys.exit(1)
features = ["shell_tool", "unified_exec", "hooks", "multi_agent", "multi_agent_v2", "apps", "plugins", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "in_app_browser", "js_repl", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "view_image"]
config = {"approval_policy":"never", "sandbox_mode":"read-only", "instructions":"", "developer_instructions":"", "project_doc_max_bytes":0, "notify":[], "features":{key:False for key in features}, "mcp_servers":{"open_builder":{"url":"http://127.0.0.1:34567/mcp", "bearer_token_env_var":"OPEN_BUILDER_MCP_TOKEN", "default_tools_approval_mode":"approve", "required":True, "enabled_tools":[]}, "user-server":{"enabled":not any('"user-server"={enabled=false}' in arg for arg in args)}}}
selection = {"model":"selected-model", "model_reasoning_effort":"high"}
if mode == "utility":
    for index, arg in enumerate(args[:-1]):
        if arg == "-c" and "=" in args[index + 1]:
            key, value = args[index + 1].split("=", 1)
            if key in selection: selection[key] = json.loads(value)
    with open("utility-process-selection", "w") as handle: json.dump(selection, handle)
def send(value, split=False):
    encoded = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    if split:
        # Deliberately split a multibyte character across separate pipe writes.
        i = encoded.index("你".encode()) + 1
        os.write(1, encoded[:i]); time.sleep(.01); os.write(1, encoded[i:])
    else:
        os.write(1, encoded)
def notify(method, **params):
    send({"method":method, "params":{"threadId":"thread-1", "turnId":"turn-1", **params}})
for line in sys.stdin:
    message = json.loads(line); method = message.get("method")
    if method == "initialized": continue
    request_id = message["id"]
    if method == "initialize": send({"id":request_id,"result":{}})
    elif method == "config/read":
        if mode == "isolation-mismatch": config["sandbox_mode"]="workspace-write"
        send({"id":request_id,"result":{"config":config}})
    elif method in ("thread/start", "thread/resume"):
        if method == "thread/start": notify("thread/started", thread={"id":"thread-1"})
        else:
            send({"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"historical-turn","tokenUsage":{"last":{"inputTokens":99999,"outputTokens":99999}}}})
        send({"id":request_id,"result":{"approvalPolicy":"never","sandbox":{"type":"readOnly"},"model":selection["model"],"reasoningEffort":selection["model_reasoning_effort"],"thread":{"id":"thread-1"}}})
    elif method == "turn/start":
        if mode == "utility":
            with open("utility-turn-selection", "w") as handle: json.dump(message["params"], handle)
        with open("sent-turns", "a") as handle: handle.write("1\n")
        if mode == "fail-after-send": sys.exit(1)
        if mode == "approval-request":
            send({"id":99,"method":"item/commandExecution/requestApproval","params":{"sentinel":"must not surface"}})
            time.sleep(60)
        notify("turn/started",turn={"id":"turn-1","status":"inProgress"})
        notify("item/started",item={"id":"r","type":"reasoning","summary":[]})
        notify("item/reasoning/summaryTextDelta",itemId="r",summaryIndex=0,delta="first ")
        notify("item/reasoning/summaryTextDelta",itemId="r",summaryIndex=1,delta="second")
        notify("item/completed",item={"id":"r","type":"reasoning","summary":["first ","second"]})
        notify("item/started",item={"id":"a","type":"agentMessage","text":""})
        send({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"a","delta":"你好🌍"}},split=True)
        if mode == "hang": time.sleep(60)
        # Text is observable before the request response and before the turn ends.
        if mode == "success":
            deadline = time.monotonic() + 5
            while not os.path.exists("observer-saw-delta"):
                if time.monotonic() > deadline: sys.exit(3)
                time.sleep(.005)
        open("response-sent", "w").close()
        send({"id":request_id,"result":{"turn":{"id":"turn-1","status":"inProgress"}}})
        notify("item/completed",item={"id":"a","type":"agentMessage","text":"你好🌍!"})
        notify("turn/completed",turn={"id":"turn-1","status":"completed"})
