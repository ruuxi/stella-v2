#!/usr/bin/env node
// Headless cloud-turn harness: drives one cloud conversation turn against the
// dev cloud-builder worker without launching the Electron verifier, then
// polls the Convex event projection for the resulting agent events.
//
//   node .agents/skills/verify-stella/cloud-turn.mjs --prompt "..." [--conversation <id>] [--wait 180]
//
// Needs, from the agent secret store or `bunx convex env get` in packages/backend:
//   STELLA_ADMIN_API_SECRET   mints a Pro test owner (dev only)
//   BUILDER_SERVICE_SECRET    the worker's service bearer (dev only)
// and CONVEX_SITE_URL / CLOUD_BUILDER_URL (defaults below match the dev deployment).
//
// The route is `POST /conversations/:id/turns` with the service bearer and the
// owner on the trusted headers, exactly what Convex itself sends. Nothing here
// prints a secret; evidence is the JSON the worker and Convex return.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const siteUrl = process.env.CONVEX_SITE_URL ?? "https://outgoing-bulldog-865.convex.site";
const builderUrl = process.env.CLOUD_BUILDER_URL ?? "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev";
const prompt = flag("--prompt");
if (!prompt) {
  console.error("--prompt is required");
  process.exit(2);
}
const waitSeconds = Number(flag("--wait", "180"));
const convexEnv = (name) =>
  process.env[name] ??
  execFileSync("bunx", ["convex", "env", "get", name], {
    cwd: new URL("../../../packages/backend/", import.meta.url).pathname,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);
const adminSecret = convexEnv("STELLA_ADMIN_API_SECRET");
const serviceSecret = convexEnv("BUILDER_SERVICE_SECRET");

const session = await (
  await fetch(`${siteUrl}/api/admin/test-accounts/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
    body: JSON.stringify({
      email: `agent-headless-${randomUUID().slice(0, 8)}@test.stella.local`,
      plan: "pro",
      usageMode: "unlimited",
    }),
  })
).json();
const ownerId = session.ownerId;
const conversationId = flag("--conversation", randomUUID());
const started = await fetch(`${builderUrl}/conversations/${conversationId}/turns`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${serviceSecret}`,
    "content-type": "application/json",
    "x-stella-owner-id": ownerId,
    "x-stella-owner-generation": "legacy",
  },
  body: JSON.stringify({
    protocol: 1,
    clientMsgId: randomUUID(),
    prompt,
    lane: "chat",
  }),
});
const startedBody = await started.json().catch(() => null);
console.log(JSON.stringify({ ownerId, conversationId, status: started.status, response: startedBody }));
if (!started.ok) process.exit(1);

// Poll the projection: the orchestrator's completion and any agent thread
// events for this owner. Each row is what `bunx convex data` prints.
const deadline = Date.now() + waitSeconds * 1000;
const ownerKey = ownerId.split("|").at(-1);
let last = "";
while (Date.now() < deadline) {
  const rows = execFileSync("bunx", ["convex", "data", "agent_events", "--limit", "20", "--order", "desc"], {
    cwd: new URL("../../../packages/backend/", import.meta.url).pathname,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(ownerKey) && !line.startsWith("Showing"));
  const snapshot = rows.join("\n");
  if (snapshot !== last) {
    last = snapshot;
    console.log(snapshot);
  }
  if (rows.some((row) => row.includes('"completed"') || row.includes('"failed"'))) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
