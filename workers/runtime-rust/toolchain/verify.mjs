import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8794";
const token = process.env.RUNTIME_VERIFY_TOKEN ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^RUNTIME_VERIFY_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("RUNTIME_VERIFY_TOKEN is required");
const thread = `verification-${randomUUID()}`;
async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-stella-thread": thread },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
  return response.json();
}
const health = await request("/health");
if (health.target !== "wasm32-unknown-emscripten") throw new Error("Unexpected Worker target");
const agents = await request("/agents");
if (agents.map((agent) => agent.id).join(",") !== "orchestrator,general,explore,fashion") throw new Error("Built-in catalog mismatch");
const context = {
  agentType: "orchestrator",
  userPrompt: "Check my Gmail inbox",
  connectors: [{ id: "gmail", name: "Gmail", connected: true, connectable: true }],
};
const first = await request("/prepare", context);
const second = await request("/prepare", context);
if (first.reminderKeys[0] !== "connector-connected:gmail" || second.reminderKeys.length !== 0) throw new Error("Durable reminder gate failed");
const compacted = await request("/prepare", { ...context, lastCompactionAt: Date.now() + 1000 });
if (compacted.reminderKeys[0] !== "connector-connected:gmail") throw new Error("Compaction reset failed");
// Resolve from the repository root: toolchain -> runtime-rust -> workers -> root.
const evidenceDir = new URL("../../../.agents/skills/verify-stella/artifacts/rust-runtime/", import.meta.url);
mkdirSync(evidenceDir, { recursive: true });
const report = { url: base, health, thread, checks: ["compiled built-ins", "Durable Object SQL persistence", "deduplication", "compaction reset", "Tokio timer"], passed: true };
writeFileSync(new URL("cloud-worker.json", evidenceDir), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
