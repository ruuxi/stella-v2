// Service integration: the actual runtime process, files, and public catalogs.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {attachJsonRpcPeerToStreams} from '../../contracts/protocol/jsonl.ts';
const root=new URL('../../../',import.meta.url).pathname;
const directory=await mkdtemp(join(tmpdir(),'stella-rust-catalog-'));
const marker=join(directory,'credential-command-ran');
const config={providers:{
  'native-fixture':{api:'openai-completions',baseUrl:'http://127.0.0.1:9999/v1',models:[{id:'fixture',contextWindow:4321}],modelOverrides:{fixture:{maxTokens:456,cost:{input:2}}}},
  'native-private':{api:'openai-completions',baseUrl:'https://example.invalid',apiKey:`!touch ${marker}`,headers:{Authorization:'credential-canary'},models:[{id:'private'}]},
  'native-invalid':{models:[{id:'missing-transport'}]},
  anthropic:{modelOverrides:{'claude-3-5-haiku-20241022':{name:'Native overridden Haiku',cost:{input:7}}}},
}};
await writeFile(join(directory,'models.json'),'// native JSONC fixture\n'+JSON.stringify(config).replace(/}}$/,'},}'));
async function launch(){
  const child=spawn(join(root,'packages/runtime-rust/target/debug/stella-runtime'),['--database',join(directory,'stella.sqlite')],{stdio:['pipe','pipe','inherit']});
  const {peer}=attachJsonRpcPeerToStreams({input:child.stdout,output:child.stdin,requestTimeoutMs:180000});
  peer.registerRequestHandler('host.deviceIdentity.get',()=>({deviceId:'native-catalog-verification'}));
  await peer.request('internal.worker.initialize',{stellaDataDirPath:directory});
  return {peer,close:async()=>{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));assert.equal(child.exitCode,0);}};
}
let session=await launch();
try{
  let snapshot=await session.peer.request('internal.worker.listModels',{});
  let model=snapshot.models.find(m=>m.provider==='native-fixture');
  assert.equal(model.contextWindow,4321);assert.equal(model.maxTokens,456);assert.equal(model.cost.input,2);
  assert.equal(snapshot.models.find(m=>m.provider==='anthropic'&&m.id==='claude-3-5-haiku-20241022').name,'Native overridden Haiku');
  assert.match(snapshot.configError,/native-invalid/);
  assert.deepEqual(snapshot.runtimeManagedProviders.find(p=>p.id==='native-fixture'),{id:'native-fixture',authManaged:false,credentialless:true});
  assert.equal(snapshot.runtimeManagedProviders.find(p=>p.id==='native-private').authManaged,true);
  assert(!JSON.stringify(snapshot).includes('credential-canary'));assert(!JSON.stringify(snapshot).includes('!touch'));
  assert.equal(await stat(marker).then(()=>true,()=>false),false);
  await writeFile(join(directory,'models.json'),'{}');
  snapshot=await session.peer.request('internal.worker.listModels',{});
  assert.match(snapshot.configError,/schema/);assert(!snapshot.models.some(m=>m.provider==='native-fixture'));
  delete config.providers['native-invalid'];
  await writeFile(join(directory,'models.json'),JSON.stringify(config));
  snapshot=await session.peer.request('internal.worker.listModels',{forceRefresh:true});
  assert(!snapshot.configError);assert(snapshot.refreshedAt>0);
  const cache=JSON.parse(await readFile(join(directory,'models-store.json'),'utf8'));
  assert(Object.keys(cache).length>0);assert(Object.values(cache).some(e=>e.models.length>0));
  assert.equal((await stat(join(directory,'models-store.json'))).mode&0o777,0o600);
  await writeFile(join(directory,'snapshot.json'),JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({models:snapshot.models.length,cachedProviders:Object.keys(cache).length,catalogError:snapshot.catalogError??null}));
}finally{await session.close();}
session=await launch();
try{
  const restored=await session.peer.request('internal.worker.listModels',{});
  assert(restored.refreshedAt>0);assert(restored.models.some(m=>m.provider==='native-fixture'));
  assert.equal(await stat(marker).then(()=>true,()=>false),false);
}finally{await session.close();}
console.log('PASS: native catalog RPC, JSONC configuration, composition rollback, credential-blind listing, public refresh, private cache and process restart',directory);
