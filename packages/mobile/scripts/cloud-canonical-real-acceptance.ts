#!/usr/bin/env bun
/// <reference types="bun-types" />

/**
 * Real signed-in mobile acceptance harness.
 *
 * This is intentionally a fixed product path, not a fixture runner: it imports
 * the same authority, WebSocket, outbox, placement, and journal-projection
 * modules used by the native Chat surface and contacts only the caller-selected
 * deployed Convex/Worker origins. Credentials are accepted through the process
 * environment and are never written to stdout or the durable outbox file.
 */

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  observeCloudConversationIdentity,
  type CloudConversationIdentity,
} from "../src/lib/cloud-conversation-auth";
import { loadCloudConversationAuthority } from "../src/lib/cloud-conversation-authority";
import {
  ConversationSocket,
  type ConversationSocketEvent,
} from "../src/lib/cloud-conversation-socket";
import type {
  JournalRecord,
  ReadyFrame,
} from "../src/lib/cloud-conversation-protocol";
import {
  canonicalCloudDispatchIds,
  projectCloudConversationMessages,
} from "../src/lib/cloud-journal-projection";
import {
  acknowledgeDesktopChatOutboxRecords,
  appendDesktopChatOutboxRecord,
  parseDesktopChatOutbox,
  partitionDesktopChatOutboxForAuthority,
  restoreOutboxMessages,
  type DesktopChatOutboxAuthority,
  type DesktopChatOutboxRecord,
} from "../src/lib/desktop-chat-outbox-state";
import {
  automaticExecutionConversationClientCreateId,
  automaticExecutionResultText,
  bindAutomaticExecutionAdmission,
  buildAutomaticExecutionAdmission,
  readAutomaticExecutionDispatch,
  waitForAutomaticExecutionStatus,
} from "../src/lib/execution-placement-core";
import { decodeMobileCloudMemoryPreferenceForSubject } from "../src/lib/cloud-memory-preference";
import { decodeConvexTokenOwner } from "../src/lib/convex-token-owner";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ID_PATTERN = UUID_PATTERN;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type ReceiptSurface = "convex" | "mobile-http" | "worker" | "mobile-client";

type Receipt = Readonly<{
  surface: ReceiptSurface;
  operation: string;
  status?: number;
  outcome?: string;
  requestIdSha256?: string;
  resourceIdSha256?: string;
  responseSha256?: string;
  stateSha256?: string;
  bytes?: number;
  count?: number;
  durationMs?: number;
  seq?: number;
}>;

type JsonResponse = Readonly<{
  value: unknown;
  status: number;
  responseSha256: string;
  bytes: number;
  durationMs: number;
}>;

type Hydration = Readonly<{
  ready: ReadyFrame;
  records: readonly JournalRecord[];
  status: "live";
  durationMs: number;
}>;

const fail: (message: string) => never = (message) => {
  throw new Error(message);
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) fail(message);
};

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) fail(`${key} is required.`);
  return value;
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string => {
  const encode = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(encode);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, encode(child)]),
    );
  };
  return JSON.stringify(encode(value));
};

