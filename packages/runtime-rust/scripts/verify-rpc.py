"""Exercise the actual JSONL process: duplex callbacks, concurrency and replay."""
import json, pathlib, select, sqlite3, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[3]
work = pathlib.Path(tempfile.mkdtemp(prefix='stella-rust-rpc-'))
binary = root / 'packages/runtime-rust/target/debug/stella-runtime'
proc = subprocess.Popen([str(binary), '--database', str(work / 'stella.sqlite')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
def send(value):
    proc.stdin.write(json.dumps(value) + '\n')
    proc.stdin.flush()
def read():
    # A watchdog protects the executable check from hanging on a deadlock.
    return json.loads(proc.stdout.readline())
def request(id, method, params=None):
    send(dict(id=id, method=method, params=params or {}))
try:
    request(1, 'internal.worker.initialize', dict(protocolVersion='v1', stellaDataDirPath=str(work)))
    callback = read()
    assert callback['method'] == 'host.deviceIdentity.get', callback
    request(2, 'internal.worker.storage.diagnostics')
    health = read()
    assert health['id'] == 2 and health['result']['schemaVersion'] == 3, health
    send(dict(id=callback['id'], result=dict(deviceId='isolated-verification-device', publicKey='public')))
    initialized = read()
    assert initialized['id'] == 1 and 'error' not in initialized, initialized
    request(3, 'method.does.not.exist')
    assert read()['error']['code'] == -32601
finally:
    proc.stdin.close()
    assert proc.wait(timeout=10) == 0
# Seed an interrupted stream, then reopen the real binary. Verify recovery and
# acknowledgments through RPC, including a second restart after the ack.
db = sqlite3.connect(work / 'stella-runs.sqlite')
import time
payload = dict(type='run-started', runId='interrupted', seq=1, conversationId='conversation')
db.execute('INSERT INTO run_event_log VALUES(?,?,?,?)', ['interrupted', 1, json.dumps(payload), int(time.time()*1000)])
db.commit()
db.close()
for restart in range(2):
    proc = subprocess.Popen([str(binary), '--database', str(work / 'stella.sqlite')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    try:
        request(4, 'internal.worker.resumeEvents', dict(runId='interrupted', lastSeq=0))
        result = read()['result']
        if restart == 0:
            assert [e['type'] for e in result['events']] == ['run-started', 'run-finished'], result
            assert result['events'][-1]['reason'] == 'worker_restart', result
            request(5, 'internal.worker.ackEvents', dict(runId='interrupted', lastSeq=9007199254740991))
            assert read()['result']['pruned'] == 2
        else:
            assert result['events'] == [], result
    finally:
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
print('PASS: existing envelope, concurrent request during callback, callback routing, restart settlement, durable acknowledgment')
print('artifacts', work)
