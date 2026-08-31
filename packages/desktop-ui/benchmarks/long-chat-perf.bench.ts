import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import v8 from "node:v8";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { afterAll, beforeAll, bench, describe } from "vitest";

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { buildHistorySource } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import { streamRenderIntervalMs } from "../src/features/chat/streaming/use-stream-text-animation";
import { shouldUseBoundedMarkdownPlaintext } from "../src/features/chat/streaming/markdown-chunks";

const CONVERSATION_ID = "pathological-long-chat";
const TURN_COUNT = 500;
const TOOL_EVENTS_PER_TURN = 1_140;
const VISIBLE_MESSAGES = 80;
const TOTAL_EVENTS = TURN_COUNT * (TOOL_EVENTS_PER_TURN + 2);
const RUNTIME_THREAD_KEY = "orchestrator:pathological-long-chat";
const RUNTIME_HISTORY_ENTRIES = 100_000;

let rootPath = "";
let db: SqliteDatabase;
let store: SessionStore;
let legacyCutoffSequence = 0;
let tailCursor: { timestamp: number; id: string; sequence: number };
const activityRecords = Array.from({ length: 486 }, (_, index) => ({
  threadId: `thread-${index}`,
  conversationId: CONVERSATION_ID,
  source: "stella",
  agentType: "general",
  description: `Background task ${index}`,
  status: index % 7 === 0 ? "running" : "completed",
  startedAt: index * 100,
  completedAt: index * 100 + 50,
  updatedAt: index * 100 + 50,
  assistantMessages: [`Finished task ${index}`],
  modelConfigSnapshot: { provider: "stella", model: "gpt-5" },
}));
const activityById = new Map(
  activityRecords.map((record) => [record.threadId, record]),
);
const visibleActivityIds = activityRecords
  .slice(0, 12)
  .map((record) => record.threadId);

const percentile = (values: number[], fraction: number) => {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))
  ]!;
};

const timed = (run: () => unknown, iterations: number) => {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
};

const benchmarkGc = (() => {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (exposed) return exposed;
  try {
    v8.setFlagsFromString("--expose_gc");
    return vm.runInNewContext("gc") as () => void;
  } catch {
    return undefined;
  }
})();

const retainedHeap = (create: () => unknown, count: number) => {
  if (!benchmarkGc) return null;
  benchmarkGc();
  const before = process.memoryUsage().heapUsed;
  const retained = Array.from({ length: count }, create);
  benchmarkGc();
  const bytes = Math.max(0, process.memoryUsage().heapUsed - before);
  if (retained.length !== count) throw new Error("retention benchmark failed");
  return bytes;
};

const legacyVisibleWindow = () => {
  const rows = db
    .prepare(
      `SELECT entry.id AS _id,
              entry.created_at AS timestamp,
              entry.seq AS sequence,
              entry.type,
              entry.payload AS payloadJson
         FROM entry
        WHERE entry.conversation_id = ?
          AND entry.seq >= ?
          AND entry.type IN (
            'user_message', 'assistant_message', 'tool_request', 'tool_result',
            'agent-started', 'agent-progress', 'agent-completed',
            'agent-failed', 'agent-canceled'
          )
        ORDER BY entry.seq ASC`,
    )
    .all(CONVERSATION_ID, legacyCutoffSequence) as Array<{
    _id: string;
    timestamp: number;
    sequence: number;
    type: string;
    payloadJson: string | null;
  }>;
  return rows.map((row) => ({
    _id: row._id,
    timestamp: row.timestamp,
    sequence: row.sequence,
    type: row.type,
    ...(row.payloadJson ? { payload: JSON.parse(row.payloadJson) } : {}),
  }));
};

const currentVisibleWindow = () =>
  store.listMessages(CONVERSATION_ID, {
    maxVisibleMessages: VISIBLE_MESSAGES,
  });

