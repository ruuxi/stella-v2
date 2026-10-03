#!/usr/bin/env node
// Headless cloud-turn harness: drives one cloud conversation turn against the
// dev cloud-builder worker as a Pro test owner without launching the Electron
// verifier, then polls the Convex event projection for the resulting agent
// events.
//
//   node .agents/skills/verify-stella/cloud-turn.mjs --prompt "..." [--conversation <id>] [--email <owner>] [--wait 180]
//
// A follow-up into an existing conversation must arrive as the same owner, so
// pass the `--email` the first run printed together with its `--conversation`.
//
// Needs STELLA_ADMIN_API_SECRET (mints the test owner, dev only) from the
// environment or the gitignored workers/cloud-builder/.dev.vars, and
// STELLA_BACKEND_URL (defaults to the dev deployment).
//
// The route is `POST /conversations/:id/turns` with the test owner's JWT, as a
// signed-in client sends it. Nothing here prints a secret; evidence is the
// JSON the worker and Convex return.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const builderUrl = (
  process.env.STELLA_BACKEND_URL ?? "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev"
).replace(/\/+$/, "");
const prompt = flag("--prompt");
if (!prompt) {
  console.error("--prompt is required");
  process.exit(2);
}
const waitSeconds = Number(flag("--wait", "180"));
const devVarsPath = new URL("../../../workers/cloud-builder/.dev.vars", import.meta.url).pathname;
const devVar = (name) => {
  if (!existsSync(devVarsPath)) return "";
  const line = readFileSync(devVarsPath, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^"(.*)"$/, "$1") : "";
};
const adminSecret = process.env.STELLA_ADMIN_API_SECRET?.trim() || devVar("STELLA_ADMIN_API_SECRET");
if (!adminSecret) {
  console.error("STELLA_ADMIN_API_SECRET is unavailable: export it or set it in workers/cloud-builder/.dev.vars.");
  process.exit(2);
}

const email = flag("--email", `agent-headless-${randomUUID().slice(0, 8)}@test.stella.local`);
const session = await (
  await fetch(`${builderUrl}/api/admin/test-accounts/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
    body: JSON.stringify({
      email,
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
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    protocol: 1,
    clientMsgId: randomUUID(),
    prompt,
    lane: "chat",
  }),
});
const startedBody = await started.json().catch(() => null);
console.log(JSON.stringify({ ownerId, email, conversationId, status: started.status, response: startedBody }));
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
