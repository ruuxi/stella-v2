#!/usr/bin/env node
// Headless cloud-turn harness: drives one cloud conversation turn against the
// dev cloud-builder worker as a Pro test owner without launching the Electron
// verifier, then polls the conversation's canonical history on the worker
// until the turn's final assistant message lands.
//
//   node .agents/skills/verify-stella/cloud-turn.mjs --prompt "..." [--conversation <id>] [--email <owner>] [--wait 180] [--agent-runtime pi] [--watch-pi] [--locale es] [--attach <drive path>]
//   (--prompt-file <path> instead of --prompt for prompts too long for one argument)
//
// `--agent-runtime pi` creates the conversation on the pi-durable runtime; it
// only takes effect on the turn that creates the conversation.
//
// `--locale` sends the turn with that reply-language locale, as a client in
// that language does.
//
// `--watch-pi` also opens the conversation socket with `pi=1`, prints the pi
// view's frames as they arrive, and folds them with the clients' reducer
// (`@stella/contracts/pi-chat`) into the final state it prints.
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
// JSON the worker returns.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const builderUrl = (
  process.env.STELLA_BACKEND_URL ?? "https://stella-v2-cloud-builder-dev.fromyou.workers.dev"
).replace(/\/+$/, "");
const promptFile = flag("--prompt-file");
const prompt = flag("--prompt") ?? (promptFile ? readFileSync(promptFile, "utf8") : undefined);
if (!prompt) {
  console.error("--prompt or --prompt-file is required");
  process.exit(2);
}
const waitSeconds = Number(flag("--wait", "180"));
const agentRuntime = flag("--agent-runtime");
const locale = flag("--locale");
// A file already in the owner's drive, attached to the turn as a client attaches one.
const attach = flag("--attach");
const watchPi = args.includes("--watch-pi");
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
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(locale ? { locale } : {}),
    ...(attach ? { attachments: [attach] } : {}),
  }),
});
const startedBody = await started.json().catch(() => null);
console.log(JSON.stringify({ ownerId, email, conversationId, status: started.status, response: startedBody }));
if (!started.ok) process.exit(1);

// The pi view over the conversation socket, folded as a client folds it.
let pi;
if (watchPi) {
  const { emptyPiChat, reducePiChat, piMessageText } = await import("../../../packages/contracts/pi-chat.ts");
  pi = { state: emptyPiChat(), frames: 0, piMessageText };
  const socket = new WebSocket(
    `${builderUrl.replace(/^http/, "ws")}/conversations/${conversationId}/socket?protocol=1&pi=1`,
    ["stella.v1", `stella.token.${session.token}`],
  );
  pi.socket = socket;
  const brief = (entry) => ({ id: entry.id, kind: entry.kind, text: piMessageText(entry.model?.[0]).slice(0, 80) });
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === "pi.snapshot") {
      pi.frames += 1;
      pi.state = reducePiChat({ ...pi.state, hasOlder: frame.hasOlder }, [frame.snapshot]);
      console.log(JSON.stringify({ pi: "snapshot", entries: frame.snapshot.entries.length, running: Boolean(frame.snapshot.run), hasOlder: frame.hasOlder }));
      for (const entry of frame.snapshot.entries) console.log(JSON.stringify({ pi: "snapshot-entry", entry: brief(entry) }));
    } else if (frame.type === "pi.events") {
      pi.frames += 1;
      pi.state = reducePiChat(pi.state, frame.events);
      for (const event of frame.events) {
        if (event.type === "message_update") continue;
        const entry = event.entry ? brief(event.entry) : undefined;
        console.log(JSON.stringify({ pi: event.type, ...(entry ? { entry } : {}), ...(event.record ? { submission: event.record.status } : {}) }));
      }
    } else if (frame.type === "error") {
      console.log(JSON.stringify({ pi: "socket-error", frame }));
    }
  };
  socket.onclose = (event) => console.log(JSON.stringify({ pi: "socket-closed", code: event.code }));
}

// Poll `GET /conversations/:id/history` (the canonical window a local turn is
// seeded from) and print each message that lands after the prompt. The turn
// is done when the newest message is an assistant message that does not stop
// for a tool call.
const deadline = Date.now() + waitSeconds * 1000;
let printed = -1;
let promptAt = -1;
while (Date.now() < deadline) {
  const response = await fetch(`${builderUrl}/conversations/${conversationId}/history`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const body = await response.json().catch(() => null);
  const messages = Array.isArray(body?.history) ? body.history.map((entry) => JSON.parse(entry)) : [];
  if (promptAt < 0) {
    promptAt = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content ?? "").includes(JSON.stringify(prompt).slice(1, -1)),
    );
    printed = promptAt;
  }
  for (let index = Math.max(printed + 1, 0); index < messages.length; index += 1) {
    console.log(JSON.stringify(messages[index]));
    printed = index;
  }
  const last = messages.at(-1);
  if (promptAt >= 0 && messages.length - 1 > promptAt && last?.role === "assistant" && last.stopReason !== "toolUse") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (pi) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const answers = pi.state.entries.filter((entry) => entry.kind === "pi.assistant");
  console.log(
    JSON.stringify({
      pi: "state",
      frames: pi.frames,
      entries: pi.state.entries.length,
      running: pi.state.running,
      lastAnswer: pi.piMessageText(answers.at(-1)?.model?.[0]).slice(0, 200),
    }),
  );
  pi.socket.close();
}
