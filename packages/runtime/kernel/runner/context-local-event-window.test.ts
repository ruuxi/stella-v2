import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTimestampForHistory } from "@stella/contracts/message-timestamp";
import { formatTimestampSystemReminder } from "@stella/contracts/system-reminders";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { SessionStore } from "../storage/session-store.js";
import {
  LOCAL_CONTEXT_EVENT_TYPES,
  type SqliteDatabase,
} from "../storage/shared.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
import {
  buildAgentContext,
  buildOrchestratorThreadHistory,
} from "./context.js";

// The orchestrator context build used to parse the newest 800 chat events on
// every turn. It now queries only the rows it consumes. These tests pin that
// the model-facing context is byte-identical to the full-window build.

const dataDir = mkdtempSync(join(tmpdir(), "stella-ctx-window-"));
const db = new Database(join(dataDir, "stella.sqlite"));
initializeDesktopDatabase(db as unknown as SqliteDatabase);
const store = new SessionStore(db as unknown as SqliteDatabase);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const BASE = Date.UTC(2026, 0, 1, 7, 13);
const MINUTE = 60_000;
let clock = 0;
// Seven minutes apart, so a 1k-event stream crosses several days.
const nextTimestamp = () => BASE + clock++ * 7 * MINUTE;

type SeedEvent = {
  type: string;
  payload?: Record<string, unknown>;
  requestId?: string;
  timestamp?: number;
};

const append = (conversationId: string, event: SeedEvent, eventId: string) =>
  store.appendEvent({
    conversationId,
    type: event.type,
    payload: event.payload,
    requestId: event.requestId,
    timestamp: event.timestamp ?? nextTimestamp(),
    eventId,
  });

const mixedEvents = (count: number, localeEvery?: number): SeedEvent[] =>
  Array.from({ length: count }, (_, i): SeedEvent => {
    switch (i % 7) {
      case 0:
        return {
          type: "user_message",
          payload: {
            text: `user ${i} ${"lorem ipsum ".repeat(i % 5)}`,
            timezone: i % 3 === 0 ? "America/Los_Angeles" : "Europe/Berlin",
            ...(localeEvery && i % localeEvery === 0
              ? { locale: i % 2 ? "fr" : "de" }
              : {}),
          },
        };
      case 1:
      case 5:
        return { type: "assistant_message", payload: { text: `assistant ${i}` } };
      case 2:
        return {
          type: "tool_request",
          requestId: `req-${i}`,
          payload: { toolName: "Read", args: { path: `/tmp/${i}` } },
        };
      case 3:
        return {
          type: "tool_result",
          requestId: `req-${i - 1}`,
          payload: { toolName: "Read", result: { ok: i } },
        };
      default:
        // Lifecycle rows count toward the window but are not context.
        return { type: "agent-started", payload: { n: i } };
    }
  });

const seed = (conversationId: string, events: SeedEvent[]): string[] =>
  events.map((event, i) => {
    const eventId = `${conversationId}-${clock}-${i}`;
    append(conversationId, event, eventId);
    return eventId;
  });

const appendThread = (
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
) =>
  store.appendThreadMessage({
    threadKey: resolveOrchestratorThreadKey(conversationId),
    role,
    content,
    timestamp,
  });

const model = {
  id: "window-test",
  name: "window-test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
};

const build = (
  conversationId: string,
  currentUserMessageId: string | undefined,
  bounded: boolean,
) => {
  const reads: Array<{ query?: unknown; rows: number }> = [];
  const context = {
    stellaDataDir: dataDir,
    runtimeStore: store,
    listLocalChatEvents: (id: string, maxItems: number) => {
      const events = store.listEvents(id, maxItems);
      reads.push({ rows: events.length });
      return events;
    },
    ...(bounded
      ? {
          openLocalChatEventWindow: (id: string, maxItems: number) => {
            const window = store.openEventWindow(id, maxItems);
            return {
              query: (query: never) => {
                const rows = window.query(query);
                reads.push({ query, rows: rows.length });
                return rows;
              },
            };
          },
        }
      : {}),
  };
  return buildAgentContext(context as never, {
    conversationId,
    agentType: "orchestrator",
    runId: `run-${conversationId}`,
    currentUserMessageId,
    resolvedLlm: {
      model: model as never,
      route: "direct-provider",
      getApiKey: () => undefined,
    },
  }).then(({ resolvedLlm: _resolvedLlm, ...rest }) => ({ context: rest, reads }));
};

const modelFacing = (context: Record<string, unknown>) =>
  JSON.stringify({
    dynamicContext: context.dynamicContext,
    staleUserReminderText: context.staleUserReminderText,
    connectorTransitionReminderText: context.connectorTransitionReminderText,
    threadHistory: context.threadHistory,
  });

