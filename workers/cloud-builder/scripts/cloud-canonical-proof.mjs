// Real cloud-canonical journal proof against the isolated staging cloud-builder
// (stella-v2-cloud-builder-staging) paired with the development Convex
// flexible-panther-999. Uses a DISPOSABLE anonymous identity (no secrets, no
// 2FA, no shared user data) and exercises the exact backend registration +
// worker journal protocol the product uses:
//   A: cloud_apps:createMyConversation (owner registration)
//      -> POST /conversations/:id/local-turns/begin  (local-desktop DO append: user)
//      -> POST /conversations/:id/local-turns/finish (assistant append)
//      -> GET  /conversations/:id/history            (canonical read)
//   B: same identity, brand-new client with ZERO local cache
//      -> cloud_apps:listMyConversations (discover via Convex projection)
//      -> GET history (hydrate from cloud) -> begin/finish t2 (continue)
//   cache-loss: a fresh no-cache client re-reads canonical history from the DO.
//
// Run:  node workers/cloud-builder/scripts/cloud-canonical-proof.mjs
const SITE = "https://flexible-panther-999.convex.site";
const CVX = "https://flexible-panther-999.convex.cloud";
const WORKER = "https://stella-v2-cloud-builder-staging.lolruuxi.workers.dev";

async function anonIdentity() {
  const anon = await fetch(`${SITE}/api/auth/sign-in/anonymous`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const cookie = (anon.headers.get("set-cookie") || "").split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const b = await anon.json();
  const jwt = (await fetch(`${SITE}/api/auth/convex/token`, { headers: { cookie } }).then((r) => r.json()))?.token;
  return { userId: b?.user?.id, H: { authorization: `Bearer ${jwt}`, "content-type": "application/json" } };
}
const mutation = (H, path, args) => fetch(`${CVX}/api/mutation`, { method: "POST", headers: H, body: JSON.stringify({ path, args, format: "json" }) }).then((r) => r.json());
const query = (H, path, args) => fetch(`${CVX}/api/query`, { method: "POST", headers: H, body: JSON.stringify({ path, args, format: "json" }) }).then((r) => r.json());
const userMsg = (t) => JSON.stringify({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const asstMsg = (t) => JSON.stringify({ role: "assistant", content: [{ type: "text", text: t }], api: "responses", provider: "stella", model: "proof", stopReason: "end_turn", usage: {}, timestamp: Date.now() });
const begin = (H, cid, deviceId, localTurnId, clientMsgId, text) => fetch(`${WORKER}/conversations/${cid}/local-turns/begin`, { method: "POST", headers: H, body: JSON.stringify({ deviceId, localTurnId, clientMsgId, userMessageJson: userMsg(text) }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const finish = (H, cid, deviceId, localTurnId, leaseToken, text) => fetch(`${WORKER}/conversations/${cid}/local-turns/finish`, { method: "POST", headers: H, body: JSON.stringify({ deviceId, localTurnId, leaseToken, phase: "completed", records: [{ ordinal: 0, role: "assistant", payloadJson: asstMsg(text) }] }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const history = (H, cid) => fetch(`${WORKER}/conversations/${cid}/history`, { headers: H }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const roles = (h) => (Array.isArray(h.body?.history) ? h.body.history.map((s) => { try { return JSON.parse(s).role; } catch { return "?"; } }) : []);

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

console.log("\n[Profile A] create + local-desktop turn (user + assistant) into staging DO journal");
const A = await anonIdentity();
const cid = (await mutation(A.H, "cloud_apps:createMyConversation", { clientCreateId: `full-${Date.now()}`, title: "Two-Client Proof" }))?.value?.conversationId;
check(!!cid, `createMyConversation -> ${cid}`);
const t1 = await begin(A.H, cid, "desktopdevicea", "t1", "cmsgprooffulla01", "hello from device A (local-desktop)");
check(t1.status === 200 && !!t1.body?.leaseToken, `begin t1 (local-desktop) DO append, turnId=${t1.body?.turnId}`);
const f1 = await finish(A.H, cid, "desktopdevicea", "t1", t1.body?.leaseToken, "assistant reply A");
check(f1.status === 200, `finish t1 (assistant append) status=${f1.status}`);
const hA = await history(A.H, cid);
check(hA.status === 200 && roles(hA).length >= 2, `A journal history roles=${JSON.stringify(roles(hA))}`);

console.log("\n[Profile B] clean client (same identity, ZERO local cache) discovers + hydrates + continues");
const listB = await query(A.H, "cloud_apps:listMyConversations", {});
check(Array.isArray(listB?.value) && listB.value.some((c) => c.conversationId === cid), `B discovers conversation via Convex projection`);
const hB = await history(A.H, cid);
check(hB.status === 200 && roles(hB).length >= 2, `B hydrates full transcript from cloud, no local cache (roles=${JSON.stringify(roles(hB))})`);
const t2 = await begin(A.H, cid, "desktopdeviceb", "t2", "cmsgprooffullb02", "continue from device B");
check(t2.status === 200 && !!t2.body?.leaseToken, `B continues (begin t2) turnId=${t2.body?.turnId}`);
const f2 = await finish(A.H, cid, "desktopdeviceb", "t2", t2.body?.leaseToken, "assistant reply B");
check(f2.status === 200, `finish t2 status=${f2.status}`);
const hB2 = await history(A.H, cid);
check(hB2.status === 200 && roles(hB2).length >= 4, `journal spans both turns (roles=${JSON.stringify(roles(hB2))})`);

console.log("\n[Cache-loss survival] a brand-new client with no cache re-reads canonical history");
const hFresh = await history(A.H, cid);
check(hFresh.status === 200 && roles(hFresh).length === roles(hB2).length, `fresh read matches (roles=${roles(hFresh).length})`);

console.log(`\nRESULT: ${fails === 0 ? "ALL PASS" : fails + " FAIL"}  conversationId=${cid}`);
process.exit(fails === 0 ? 0 : 1);