const currentOneEventTail = () =>
  store.listMessagesAfter(CONVERSATION_ID, {
    afterTimestampMs: tailCursor.timestamp,
    afterId: tailCursor.id,
    afterSequence: tailCursor.sequence,
    maxVisibleMessages: VISIBLE_MESSAGES + 2,
    includeSourceEvents: false,
  });

const legacyActivityUpdate = () => {
  const signature = activityRecords
    .map(
      (record) =>
        `${record.threadId}\0${record.status}\0${record.updatedAt}\0${record.description}\0${JSON.stringify(record.modelConfigSnapshot)}\0${JSON.stringify(record.assistantMessages)}`,
    )
    .join("\n");
  const payload = JSON.stringify({
    conversationId: CONVERSATION_ID,
    records: activityRecords,
  });
  const visible = visibleActivityIds.map((threadId) =>
    activityRecords.find((record) => record.threadId === threadId),
  );
  return signature.length + payload.length + visible.length;
};

const keyedActivityUpdate = () => {
  const record = activityRecords[0]!;
  activityById.set(record.threadId, record);
  return (
    JSON.stringify({ conversationId: CONVERSATION_ID, record }).length +
    (activityById.get(record.threadId) ? 1 : 0)
  );
};

const markdown = Array.from(
  { length: 300 },
  (_, index) =>
    `## Section ${index}\n\nThis is streamed markdown with **formatting**, [a link](https://example.com), and enough text to exercise incremental block parsing.\n\n`,
).join("");

const renderGrowingMarkdown = (commits: number) => {
  for (let index = 1; index <= commits; index += 1) {
    const text = markdown.slice(
      0,
      Math.ceil((markdown.length * index) / commits),
    );
    renderToStaticMarkup(
      createElement(Streamdown, { mode: "streaming" }, text),
    );
  }
};

const renderGrowingPlainText = (commits: number) => {
  for (let index = 1; index <= commits; index += 1) {
    const text = markdown.slice(
      0,
      Math.ceil((markdown.length * index) / commits),
    );
    renderToStaticMarkup(createElement("div", null, text));
  }
};

const legacyRuntimeHistory = () =>
  store.loadThreadSessionEntries(RUNTIME_THREAD_KEY);
const currentRuntimeHistory = () =>
  store.loadThreadMessages(RUNTIME_THREAD_KEY);

// Before active-turn page-in, a never-idle Pi loop can keep the original
// pre-compaction mirror even after SQLite has a compacted overlay. The managed
// case rebuilds exactly the same AgentMessage[] shape used by PiSessionCore:
// durable checkpoint plus uncompacted tail.
const legacyActiveTurnWorkingSet = () =>
  legacyRuntimeHistory().map((entry) => entry.payload ?? entry);
const currentActiveTurnWorkingSet = () =>
  buildHistorySource({
    systemPrompt: "",
    dynamicContext: "",
    maxAgentDepth: 1,
    threadHistory: currentRuntimeHistory(),
  });