const scenarios: Array<{
  name: string;
  setup: () => { conversationId: string; currentUserMessageId?: string };
  expectRowsAtMost?: number;
}> = [
  {
    name: "legacy events with no durable thread (1.2k events)",
    setup: () => {
      const ids = seed("legacy", mixedEvents(1200, 21));
      return { conversationId: "legacy", currentUserMessageId: ids.at(-1) };
    },
  },
  {
    name: "legacy head, then a durable thread, then newer events",
    setup: () => {
      seed("transition", mixedEvents(900, 35));
      const t = nextTimestamp();
      appendThread("transition", "user", "user 0", t);
      appendThread("transition", "assistant", "durable reply", t + 1000);
      const ids = seed("transition", [
        ...mixedEvents(300),
        {
          type: "user_message",
          payload: { text: "from the phone", source: "connector", provider: "stella_app" },
          timestamp: nextTimestamp() + 3 * 60 * MINUTE,
        },
      ]);
      return { conversationId: "transition", currentUserMessageId: ids.at(-1) };
    },
  },
  {
    name: "modern conversation: durable thread first, 1.2k events after",
    setup: () => {
      const t = nextTimestamp();
      appendThread("modern", "user", "hello", t);
      appendThread("modern", "assistant", "hi", t + 1000);
      const ids = seed("modern", mixedEvents(1200, 14));
      return { conversationId: "modern", currentUserMessageId: ids.at(-7) };
    },
    // Only the newest context events for the reminders/locale; no legacy
    // history rows.
    expectRowsAtMost: 16,
  },
  {
    name: "locale only outside the 800-event window",
    setup: () => {
      seed("locale-outside", [
        { type: "user_message", payload: { text: "bonjour", locale: "fr" } },
        ...mixedEvents(1000),
        { type: "assistant_message", payload: { text: "tail" } },
      ]);
      return { conversationId: "locale-outside" };
    },
  },
  {
    name: "locale deep inside the window, stale gap and connector transition",
    setup: () => {
      seed("deep", mixedEvents(400));
      append("deep", { type: "user_message", payload: { text: "hi", locale: "ja" } }, "deep-ja");
      seed("deep", mixedEvents(600));
      append(
        "deep",
        {
          type: "user_message",
          payload: {
            text: "back after a while",
            locale: "   ",
            source: "connector",
            provider: "telegram",
            timezone: "Asia/Tokyo",
          },
          timestamp: nextTimestamp() + 5 * 60 * MINUTE,
        },
        "deep-last",
      );
      return { conversationId: "deep", currentUserMessageId: "deep-last" };
    },
  },
  {
    name: "a long tool run hides the previous user messages from the newest reads",
    setup: () => {
      seed("tool-run", mixedEvents(700, 14));
      append(
        "tool-run",
        { type: "user_message", payload: { text: "do the thing" }, timestamp: nextTimestamp() + 45 * MINUTE },
        "tool-run-user",
      );
      seed(
        "tool-run",
        Array.from({ length: 40 }, (_, i): SeedEvent =>
          i % 2
            ? { type: "tool_result", requestId: `run-${i - 1}`, payload: { toolName: "Bash", result: i } }
            : { type: "tool_request", requestId: `run-${i}`, payload: { toolName: "Bash", args: { i } } },
        ),
      );
      return { conversationId: "tool-run", currentUserMessageId: "tool-run-user" };
    },
  },
  {
    name: "lifecycle noise pushes every context event out of the window",
    setup: () => {
      seed("noise", [
        ...mixedEvents(300, 7),
        ...Array.from({ length: 850 }, (_, i) => ({ type: "agent-started", payload: { i } })),
      ]);
      return { conversationId: "noise" };
    },
  },
];

describe("orchestrator context: bounded local-event reads", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const { conversationId, currentUserMessageId } = scenario.setup();

      const fullWindow = await build(conversationId, currentUserMessageId, false);
      const bounded = await build(conversationId, currentUserMessageId, true);

      // The whole agent context, and the model-facing parts byte for byte.
      expect(modelFacing(bounded.context)).toBe(modelFacing(fullWindow.context));
      expect(JSON.stringify(bounded.context)).toBe(JSON.stringify(fullWindow.context));

      // The history equals the pre-change build over the full 800 window.
      const window = store
        .listEvents(conversationId, 800)
        .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type))
        .filter(
          (event) =>
            !currentUserMessageId ||
            (event._id !== currentUserMessageId &&
              event.requestId !== currentUserMessageId),
        );
      const reference = buildOrchestratorThreadHistory({
        storedThreadMessages: store.loadThreadMessages(
          resolveOrchestratorThreadKey(conversationId),
        ),
        localEvents: window,
        contextWindow: model.contextWindow,
      });
      expect(JSON.stringify(bounded.context.threadHistory ?? [])).toBe(
        JSON.stringify(reference),
      );

      // The bounded path never falls back to the full window read.
      expect(bounded.reads.every((read) => read.query !== undefined)).toBe(true);
      if (scenario.expectRowsAtMost !== undefined) {
        const rows = bounded.reads.reduce((total, read) => total + read.rows, 0);
        expect(rows).toBeLessThanOrEqual(scenario.expectRowsAtMost);
      }
    });
  }
});

describe("formatTimestampForHistory", () => {
  // The pre-change implementation (a fresh Intl formatter per call).
  const reference = (timestamp: number, prevDate?: string, timezone?: string) => {
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    const d = new Date(timestamp);
    const timeStr = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    });
    const dateStr = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: tz,
    });
    const tag =
      prevDate && dateStr === prevDate
        ? formatTimestampSystemReminder(timeStr)
        : formatTimestampSystemReminder(`${timeStr}, ${dateStr}`);
    return { tag, dateStr };
  };

  test("matches the per-call toLocale* output across zones and dates", () => {
    const zones = [undefined, "UTC", "America/Los_Angeles", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Chatham"];
    let prevDate: string | undefined;
    for (const timezone of zones) {
      for (let i = 0; i < 400; i += 1) {
        const timestamp = Date.UTC(2025, 2, 8) + i * 37 * MINUTE + (i % 60) * 1000;
        const expected = reference(timestamp, prevDate, timezone);
        expect(formatTimestampForHistory(timestamp, prevDate, timezone)).toEqual(expected);
        prevDate = expected.dateStr;
      }
    }
    expect(formatTimestampForHistory(Number.NaN)).toEqual(reference(Number.NaN));
    expect(() => formatTimestampForHistory(0, undefined, "Not/AZone")).toThrow(RangeError);
  });
});
