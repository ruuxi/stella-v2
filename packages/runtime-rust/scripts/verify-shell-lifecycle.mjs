// Live agent + detached native socket process. No mock provider or unit harness.
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {attachJsonRpcPeerToStreams} from '../../contracts/protocol/jsonl.ts';
const root=new URL('../../../',import.meta.url).pathname;
const directory=await mkdtemp(join(tmpdir(),'stella-shell-lifecycle-'));
const socketPath=join(directory,'r.sock');
const release=join(directory,'release');
const pidFile=join(directory,'child.pid');
const script=join(directory,'background.py');
const signalMode=process.argv.includes('--shutdown-shell');
await writeFile(script,`import os,time\nopen(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\nprint('READY',flush=True)\nwhile not os.path.exists(${JSON.stringify(release)}): time.sleep(0.05)\n`);
const child=spawn(join(root,'packages/runtime-rust/target/debug/stella-runtime'),['--stella-root',directory,'--database',join(directory,'stella.sqlite'),'--listen',`unix://${socketPath}`,'--idle-shutdown-ms','1000'],{stdio:['ignore','ignore','inherit']});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let socket;
try{
  for(let n=0;n<3000;n++){if(await stat(socketPath).then(()=>true,()=>false))break;assert.equal(child.exitCode,null);await pause(10);}
  socket=createConnection(socketPath);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const {peer}=attachJsonRpcPeerToStreams({input:socket,output:socket,requestTimeoutMs:180000});
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const rawPublicKey=[...publicKey.export({format:'der',type:'spki'}).subarray(-32)];
  peer.registerRequestHandler('host.deviceIdentity.get',()=>({deviceId:'native-shell-lifecycle'}));
  peer.registerRequestHandler('host.auth.signDevice',({input})=>({alg:'ed25519',rawPublicKey,signature:sign(null,Buffer.from(input),privateKey).toString('base64url')}));
  const events=[];
  let finish;const finished=new Promise(resolve=>{finish=resolve;});
  peer.registerNotificationHandler('run.event',event=>{events.push(event);if(event.type==='run-finished')finish(event);});
  await peer.request('internal.worker.initialize',{stellaDataDirPath:directory,authToken:process.env.STELLA_AUTH_TOKEN,convexSiteUrl:'https://outgoing-bulldog-865.convex.site'});
  const conversationId=await peer.request('internal.worker.localChat.getOrCreateDefaultConversationId',{});
  await peer.request('internal.worker.startChat',{conversationId,agentType:'general',requestId:randomUUID(),userPrompt:`Use exec_command exactly once to run python3 -u ${script}, with yield_time_ms=1000. Leave it running in the background. After the tool returns a running session, reply STARTED and end your turn. Do not poll, terminate, read or change files, or delegate.`});
  const final=await finished;assert.equal(final.outcome,'success');
  const execution=events.find(e=>e.type==='tool-end'&&e.toolName==='exec_command');
  assert(execution&&!execution.isError);
  const shellPid=Number(await readFile(pidFile,'utf8'));assert(shellPid>0);process.kill(shellPid,0);
  if(signalMode){
    child.kill('SIGTERM');
    const result=await Promise.race([exited,pause(10000).then(()=>{throw Error('Runtime did not settle shutdown');})]);
    assert.equal(result.code,0);
    assert.throws(()=>process.kill(shellPid,0),{code:'ESRCH'});
  }else{
    socket.end();await pause(2500);
    assert.equal(child.exitCode,null);process.kill(shellPid,0);
    await writeFile(release,'release');
    const result=await Promise.race([exited,pause(10000).then(()=>{throw Error('Runtime did not exit after its last shell');})]);
    assert.equal(result.code,0);
  }
  assert.equal(await stat(socketPath).then(()=>true,()=>false),false);
  await writeFile(join(directory,'events.json'),JSON.stringify(events,null,2));
  console.log('PASS: real native shell',signalMode?'settled on graceful runtime shutdown':'kept its detached runtime alive beyond idle timeout and released it on exit',directory);
}finally{
  socket?.destroy();
  if(child.exitCode===null){child.kill('SIGTERM');await exited;}
}
