#!/usr/bin/env node

/**
 * Mutating protocol verification for the dedicated Stella acceptance preview.
 *
 * This is intentionally NOT product acceptance. It exercises the authenticated
 * Convex + cloud-builder contracts directly and writes synthetic assistant rows
 * to prove journal mechanics. Real Electron streaming, routing, reconnect, and
 * cache-loss acceptance belongs to cloud-canonical-acceptance.mjs.
 *
 * Required environment (all fail closed):
 *   CONVEX_DEPLOYMENT=preview:basic-nightingale-118
 *   CONVEX_URL=https://basic-nightingale-118.convex.cloud
 *   CONVEX_SITE_URL=https://basic-nightingale-118.convex.site
 *   CLOUD_BUILDER_URL=https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev
 *   STELLA_CLOUD_PROOF_CONFIRM=mutate-preview:basic-nightingale-118
 *   STELLA_CLOUD_PROOF_IDENTITY_KIND=disposable
 *   STELLA_CLOUD_PROOF_JWT=<short-lived disposable identity JWT>
 *   BUILDER_SERVICE_SECRET=<matching preview service secret>
 *   STELLA_CLOUD_PROOF_EVIDENCE_PATH=/absolute/path/evidence.json
 *
 * Add --with-r2 to force enough synthetic journal rows to cross the rollover
 * threshold and prove a cold read through R2. The created conversation is
 * always tombstoned and purged in finally.
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import {
  CloudProofError,
  assert,
  loadProtocolProofConfig,
  poll,
  requestJson,
  sanitizeEvidence,
  sha256,
  writeEvidence,
} from "./cloud-proof-lib.mjs";

const WITH_R2 = process.argv.slice(2).includes("--with-r2");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--with-r2");
if (unknownArguments.length > 0) {
  throw new CloudProofError(
    `Unknown argument(s): ${unknownArguments.join(", ")}. Only --with-r2 is supported.`,
  );
}

const config = loadProtocolProofConfig(process.env);
try {
  await access(config.evidencePath);
  throw new CloudProofError(
    "Protocol evidence already exists; choose a fresh evidence path before any dev writes.",
  );
} catch (error) {
  if (error instanceof CloudProofError) throw error;
  if (error?.code !== "ENOENT") throw error;
}
const runId = randomUUID().replaceAll("-", "").slice(0, 20);
const startedAt = new Date().toISOString();
const checks = [];
let conversationId = null;
let expectedOwnerGeneration = null;
let runError = null;

const evidence = {
  version: 1,
  kind: "cloud-canonical-protocol-smoke",
  acceptance: false,
  syntheticAssistantRecords: true,
  scope: WITH_R2 ? "protocol-plus-r2" : "fast-protocol",
  runId,
  startedAt,
  target: {
    convexDeployment: config.deployment,
    convexUrl: config.convexUrl,
    convexSiteUrl: config.convexSiteUrl,
    cloudBuilderUrl: config.cloudBuilderUrl,
  },
  checks,
  limitations: [
    "Direct protocol calls do not prove Electron or runtime integration.",
    "The stateless second API client is not clean-profile product acceptance.",
    "Assistant rows in this smoke are synthetic; no model is invoked.",
    "Real cancellation and no-local-fallback behavior require the acceptance runner.",
  ],
};

const pass = (name, details = {}) => {
  checks.push({ name, passed: true, at: new Date().toISOString(), ...details });
};

const userHeaders = () => ({
  authorization: `Bearer ${config.jwt}`,
  "content-type": "application/json",
});

const serviceHeaders = () => ({
  authorization: `Bearer ${config.builderServiceSecret}`,
  "content-type": "application/json",
});

const userMessage = (text) =>
  JSON.stringify({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

const assistantMessage = (text) =>
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "stella-proof",
    model: "protocol-smoke",
    stopReason: "end_turn",
    usage: {},
    timestamp: Date.now(),
  });

const convexCall = async (kind, functionPath, args, label) => {
  const response = await requestJson(`${config.convexUrl}/api/${kind}`, {
    label,
    timeoutMs: config.timeoutMs,
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify({ path: functionPath, args, format: "json" }),
  });
  const body = response.body;
  assert(body && typeof body === "object", `${label} returned no result.`);
  assert(body.status !== "error", `${label} returned a Convex error.`, {
    errorMessage: body.errorMessage,
    errorData: body.errorData,
  });
  assert(
    Object.prototype.hasOwnProperty.call(body, "value"),
    `${label} omitted its value.`,
  );
  return body.value;
};

const convexMutation = (functionPath, args, label) =>
  convexCall("mutation", functionPath, args, label);
const convexQuery = (functionPath, args, label) =>
  convexCall("query", functionPath, args, label);
const convexAction = (functionPath, args, label) =>
  convexCall("action", functionPath, args, label);

const workerUserRequest = (pathname, init, label, options = {}) =>
  requestJson(`${config.cloudBuilderUrl}${pathname}`, {
    label,
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    expectedStatuses: options.expectedStatuses ?? [200],
    maxResponseBytes: options.maxResponseBytes,
    ...init,
    headers: { ...userHeaders(), ...(init.headers ?? {}) },
  });

const workerServiceRequest = (pathname, init, label, options = {}) =>
  requestJson(`${config.cloudBuilderUrl}${pathname}`, {
    label,
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    expectedStatuses: options.expectedStatuses ?? [200],
    maxResponseBytes: options.maxResponseBytes,
    ...init,
    headers: { ...serviceHeaders(), ...(init.headers ?? {}) },
  });

const beginTurn = async ({
  deviceId,
  localTurnId,
  clientMsgId,
  userMessageJson,
}) =>
  (
    await workerUserRequest(
      `/conversations/${encodeURIComponent(conversationId)}/local-turns/begin`,
      {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          expectedOwnerGeneration,
          localTurnId,
          clientMsgId,
          userMessageJson,
        }),
      },
      `begin ${localTurnId}`,
      { maxResponseBytes: 2_000_000 },
    )
  ).body;

const finishTurn = async (
  { deviceId, localTurnId, leaseToken, phase = "completed", records = [] },
  options = {},
) =>
  (
    await workerUserRequest(
      `/conversations/${encodeURIComponent(conversationId)}/local-turns/finish`,
      {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          expectedOwnerGeneration,
          localTurnId,
          leaseToken,
          phase,
          records,
        }),
      },
      `finish ${localTurnId}`,
      options,
    )
  ).body;

const probeJournal = async (beforeSeq) => {
  const query = new URLSearchParams({ limit: "200" });
  if (beforeSeq !== undefined) query.set("beforeSeq", String(beforeSeq));
  return (
    await workerServiceRequest(
      `/conversations/${encodeURIComponent(conversationId)}/journal?${query}`,
      { method: "GET" },
      "journal probe",
      { maxResponseBytes: 2_000_000 },
    )
  ).body;
};

const canonicalHistory = async () =>
  (
    await workerUserRequest(
      `/conversations/${encodeURIComponent(conversationId)}/history`,
      { method: "GET" },
      "canonical history",
      { maxResponseBytes: 2_000_000 },
    )
  ).body;

const listConversations = () =>
  convexQuery("cloud_apps:listMyConversations", {}, "list conversations");

const messageText = (message) => {
  if (!message || typeof message !== "object") return "";
  return (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
};

const parseHistory = (body) => {
  assert(Array.isArray(body?.history), "History response omitted history.");
  return body.history.map((entry, index) => {
    assert(
      typeof entry === "string",
      `History entry ${index} is not serialized.`,
    );
    try {
      return JSON.parse(entry);
    } catch {
      throw new CloudProofError(`History entry ${index} is invalid JSON.`);
    }
  });
};

const loadWholeJournal = async () => {
  const initial = await probeJournal();
  const head = initial?.head;
  assert(
    head &&
      Number.isSafeInteger(head.headSeq) &&
      Number.isSafeInteger(head.floorSeq),
    "Journal probe omitted a valid head.",
  );
  if (head.headSeq < head.floorSeq)
    return { head, probe: initial, records: [] };
  let beforeSeq = head.headSeq + 1;
  let records = [];
  let pages = 0;
  while (beforeSeq > head.floorSeq) {
    pages += 1;
    assert(pages <= 100, "Journal pagination exceeded 100 pages.");
    const page = await probeJournal(beforeSeq);
    assert(Array.isArray(page?.records), "Journal page omitted records.");
    assert(
      page.records.length > 0,
      "Journal pagination stopped before floorSeq.",
      {
        beforeSeq,
        floorSeq: head.floorSeq,
      },
    );
    records = [...page.records, ...records];
    const firstSeq = page.records[0]?.seq;
    assert(
      Number.isSafeInteger(firstSeq),
      "Journal page has an invalid first seq.",
    );
    assert(firstSeq < beforeSeq, "Journal cursor did not move backwards.");
    beforeSeq = firstSeq;
  }
  assert(
    records[0]?.seq === head.floorSeq && records.at(-1)?.seq === head.headSeq,
    "Journal pagination did not cover the declared floor and head.",
    {
      firstSeq: records[0]?.seq,
      lastSeq: records.at(-1)?.seq,
      floorSeq: head.floorSeq,
      headSeq: head.headSeq,
    },
  );
  for (let index = 0; index < records.length; index += 1) {
    assert(
      records[index]?.seq === head.floorSeq + index,
      "Journal sequence is not gapless.",
      { index, seq: records[index]?.seq, expected: head.floorSeq + index },
    );
  }
  return { head, probe: initial, records };
};

const turnShape = (records, turnId) =>
  records
    .filter((record) => record.turnId === turnId)
    .map((record) =>
      record.kind === "message"
        ? `message:${record.role}`
        : record.kind === "turn"
          ? `turn:${record.phase}`
          : record.kind,
    );

const receiptFields = (receipt) => ({
  turnId: receipt?.turnId,
  phase: receipt?.phase,
  firstSeq: receipt?.firstSeq,
  lastSeq: receipt?.lastSeq,
  epoch: receipt?.epoch,
  replayed: receipt?.replayed,
});

const assertReceiptMatchesJournal = (receipt, records) => {
  assert(
    Number.isSafeInteger(receipt?.firstSeq),
    "Receipt firstSeq is invalid.",
  );
  assert(Number.isSafeInteger(receipt?.lastSeq), "Receipt lastSeq is invalid.");
  assert(
    receipt.firstSeq <= receipt.lastSeq,
    "Receipt sequence range is inverted.",
  );
  const range = records.filter(
    (record) => record.seq >= receipt.firstSeq && record.seq <= receipt.lastSeq,
  );
  assert(
    range.length === receipt.lastSeq - receipt.firstSeq + 1,
    "Receipt range has a gap.",
  );
  assert(
    range.every((record) => record.turnId === receipt.turnId),
    "Receipt range contains another turn.",
  );
};

const waitForProjection = async (expectedPreview) =>
  poll(
    async () => {
      const [list, probe] = await Promise.all([
        listConversations(),
        probeJournal(),
      ]);
      const row = Array.isArray(list)
        ? list.find((entry) => entry.conversationId === conversationId)
        : undefined;
      return { row, probe };
    },
    ({ row, probe }) =>
      row?.lastPreview === expectedPreview &&
      row?.activity === "idle" &&
      probe?.indexSyncedSeq === probe?.head?.headSeq &&
      probe?.pendingExcerpts === 0,
    {
      timeoutMs: config.projectionTimeoutMs,
      intervalMs: 750,
      label: "DO to Convex projection",
    },
  );

const verifyStaleProjectionFence = async (expectedPreview) => {
  const owner = (
    await requestJson(
      `${config.convexSiteUrl}/api/cloud/conversation-owner?conversationId=${encodeURIComponent(conversationId)}`,
      {
        label: "conversation owner lookup",
        timeoutMs: config.timeoutMs,
        method: "GET",
        headers: serviceHeaders(),
      },
    )
  ).body;
  assert(typeof owner?.ownerId === "string", "Owner lookup omitted ownerId.");
  assert(
    typeof owner?.ownerGeneration === "string",
    "Owner lookup omitted ownerGeneration.",
  );
  const probe = await probeJournal();
  assert(probe.head.headSeq > 0, "Projection fence needs a non-empty journal.");
  const poison = `stale-projection-${runId}`;
  const stale = (
    await requestJson(`${config.convexSiteUrl}/api/cloud/index`, {
      label: "stale projection write",
      timeoutMs: config.timeoutMs,
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify({
        conversationId,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        epoch: probe.head.epoch,
        lastSeq: probe.head.headSeq - 1,
        updatedAt: Date.now() + 60_000,
        lastPreview: poison,
        lastRole: "assistant",
        activity: "running",
      }),
    })
  ).body;
  assert(stale?.accepted === false, "Stale projection was accepted.", stale);
  assert(
    stale?.reason === "stale" && stale?.lastSeq === probe.head.headSeq,
    "Stale projection did not return the current monotonic fence.",
    stale,
  );
  const list = await listConversations();
  const row = list.find((entry) => entry.conversationId === conversationId);
  assert(
    row?.lastPreview === expectedPreview,
    "Stale projection changed preview.",
    {
      expectedPreview,
      actualPreview: row?.lastPreview,
    },
  );
  assert(row?.activity === "idle", "Stale projection changed activity.", {
    activity: row?.activity,
  });
  return {
    epoch: probe.head.epoch,
    lastSeq: probe.head.headSeq,
    reason: stale.reason,
    ownerHash: sha256(owner.ownerId),
  };
};

const executeSyntheticTurn = async ({
  clientLabel,
  turnLabel,
  userText,
  assistantTexts,
  phase = "completed",
}) => {
  const deviceId = `proof-${clientLabel}-${runId.slice(0, 8)}`;
  const localTurnId = `${turnLabel}-${runId}`;
  const clientMsgId = `msg-${turnLabel}-${runId}`.slice(0, 64);
  const beginBody = {
    deviceId,
    localTurnId,
    clientMsgId,
    userMessageJson: userMessage(userText),
  };
  const begun = await beginTurn(beginBody);
  assert(begun?.replayed === false, `${turnLabel} was unexpectedly replayed.`);
  assert(
    /^[a-f0-9]{64}$/.test(begun?.leaseToken ?? ""),
    `${turnLabel} lease token is invalid.`,
  );
  const records = assistantTexts.map((text, ordinal) => ({
    ordinal,
    role: "assistant",
    payloadJson: assistantMessage(text),
  }));
  const finishBody = {
    deviceId,
    localTurnId,
    leaseToken: begun.leaseToken,
    phase,
    records,
  };
  const finished = await finishTurn(finishBody, {
    timeoutMs: Math.max(config.timeoutMs, 60_000),
  });
  return { beginBody, begun, finishBody, finished };
};

const runFastProtocol = async () => {
  const health = await requestJson(`${config.cloudBuilderUrl}/healthz`, {
    label: "cloud-builder health",
    timeoutMs: config.timeoutMs,
    method: "GET",
  });
  assert(
    health.body?.ok === true &&
      health.body?.service === "stella-v2-cloud-builder",
    "Unexpected cloud-builder health response.",
    health.body,
  );
  pass("dedicated preview worker reachable", {
    service: health.body.service,
  });

  const placementIdentity = await convexQuery(
    "execution_placement:getMyExecutionPlacementIdentity",
    {},
    "resolve owner generation",
  );
  expectedOwnerGeneration = placementIdentity?.ownerGeneration;
  assert(
    typeof expectedOwnerGeneration === "string" &&
      expectedOwnerGeneration.trim() === expectedOwnerGeneration &&
      expectedOwnerGeneration.length > 0,
    "Execution placement identity omitted its owner generation.",
    placementIdentity,
  );

  const created = await convexMutation(
    "cloud_apps:createMyConversation",
    {
      clientCreateId: `proof-${runId}`,
      expectedOwnerGeneration,
      title: `Cloud protocol proof ${runId.slice(0, 8)}`,
    },
    "create conversation",
  );
  conversationId = created?.conversationId;
  assert(
    typeof conversationId === "string" && conversationId.length >= 32,
    "Conversation creation omitted its durable id.",
    created,
  );
  evidence.conversationId = conversationId;
  pass("Convex owner registration", { conversationId });

  const firstUser = `protocol-user-a-${runId}`;
  const firstAssistant = `protocol-assistant-a-${runId}`;
  const firstDevice = `proof-a-${runId.slice(0, 8)}`;
  const firstLocalTurn = `turn-a-${runId}`;
  const firstClientMsg = `msg-a-${runId}`;
  const firstBeginBody = {
    deviceId: firstDevice,
    localTurnId: firstLocalTurn,
    clientMsgId: firstClientMsg,
    userMessageJson: userMessage(firstUser),
  };
  const firstBegin = await beginTurn(firstBeginBody);
  assert(
    firstBegin?.replayed === false,
    "First begin was unexpectedly replayed.",
  );
  assert(
    /^[a-f0-9]{64}$/.test(firstBegin?.leaseToken ?? ""),
    "First lease token is invalid.",
  );
  assert(
    parseHistory(firstBegin).length === 0,
    "New conversation returned prior history.",
  );
  const afterFirstBegin = await probeJournal();

  const replayedBegin = await beginTurn(firstBeginBody);
  assert(
    replayedBegin?.replayed === true,
    "Exact begin retry was not replayed.",
  );
  assert(
    replayedBegin?.turnId === firstBegin.turnId,
    "Begin replay changed turnId.",
  );
  assert(
    replayedBegin?.leaseToken === firstBegin.leaseToken,
    "Begin replay changed leaseToken.",
  );
  const afterBeginReplay = await probeJournal();
  assert(
    afterBeginReplay.head.headSeq === afterFirstBegin.head.headSeq,
    "Begin replay appended journal rows.",
  );
  pass("idempotent begin replay", {
    turnId: firstBegin.turnId,
    headSeq: afterBeginReplay.head.headSeq,
  });

  const firstFinishBody = {
    deviceId: firstDevice,
    localTurnId: firstLocalTurn,
    leaseToken: firstBegin.leaseToken,
    phase: "completed",
    records: [
      {
        ordinal: 0,
        role: "assistant",
        payloadJson: assistantMessage(firstAssistant),
      },
    ],
  };
  const firstFinish = await finishTurn(firstFinishBody);
  assert(
    firstFinish?.replayed === false,
    "First finish was unexpectedly replayed.",
  );
  const afterFirstFinish = await loadWholeJournal();
  assertReceiptMatchesJournal(firstFinish, afterFirstFinish.records);
  assert(
    JSON.stringify(turnShape(afterFirstFinish.records, firstFinish.turnId)) ===
      JSON.stringify([
        "message:user",
        "turn:started",
        "message:assistant",
        "turn:completed",
      ]),
    "First turn journal shape is not exact.",
    { shape: turnShape(afterFirstFinish.records, firstFinish.turnId) },
  );

  const replayedFinish = await finishTurn(firstFinishBody);
  assert(
    replayedFinish?.replayed === true,
    "Exact finish retry was not replayed.",
  );
  assert(
    JSON.stringify(receiptFields(replayedFinish)) ===
      JSON.stringify({ ...receiptFields(firstFinish), replayed: true }),
    "Finish replay changed its durable receipt.",
    {
      first: receiptFields(firstFinish),
      replay: receiptFields(replayedFinish),
    },
  );
  const afterFinishReplay = await probeJournal();
  assert(
    afterFinishReplay.head.headSeq === afterFirstFinish.head.headSeq,
    "Finish replay appended journal rows.",
  );
  pass("exact first turn and idempotent finish receipt", {
    turnId: firstFinish.turnId,
    receipt: receiptFields(firstFinish),
    journalShape: turnShape(afterFirstFinish.records, firstFinish.turnId),
  });

  // A separately constructed client has only the bearer identity and no
  // application cache. This is useful protocol coverage, but is deliberately
  // not labeled as clean-profile product acceptance.
  const statelessList = await listConversations();
  assert(
    statelessList.some((row) => row.conversationId === conversationId),
    "Stateless client could not discover the conversation.",
  );
  const statelessHistory = parseHistory(await canonicalHistory());
  assert(
    JSON.stringify(statelessHistory.map((message) => message.role)) ===
      JSON.stringify(["user", "assistant"]),
    "Stateless history roles are not exact after turn one.",
  );
  assert(
    messageText(statelessHistory[0]) === firstUser &&
      messageText(statelessHistory[1]) === firstAssistant,
    "Stateless history content does not match turn one.",
  );
  pass("stateless API discovery and hydration", {
    productCleanClientAcceptance: false,
    historyDigest: sha256(JSON.stringify(statelessHistory)),
  });

  const secondUser = `protocol-user-b-${runId}`;
  const secondAssistant = `protocol-assistant-b-${runId}`;
  const second = await executeSyntheticTurn({
    clientLabel: "b",
    turnLabel: "turn-b",
    userText: secondUser,
    assistantTexts: [secondAssistant],
  });
  const afterSecond = await loadWholeJournal();
  assertReceiptMatchesJournal(second.finished, afterSecond.records);
  assert(
    JSON.stringify(turnShape(afterSecond.records, second.finished.turnId)) ===
      JSON.stringify([
        "message:user",
        "turn:started",
        "message:assistant",
        "turn:completed",
      ]),
    "Second turn journal shape is not exact.",
  );
  const completeHistory = parseHistory(await canonicalHistory());
  assert(
    JSON.stringify(completeHistory.map((message) => message.role)) ===
      JSON.stringify(["user", "assistant", "user", "assistant"]),
    "Two-turn canonical history roles are not exact.",
    { roles: completeHistory.map((message) => message.role) },
  );
  assert(
    JSON.stringify(completeHistory.map(messageText)) ===
      JSON.stringify([firstUser, firstAssistant, secondUser, secondAssistant]),
    "Two-turn canonical history content is not exact.",
  );
  pass("gapless multi-turn DO journal", {
    head: afterSecond.head,
    recordCount: afterSecond.records.length,
    journalDigest: sha256(JSON.stringify(afterSecond.records)),
  });

  const projection = await waitForProjection(secondAssistant);
  const staleFence = await verifyStaleProjectionFence(secondAssistant);
  pass("monotonic Convex projection", {
    lastPreview: projection.row.lastPreview,
    activity: projection.row.activity,
    indexSyncedSeq: projection.probe.indexSyncedSeq,
    pendingExcerpts: projection.probe.pendingExcerpts,
    staleFence,
  });

  const cancelUser = `protocol-cancel-${runId}`;
  const cancelDevice = `proof-c-${runId.slice(0, 8)}`;
  const cancelLocalTurn = `turn-c-${runId}`;
  const canceledBegin = await beginTurn({
    deviceId: cancelDevice,
    localTurnId: cancelLocalTurn,
    clientMsgId: `msg-c-${runId}`,
    userMessageJson: userMessage(cancelUser),
  });
  const cancelFinishBody = {
    deviceId: cancelDevice,
    localTurnId: cancelLocalTurn,
    leaseToken: canceledBegin.leaseToken,
    phase: "canceled",
    records: [],
  };
  const canceled = await finishTurn(cancelFinishBody);
  const canceledReplay = await finishTurn(cancelFinishBody);
  assert(
    canceled.phase === "canceled",
    "Canceled protocol turn was not terminal canceled.",
  );
  assert(
    canceledReplay.replayed === true,
    "Canceled finish retry was not replayed.",
  );
  const afterCancel = await loadWholeJournal();
  assertReceiptMatchesJournal(canceled, afterCancel.records);
  assert(
    JSON.stringify(turnShape(afterCancel.records, canceled.turnId)) ===
      JSON.stringify(["message:user", "turn:started", "turn:canceled"]),
    "Canceled turn journal shape is not exact.",
    { shape: turnShape(afterCancel.records, canceled.turnId) },
  );
  pass("canceled terminal receipt is idempotent", {
    productCancellationAcceptance: false,
    receipt: receiptFields(canceled),
    journalShape: turnShape(afterCancel.records, canceled.turnId),
  });
};

const runR2Rollover = async () => {
  let rolloverProbe = await probeJournal();
  let bulkTurns = 0;
  while (rolloverProbe.head.windowStartSeq <= rolloverProbe.head.floorSeq) {
    bulkTurns += 1;
    assert(bulkTurns <= 4, "R2 rollover did not occur after four bulk turns.", {
      head: rolloverProbe.head,
      hot: rolloverProbe.hot,
      databaseBytes: rolloverProbe.databaseBytes,
    });
    const textStem = `r2-${runId}-${bulkTurns}-`;
    const assistantTexts = Array.from(
      { length: config.rolloverRowsPerTurn },
      (_, ordinal) =>
        `${textStem}${String(ordinal).padStart(4, "0")}:${"r".repeat(480)}`,
    );
    const bulk = await executeSyntheticTurn({
      clientLabel: `r${bulkTurns}`,
      turnLabel: `rollover-${bulkTurns}`,
      userText: `force-r2-rollover-${runId}-${bulkTurns}`,
      assistantTexts,
    });
    rolloverProbe = await poll(
      probeJournal,
      (probe) => probe?.head?.headSeq >= bulk.finished.lastSeq,
      {
        timeoutMs: config.projectionTimeoutMs,
        intervalMs: 500,
        label: "journal rollover observation",
      },
    );
  }

  assert(
    rolloverProbe.head.floorSeq < rolloverProbe.head.windowStartSeq,
    "R2 rollover did not move the SQLite resident window.",
    rolloverProbe.head,
  );
  assert(
    rolloverProbe.storedBytes > rolloverProbe.hot.bytes,
    "Archived byte accounting does not exceed the hot SQLite set.",
    {
      storedBytes: rolloverProbe.storedBytes,
      hotBytes: rolloverProbe.hot.bytes,
    },
  );
  const whole = await loadWholeJournal();
  const cold = whole.records.filter(
    (record) => record.seq < whole.head.windowStartSeq,
  );
  const hot = whole.records.filter(
    (record) => record.seq >= whole.head.windowStartSeq,
  );
  assert(cold.length > 0, "No cold journal record was read through R2.");
  assert(
    hot.length > 0,
    "No hot SQLite journal record remained after rollover.",
  );
  assert(
    cold[0].seq === whole.head.floorSeq &&
      cold.at(-1).seq === whole.head.windowStartSeq - 1,
    "Cold R2 range does not meet the SQLite resident boundary.",
    {
      coldFirst: cold[0]?.seq,
      coldLast: cold.at(-1)?.seq,
      floorSeq: whole.head.floorSeq,
      windowStartSeq: whole.head.windowStartSeq,
    },
  );
  const owner = (
    await requestJson(
      `${config.convexSiteUrl}/api/cloud/conversation-owner?conversationId=${encodeURIComponent(conversationId)}`,
      {
        label: "conversation owner lookup for R2 prefix",
        timeoutMs: config.timeoutMs,
        method: "GET",
        headers: serviceHeaders(),
      },
    )
  ).body;
  assert(
    typeof owner?.ownerId === "string" && owner.ownerId.length > 0,
    "R2 owner lookup omitted ownerId.",
  );
  const ownerHash = sha256(owner.ownerId);
  pass("R2 rollover with hot and cold reads", {
    bulkTurns,
    head: whole.head,
    hotRows: rolloverProbe.hot.rows,
    hotBytes: rolloverProbe.hot.bytes,
    storedBytes: rolloverProbe.storedBytes,
    coldRecordCount: cold.length,
    hotRecordCount: hot.length,
    coldDigest: sha256(JSON.stringify(cold)),
    hotDigest: sha256(JSON.stringify(hot)),
    r2ObjectPrefix: `conversations/${ownerHash}/${conversationId}/seg/`,
  });
};

const cleanup = async () => {
  if (!conversationId) return { attempted: false };
  const result = await convexAction(
    "cloud_apps:deleteMyConversation",
    { conversationId },
    "delete proof conversation",
  );
  assert(
    result?.ok === true,
    "Conversation deletion was not accepted.",
    result,
  );
  await poll(
    listConversations,
    (rows) =>
      Array.isArray(rows) &&
      !rows.some((row) => row.conversationId === conversationId),
    {
      timeoutMs: config.projectionTimeoutMs,
      intervalMs: 750,
      label: "conversation list cleanup",
    },
  );

  let purge = null;
  try {
    purge = await poll(
      probeJournal,
      (probe) =>
        probe?.head?.headSeq === -1 &&
        probe?.storedBytes === 0 &&
        probe?.purgePending === 0,
      {
        timeoutMs: Math.min(config.projectionTimeoutMs, 30_000),
        intervalMs: 1_000,
        label: "scheduled DO/R2 purge",
      },
    );
  } catch {
    // The public delete action is authoritative and schedules this same purge.
    // A bounded direct retry is safe because this script created and owns the
    // disposable conversation id in this run.
    let directAttempt = 0;
    await poll(
      async () => {
        directAttempt += 1;
        return (
          await workerServiceRequest(
            `/conversations/${encodeURIComponent(conversationId)}/purge`,
            { method: "POST", body: "{}" },
            `direct cleanup purge attempt ${directAttempt}`,
            { expectedStatuses: [200, 202], timeoutMs: 60_000 },
          )
        ).body;
      },
      (body) => body?.purged === true,
      {
        timeoutMs: config.projectionTimeoutMs,
        intervalMs: 1_000,
        label: "direct DO/R2 purge request",
      },
    );
    purge = await poll(
      probeJournal,
      (probe) =>
        probe?.head?.headSeq === -1 &&
        probe?.storedBytes === 0 &&
        probe?.purgePending === 0,
      {
        timeoutMs: config.projectionTimeoutMs,
        intervalMs: 1_000,
        label: "direct DO/R2 purge",
      },
    );
  }
  return {
    attempted: true,
    listAbsent: true,
    journalEmpty: purge.head.headSeq === -1,
    storedBytes: purge.storedBytes,
    purgePending: purge.purgePending,
  };
};

try {
  await runFastProtocol();
  if (WITH_R2) await runR2Rollover();
  evidence.result = "passed";
} catch (error) {
  runError = error;
  evidence.result = "failed";
  evidence.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    details: error instanceof CloudProofError ? error.details : undefined,
  };
} finally {
  try {
    evidence.cleanup = await cleanup();
    pass("disposable conversation and archive cleanup", evidence.cleanup);
  } catch (error) {
    evidence.cleanup = {
      attempted: Boolean(conversationId),
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof CloudProofError ? error.details : undefined,
    };
    evidence.result = "failed";
    if (!runError) runError = error;
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs =
    Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  await writeEvidence(config.evidencePath, evidence);
}

if (runError) {
  const safe = sanitizeEvidence({
    name: runError instanceof Error ? runError.name : "Error",
    message: runError instanceof Error ? runError.message : String(runError),
  });
  console.error(
    `CLOUD PROTOCOL PROOF FAILED: ${safe.message}. Evidence: ${config.evidencePath}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `CLOUD PROTOCOL PROOF PASSED (${WITH_R2 ? "with R2" : "fast"}). Evidence: ${config.evidencePath}`,
  );
}
