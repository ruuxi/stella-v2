"""Executable integration verification against an isolated runtime, not a unit suite."""
import subprocess, pathlib, tempfile, os, urllib.request, json, uuid, sys
root = pathlib.Path(__file__).resolve().parents[3]
work = pathlib.Path(tempfile.mkdtemp(prefix='stella-native-live-'))
site = 'https://outgoing-bulldog-865.convex.site'
secret = subprocess.check_output(['bunx', 'convex', 'env', 'get', 'STELLA_ADMIN_API_SECRET'], cwd=root / 'packages/backend', text=True).strip().split('\n')[-1]
request = urllib.request.Request(site + '/api/admin/test-accounts/session', data=json.dumps({'email': 'agent-rust-' + uuid.uuid4().hex[:8] + '@test.stella.local', 'plan': 'pro', 'usageMode': 'unlimited'}).encode(), headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    session = json.load(response)
with urllib.request.urlopen(urllib.request.Request(site + '/api/auth/convex/token', headers={'Authorization': 'Bearer ' + session['sessionToken'], 'Accept': 'application/json'}), timeout=30) as response:
    auth = json.load(response)['token']
nonce = 'rust-native-' + uuid.uuid4().hex
file = work / 'verification.txt'
file.write_text(nonce + '\n')
image_mode = '--image' in sys.argv
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
env['STELLA_MODEL_GATEWAY_URL'] = 'https://stella-v2-model-gateway-dev.lolruuxi.workers.dev'
if '--rpc' in sys.argv:
    subprocess.run(['bun', str(root / 'packages/runtime-rust/scripts/verify-live-rpc.mjs'), *sys.argv[1:]], env=env, timeout=180, check=True)
    raise SystemExit(0)
request = {'agentType': 'general', 'prompt': f'Use the Read tool to read {file}. Reply with exactly the single line from that file. Do not delegate.'}
if image_mode:
    request['prompt'] = f'Use Read to inspect {file}. Reply with the two solid colours from left to right in lowercase, separated by a comma and a space. Do not delegate.'
proc = subprocess.run([os.environ.get('STELLA_RUNTIME_BIN', str(root / 'packages/runtime-rust/target/debug/stella-runtime')), '--run', '--database', str(work / 'stella.sqlite')], input=json.dumps(request), text=True, env=env, capture_output=True, timeout=180)
(work / 'events.jsonl').write_text(proc.stdout)
print('exit', proc.returncode, 'artifacts', work)
if proc.returncode:
    print(proc.stderr[-3000:])
    raise SystemExit(1)
events = [json.loads(line)['params'] for line in proc.stdout.splitlines()]
assert any((e['type'] == 'tool_execution_end' and e['toolName'] == 'Read' and (not e['isError']) for e in events)), [e['type'] for e in events]
assert events[-1]['type'] == 'agent_end'
text = '\n'.join((b.get('text', '') for m in events[-1]['messages'] if m.get('role') == 'assistant' for b in m.get('content', [])))
assert nonce in text.lower() if image_mode else nonce in text, text
if image_mode:
    assert any(b.get('type') == 'image' for e in events if e['type'] == 'tool_execution_end' for b in e['result']['content'])
print('Native Rust gateway authentication, live model completion, tool execution, follow-up completion, and transcript persistence passed')
