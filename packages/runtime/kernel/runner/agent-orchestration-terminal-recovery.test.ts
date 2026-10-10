import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentOrchestration,
  hasDurableAgentLifecycleEvent,
} from "./agent-orchestration.js";
import {
  LOCAL_TERMINAL_RECOVERY_LEDGER_PREFIX,
  LOCAL_TERMINAL_RECOVERY_MAX_ATTEMPTS,
  LOCAL_TERMINAL_RECOVERY_STALE_AFTER_MS,
  LocalAgentManager,
  type LocalAgentContext,
} from "../agents/local-agent-manager.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../storage/database-init.js";
import { SessionStore } from "../storage/session-store.js";
import type { SqliteDatabase } from "../storage/shared.js";
import { createReadinessLatch } from "../shared/readiness-latch.js";
import { persistThreadCustomMessage } from "../agent-runtime/thread-memory.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";

const CONVERSATION = "conversation-receipts";
const LIFECYCLE = "runtime.task_lifecycle";
const orchestratorThreadKey = resolveOrchestratorThreadKey(CONVERSATION);

const openStores: Array<{ db: SqliteDatabase; root: string }> = [];

const openStore = (root?: string) => {
  const dataDir =
    root ??
    path.join(
      os.tmpdir(),
      `stella-terminal-recovery-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  const db = new Database(
    getDesktopDatabasePath(dataDir),
  ) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  openStores.push({ db, root: dataDir });
  return { db, store: new SessionStore(db), root: dataDir };
};

afterEach(() => {
  const roots = new Set<string>();
  for (const { db, root } of openStores.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    roots.add(root);
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const buildContext = (
  store: SessionStore,
  root: string,
  state: Record<string, unknown> = {},
) =>
  ({
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
      supervisor: { adoptChild: () => {} },
      ...state,
    },
    runtimeStore: store,
    appendLocalChatEvent: (event: {
      conversationId: string;
      eventId?: string;
      type: string;
      payload?: unknown;
    }) => {
      if (event.eventId && store.hasEvent(event.conversationId, event.eventId))
        return;
      store.appendEvent({ ...event, timestamp: Date.now() } as never);
    },
    stellaDataDir: root,
    toolHost: { listRunningShellSessionsOwnedBy: () => [] },
  }) as never;

const countReminders = (db: SqliteDatabase, threadId: string, eventId: string) =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM thread_entry
         WHERE thread_id = ? AND custom_type = ?
           AND json_extract(payload, '$.eventId') = ?`,
      )
      .get(threadId, LIFECYCLE, eventId) as { n: number }
  ).n;

