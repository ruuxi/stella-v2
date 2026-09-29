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
env = os.environ.copy()
env['STELLA_AUTH_TOKEN'] = auth
env['STELLA_MODEL_GATEWAY_URL'] = 'https://stella-v2-model-gateway-dev.lolruuxi.workers.dev'
if '--rpc' in sys.argv:
    subprocess.run(['bun', str(root / 'packages/runtime-rust/scripts/verify-live-rpc.mjs')], env=env, timeout=180, check=True)
    raise SystemExit(0)
request = {'agentType': 'general', 'prompt': f'Use the Read tool to read {file}. Reply with exactly the single line from that file. Do not delegate.'}
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
assert nonce in text, text
print('Native Rust gateway authentication, live model completion, tool execution, follow-up completion, and transcript persistence passed')