beforeAll(() => {
  rootPath = mkdtempSync(path.join(os.tmpdir(), "stella-long-chat-bench-"));
  db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  store = new SessionStore(db);
  db.prepare(
    `INSERT INTO conversation (id, title, status, next_seq, created_at, updated_at)
     VALUES (?, '', 'active', 1, 1, 1)`,
  ).run(CONVERSATION_ID);
  const insertEntry = db.prepare(
    `INSERT INTO entry (
       conversation_id, seq, id, type, role, visible, turn_seq,
       payload, search_text, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let sequence = 0;
  let currentTurnSeq: number | null = null;
  const append = (type: string, payload: unknown) => {
    sequence += 1;
    const id = `event-${String(sequence).padStart(7, "0")}`;
    const role =
      type === "user_message"
        ? "user"
        : type === "assistant_message"
          ? "assistant"
          : "tool";
    const visible =
      type === "user_message" || type === "assistant_message" ? 1 : 0;
    if (type === "user_message") currentTurnSeq = sequence;
    const payloadRecord = payload as { text?: unknown };
    insertEntry.run(
      CONVERSATION_ID,
      sequence,
      id,
      type,
      role,
      visible,
      currentTurnSeq,
      JSON.stringify(payload),
      visible === 1 && typeof payloadRecord.text === "string"
        ? payloadRecord.text
        : null,
      sequence,
      sequence,
    );
    return { id, timestamp: sequence, sequence };
  };

  db.exec("BEGIN IMMEDIATE");
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    append("user_message", { text: `user ${turn}` });
    for (let event = 0; event < TOOL_EVENTS_PER_TURN; event += 1) {
      const pathologicalTail =
        turn === TURN_COUNT - 1 && event >= TOOL_EVENTS_PER_TURN - 893;
      append(event % 2 === 0 ? "tool_request" : "tool_result", {
        toolName: "exec_command",
        event,
        output: pathologicalTail ? "x".repeat(5_000) : "ok",
      });
    }
    const assistant = append("assistant_message", {
      text: `assistant ${turn}`,
    });
    if (turn === TURN_COUNT - 1) tailCursor = assistant;
  }
  db.exec("COMMIT");

  const cutoff = db
    .prepare(
      `SELECT MIN(seq) AS sequence
         FROM (
           SELECT seq
             FROM entry
            WHERE conversation_id = ?
              AND type IN ('user_message', 'assistant_message')
            ORDER BY seq DESC
            LIMIT ?
         )`,
    )
    .get(CONVERSATION_ID, VISIBLE_MESSAGES) as { sequence: number };
  legacyCutoffSequence = cutoff.sequence;

  append("tool_result", { toolName: "exec_command", output: "new tail event" });
  db.prepare(`UPDATE conversation SET next_seq = ? WHERE id = ?`).run(
    sequence + 1,
    CONVERSATION_ID,
  );

  db.prepare(
    `INSERT INTO thread (
       id, conversation_id, agent_type, name, status, session_id, cwd,
       next_seq, created_at, last_used_at
     ) VALUES (?, ?, 'orchestrator', 'Orchestrator', 'active', ?, '', ?, 1, 1)`,
  ).run(
    RUNTIME_THREAD_KEY,
    CONVERSATION_ID,
    CONVERSATION_ID,
    RUNTIME_HISTORY_ENTRIES + 2,
  );
  const insertRuntimeEntry = db.prepare(
    `INSERT INTO thread_entry (
       thread_id, seq, id, type, role, payload, est_tokens,
       timestamp_iso, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 700, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < RUNTIME_HISTORY_ENTRIES; index += 1) {
    const entryId = `runtime-${String(index).padStart(6, "0")}`;
    insertRuntimeEntry.run(
      RUNTIME_THREAD_KEY,
      index + 1,
      entryId,
      "message",
      "assistant",
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: `${index}:` + "r".repeat(2_000) }],
          api: "openai-responses",
          provider: "openai",
          model: "history",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: index + 1,
        },
      }),
      new Date(index + 1).toISOString(),
      index + 1,
    );
  }
  const compactionId = "runtime-compaction";
  insertRuntimeEntry.run(
    RUNTIME_THREAD_KEY,
    RUNTIME_HISTORY_ENTRIES + 1,
    compactionId,
    "compaction",
    null,
    JSON.stringify({
      summary: "Bounded durable checkpoint",
      fromEntryId: "runtime-000000",
      toEntryId: `runtime-${String(RUNTIME_HISTORY_ENTRIES - 11).padStart(6, "0")}`,
      tokensBefore: 1_000_000,
    }),
    new Date(RUNTIME_HISTORY_ENTRIES + 1).toISOString(),
    RUNTIME_HISTORY_ENTRIES + 1,
  );
  db.prepare(
    `INSERT INTO thread_context (
       thread_id, compaction_entry_id, covered_from_seq, covered_through_seq,
       summary, details, tokens_before, timestamp_iso, created_at, updated_at
     ) VALUES (?, ?, 1, ?, 'Bounded durable checkpoint', NULL, 1000000, ?, ?, ?)`,
  ).run(
    RUNTIME_THREAD_KEY,
    compactionId,
    RUNTIME_HISTORY_ENTRIES - 10,
    new Date(RUNTIME_HISTORY_ENTRIES + 1).toISOString(),
    RUNTIME_HISTORY_ENTRIES + 1,
    RUNTIME_HISTORY_ENTRIES + 1,
  );
  db.exec("COMMIT");

  legacyVisibleWindow();
  currentVisibleWindow();
  currentOneEventTail();
  const legacy = legacyVisibleWindow();
  const current = currentVisibleWindow();
  const tail = currentOneEventTail();
  const legacyPayloadBytes = Buffer.byteLength(JSON.stringify(legacy));
  const currentPayloadBytes = Buffer.byteLength(JSON.stringify(current));
  const tailPayloadBytes = Buffer.byteLength(JSON.stringify(tail));
  const legacyTiming = timed(() => JSON.stringify(legacyVisibleWindow()), 12);
  const currentTiming = timed(() => JSON.stringify(currentVisibleWindow()), 12);
  const tailTiming = timed(() => JSON.stringify(currentOneEventTail()), 20);
  const legacyRetainedHeapBytes = retainedHeap(legacyVisibleWindow, 5);
  const currentRetainedHeapBytes = retainedHeap(currentVisibleWindow, 5);
  const legacyActivityTiming = timed(legacyActivityUpdate, 1_000);
  const keyedActivityTiming = timed(keyedActivityUpdate, 1_000);
  const legacyMarkdownTiming = timed(() => renderGrowingMarkdown(34), 5);
  const currentMarkdownCommits = Math.ceil(
    1_000 / streamRenderIntervalMs(markdown.length),
  );
  const currentMarkdownTiming = timed(
    () => renderGrowingPlainText(currentMarkdownCommits),
    5,
  );
  const settledMarkdownPlaintextTiming = timed(
    () =>
      renderToStaticMarkup(
        createElement(
          "div",
          { className: "markdown markdown--streaming-plaintext" },
          markdown,
        ),
      ),
    5,
  );
  const legacyRuntime = legacyRuntimeHistory();
  const currentRuntime = currentRuntimeHistory();
  const legacyRuntimeTiming = timed(legacyRuntimeHistory, 3);
  const currentRuntimeTiming = timed(currentRuntimeHistory, 20);
  const legacyRuntimeHeapBytes = retainedHeap(legacyRuntimeHistory, 1);
  const currentRuntimeHeapBytes = retainedHeap(currentRuntimeHistory, 5);
  const legacyActiveTurn = legacyActiveTurnWorkingSet();
  const currentActiveTurn = currentActiveTurnWorkingSet();
  const legacyActiveTurnHeapBytes = retainedHeap(legacyActiveTurnWorkingSet, 1);
  const currentActiveTurnHeapBytes = retainedHeap(
    currentActiveTurnWorkingSet,
    5,
  );

  console.log(
    "LONG_CHAT_PERF " +
      JSON.stringify({
        totalEvents: TOTAL_EVENTS + 1,
        turns: TURN_COUNT,
        visibleMessages: VISIBLE_MESSAGES,
        legacy: {
          eagerRows: legacy.length,
          ipcPayloadBytes: legacyPayloadBytes,
          fiveRetainedSnapshotsHeapBytes: legacyRetainedHeapBytes,
          updateMainThreadBlock: legacyTiming,
        },
        current: {
          eagerToolRows: current.messages.reduce(
            (total, message) => total + message.toolEvents.length,
            0,
          ),
          ipcPayloadBytes: currentPayloadBytes,
          fiveRetainedSnapshotsHeapBytes: currentRetainedHeapBytes,
          initialWindowMainThreadBlock: currentTiming,
          oneEventTailPayloadBytes: tailPayloadBytes,
          oneEventTailMainThreadBlock: tailTiming,
        },
        mobileCatchUp: {
          priorForcedWindowMessages: current.messages.length,
          validCursorDeltaMessages: tail.messages.length,
          priorForcedWindowPayloadBytes: currentPayloadBytes,
          validCursorDeltaPayloadBytes: tailPayloadBytes,
          payloadReductionPercent:
            Math.round((1 - tailPayloadBytes / currentPayloadBytes) * 10_000) /
            100,
          priorForcedWindowMainThreadBlock: currentTiming,
          validCursorDeltaMainThreadBlock: tailTiming,
        },
        activity: {
          recordCount: activityRecords.length,
          legacySnapshotPayloadBytes: Buffer.byteLength(
            JSON.stringify({
              conversationId: CONVERSATION_ID,
              records: activityRecords,
            }),
          ),
          keyedPayloadBytes: Buffer.byteLength(
            JSON.stringify({
              conversationId: CONVERSATION_ID,
              record: activityRecords[0],
            }),
          ),
          legacyUpdateMainThreadBlock: legacyActivityTiming,
          keyedUpdateMainThreadBlock: keyedActivityTiming,
        },
        streamingMarkdown: {
          streamedCharacters: markdown.length,
          legacyCommitsPerSecond: 34,
          currentCommitsPerSecond: currentMarkdownCommits,
          legacyOneSecondCommitWork: legacyMarkdownTiming,
          currentOneSecondCommitWork: currentMarkdownTiming,
          boundedSettledPlaintext: shouldUseBoundedMarkdownPlaintext(
            markdown.length,
          ),
          settledPlaintextMainThreadBlock: settledMarkdownPlaintextTiming,
        },
        runtimeHistory: {
          durableEntries: RUNTIME_HISTORY_ENTRIES + 1,
          legacyResidentEntries: legacyRuntime.length,
          currentResidentMessages: currentRuntime.length,
          legacyLoadMainThreadBlock: legacyRuntimeTiming,
          currentLoadMainThreadBlock: currentRuntimeTiming,
          legacyOneSnapshotHeapBytes: legacyRuntimeHeapBytes,
          currentFiveSnapshotsHeapBytes: currentRuntimeHeapBytes,
        },
        activeTurnWorkingSet: {
          legacyResidentMessages: legacyActiveTurn.length,
          currentResidentMessages: currentActiveTurn.length,
          legacyResidentPayloadBytes: Buffer.byteLength(
            JSON.stringify(legacyActiveTurn),
          ),
          currentResidentPayloadBytes: Buffer.byteLength(
            JSON.stringify(currentActiveTurn),
          ),
          legacyOneResidentHeapBytes: legacyActiveTurnHeapBytes,
          currentFiveResidentsHeapBytes: currentActiveTurnHeapBytes,
        },
      }),
  );
}, 120_000);

afterAll(() => {
  db.close();
  rmSync(rootPath, { recursive: true, force: true });
});

describe("pathological long chat", () => {
  bench("legacy visible-cutoff rescan + deserialize + IPC serialize", () => {
    JSON.stringify(legacyVisibleWindow());
  });

  bench("bounded visible window + projected events", () => {
    JSON.stringify(currentVisibleWindow());
  });

  bench("mobile catch-up via sequence-cursor small suffix", () => {
    JSON.stringify(currentOneEventTail());
  });

  bench("legacy 486-record activity broadcast", () => {
    legacyActivityUpdate();
  });

  bench("keyed one-record activity patch", () => {
    keyedActivityUpdate();
  });

  bench("compaction-aware runtime history reconstruction", () => {
    currentRuntimeHistory();
  });

  bench("active Pi turn checkpoint working-set page-in", () => {
    currentActiveTurnWorkingSet();
  });
});
