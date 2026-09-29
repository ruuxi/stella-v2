import tempfile, sqlite3, subprocess, json, pathlib, shutil
root=pathlib.Path.cwd()
bin=root/'packages/runtime-rust/target/debug/stella-runtime'
work=pathlib.Path(tempfile.mkdtemp(prefix='stella-rust-storage-'))
def migrate(path):
 p=subprocess.run([str(bin),'--migrate','--database',str(path)],text=True,capture_output=True)
 if p.returncode: raise RuntimeError(p.stderr)
 return json.loads(p.stdout)
p=work/'native.sqlite'
print('native fresh',migrate(p))
# Real product protocol: sequence allocation must ignore wall-clock ordering.
proc=subprocess.Popen([str(bin),'--database',str(p)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def rpc(method,params={}):
 rpc.i+=1
 proc.stdin.write(json.dumps(dict(jsonrpc='2.0',id=rpc.i,method=method,params=params))+'\n');proc.stdin.flush()
 while True:
  result=json.loads(proc.stdout.readline())
  if result.get('id')==rpc.i:
   if 'error' in result: raise RuntimeError(result)
   return result['result']
rpc.i=0
conversation=rpc('internal.worker.localChat.getOrCreateDefaultConversationId')
for i,t in enumerate([300,100,200]):
 rpc('internal.worker.localChat.appendEvent',dict(conversationId=conversation,eventId='evt-'+str(i),type='user_message' if i==0 else 'assistant_message',timestamp=t,payload=dict(text='migrating durable transcript '+str(i))))
# Overwrite by id must not allocate a fresh sequence.
rpc('internal.worker.localChat.appendEvent',dict(conversationId=conversation,eventId='evt-1',type='assistant_message',timestamp=900,payload=dict(text='updated durable transcript')))
events=rpc('internal.worker.localChat.listEvents',dict(conversationId=conversation))
assert [e['sequence'] for e in events]==[1,2,3],events
assert [e['timestamp'] for e in events]==[300,900,200],events
assert len(rpc('internal.worker.localChat.search',dict(query='durable transcript')))==3
proc.stdin.close();assert proc.wait(timeout=10)==0
# Seed pending durable deliveries. Opening and migration may not consume them.
db=sqlite3.connect(p)
db.execute("INSERT INTO cloud_journal_outbox(id,conversation_id,device_id,owner_generation,append_id,payload_json,created_at,updated_at) VALUES('pending',?,'device','generation','append','{}',1,2)",[conversation]);db.commit()
old=db.execute('SELECT * FROM cloud_journal_outbox').fetchall();db.close()
print('native reopen',migrate(p))
db=sqlite3.connect(p)
assert db.execute('SELECT * FROM cloud_journal_outbox').fetchall()==old
assert db.execute('PRAGMA integrity_check').fetchone()==('ok',)
assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
print('RPC/reopen: persisted order, idempotent overwrite, FTS5, pending outbox, integrity all passed')
db.close()
# v1 and v2 files exercise both forward migrations with actual existing data.
for v in [1,2]:
 q=work/f'v{v}.sqlite';shutil.copyfile(p,q)
 db=sqlite3.connect(q)
 for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_durable_thread_summaries_fts_%'").fetchall():db.execute(f'DROP TRIGGER {name}')
 db.execute('DROP TABLE durable_thread_summaries_fts')
 if v==1:db.execute('DROP TABLE entry_ref')
 db.execute(f'PRAGMA user_version={v}');db.commit();db.close()
 print(f'upgrade v{v}',migrate(q))
 db=sqlite3.connect(q);assert db.execute('SELECT * FROM cloud_journal_outbox').fetchall()==old
 assert db.execute('SELECT COUNT(*) FROM entry').fetchone()[0]==3
 db.close()
print('artifacts',work)
