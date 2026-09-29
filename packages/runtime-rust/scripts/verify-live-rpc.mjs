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
let heldSigner = false;
const secondNonce = `native-steering-${randomUUID()}`;
await writeFile(join(directory, 'nonce.txt'), nonce);
await writeFile(join(directory, 'second.txt'), secondNonce);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = [...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)];
const child = spawn(join(root, 'packages/runtime-rust/target/debug/stella-runtime'), ['--database', join(directory, 'stella.sqlite')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
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
  await peer.request('internal.worker.initialize',{protocolVersion:'v1',stellaDataDirPath:directory,authToken:process.env.STELLA_AUTH_TOKEN,convexUrl:'https://outgoing-bulldog-865.convex.cloud'});
  const conversationId=await peer.request('internal.worker.localChat.getOrCreateDefaultConversationId',{});
  const started=await peer.request('internal.worker.startChat',{conversationId,agentType:'general',storageMode:cloud?'cloud':'local',requestId:randomUUID(),userPrompt:`Use Read to read ${join(directory,'nonce.txt')}. Reply with exactly its contents. Do not delegate.`});
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
} finally {
  child.stdin.end();
  await new Promise(resolve=>child.once('exit',resolve));
}
