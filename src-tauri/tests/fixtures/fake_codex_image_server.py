#!/usr/bin/env python3
"""Image-only app-server fixture, including inherited configuration and artifacts."""
import json
import os
import pathlib
import sys
import time

root = pathlib.Path.cwd()
mode_path = root / 'fixture-mode'
mode = mode_path.read_text() if mode_path.exists() else 'success'
args = sys.argv[1:]
config = {'mcp_servers': {'legacy.server': {'enabled': True}}}
for index, arg in enumerate(args):
    if arg != '-c' or index + 1 == len(args):
        continue
    key, value = args[index + 1].split('=', 1)
    if key == 'mcp_servers':
        if '"legacy.server"={enabled=false}' in value:
            config['mcp_servers']['legacy.server']['enabled'] = False
        continue
    try:
        parsed = json.loads(value)
    except ValueError:
        continue
    if '.' in key:
        table, name = key.split('.', 1)
        config.setdefault(table, {})[name] = parsed
    else:
        config[key] = parsed
with (root / 'image-processes.jsonl').open('a') as log:
    log.write(json.dumps({'pid': os.getpid(), 'disabled': not config['mcp_servers']['legacy.server']['enabled']}) + '\n')

def emit(message):
    print(json.dumps(message), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    rid = request.get('id')
    if method == 'initialize':
        emit({'id': rid, 'result': {'userAgent': 'fake-codex'}})
    elif method == 'initialized':
        pass
    elif method == 'config/read':
        if mode == 'isolation-mismatch' and not config['mcp_servers']['legacy.server']['enabled']:
            config['web_search'] = 'live'
        emit({'id': rid, 'result': {'config': config}})
    elif method == 'modelProvider/capabilities/read':
        emit({'id': rid, 'result': {'imageGeneration': True, 'webSearch': True}})
    elif method == 'thread/start':
        assert not config['mcp_servers']['legacy.server']['enabled'], 'inherited MCP must be disabled before thread/start'
        (root / 'thread-started').write_text('yes')
        emit({'id': rid, 'result': {'thread': {'id': 'thread-1'}, 'model': 'wrong-model' if mode == 'selection-mismatch' else 'gpt-test', 'modelProvider': 'openai', 'reasoningEffort': config.get('model_reasoning_effort'), 'approvalPolicy': 'never', 'sandbox': {'type': 'dangerFullAccess' if mode == 'thread-permission-mismatch' else 'readOnly'}}})
    elif method == 'turn/start':
        emit({'id': rid, 'result': {'turn': {'id': 'turn-1', 'status': 'inProgress', 'items': [], 'error': None}}})
        (root / 'turn-started').write_text('yes')
        emit({'method': 'thread/settings/updated', 'params': {'threadId': 'thread-1', 'threadSettings': {'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'dangerFullAccess' if mode == 'permission-drift' else 'readOnly'}, 'model': 'gpt-test', 'effort': request['params'].get('effort')}}})
        emit({'method': 'thread/status/changed', 'params': {'threadId': 'thread-1', 'status': {'type': 'active'}}})
        emit({'method': 'thread/readState/changed', 'params': {'threadId': 'thread-1', 'readState': 'read'}})
        if mode == 'cancel':
            while True:
                time.sleep(1)
        if mode == 'unauthorized-tool':
            emit({'method': 'item/started', 'params': {'threadId': 'thread-1', 'turnId': 'turn-1', 'item': {'id': 'cmd', 'type': 'commandExecution'}}})
            continue
        output = pathlib.Path(os.environ['CODEX_HOME']) / 'generated_images' / 'thread-1' / 'image-1.png'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRpayload\x00\x00\x00\x00IEND\xaeB`\x82')
        emit({'method': 'item/completed', 'params': {'threadId': 'thread-1', 'turnId': 'turn-1', 'item': {'id': 'image-1', 'type': 'imageGeneration', 'status': 'completed', 'savedPath': str(output), 'revisedPrompt': 'A red fox'}}})
        emit({'method': 'turn/completed', 'params': {'threadId': 'thread-1', 'turn': {'id': 'turn-1', 'status': 'completed', 'items': [], 'error': None}}})