describe("keyed lifecycle reminder lookup", () => {
  test("finds exactly the events the full transcript scan finds", () => {
    const { store, root } = openStore();
    const filler = Array.from({ length: 300 }, (_, index) => ({
      threadKey: CONVERSATION,
      timestamp: 1_000 + index,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `filler ${index}`,
    }));
    store.appendThreadMessages(filler);
    const custom = (
      threadKey: string,
      customType: string,
      eventId: string,
      text = "report",
    ) =>
      store.appendThreadCustomMessage({
        threadKey,
        customType,
        content: [{ type: "text", text }],
        display: false,
        timestamp: 5_000,
        eventId,
      });
    custom(CONVERSATION, LIFECYCLE, "child-a:1:agent-completed");
    // Same id under the display-only private type must not count.
    custom(
      CONVERSATION,
      "runtime.task_lifecycle_private",
      "child-b:1:agent-completed",
    );
    // Same id in a different thread must not count for this one.
    custom("other-thread", LIFECYCLE, "child-c:1:agent-failed");
    // Oversized text is truncated for storage; the id survives.
    custom(
      CONVERSATION,
      LIFECYCLE,
      "child-d:2:agent-canceled",
      "x".repeat(200_000),
    );
    store.appendThreadMessages([
      { threadKey: CONVERSATION, timestamp: 9_000, role: "user", content: "tail" },
    ]);

    const indexed = buildContext(store, root);
    // Same store without the keyed probe: the historical transcript scan.
    const scanStore = new Proxy(store, {
      get: (target, key) => {
        if (key === "hasThreadCustomEvent") return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scanned = buildContext(scanStore as SessionStore, root);
    const probe = (eventId: string) => ({
      type: "agent-completed" as const,
      conversationId: CONVERSATION,
      agentId: eventId.split(":")[0]!,
      agentType: "general",
      eventId,
      audience: "orchestrator-only" as const,
    });
    const cases: Array<[string, boolean]> = [
      ["child-a:1:agent-completed", true],
      ["child-b:1:agent-completed", false],
      ["child-c:1:agent-failed", false],
      ["child-d:2:agent-canceled", true],
      ["child-a:2:agent-completed", false],
      ["missing", false],
    ];
    for (const [eventId, expected] of cases) {
      const viaIndex = hasDurableAgentLifecycleEvent(
        indexed,
        probe(eventId) as never,
      );
      const viaScan = hasDurableAgentLifecycleEvent(
        scanned,
        probe(eventId) as never,
      );
      expect({ eventId, found: viaIndex }).toEqual({ eventId, found: expected });
      expect(viaIndex).toBe(viaScan);
    }
  });
});

type RecordShape = Record<string, any>;

const bootManager = (options: {
  records: Map<string, RecordShape>;
  ledger: Map<string, string>;
  onAgentEvent: (event: any) => Promise<void> | void;
}) =>
  new LocalAgentManager({
    maxConcurrent: 1,
    fetchAgentContext: async () => ({ maxAgentDepth: 3 }) as LocalAgentContext,
    runSubagent: async () => ({ runId: "unused", result: "" }),
    toolExecutor: async () => ({ result: null }),
    saveAgentRecord: (record: RecordShape) => {
      options.records.set(record.threadId, { ...record });
    },
    getAgentRecord: (threadId: string) => options.records.get(threadId) ?? null,
    listAgentRecordsByStatus: (status: string) =>
      [...options.records.values()].filter((record) => record.status === status),
    hasAgentLifecycleEvent: () => false,
    onAgentEvent: options.onAgentEvent,
    readTerminalLifecycleRecoveryLedger: (key: string) =>
      options.ledger.get(key) ?? null,
    writeTerminalLifecycleRecoveryLedger: (key: string, value: string) => {
      options.ledger.set(key, value);
    },
  } as never);

const terminalRecord = (overrides: RecordShape = {}): RecordShape => ({
  threadId: "child-1",
  conversationId: CONVERSATION,
  storageMode: "local",
  agentType: "general",
  description: "Child task",
  agentDepth: 2,
  parentAgentId: "parent-1",
  status: "completed",
  attemptGeneration: 1,
  startedAt: Date.now() - 2_000,
  completedAt: Date.now() - 1_000,
  updatedAt: Date.now() - 1_000,
  result: "done",
  ...overrides,
});

const drainBoot = async (manager: LocalAgentManager) => {
  await manager.awaitTerminalLifecycleRecovery();
  await manager.shutdown();
};

describe("terminal receipt replay bookkeeping", () => {
  test("a failed wake retries on the next boot and then delivers exactly once", async () => {
    const records = new Map([["child-1", terminalRecord()]]);
    const ledger = new Map<string, string>();
    const delivered: string[] = [];
    let fail = true;
    const onAgentEvent = async (event: any) => {
      if (fail) throw new Error("Unable to durably admit terminal wake");
      delivered.push(event.eventId);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await drainBoot(bootManager({ records, ledger, onAgentEvent }));
      expect(delivered).toEqual([]);
      expect(records.get("child-1")?.terminalLifecycleReceiptGeneration).toBeUndefined();
      const key = `${LOCAL_TERMINAL_RECOVERY_LEDGER_PREFIX}${CONVERSATION}:child-1:1:agent-completed`;
      expect(JSON.parse(ledger.get(key)!)).toMatchObject({
        attempts: 1,
        outcome: "retrying",
      });

      fail = false;
      await drainBoot(bootManager({ records, ledger, onAgentEvent }));
      expect(delivered).toEqual(["child-1:1:agent-completed"]);
      expect(records.get("child-1")?.terminalLifecycleReceiptGeneration).toBe(1);

      await drainBoot(bootManager({ records, ledger, onAgentEvent }));
      expect(delivered).toEqual(["child-1:1:agent-completed"]);
    } finally {
      console.warn = warn;
    }
  });

  test("records an abandoned outcome after the attempt bound and stops replaying", async () => {
    const records = new Map([["child-1", terminalRecord()]]);
    const ledger = new Map<string, string>();
    let calls = 0;
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      for (let boot = 0; boot < LOCAL_TERMINAL_RECOVERY_MAX_ATTEMPTS; boot += 1) {
        await drainBoot(
          bootManager({
            records,
            ledger,
            onAgentEvent: async () => {
              calls += 1;
              throw new Error("parent missing");
            },
          }),
        );
      }
      expect(calls).toBe(LOCAL_TERMINAL_RECOVERY_MAX_ATTEMPTS);
      const [entry] = [...ledger.values()].map((value) => JSON.parse(value));
      expect(entry).toMatchObject({
        attempts: LOCAL_TERMINAL_RECOVERY_MAX_ATTEMPTS,
        outcome: "abandoned",
        lastError: "parent missing",
      });
      expect(
        warnings.some(([message]) =>
          String(message).includes("wake abandoned"),
        ),
      ).toBe(true);

      // Later boots never replay it again, even once it would succeed.
      await drainBoot(
        bootManager({
          records,
          ledger,
          onAgentEvent: async () => {
            calls += 1;
          },
        }),
      );
      expect(calls).toBe(LOCAL_TERMINAL_RECOVERY_MAX_ATTEMPTS);
      // Abandonment is a ledger outcome, never a fabricated delivery receipt.
      expect(records.get("child-1")?.terminalLifecycleReceiptGeneration).toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });

  test("does not wake parents for receipts long predating the previous session's last activity", async () => {
    const lastActivityAt = Date.now() - 60_000;
    const staleAt = lastActivityAt - LOCAL_TERMINAL_RECOVERY_STALE_AFTER_MS - 1;
    const records = new Map<string, RecordShape>([
      [
        "stale-child",
        terminalRecord({
          threadId: "stale-child",
          completedAt: staleAt,
          updatedAt: staleAt,
        }),
      ],
      [
        "fresh-child",
        terminalRecord({
          threadId: "fresh-child",
          completedAt: lastActivityAt,
          updatedAt: lastActivityAt,
        }),
      ],
    ]);
    const ledger = new Map<string, string>();
    const delivered: string[] = [];
    await drainBoot(
      bootManager({
        records,
        ledger,
        onAgentEvent: async (event) => {
          delivered.push(event.eventId);
        },
      }),
    );
    expect(delivered).toEqual(["fresh-child:1:agent-completed"]);
    expect(records.get("stale-child")?.terminalLifecycleReceiptGeneration).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  test("real store: a failed wake retries on the next boot, then its report lands exactly once in the user's thread", async () => {
    const { db, store, root } = openStore();
    const now = Date.now();
    store.saveAgentRecord({
      threadId: "parent-1",
      conversationId: CONVERSATION,
      agentType: "general",
      description: "Parent task",
      agentDepth: 1,
      // Dead owner: the report must reach the user's thread instead.
      status: "error",
      attemptGeneration: 1,
      terminalLifecycleReceiptGeneration: 1,
      startedAt: now - 5_000,
      completedAt: now - 3_000,
      error: "parent stopped",
      updatedAt: now - 3_000,
    });
    store.saveAgentRecord({
      threadId: "child-1",
      conversationId: CONVERSATION,
      agentType: "general",
      description: "Child task",
      agentDepth: 2,
      parentAgentId: "parent-1",
      status: "completed",
      attemptGeneration: 1,
      startedAt: now - 2_000,
      completedAt: now - 1_000,
      result: "child result",
      updatedAt: now - 1_000,
    });
    const eventId = "child-1:1:agent-completed";
    const appendThreadCustomMessage = store.appendThreadCustomMessage.bind(store);
    let failWrites = true;
    store.appendThreadCustomMessage = (message) => {
      if (failWrites) throw new Error("SQLITE_FULL: database or disk is full");
      appendThreadCustomMessage(message);
    };
    const boot = async () => {
      const latch = createReadinessLatch();
      const context = buildContext(store, root, {
        isRunning: false,
        initializationStarted: latch,
        initializationPromise: null,
      }) as any;
      const orchestration = createAgentOrchestration(context, {
        buildAgentContext: async () => ({}) as never,
        sendMessage: async ({ text, eventId: deliveredEventId }) => {
          persistThreadCustomMessage(store, {
            threadKey: orchestratorThreadKey,
            customType: LIFECYCLE,
            content: [{ type: "text", text }],
            display: false,
            timestamp: Date.now(),
            ...(deliveredEventId ? { eventId: deliveredEventId } : {}),
          });
        },
      });
      context.state.isRunning = true;
      context.state.initializationPromise = Promise.resolve();
      latch.open();
      await context.state.localAgentManager.awaitTerminalLifecycleRecovery();
      await orchestration.shutdown();
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      // Boot 1: the report cannot be written, so the wake fails.
      await boot();
      expect(store.getAgentRecord("child-1")?.terminalLifecycleReceiptGeneration).toBeUndefined();
      expect(countReminders(db, orchestratorThreadKey, eventId)).toBe(0);
      const ledgerKey = `${LOCAL_TERMINAL_RECOVERY_LEDGER_PREFIX}${CONVERSATION}:${eventId}`;
      expect(JSON.parse(store.getSetting(ledgerKey)!)).toMatchObject({
        attempts: 1,
        outcome: "retrying",
      });

      // Boot 2: the write succeeds; the user's thread admits the report and
      // the dead owner is never woken or credited with it.
      failWrites = false;
      await boot();
      expect(store.getAgentRecord("child-1")?.terminalLifecycleReceiptGeneration).toBe(1);
      expect(countReminders(db, orchestratorThreadKey, eventId)).toBe(1);
      expect(countReminders(db, "parent-1", eventId)).toBe(0);
      expect(
        store.getAgentRecord("parent-1")?.descendantBoundaryState?.consumedEventIds ?? [],
      ).toEqual([]);

      // Boot 3: nothing replays; the user's thread still holds one report.
      await boot();
      expect(countReminders(db, orchestratorThreadKey, eventId)).toBe(1);
    } finally {
      console.warn = warn;
    }
  });
});

describe("boot critical path", () => {
  const seedOrchestratorReceipts = (store: SessionStore, count: number) => {
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      store.saveAgentRecord({
        threadId: `child-${index}`,
        conversationId: CONVERSATION,
        agentType: "general",
        description: `Child ${index}`,
        agentDepth: 1,
        status: "completed",
        attemptGeneration: 1,
        startedAt: now - 2_000,
        completedAt: now - 1_000,
        result: `result ${index}`,
        updatedAt: now - 1_000,
      });
    }
  };
  const unstamped = (db: SqliteDatabase) =>
    (
      db
        .prepare(
          `SELECT count(*) AS n FROM agent
           WHERE terminal_lifecycle_receipt_generation IS NULL`,
        )
        .get() as { n: number }
    ).n;

  test("construction returns before the sweep, which completes once the runtime is ready", async () => {
    const { db, store, root } = openStore();
    seedOrchestratorReceipts(store, 40);
    const latch = createReadinessLatch();
    const sent: string[] = [];
    const context = buildContext(store, root, {
      isRunning: false,
      initializationStarted: latch,
      initializationPromise: null,
    }) as any;
    const orchestration = createAgentOrchestration(context, {
      buildAgentContext: async () => ({}) as never,
      sendMessage: async (input: { eventId?: string }) => {
        if (!context.state.isRunning) {
          throw new Error("Stella runtime is not started");
        }
        sent.push(input.eventId ?? "");
      },
    });
    const manager = context.state.localAgentManager;
    // Boot returned with no replay started and nothing stamped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(manager.terminalReceiptRecoveries.size).toBe(0);
    expect(unstamped(db)).toBe(40);

    context.state.isRunning = true;
    context.state.initializationPromise = Promise.resolve();
    latch.open();
    await manager.awaitTerminalLifecycleRecovery();
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    expect(unstamped(db)).toBe(0);
    await orchestration.shutdown();
  });

  test("shutdown before readiness interrupts the sweep and leaves receipts for the next boot", async () => {
    const { db, store, root } = openStore();
    seedOrchestratorReceipts(store, 5);
    const context = buildContext(store, root, {
      isRunning: false,
      initializationStarted: createReadinessLatch(),
      initializationPromise: null,
    }) as any;
    let sends = 0;
    const orchestration = createAgentOrchestration(context, {
      buildAgentContext: async () => ({}) as never,
      sendMessage: async () => {
        sends += 1;
      },
    });
    await orchestration.shutdown();
    await context.state.localAgentManager.awaitTerminalLifecycleRecovery();
    expect(sends).toBe(0);
    expect(unstamped(db)).toBe(5);
  });
});
