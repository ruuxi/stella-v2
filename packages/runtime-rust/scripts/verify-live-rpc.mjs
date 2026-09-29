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
await writeFile(join(directory, 'nonce.txt'), nonce);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = [...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)];
const child = spawn(join(root, 'packages/runtime-rust/target/debug/stella-runtime'), ['--database', join(directory, 'stella.sqlite')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const { peer } = attachJsonRpcPeerToStreams({ input: child.stdout, output: child.stdin, requestTimeoutMs: 180000 });
peer.registerRequestHandler('host.deviceIdentity.get', () => ({ deviceId: 'native-rpc-verification', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }));
peer.registerRequestHandler('host.auth.signDevice', ({input}) => ({ alg:'ed25519', rawPublicKey, signature:sign(null,Buffer.from(input),privateKey).toString('base64url') }));
const events=[];
let complete;
const terminal=new Promise(resolve=>{complete=resolve;});
peer.registerNotificationHandler('run.event',event=>{events.push(event);if(event.type==='run-finished')complete(event);});
try {
  await peer.request('internal.worker.initialize',{protocolVersion:'v1',stellaDataDirPath:directory,authToken:process.env.STELLA_AUTH_TOKEN});
  const conversationId=await peer.request('internal.worker.localChat.getOrCreateDefaultConversationId',{});
  const started=await peer.request('internal.worker.startChat',{conversationId,agentType:'general',requestId:randomUUID(),userPrompt:`Use Read to read ${join(directory,'nonce.txt')}. Reply with exactly its contents. Do not delegate.`});
  const final=await terminal;
  if(final.outcome!=='success')throw Error(JSON.stringify(final));
  if(!events.some(e=>e.type==='tool-end' && e.toolName==='Read' && !e.isError))throw Error('No successful native Read');
  if(!events.some(e=>e.type==='assistant-message' && e.assistantMessageText.includes(nonce)))throw Error('Missing nonce answer');
  const replay=await peer.request('internal.worker.resumeEvents',{runId:started.runId,lastSeq:0});
  if(JSON.stringify(replay.events)!==JSON.stringify(events))throw Error('Durable replay differs from notifications');
  const stored=await peer.request('internal.worker.localChat.listEvents',{conversationId});
  if(!stored.some(e=>e.type==='assistant_message' && e.payload.text.includes(nonce)))throw Error('Missing stored answer');
  await writeFile(join(directory,'run-events.json'),JSON.stringify(events,null,2));
  console.log('PASS: native RPC admission, host signing callbacks, live model/tool execution, transcript, event replay',directory);
} finally {
  child.stdin.end();
  await new Promise(resolve=>child.once('exit',resolve));
}
