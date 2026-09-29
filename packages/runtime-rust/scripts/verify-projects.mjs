// Exercise the native service against real Bun app servers and process trees.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {attachJsonRpcPeerToStreams} from '../../contracts/protocol/jsonl.ts';
const root=new URL('../../../',import.meta.url).pathname;
const directory=await mkdtemp(join(tmpdir(),'stella-rust-projects-'));
const workspace=join(directory,'workspace');
const app=join(workspace,'apps','native-app');
await mkdir(app,{recursive:true});
const manifest={schemaVersion:1,slug:'native-app',name:'Native supervised app',createdAt:new Date().toISOString(),runtime:{frontend:'frontend',processes:[
  {id:'backend',command:'bun',args:['backend.mjs','${PORT}'],port:'auto',ports:[{id:'media',protocol:'udp'}],readiness:{type:'http',path:'/health'}},
  {id:'frontend',command:'bun',args:['frontend.mjs','${PORT}'],port:'auto',readiness:{type:'http',path:'/health'}},
]}};
await writeFile(join(app,'stella.app.json'),JSON.stringify(manifest));
await writeFile(join(app,'package.json'),JSON.stringify({name:'native-project-verification',private:true}));
await writeFile(join(app,'backend.mjs'),`
import {writeFileSync} from 'node:fs';import {createSocket} from 'node:dgram';
writeFileSync('backend.pid',String(process.pid));
const grandchild=Bun.spawn(['python3','-c','import time; time.sleep(600)'],{stdout:'ignore',stderr:'ignore'});
writeFileSync('grandchild.pid',String(grandchild.pid));
if(process.env.STELLA_APP_PORT_MEDIA){const udp=createSocket('udp4');udp.bind(Number(process.env.STELLA_APP_PORT_MEDIA),'127.0.0.1');}
Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[2]||process.env.PORT),fetch:()=>Response.json({pid:process.pid,media:process.env.STELLA_APP_PORT_MEDIA})});
`);
await writeFile(join(app,'frontend.mjs'),`
import {writeFileSync} from 'node:fs';writeFileSync('frontend.pid',String(process.pid));
Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[2]||process.env.PORT),fetch:async()=>Response.json({frontend:process.pid,backend:await(await fetch(process.env.STELLA_APP_URL_BACKEND||process.env.STELLA_APP_URL_DEV_BACKEND)).json(),port:process.env.PORT})});
`);
await symlink(app,join(workspace,'apps','linked-app'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(50);}throw Error('Timed out waiting for real project state');}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function launch(){
 const child=spawn(join(root,'packages/runtime-rust/target/debug/stella-runtime'),['--database',join(directory,'stella.sqlite')],{stdio:['pipe','pipe','inherit']});
 const {peer}=attachJsonRpcPeerToStreams({input:child.stdout,output:child.stdin,requestTimeoutMs:180000});
 const notifications=[];peer.registerNotificationHandler('projects.updated',event=>notifications.push(event));
 peer.registerRequestHandler('host.deviceIdentity.get',()=>({deviceId:'native-project-service'}));
 await peer.request('internal.worker.initialize',{stellaDataDirPath:directory,stellaWorkspacePath:workspace,bunExecutablePath:process.execPath});
 return {peer,notifications,close:async()=>{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));assert.equal(child.exitCode,0);}};
}
let session=await launch();let url;
try{
 const listed=await session.peer.request('internal.worker.projects.list',{});
 assert.deepEqual(listed.apps.map(a=>a.slug),['native-app']);
 await assert.rejects(session.peer.request('internal.worker.projects.start',{slug:'linked-app'}));
 const results=await Promise.all([0,1].map(()=>session.peer.request('internal.worker.projects.start',{slug:'native-app'})));
 assert.equal(results[0].status,'running',JSON.stringify(results));assert.equal(results[0].url,results[1].url);url=results[0].url;
 const first=await(await fetch(url)).json();const grandchild=Number(await readFile(join(app,'grandchild.pid'),'utf8'));
 assert.equal(Number(first.port),Number(new URL(url).port));assert(Number(first.backend.media)>0);assert(alive(grandchild));
 const before=session.notifications.length;
 manifest.name='Native renamed app';await writeFile(join(app,'stella.app.json'),JSON.stringify(manifest));
 await until(async()=>session.notifications.length>before);
 assert.equal((await session.peer.request('internal.worker.projects.list',{})).apps[0].meta.label,'Native renamed app');
 process.kill(first.backend.pid,'SIGTERM');
 let recovered;
 await until(async()=>{try{const candidate=await(await fetch(url)).json();if(candidate.backend.pid!==first.backend.pid){recovered=candidate;return true;}}catch{}return false;});
 assert.notEqual(recovered.frontend,first.frontend);
 await until(async()=>!alive(first.frontend)&&!alive(first.backend.pid)&&!alive(grandchild));
 const newGrandchild=Number(await readFile(join(app,'grandchild.pid'),'utf8'));
 await session.peer.request('internal.worker.projects.stop',{slug:'native-app'});
 await until(async()=>!alive(recovered.frontend)&&!alive(recovered.backend.pid)&&!alive(newGrandchild));
 await assert.rejects(fetch(url));
 const broken={...manifest,runtime:{...manifest.runtime,processes:[manifest.runtime.processes[0],{...manifest.runtime.processes[1],args:['-e','process.exit(7)']}]}};
 await writeFile(join(app,'stella.app.json'),JSON.stringify(broken));
 const failed=await session.peer.request('internal.worker.projects.start',{slug:'native-app'});
 assert.equal(failed.status,'error');assert.equal(failed.url,null);
 const failedBackend=Number(await readFile(join(app,'backend.pid'),'utf8'));
 await until(async()=>!alive(failedBackend));
 await writeFile(join(app,'stella.app.json'),JSON.stringify(manifest));
 assert.equal((await stat(join(workspace,'apps','.stella-app-ports.json'))).mode&0o777,0o600);
 await writeFile(join(directory,'evidence.json'),JSON.stringify({url,first,recovered,failed,notifications:session.notifications.length},null,2));
}finally{await session.close();}
// A normal package-script app uses discovery instead of a runtime override.
delete manifest.runtime;
await writeFile(join(app,'stella.app.json'),JSON.stringify(manifest));
await writeFile(join(app,'package.json'),JSON.stringify({name:'native-project-verification',private:true,scripts:{dev:'bun frontend.mjs','dev:backend':'bun backend.mjs'}}));
session=await launch();
try{
 const started=await session.peer.request('internal.worker.projects.start',{slug:'native-app'});
 assert.equal(started.url,url);const response=await(await fetch(url)).json();
 assert(alive(response.frontend));
}finally{await session.close();}
await assert.rejects(fetch(url));
console.log('PASS: native project RPC, discovery, watcher, dependency install, HTTP readiness, multi-process and UDP ports, concurrent start, crash recovery, rollback, private stable ports, shutdown',directory);