const exactOrigin = (
  raw: string,
  protocols: readonly string[],
  label: string,
): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${label} is invalid.`);
  }
  const local =
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    protocols.includes("http:");
  assert(
    protocols.includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      (url.protocol === "https:" || local),
    `${label} must be a clean HTTPS origin.`,
  );
  return url.origin;
};

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(`${label} returned invalid JSON.`);
  }
};

const fetchJson = async (
  url: string,
  init: RequestInit,
  expectedStatuses: readonly number[],
  timeoutMs: number,
  label: string,
): Promise<JsonResponse> => {
  const started = Date.now();
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  assert(bytes <= MAX_RESPONSE_BYTES, `${label} exceeded the response limit.`);
  const responseSha256 = sha256(text);
  assert(
    expectedStatuses.includes(response.status),
    `${label} returned an unexpected status (${response.status}; ${responseSha256}).`,
  );
  return {
    value: parseJson(text, label),
    status: response.status,
    responseSha256,
    bytes,
    durationMs: Date.now() - started,
  };
};

const convexCall = async (
  convexOrigin: string,
  jwt: string,
  kind: "query" | "mutation",
  functionPath: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  receipts: Receipt[],
): Promise<unknown> => {
  const response = await fetchJson(
    `${convexOrigin}/api/${kind}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: functionPath, args, format: "json" }),
    },
    [200],
    timeoutMs,
    `Convex ${functionPath}`,
  );
  const envelope = response.value as {
    status?: unknown;
    value?: unknown;
  } | null;
  assert(
    envelope && typeof envelope === "object" && envelope.status !== "error",
    `Convex ${functionPath} failed (${response.responseSha256}).`,
  );
  assert(
    Object.hasOwn(envelope, "value"),
    `Convex ${functionPath} omitted its value.`,
  );
  receipts.push({
    surface: "convex",
    operation: `${kind}.${functionPath.replaceAll(":", ".")}`.toLowerCase(),
    status: response.status,
    responseSha256: response.responseSha256,
    bytes: response.bytes,
    durationMs: response.durationMs,
  });
  return envelope.value;
};

