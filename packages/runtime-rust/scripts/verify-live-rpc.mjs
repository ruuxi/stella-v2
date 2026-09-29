// Integration through the production host transport and a real native process.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachJsonRpcPeerToStreams } from '../../contracts/protocol/jsonl.ts';
const root = new URL('../../../', import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), 'stella-rust-live-rpc-'));
const nonce = `native-rpc-${randomUUID()}`;
const steer = process.argv.includes('--steer');
const cloud = process.argv.includes('--cloud');
const cancelShell = process.argv.includes('--cancel-shell');
const catalogMode = process.argv.includes('--catalog');
let heldSigner = false;
const secondNonce = `native-steering-${randomUUID()}`;
await writeFile(join(directory, 'nonce.txt'), nonce);
await writeFile(join(directory, 'second.txt'), secondNonce);
if(cancelShell)await writeFile(join(directory,'waiting.py'),`import os,time\nopen(${JSON.stringify(join(directory,'child.pid'))},'w').write(str(os.getpid()))\ntime.sleep(600)\n`);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = [...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)];
const environment={...process.env};
if(catalogMode)delete environment.STELLA_MODEL_GATEWAY_URL;
const child = spawn(join(root, 'packages/runtime-rust/target/debug/stella-runtime'), ['--database', join(directory, 'stella.sqlite')], { env: environment, stdio: ['pipe', 'pipe', 'inherit'] });
const { peer } = attachJsonRpcPeerToStreams({ input: child.stdout, output: child.stdin, requestTimeoutMs: 180000 });
peer.registerRequestHandler('host.deviceIdentity.get', () => ({ deviceId: 'native-rpc-verification', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }));
peer.registerRequestHandler('host.auth.signDevice', async ({input}) => {
  if(cloud && !heldSigner){heldSigner=true;await new Promise(resolve=>setTimeout(resolve,40000));}
  return { alg:'ed25519', rawPublicKey, signature:sign(null,Buffer.from(input),privateKey).toString('base64url') };
});
const events=[];
let complete;
const terminal=new Promise(resolve=>{complete=resolve;});
peer.registerNotificationHandler('run.event',event=>{events.push(event);if(event.type==='run-finished')complete(event);});
try {
  await peer.request('internal.worker.initialize',{protocolVersion:'v1',stellaDataDirPath:directory,authToken:process.env.STELLA_AUTH_TOKEN,convexUrl:'https://outgoing-bulldog-865.convex.cloud',convexSiteUrl:'https://outgoing-bulldog-865.convex.site'});
  if(catalogMode){
    const snapshots=await Promise.all(Array.from({length:4},()=>peer.request('internal.worker.listModels',{})));
    const snapshot=snapshots[0];
    if(snapshot.catalogError)throw Error(snapshot.catalogError);
    if(!snapshot.models.some(m=>m.provider==='stella'))throw Error('No managed catalog models');
    if(!snapshot.models.some(m=>m.provider==='anthropic'))throw Error('No vendored provider models');
    if(snapshot.models.some(m=>'headers' in m))throw Error('Catalog leaked headers');
    if(snapshots.some(s=>s.revision!==snapshot.revision))throw Error('Unstable catalog revision');
    await writeFile(join(directory,'catalog.json'),JSON.stringify(snapshot,null,2));
  }
  const conversationId=await peer.request('internal.worker.localChat.getOrCreateDefaultConversationId',{});
  const started=await peer.request('internal.worker.startChat',{conversationId,agentType:'general',storageMode:cloud?'cloud':'local',requestId:randomUUID(),userPrompt:cancelShell?`Use exec_command to run python3 -u ${join(directory,'waiting.py')} with yield_time_ms=30000. Do not delegate.`:`Use Read to read ${join(directory,'nonce.txt')}. Reply with exactly its contents. Do not delegate.`});
  if(cancelShell){
    let pid;const deadline=Date.now()+90000;
    while(Date.now()<deadline){try{pid=Number(await readFile(join(directory,'child.pid'),'utf8'));if(pid)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    if(!pid)throw Error('Native shell child did not start');
    const result=await peer.request('internal.worker.cancel',{runId:started.runId});
    const final=await terminal;
    if(!result.cancelled || final.outcome!=='canceled')throw Error('Native run did not cancel');
    let alive=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
    if(alive)throw Error('Cancellation returned while the owned child was still alive');
    if(!events.some(e=>e.type==='tool-end' && e.toolName==='exec_command' && e.isError))throw Error('Cancellation left a dangling tool call');
    await writeFile(join(directory,'run-events.json'),JSON.stringify(events,null,2));
    console.log('PASS: native shell child started, cancellation joined process teardown, interrupted tool result and terminal event persisted',directory);
  }else{
  const secondId=randomUUID();
  if(steer){
    const parameters={conversationId,agentType:'general',requestId:randomUUID(),userMessageEventId:secondId,userPrompt:`Correction: use Read to read ${join(directory,'second.txt')} instead. Reply with exactly that file's contents. Do not delegate.`};
    const continued=await peer.request('internal.worker.startChat',parameters);
    if(continued.runId!==started.runId)throw Error('Local steering incorrectly created a second run');
    const duplicate=await peer.request('internal.worker.startChat',parameters);
    if(duplicate.runId!==started.runId)throw Error('Repeated steering was not idempotent');
  }
  const final=await terminal;
  if(final.outcome!=='success')throw Error(JSON.stringify(final));
  if(!events.some(e=>e.type==='tool-end' && e.toolName==='Read' && !e.isError))throw Error('No successful native Read');
  const expected=steer?secondNonce:nonce;
  if(!events.some(e=>e.type==='assistant-message' && e.assistantMessageText.includes(expected)))throw Error('Missing nonce answer');
  if(steer && final.userMessageId!==secondId)throw Error('Run did not transfer response ownership to steering input');
  const replay=await peer.request('internal.worker.resumeEvents',{runId:started.runId,lastSeq:0});
  if(JSON.stringify(replay.events)!==JSON.stringify(events))throw Error('Durable replay differs from notifications');
  const stored=await peer.request('internal.worker.localChat.listEvents',{conversationId});
  if(!cloud && !stored.some(e=>e.type==='assistant_message' && e.payload.text.includes(expected)))throw Error('Missing stored answer');
  if(cloud && stored.some(e=>e.type==='assistant_message'))throw Error('Cloud turn incorrectly wrote local canonical chat');
  await writeFile(join(directory,'run-events.json'),JSON.stringify(events,null,2));
  console.log('PASS: native RPC admission, host signing callbacks, live model/tool execution, transcript, event replay',steer?'with idempotent steering and response ownership':cloud?'with live cloud turn and lease renewals during a 40-second signer delay':'',directory);
  }
} finally {
  child.stdin.end();
  await new Promise(resolve=>child.once('exit',resolve));
}
