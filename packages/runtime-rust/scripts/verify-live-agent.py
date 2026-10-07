"""Executable integration verification against an isolated runtime, not a unit suite."""
import subprocess, pathlib, tempfile, os, urllib.request, json, uuid, sys
root = pathlib.Path(__file__).resolve().parents[3]
work = pathlib.Path(tempfile.mkdtemp(prefix='stella-native-live-'))
site = os.environ.get('STELLA_BACKEND_URL', 'https://stella-v2-cloud-builder-dev.fromyou.workers.dev').rstrip('/')
def dev_var(name):
    path = root / 'workers/cloud-builder/.dev.vars'
    for line in (path.read_text().splitlines() if path.exists() else []):
        if line.strip().startswith(name + '='):
            return line.strip()[len(name) + 1:].strip().strip('"')
    return ''
secret = os.environ.get('STELLA_ADMIN_API_SECRET', '').strip() or dev_var('STELLA_ADMIN_API_SECRET')
assert secret, 'STELLA_ADMIN_API_SECRET is unavailable: export it or set it in workers/cloud-builder/.dev.vars'
request = urllib.request.Request(site + '/api/admin/test-accounts/session', data=json.dumps({'email': 'agent-rust-' + uuid.uuid4().hex[:8] + '@test.stella.local', 'plan': 'pro', 'usageMode': 'unlimited'}).encode(), headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    session = json.load(response)
auth = session['token']
nonce = 'rust-native-' + uuid.uuid4().hex
file = work / 'verification.txt'
file.write_text(nonce + '\n')
image_mode = '--image' in sys.argv
patch_mode = '--patch' in sys.argv
volume_mode = '--shell-volume' in sys.argv
shell_mode = '--shell' in sys.argv or '--pty' in sys.argv or volume_mode
pty_mode = '--pty' in sys.argv
if shell_mode:
    (work / 'interactive.py').write_text('import os,sys\nprint("READY",flush=True)\nline=sys.stdin.readline().strip()\nassert "STELLA_AUTH_TOKEN" not in os.environ\n' + ('print("x"*2200000,flush=True)\n' if volume_mode else '') + 'print("RESULT:"+open('+repr(str(file))+').read().strip()+":"+line+":"+str(os.isatty(0)),flush=True)\n')
if patch_mode:
    file.write_text('before\n' + nonce + '\nafter\n')
    (work / 'obsolete.txt').write_text('obsolete\n')
if image_mode:
    import struct, zlib
    file = work / 'vision.png'
    width, height = 512, 384
    pixels = b''.join(b'\x00' + b'\xff\x00\x00' * (width//2) + b'\x00\x00\xff' * (width//2) for _ in range(height))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    file.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width,height,8,2,0,0,0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND',b''))
    nonce = 'red, blue' 
env = os.environ.copy()
env['STELLA_AUTH_TOKEN'] = auth
env['STELLA_MODEL_GATEWAY_URL'] = 'https://stella-v2-model-gateway-dev.fromyou.workers.dev'
if '--idle-shell' in sys.argv or '--shutdown-shell' in sys.argv:
    subprocess.run(['bun', str(root / 'packages/runtime-rust/scripts/verify-shell-lifecycle.mjs'), *sys.argv[1:]], env=env, timeout=180, check=True)
    raise SystemExit(0)
if '--rpc' in sys.argv:
    subprocess.run(['bun', str(root / 'packages/runtime-rust/scripts/verify-live-rpc.mjs'), *sys.argv[1:]], env=env, timeout=180, check=True)
    raise SystemExit(0)
request = {'agentType': 'general', 'prompt': f'Use the Read tool to read {file}. Reply with exactly the single line from that file. Do not delegate.'}
if '--model' in sys.argv:
    request['model'] = sys.argv[sys.argv.index('--model')+1]
    if '--backend-provider-key' in sys.argv:
        provider = request['model'].split('/')[0]
        name = {'anthropic':'ANTHROPIC_API_KEY','google':'GOOGLE_AI_API_KEY'}[provider]
        value = os.environ.get(name, '').strip()
        assert value, 'Provider verification credential is unavailable: export ' + name
        env[name] = value
if image_mode:
    request['prompt'] = f'Use Read to inspect {file}. Reply with the two solid colours from left to right in lowercase, separated by a comma and a space. Do not delegate.'
if patch_mode:
    request['prompt'] = f'Use Read to inspect {file}. Use apply_patch to change the first line from before to updated, preserving the other lines, and move it to {work / "moved.txt"}. In the same patch, add {work / "new.txt"} containing exactly added plus a trailing newline, and delete {work / "obsolete.txt"}. Read the moved file to verify it. Reply with exactly the nonce from its second line. Do not delegate.'
if shell_mode:
    request['prompt'] = f'Use exec_command to run python3 -u {work / "interactive.py"}, tty={str(pty_mode).lower()}, yield_time_ms=1000. It prints READY and waits for input. Use write_stdin to send verified followed by a newline, write_id="verification-input", yield_time_ms=1000, max_output_tokens=256. Poll with write_stdin if needed until exit. Reply with exactly the RESULT line the process prints. Do not inspect or change the script or any files. Do not delegate.'
proc = subprocess.run([os.environ.get('STELLA_RUNTIME_BIN', str(root / 'packages/runtime-rust/target/debug/stella-runtime')), '--run', '--database', str(work / 'stella.sqlite')], input=json.dumps(request), text=True, env=env, capture_output=True, timeout=180)
(work / 'events.jsonl').write_text(proc.stdout)
print('exit', proc.returncode, 'artifacts', work)
if proc.returncode:
    print(proc.stderr[-3000:])
    raise SystemExit(1)
events = [json.loads(line)['params'] for line in proc.stdout.splitlines()]
if '--model' in sys.argv and not request['model'].startswith('stella/'):
    provider=request['model'].split('/')[0]
    protocol={'anthropic':'anthropic-messages','google':'google-generative-ai'}.get(provider)
    messages=[e['message'] for e in events if e['type']=='message_end' and e['message']['role']=='assistant']
    assert messages and all(m['provider']==provider and (not protocol or m['api']==protocol) for m in messages), 'Requested provider was not exercised'
assert any((e['type'] == 'tool_execution_end' and e['toolName'] == ('exec_command' if shell_mode else 'Read') and (not e['isError']) for e in events)), [e['type'] for e in events]
assert events[-1]['type'] == 'agent_end'
text = '\n'.join((b.get('text', '') for m in events[-1]['messages'] if m.get('role') == 'assistant' for b in m.get('content', [])))
assert nonce in text.lower() if image_mode else nonce in text, text
if image_mode:
    assert any(b.get('type') == 'image' for e in events if e['type'] == 'tool_execution_end' for b in e['result']['content'])
if patch_mode:
    assert not file.exists() and not (work / 'obsolete.txt').exists()
    assert (work / 'moved.txt').read_text() == 'updated\n' + nonce + '\nafter\n'
    assert (work / 'new.txt').read_text() == 'added\n'
    assert any(e['type'] == 'tool_execution_end' and e['toolName'] == 'apply_patch' and not e['isError'] for e in events)
if shell_mode:
    assert 'RESULT:' + nonce + ':verified:' + str(pty_mode) in text, text
    results=[e['result']['details'] for e in events if e['type']=='tool_execution_end' and e['toolName'] in ['exec_command','write_stdin'] and not e['isError']]
    assert results[0]['running'] and results[0]['session_id']
    assert any(r.get('write_id')=='verification-input' and r.get('write_deduplicated') is False for r in results)
    assert not results[-1]['running'] and results[-1]['exit_code']==0
    assert all(r['shell_session_id']==results[0]['session_id'] and r['worker_generation']==results[0]['worker_generation'] for r in results)
    if volume_mode:
        assert any(r['raw_output_truncated'] and r['original_output_bytes'] > 2_200_000 for r in results), results
print('Native Rust provider routing, live model completion, tool execution, follow-up completion, and transcript persistence passed')
