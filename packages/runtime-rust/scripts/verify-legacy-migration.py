import pathlib,tempfile,sqlite3,subprocess,shutil,json
root=pathlib.Path.cwd(); work=pathlib.Path(tempfile.mkdtemp(prefix='stella-legacy-migration-'))
p=work/'legacy.sqlite';db=sqlite3.connect(p)
db.executescript('''
CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,role TEXT,device_id TEXT,request_id TEXT,target_device_id TEXT,run_id TEXT,agent_type TEXT,data_json TEXT,created_at INTEGER,updated_at INTEGER,ordering_sequence INTEGER,ui_visible INTEGER);
CREATE TABLE part(message_id TEXT,ord INTEGER,data_json TEXT);
CREATE TABLE runtime_threads(thread_key TEXT PRIMARY KEY,conversation_id TEXT,agent_type TEXT,name TEXT,status TEXT,summary TEXT,created_at INTEGER,last_used_at INTEGER);
CREATE TABLE runtime_thread_sessions(thread_key TEXT,session_id TEXT,created_at INTEGER,cwd TEXT,parent_session TEXT);
CREATE TABLE runtime_thread_entries(thread_key TEXT,entry_id TEXT,entry_type TEXT,timestamp_iso TEXT,created_at INTEGER,data_json TEXT,insertion_sequence INTEGER);
CREATE TABLE runtime_thread_entry_payload_chunks(entry_id TEXT,chunk_index INTEGER,chunk_text TEXT);
CREATE TABLE runtime_agents(thread_id TEXT,conversation_id TEXT,agent_type TEXT,description TEXT,agent_depth INTEGER,max_agent_depth INTEGER,parent_agent_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,result TEXT,error TEXT,updated_at INTEGER);
CREATE TABLE legacy_chat_cloud_import(local_conversation_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,cloud_conversation_id TEXT,next_turn_index INTEGER,status TEXT,detail TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE cloud_transcript_outbox(id TEXT PRIMARY KEY,kind TEXT,conversation_id TEXT,device_id TEXT,local_turn_id TEXT,payload_json TEXT,attempts INTEGER,created_at INTEGER,updated_at INTEGER);
INSERT INTO session VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAV','Legacy','active',100,200);
INSERT INTO runtime_threads VALUES('general:thread','01ARZ3NDEKTSV4RRFFQ69G5FAV','general','Work','active','summary',100,200);
INSERT INTO runtime_thread_sessions VALUES('general:thread','session-id',100,'/tmp','parent');
INSERT INTO runtime_agents VALUES('general:thread','01ARZ3NDEKTSV4RRFFQ69G5FAV','general','description',1,2,NULL,'completed',100,200,'result',NULL,200);
INSERT INTO legacy_chat_cloud_import VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAV','cloud-id',7,'pending','keep receipt',100,200);
INSERT INTO cloud_transcript_outbox VALUES('pending','begin','01ARZ3NDEKTSV4RRFFQ69G5FAV','device','turn','{}',4,100,200);
''')
conv='01ARZ3NDEKTSV4RRFFQ69G5FAV'
for i,(typ,payload) in enumerate([('user_message',{'text':'durable user message'}),('assistant_message',{'text':'hidden','metadata':{'ui':{'visibility':'hidden'}}}),('assistant_message',{'text':'durable reply'})]):
 db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(f'm{i}',conv,typ,typ.split('_')[0],None,'request',None,'run','orchestrator','{}',300-i*10,300-i*10,i+1,None))
 db.execute('INSERT INTO part VALUES(?,0,?)',(f'm{i}',json.dumps(payload)))
exact=json.dumps({'type':'message','message':{'role':'assistant','content':[{'type':'text','text':'exact unicode 🦀 '+('long '*100)}]}})
entries=[('t0','message',{'message':{'role':'user','content':'question'}}),('t1','message',{'message':{'role':'assistant','content':'bounded'},'__stellaExactPayloadChunks':{'chunkCount':2,'byteLength':len(exact.encode())}}),('t2','message',{'message':{'role':'user','content':'more'}}),('c','compaction',{'summary':'compact history','firstKeptEntryId':'t2','tokensBefore':17.8,'details':{'kept':True}})]
for i,(id,typ,payload) in enumerate(entries):
 db.execute('INSERT INTO runtime_thread_entries VALUES(?,?,?,?,?,?,?)',('general:thread',id,typ,'2026-09-29T00:00:00Z',100+i,json.dumps(payload),i+1))
for i,chunk in enumerate([exact[:100],exact[100:]]):db.execute('INSERT INTO runtime_thread_entry_payload_chunks VALUES(?,?,?)',('t1',i,chunk))
db.commit();db.close()
for name in ['typescript','rust']:shutil.copyfile(p,work/f'{name}.sqlite')
subprocess.run(['bun','--eval',f'import {{ Database }} from "bun:sqlite"; import {{ migrateDesktopDatabase }} from "./packages/runtime/kernel/storage/schema.ts"; const db = new Database({json.dumps(str(work/"typescript.sqlite"))}); migrateDesktopDatabase(db); db.close();'],cwd=root,check=True)
subprocess.run([str(root/'packages/runtime-rust/target/debug/stella-runtime'),'--migrate','--database',str(work/'rust.sqlite')],check=True)
a=sqlite3.connect(work/'typescript.sqlite');b=sqlite3.connect(work/'rust.sqlite')
for table in ['conversation','entry','thread','thread_entry','blob','thread_context','agent','legacy_chat_cloud_import','cloud_transcript_outbox','entry_ref']:
 rows_a=a.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall();rows_b=b.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall()
 assert rows_a==rows_b,(table,rows_a,rows_b)
 print(table,len(rows_a),'rows match')
assert b.execute('PRAGMA foreign_key_check').fetchall()==[]
assert b.execute('PRAGMA integrity_check').fetchone()==('ok',)
assert b.execute("SELECT COUNT(*) FROM entry_fts WHERE entry_fts MATCH 'durable'").fetchone()==(2,)
print('legacy migration matches current TypeScript runtime; artifacts',work)