const requireString = (
  value: unknown,
  label: string,
  maximum = 512,
): string => {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} is invalid.`,
  );
  return value;
};

const resolveOutboxFile = async (
  harnessRootRaw: string,
  outboxFileRaw: string,
): Promise<{ harnessRoot: string; outboxFile: string }> => {
  const harnessRoot = await realpath(harnessRootRaw);
  const outboxFile = path.resolve(outboxFileRaw);
  const relative = path.relative(harnessRoot, outboxFile);
  assert(
    path.isAbsolute(outboxFileRaw) &&
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      outboxFile.endsWith(".json"),
    "The mobile outbox file must be a JSON file inside the isolated harness root.",
  );
  await mkdir(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
  return { harnessRoot, outboxFile };
};

const outboxExists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const writeOutbox = async (
  file: string,
  records: readonly DesktopChatOutboxRecord[],
): Promise<string> => {
  const body = JSON.stringify(records);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  return sha256(body);
};

const readOutbox = async (file: string): Promise<DesktopChatOutboxRecord[]> =>
  parseDesktopChatOutbox(
    parseJson(await readFile(file, "utf8"), "Mobile outbox"),
  );

const hydrateConversation = async (args: {
  conversationId: string;
  socketOrigin: string;
  jwt: string;
  timeoutMs: number;
}): Promise<Hydration> => {
  const started = Date.now();
  let ready: ReadyFrame | null = null;
  let live = false;
  const records = new Map<number, JournalRecord>();
  let settled = false;
  let resolveResult!: (value: Hydration) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<Hydration>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const maybeResolve = () => {
    if (settled || !ready || !live) return;
    const highest = Math.max(-1, ...records.keys());
    if (ready.headSeq >= 0 && highest < ready.headSeq) return;
    settled = true;
    resolveResult({
      ready,
      records: [...records.values()].sort(
        (left, right) => left.seq - right.seq,
      ),
      status: "live",
      durationMs: Date.now() - started,
    });
  };
  const onEvent = (event: ConversationSocketEvent) => {
    if (event.type === "ready") {
      ready = event.ready;
      assert(
        ready.conversationId === args.conversationId,
        "The WebSocket returned another conversation authority.",
      );
    } else if (event.type === "records") {
      for (const record of event.records) records.set(record.seq, record);
    } else if (event.type === "status") {
      if (event.status === "live") live = true;
      if (event.status === "blocked" && !settled) {
        settled = true;
        rejectResult(new Error("The canonical mobile WebSocket was blocked."));
      }
    } else if (event.type === "gap" && !settled) {
      settled = true;
      rejectResult(new Error("The canonical mobile WebSocket exposed a gap."));
    }
    maybeResolve();
  };
  const socket = new ConversationSocket({
    conversationId: args.conversationId,
    baseUrl: args.socketOrigin,
    getToken: async () => args.jwt,
    isActive: () => true,
    onEvent,
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult(new Error("Canonical mobile WebSocket hydration timed out."));
  }, args.timeoutMs);
  socket.start();
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    socket.stop();
  }
};

const submitExecution = async (args: {
  convexSiteOrigin: string;
  jwt: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  operation: string;
  receipts: Receipt[];
}) => {
  const response = await fetchJson(
    `${args.convexSiteOrigin}/api/mobile/execution/submit`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.body),
    },
    [202],
    args.timeoutMs,
    "Mobile execution admission",
  );
  const dispatch = readAutomaticExecutionDispatch(response.value, {
    idempotencyKey: String(args.body.idempotencyKey),
  }) as ReturnType<typeof readAutomaticExecutionDispatch> & {
    cloudTurnId?: string;
    resultJson?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  args.receipts.push({
    surface: "mobile-http",
    operation: args.operation,
    status: response.status,
    requestIdSha256: sha256(dispatch.idempotencyKey),
    resourceIdSha256: sha256(dispatch.dispatchId),
    responseSha256: response.responseSha256,
    bytes: response.bytes,
    durationMs: response.durationMs,
  });
  return dispatch;
};

export const assertBun14 = (version: string | undefined): string => {
  const checked = version?.trim() ?? "";
  assert(/^1\.4\.[0-9]+(?:[-+].*)?$/u.test(checked), "Bun 1.4.x is required.");
  return checked;
};

export const runMobileCanonicalRealAcceptance = async (): Promise<unknown> => {
  const bunVersion = assertBun14(
    (process.versions as Record<string, string | undefined>).bun,
  );
  const runId = required("STELLA_MOBILE_ACCEPTANCE_RUN_ID");
  assert(RUN_ID_PATTERN.test(runId), "The acceptance run id is invalid.");
  const phase = required("STELLA_MOBILE_ACCEPTANCE_PHASE");
  assert(
    phase === "enqueue" || phase === "replay",
    "The mobile acceptance phase is invalid.",
  );
  const jwt = required("STELLA_MOBILE_ACCEPTANCE_JWT");
  const sessionSubject = required("STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT");
  const sessionId = required("STELLA_MOBILE_ACCEPTANCE_SESSION_ID");
  const expectedOwnerGeneration = required(
    "STELLA_MOBILE_ACCEPTANCE_OWNER_GENERATION",
  );
  const convexOrigin = exactOrigin(
    required("STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN"),
    ["https:", "http:"],
    "Convex origin",
  );
  const convexSiteOrigin = exactOrigin(
    required("STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN"),
    ["https:", "http:"],
    "Convex site origin",
  );
  const expectedBuilderOrigin = exactOrigin(
    required("STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN"),
    ["https:", "http:"],
    "Cloud builder origin",
  );
  const timeoutMs = Math.max(
    60_000,
    Math.min(
      DEFAULT_TIMEOUT_MS,
      Number(process.env.STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS) ||
        DEFAULT_TIMEOUT_MS,
    ),
  );
  const { outboxFile } = await resolveOutboxFile(
    required("STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT"),
    required("STELLA_MOBILE_ACCEPTANCE_OUTBOX_FILE"),
  );
  assert(
    phase === "enqueue"
      ? !(await outboxExists(outboxFile))
      : await outboxExists(outboxFile),
    phase === "enqueue"
      ? "The mobile outbox file is not fresh."
      : "The prior-process mobile outbox is unavailable.",
  );

  const receipts: Receipt[] = [];
  const tokenOwner = decodeConvexTokenOwner(jwt);
  assert(
    tokenOwner.subject === sessionSubject,
    "The native session and Convex bearer token identify different users.",
  );
  const identity = observeCloudConversationIdentity({
    user: { id: sessionSubject },
    session: { id: sessionId },
  });
  assert(identity, "The native signed-in session produced no mobile identity.");

  let ensuredConversationOwner = "";
  const authority = await loadCloudConversationAuthority(
    identity as CloudConversationIdentity,
    {
      confirmIdentity: async (input) =>
        (await convexCall(
          convexOrigin,
          jwt,
          "query",
          "cloud_apps:confirmMySessionIdentity",
          input,
          timeoutMs,
          receipts,
        )) === true,
      ensureConversation: async () => {
        const value = (await convexCall(
          convexOrigin,
          jwt,
          "mutation",
          "cloud_apps:createMyConversation",
          {
            clientCreateId:
              automaticExecutionConversationClientCreateId("cloud"),
            title: "Chat",
          },
          timeoutMs,
          receipts,
        )) as Record<string, unknown>;
        const conversationId = requireString(
          value?.conversationId,
          "Mobile conversation id",
          256,
        );
        assert(
          UUID_PATTERN.test(conversationId),
          "Mobile conversation id is invalid.",
        );
        ensuredConversationOwner = requireString(
          value?.ownerId,
          "Mobile conversation owner",
        );
        assert(
          ensuredConversationOwner === tokenOwner.tokenIdentifier,
          "The deterministic mobile conversation belongs to another owner.",
        );
        return conversationId;
      },
      getRealtimeConfig: async () => {
        const value = (await convexCall(
          convexOrigin,
          jwt,
          "query",
          "cloud_apps:getCloudRealtimeConfig",
          {},
          timeoutMs,
          receipts,
        )) as Record<string, unknown>;
        return {
          httpOrigin:
            typeof value?.httpOrigin === "string" ? value.httpOrigin : null,
          socketOrigin:
            typeof value?.socketOrigin === "string" ? value.socketOrigin : null,
          protocol:
            typeof value?.protocol === "number" ? value.protocol : Number.NaN,
        };
      },
      getOwnerGeneration: async () => {
        const value = await convexCall(
          convexOrigin,
          jwt,
          "query",
          "cloud_memory:getMyMemoryPreference",
          { expectedSubject: tokenOwner.tokenIdentifier },
          timeoutMs,
          receipts,
        );
        return decodeMobileCloudMemoryPreferenceForSubject(
          value,
          tokenOwner.tokenIdentifier,
        ).ownerGeneration;
      },
    },
  );
  assert(
    authority.accountScope === identity.accountScope &&
      authority.identityKey === identity.identityKey &&
      authority.ownerGeneration === expectedOwnerGeneration,
    "The resolved mobile authority disagrees with the signed-in account fence.",
  );
  assert(
    authority.socketOrigin === expectedBuilderOrigin.replace(/^http/u, "ws"),
    "The mobile realtime authority is not the selected cloud builder.",
  );

  const initialHydration = await hydrateConversation({
    conversationId: authority.conversationId,
    socketOrigin: authority.socketOrigin,
    jwt,
    timeoutMs: Math.min(timeoutMs, 90_000),
  });
  receipts.push({
    surface: "worker",
    operation: "mobile.websocket.initial-ready",
    outcome: "ready",
    resourceIdSha256: sha256(authority.conversationId),
    responseSha256: sha256(stableJson(initialHydration.ready)),
    stateSha256: sha256(stableJson(initialHydration.records)),
    count: initialHydration.records.length,
    durationMs: initialHydration.durationMs,
    ...(initialHydration.ready.headSeq >= 0
      ? { seq: initialHydration.ready.headSeq }
      : {}),
  });

  const authorityFence: DesktopChatOutboxAuthority = {
    accountScope: authority.accountScope,
    ownerGeneration: authority.ownerGeneration,
    conversationId: authority.conversationId,
  };
  const sendId = `mobile-acceptance:${runId}`;
  const marker = `MOBILE-CANONICAL-${runId}`;
  const prompt = `Signed-in mobile canonical acceptance. Reply exactly ${marker}.`;
  if (phase === "enqueue") {
    const enqueued = appendDesktopChatOutboxRecord([], {
      sendId,
      userMessageId: sendId,
      text: prompt,
      displayText: prompt,
      createdAt: Date.now(),
      assets: [],
      authority: authorityFence,
    });
    const durableStateSha256 = await writeOutbox(outboxFile, enqueued.records);
    receipts.push({
      surface: "mobile-client",
      operation: "mobile.outbox.enqueue",
      outcome: "committed",
      requestIdSha256: sha256(sendId),
      stateSha256: durableStateSha256,
      count: enqueued.records.length,
    });
    return {
      version: 1,
      phase,
      bunVersion,
      productModuleCount: 8,
      identity: {
        identityRevision: identity.revision,
        identityKeySha256: sha256(identity.identityKey),
        accountScopeSha256: sha256(identity.accountScope),
        sessionIdSha256: sha256(sessionId),
        tokenIdentifierSha256: sha256(tokenOwner.tokenIdentifier),
        subjectMatchesSignedSession: true,
      },
      authority: {
        conversationId: authority.conversationId,
        ownerGeneration: authority.ownerGeneration,
        socketOriginSha256: sha256(authority.socketOrigin),
        deterministicClientCreateIdSha256: sha256(
          automaticExecutionConversationClientCreateId("cloud"),
        ),
        identityConfirmed: true,
      },
      initialHydration: {
        coldSocket: true,
        epoch: initialHydration.ready.epoch,
        headSeq: initialHydration.ready.headSeq,
        recordCount: initialHydration.records.length,
        caughtUp: true,
      },
      outbox: {
        sendId,
        sendIdSha256: sha256(sendId),
        promptSha256: sha256(prompt),
        durableStateSha256,
        enqueuedBeforeNetwork: true,
        processExitedBeforeAdmission: true,
      },
      receipts,
    };
  }

  // This process has no enqueue result at all. Everything below starts from
  // bytes committed by the prior Bun process, matching an iOS process death
  // before network admission.
  const outboxSha256BeforeReload = sha256(await readFile(outboxFile));
  const restartedRows = await readOutbox(outboxFile);
  const scoped = partitionDesktopChatOutboxForAuthority(
    restartedRows,
    authorityFence,
  );
  assert(
    scoped.active.length === 1 &&
      scoped.stale.length === 0 &&
      scoped.active[0]?.sendId === sendId,
    "The restarted outbox did not replay the exact signed-in authority row.",
  );
  const restoredMessages = restoreOutboxMessages([], scoped.active);
  assert(
    restoredMessages.length === 1 &&
      restoredMessages[0]?.id === sendId &&
      restoredMessages[0]?.queued === true,
    "The durable mobile outbox did not restore its optimistic queued message.",
  );
  receipts.push({
    surface: "mobile-client",
    operation: "mobile.outbox.reload",
    outcome: "replayable",
    requestIdSha256: sha256(sendId),
    stateSha256: sha256(stableJson(scoped.active)),
    count: scoped.active.length,
  });

  const admission = buildAutomaticExecutionAdmission({
    idempotencyKey: scoped.active[0]!.sendId,
    conversationId: authority.conversationId,
    kind: "chat",
    prompt: scoped.active[0]!.text,
    requiredCapabilities: ["chat"],
  });
  const admitted = await submitExecution({
    convexSiteOrigin,
    jwt,
    body: admission.body,
    timeoutMs,
    operation: "mobile.execution.submit",
    receipts,
  });
  const control = bindAutomaticExecutionAdmission(
    { clientIdempotencyKey: sendId },
    admitted,
  );
  assert(
    control.serverDispatchId === admitted.dispatchId &&
      admitted.conversationId === authority.conversationId,
    "Mobile admission changed the durable outbox or conversation identity.",
  );
  const replayed = await submitExecution({
    convexSiteOrigin,
    jwt,
    body: admission.body,
    timeoutMs,
    operation: "mobile.execution.replay",
    receipts,
  });
  assert(
    replayed.dispatchId === admitted.dispatchId &&
      replayed.revision >= admitted.revision,
    "Mobile admission replay created a second server dispatch.",
  );

  let statusReads = 0;
  const terminal = await waitForAutomaticExecutionStatus({
    dispatchId: admitted.dispatchId,
    pollIntervalMs: 750,
    readStatus: async (dispatchId) => {
      statusReads += 1;
      const response = await fetchJson(
        `${convexSiteOrigin}/api/mobile/execution/status?dispatchId=${encodeURIComponent(dispatchId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${jwt}` },
        },
        [200],
        Math.min(timeoutMs, 30_000),
        "Mobile execution status",
      );
      const status = readAutomaticExecutionDispatch(response.value, {
        dispatchId,
      }) as ReturnType<typeof readAutomaticExecutionDispatch> & {
        cloudTurnId?: string;
        resultJson?: string;
        errorCode?: string;
        errorMessage?: string;
      };
      if (["completed", "failed", "canceled"].includes(status.state)) {
        receipts.push({
          surface: "mobile-http",
          operation: "mobile.execution.terminal",
          status: response.status,
          outcome: status.state,
          resourceIdSha256: sha256(dispatchId),
          responseSha256: response.responseSha256,
          bytes: response.bytes,
          durationMs: response.durationMs,
          count: statusReads,
        });
      }
      return status;
    },
  });
  assert(
    terminal.state === "completed" &&
      terminal.placement === "cloud" &&
      terminal.conversationId === authority.conversationId,
    "The signed-in portable mobile turn did not complete in cloud placement.",
  );
  const cloudTurnId = requireString(
    terminal.cloudTurnId,
    "Mobile canonical cloud turn id",
    256,
  );
  assert(
    UUID_PATTERN.test(cloudTurnId),
    "Mobile canonical cloud turn id is invalid.",
  );

  // A brand-new socket has no local cursor or transcript. Its tail must rebuild
  // the just-completed outbox turn entirely from the authoritative DO journal.
  const cleanHydration = await hydrateConversation({
    conversationId: authority.conversationId,
    socketOrigin: authority.socketOrigin,
    jwt,
    timeoutMs: Math.min(timeoutMs, 90_000),
  });
  const turnRecords = cleanHydration.records.filter(
    (record) => record.turnId === cloudTurnId,
  );
  const promptRecord = turnRecords.find(
    (record) =>
      record.kind === "message" &&
      record.role === "user" &&
      record.clientMsgId === admitted.dispatchId,
  );
  const terminalRecord = turnRecords.find(
    (record): record is Extract<JournalRecord, { kind: "turn" }> =>
      record.kind === "turn" && record.phase === "completed",
  );
  assert(promptRecord, "Clean mobile hydration omitted the admitted user row.");
  assert(
    terminalRecord,
    "Clean mobile hydration omitted the terminal turn row.",
  );
  assert(
    canonicalCloudDispatchIds(cleanHydration.records).has(admitted.dispatchId),
    "The hydrated journal did not acknowledge the server dispatch id.",
  );
  const projected = projectCloudConversationMessages({
    conversationId: authority.conversationId,
    records: cleanHydration.records,
    live: null,
    hasOlder:
      cleanHydration.ready.windowStartSeq > cleanHydration.ready.floorSeq,
  });
  const projectedUser = projected.find(
    (message) => message.role === "user" && message.id === admitted.dispatchId,
  );
  const projectedAssistant = projected.find(
    (message) =>
      message.role === "assistant" &&
      message.requestId === admitted.dispatchId &&
      message.text.includes(marker),
  );
  assert(
    projectedUser && projectedAssistant,
    "The native journal projection did not reconstruct the exact mobile turn.",
  );
  receipts.push({
    surface: "worker",
    operation: "mobile.websocket.clean-hydration",
    outcome: "terminal",
    requestIdSha256: sha256(admitted.dispatchId),
    resourceIdSha256: sha256(cloudTurnId),
    responseSha256: sha256(stableJson(cleanHydration.ready)),
    stateSha256: sha256(stableJson(turnRecords)),
    count: cleanHydration.records.length,
    durationMs: cleanHydration.durationMs,
    seq: terminalRecord.seq,
  });

  const acknowledged = acknowledgeDesktopChatOutboxRecords(
    restartedRows,
    new Set([admitted.dispatchId, sendId]),
    authorityFence,
  );
  assert(
    acknowledged.length === 0,
    "The terminal mobile outbox row was not acknowledged.",
  );
  await unlink(outboxFile);
  assert(
    !(await outboxExists(outboxFile)),
    "The acknowledged mobile outbox remained durable.",
  );
  receipts.push({
    surface: "mobile-client",
    operation: "mobile.outbox.acknowledge",
    outcome: "removed",
    requestIdSha256: sha256(sendId),
    stateSha256: sha256("absent"),
    count: 0,
  });

  for (const receipt of receipts) {
    for (const digest of [
      receipt.requestIdSha256,
      receipt.resourceIdSha256,
      receipt.responseSha256,
      receipt.stateSha256,
    ]) {
      assert(
        digest === undefined || SHA256_PATTERN.test(digest),
        "A receipt digest is invalid.",
      );
    }
  }

  return {
    version: 1,
    phase,
    bunVersion,
    productModuleCount: 8,
    identity: {
      identityRevision: identity.revision,
      identityKeySha256: sha256(identity.identityKey),
      accountScopeSha256: sha256(identity.accountScope),
      sessionIdSha256: sha256(sessionId),
      tokenIdentifierSha256: sha256(tokenOwner.tokenIdentifier),
      subjectMatchesSignedSession: true,
    },
    authority: {
      conversationId: authority.conversationId,
      ownerGeneration: authority.ownerGeneration,
      socketOriginSha256: sha256(authority.socketOrigin),
      deterministicClientCreateIdSha256: sha256(
        automaticExecutionConversationClientCreateId("cloud"),
      ),
      identityConfirmed: true,
    },
    initialHydration: {
      coldSocket: true,
      epoch: initialHydration.ready.epoch,
      headSeq: initialHydration.ready.headSeq,
      recordCount: initialHydration.records.length,
      caughtUp: true,
    },
    outbox: {
      sendId,
      sendIdSha256: sha256(sendId),
      promptSha256: sha256(prompt),
      durableStateSha256: outboxSha256BeforeReload,
      enqueuedBeforeNetwork: true,
      restartedFromDurableBytes: true,
      restoredQueuedMessage: true,
      authorityFenceMatched: true,
      acknowledgedAfterTerminal: true,
      durableBytesRemoved: true,
    },
    execution: {
      dispatchId: admitted.dispatchId,
      dispatchIdSha256: sha256(admitted.dispatchId),
      replayDispatchIdSha256: sha256(replayed.dispatchId),
      duplicateAdmissionCollapsed: true,
      placement: terminal.placement,
      state: terminal.state,
      cloudTurnId,
      terminalRevision: terminal.revision,
      terminalResultSha256: sha256(automaticExecutionResultText(terminal)),
      statusReadCount: statusReads,
    },
    cleanHydration: {
      coldSocket: true,
      conversationId: cleanHydration.ready.conversationId,
      epoch: cleanHydration.ready.epoch,
      headSeq: cleanHydration.ready.headSeq,
      floorSeq: cleanHydration.ready.floorSeq,
      recordCount: cleanHydration.records.length,
      turnRecordCount: turnRecords.length,
      promptSeq: promptRecord.seq,
      terminalSeq: terminalRecord.seq,
      terminalPhase: terminalRecord.phase,
      dispatchLinked: true,
      projectedUser: true,
      projectedAssistant: true,
      projectedAssistantSha256: sha256(projectedAssistant.text),
    },
    receipts,
  };
};

if (import.meta.main) {
  runMobileCanonicalRealAcceptance().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ ok: false, errorSha256: sha256(message) })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
