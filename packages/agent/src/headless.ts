/**
 * A headless Stella chat on the new harness: the desktop's harness, over
 * one SQLite file, talking to the model gateway as the desktop does.
 *
 *   bun packages/agent/src/headless.ts --data-dir <dir> --test-account <email> --prompt "Hi"
 *   bun packages/agent/src/headless.ts --data-dir <dir> --test-account <email> --resume
 *
 * `--resume` reopens the conversation and waits for whatever an earlier
 * process left unanswered, which is how a killed run is picked up. Output
 * is JSON lines on stdout.
 */
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, watchEvents, type Conversation, type Harness, type SubmissionRecord } from "@earendil-works/pi-durable";
import { openStellaHarness, stellaModelRef } from "./harness.ts";
import { desktopContextSources } from "./host/desktop-sources.ts";
import { desktopGatewayAccess, resolveStellaModels } from "./host/desktop-gateway.ts";
import { stellaProvider } from "./provider/stella.ts";
import { openBunSqliteStorage } from "./storage/bun-sqlite.ts";

const DEV_BACKEND = "https://stella-v2-cloud-builder-dev.fromyou.workers.dev";
const context = BACKGROUND_CONTEXT;

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    conversation: { type: "string", default: "headless" },
    backend: { type: "string" },
    "auth-token": { type: "string" },
    "test-account": { type: "string" },
    prompt: { type: "string" },
    "request-id": { type: "string" },
    resume: { type: "boolean", default: false },
    timeout: { type: "string", default: "600" },
  },
});

const out = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(record)}\n`);

const dataDir = values["data-dir"];
if (!dataDir) throw new Error("--data-dir is required (use an isolated directory).");
if (!values.prompt && !values.resume) throw new Error("Pass --prompt <text> or --resume.");
const backendUrl = (values.backend ?? process.env.STELLA_BACKEND_URL ?? DEV_BACKEND).replace(/\/+$/, "");

/** A Better Auth JWT: given, or minted for a dev test account. */
async function authToken(): Promise<string> {
  const given = values["auth-token"] ?? process.env.STELLA_AUTH_TOKEN;
  if (given) return given;
  const email = values["test-account"];
  if (!email) throw new Error("Pass --auth-token, STELLA_AUTH_TOKEN, or --test-account <email@test.stella.local>.");
  const admin = process.env.STELLA_ADMIN_API_SECRET;
  if (!admin) throw new Error("STELLA_ADMIN_API_SECRET is needed for --test-account.");
  const response = await fetch(`${backendUrl}/api/admin/test-accounts/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ email, plan: "pro", usageMode: "unlimited" }),
  });
  if (!response.ok) throw new Error(`Test account: ${response.status} ${await response.text()}`);
  const { token } = (await response.json()) as { token: string };
  // An owner reads as anonymous until a signed-in call names it; the gateway
  // refuses anonymous owners from hosting networks.
  await fetch(`${backendUrl}/api/rpc/owner.identity`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ args: {} }),
  });
  return token;
}

/** This data directory's device key; the real app keeps it in protected storage. */
async function deviceSigner() {
  const file = path.join(dataDir!, "headless-device.json");
  let pkcs8: string;
  try {
    pkcs8 = (JSON.parse(await readFile(file, "utf8")) as { pkcs8: string }).pkcs8;
  } catch {
    const { privateKey } = generateKeyPairSync("ed25519");
    pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    await writeFile(file, JSON.stringify({ pkcs8 }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string };
  return {
    alg: "ed25519" as const,
    rawPublicKey: new Uint8Array(Buffer.from(jwk.x, "base64url")),
    sign: async (input: string) => sign(null, Buffer.from(input, "utf8"), privateKey).toString("base64url"),
  };
}

const assistantText = async (harness: Harness, conversation: Conversation, answer: number) => {
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answer as never), context);
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

async function main() {
  await mkdir(dataDir!, { recursive: true });
  const token = await authToken();
  const signer = await deviceSigner();
  const catalog = (await (await fetch(`${backendUrl}/api/stella/models`)).json()) as { gateway?: { origin?: string } };
  const gatewayOrigin = catalog.gateway?.origin;
  if (!gatewayOrigin) throw new Error("The backend's model catalog names no gateway origin.");
  const access = desktopGatewayAccess({ gatewayOrigin, getAuthToken: () => token, getDeviceSigner: () => signer });
  const specs = await resolveStellaModels(access, gatewayOrigin, "stella/default", ["orchestrator", "general"]);
  const models = createModels();
  models.setProvider(stellaProvider({ access, models: specs }));

  const database = path.join(dataDir!, "agent", `${values.conversation}.sqlite`);
  const storage = await openBunSqliteStorage(database);
  const { harness } = await openStellaHarness(
    {
      storage,
      models,
      sources: desktopContextSources({
        stellaHome: dataDir!,
        backendUrl,
        destination: { kind: "device", deviceId: "headless", label: "This computer (headless)" },
      }),
    },
    context,
  );
  const root = await harness.root(context, { agent: { model: stellaModelRef("orchestrator") } });
  out({ kind: "start", pid: process.pid, database, conversationId: root.id });

  const events = await watchEvents(harness, root.id, context);
  events.start(async (batch) => {
    for (const event of batch) {
      if (event.type === "message_end") {
        const message = event.entry.model?.[0];
        out({ kind: "entry", entryId: event.entry.id, entryKind: event.entry.kind, role: message?.role });
      } else if (event.type === "run_start" || event.type === "run_end" || event.type === "turn_start" || event.type === "turn_end") {
        out({ kind: event.type });
      } else if (event.type === "auto_retry_start") {
        out({ kind: event.type, attempt: event.attempt, error: event.errorMessage });
      } else if (event.type === "task_failed") {
        out({ kind: event.type, taskKind: event.kind, message: event.message });
      }
    }
  });

  // Recovered work starts here: a run the last process left mid-request
  // resends the same committed request.
  harness.resume();

  const waiting: SubmissionRecord[] = [];
  if (values.prompt) {
    const requestId = values["request-id"] ?? crypto.randomUUID();
    const submission = await root.submit({ type: "input", content: values.prompt, requestId }, context);
    out({ kind: "submitted", submissionId: submission.id, requestId });
    waiting.push(await submission.status(context));
  } else {
    const inspection = await harness.inspect(context);
    waiting.push(...inspection.submissions.filter((record) => record.conversationId === root.id));
    out({ kind: "resumed", pending: waiting.map((record) => ({ id: record.id, requestId: record.requestId, status: record.status })), liveTasks: inspection.tasks.length });
  }

  const deadline = AbortSignal.timeout(Number(values.timeout) * 1000);
  for (const record of waiting) {
    const submission = await harness.submission(record.id, context);
    if (!submission) continue;
    const settled = await Promise.race([
      submission.wait(context),
      new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(new Error("timed out")))),
    ]);
    out(
      settled.status === "done" && settled.type === "input"
        ? { kind: "answer", submissionId: record.id, requestId: record.requestId, text: await assistantText(harness, root, settled.answer) }
        : { kind: "unanswered", submissionId: record.id, requestId: record.requestId, reason: settled.status === "unanswered" ? settled.reason : undefined },
    );
  }
  await root.waitForIdle(context);
  const view = await root.context(context);
  out({ kind: "transcript", entries: view.entries.map((entry) => ({ id: entry.id, kind: entry.kind })) });
  await events.stop();
  await harness.close(context);
}

await main();
