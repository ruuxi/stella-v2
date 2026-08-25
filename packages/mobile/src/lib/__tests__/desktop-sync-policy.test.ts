import { describe, expect, test } from "bun:test";
import {
  consumeDesktopLocalChatPush,
  desktopSyncPullPlan,
  desktopSyncJoinPlan,
  DESKTOP_PUSH_DEDUPE_LIMIT,
  DESKTOP_TASK_POLL_MS,
  DESKTOP_TASK_POLL_PUSH_VERIFY_MS,
  desktopLiveConnectionSyncPlan,
  desktopTaskPollIntervalMs,
  mergeDeferredDesktopSyncIntent,
  shouldArmDesktopTaskPoll,
  shouldDeferLocalChatPushDuringSend,
  shouldStartDesktopSyncRun,
  shouldRunDesktopForegroundTimer,
  shouldScheduleDesktopTranscriptSyncForPush,
  shouldSyncOnLocalChatPush,
} from "../desktop-sync-policy";

describe("consumeDesktopLocalChatPush", () => {
  test("deduplicates durable events and ignores other conversations", () => {
    const seenEventIds = new Set<string>();
    const input = {
      activeConversationId: "conv-1",
      payloadConversationId: "conv-1",
      eventId: "event-1",
      seenEventIds,
    };
    expect(consumeDesktopLocalChatPush(input)).toBe("sync");
    expect(consumeDesktopLocalChatPush(input)).toBe("duplicate");
    expect(
      consumeDesktopLocalChatPush({
        ...input,
        payloadConversationId: "conv-2",
        eventId: "event-2",
      }),
    ).toBe("other-conversation");
  });

  test("keeps unkeyed invalidations lossless and bounds dedupe memory", () => {
    const seenEventIds = new Set<string>();
    expect(
      consumeDesktopLocalChatPush({
        activeConversationId: "conv-1",
        seenEventIds,
      }),
    ).toBe("sync");
    expect(
      consumeDesktopLocalChatPush({
        activeConversationId: "conv-1",
        eventId: "event-1",
        seenEventIds,
        maxSeenEventIds: 1,
      }),
    ).toBe("sync");
    expect(
      consumeDesktopLocalChatPush({
        activeConversationId: "conv-1",
        eventId: "event-2",
        seenEventIds,
        maxSeenEventIds: 1,
      }),
    ).toBe("sync");
    expect(seenEventIds).toEqual(new Set(["conv-1:event-2"]));
  });

  test("bounds identity state across a deterministic 100k-event push storm", () => {
    const seenEventIds = new Set<string>();
    for (let index = 0; index < 100_000; index += 1) {
      expect(
        consumeDesktopLocalChatPush({
          activeConversationId: "conv-scale",
          payloadConversationId: "conv-scale",
          eventId: `event-${index}`,
          seenEventIds,
        }),
      ).toBe("sync");
    }
    expect(seenEventIds.size).toBe(DESKTOP_PUSH_DEDUPE_LIMIT);
    expect(seenEventIds.has("conv-scale:event-99999")).toBe(true);
    expect(seenEventIds.has("conv-scale:event-0")).toBe(false);
  });
});

describe("shouldScheduleDesktopTranscriptSyncForPush", () => {
  test("coalesces tool churn until a transcript or lifecycle event", () => {
    expect(shouldScheduleDesktopTranscriptSyncForPush("tool_request")).toBe(
      false,
    );
    expect(shouldScheduleDesktopTranscriptSyncForPush("tool_result")).toBe(
      false,
    );
    expect(shouldScheduleDesktopTranscriptSyncForPush("agent-progress")).toBe(
      false,
    );
    expect(
      shouldScheduleDesktopTranscriptSyncForPush("assistant_message"),
    ).toBe(true);
    expect(shouldScheduleDesktopTranscriptSyncForPush("agent-completed")).toBe(
      true,
    );
    expect(shouldScheduleDesktopTranscriptSyncForPush()).toBe(true);
  });
});

const base = {
  isDesktopTransport: true,
  storageLoaded: true,
  hasRunningConversationTask: true,
  sending: false,
  appActive: true,
};

describe("shouldArmDesktopTaskPoll", () => {
  test("arms only for a loaded desktop thread with a running task", () => {
    expect(shouldArmDesktopTaskPoll(base)).toBe(true);
    expect(
      shouldArmDesktopTaskPoll({ ...base, isDesktopTransport: false }),
    ).toBe(false);
    expect(shouldArmDesktopTaskPoll({ ...base, storageLoaded: false })).toBe(
      false,
    );
    expect(
      shouldArmDesktopTaskPoll({ ...base, hasRunningConversationTask: false }),
    ).toBe(false);
    expect(shouldArmDesktopTaskPoll({ ...base, appActive: false })).toBe(false);
  });

  test("never polls mid-send (05e5bf6)", () => {
    expect(shouldArmDesktopTaskPoll({ ...base, sending: true })).toBe(false);
  });

  test("stays armed while the push socket is connected (build-94 regression)", () => {
    // The pill's task snapshots ride these pulls; push must relax the
    // cadence, never fully suspend the poll while a task is running.
    expect(shouldArmDesktopTaskPoll(base)).toBe(true);
    expect(desktopTaskPollIntervalMs(false)).toBe(DESKTOP_TASK_POLL_MS);
    expect(desktopTaskPollIntervalMs(true)).toBe(
      DESKTOP_TASK_POLL_PUSH_VERIFY_MS,
    );
    expect(DESKTOP_TASK_POLL_PUSH_VERIFY_MS).toBeGreaterThan(
      DESKTOP_TASK_POLL_MS,
    );
  });
});

describe("foreground timer gate", () => {
  test("runs only while the computer surface is focused and active", () => {
    expect(
      shouldRunDesktopForegroundTimer({ focused: true, appActive: true }),
    ).toBe(true);
    expect(
      shouldRunDesktopForegroundTimer({ focused: true, appActive: false }),
    ).toBe(false);
    expect(
      shouldRunDesktopForegroundTimer({ focused: false, appActive: true }),
    ).toBe(false);
  });
});

describe("shouldSyncOnLocalChatPush", () => {
  test("push-triggered syncs honor the same mid-send gate", () => {
    expect(
      shouldSyncOnLocalChatPush({ storageLoaded: true, sending: false }),
    ).toBe(true);
    expect(
      shouldSyncOnLocalChatPush({ storageLoaded: true, sending: true }),
    ).toBe(false);
    expect(
      shouldSyncOnLocalChatPush({ storageLoaded: false, sending: false }),
    ).toBe(false);
  });
});

describe("deferred reconnect gaps", () => {
  test("coalesces 100k mid-send pushes and preserves catch-up intent", () => {
    let intent: ReturnType<typeof mergeDeferredDesktopSyncIntent> | null = null;
    for (let index = 0; index < 100_000; index += 1) {
      expect(
        shouldDeferLocalChatPushDuringSend({
          storageLoaded: true,
          sending: true,
        }),
      ).toBe(true);
      intent = mergeDeferredDesktopSyncIntent(intent, index === 50_000);
    }
    expect(intent).toEqual({ catchUp: true });
    expect(
      shouldStartDesktopSyncRun({ sending: true, duringSend: false }),
    ).toBe(false);
    expect(
      shouldStartDesktopSyncRun({ sending: false, duringSend: false }),
    ).toBe(true);
  });
});

describe("shouldDeferLocalChatPushDuringSend", () => {
  test("mid-send pushes are deferred, not dropped", () => {
    // The turn's own agent-started/task events broadcast while sending; the
    // flush after the send is what re-delivers the running-task snapshot if
    // the reconcile raced the desktop persisting those rows.
    expect(
      shouldDeferLocalChatPushDuringSend({
        storageLoaded: true,
        sending: true,
      }),
    ).toBe(true);
    expect(
      shouldDeferLocalChatPushDuringSend({
        storageLoaded: true,
        sending: false,
      }),
    ).toBe(false);
    // Pre-hydration pushes stay dropped: the landing sync re-pulls anyway.
    expect(
      shouldDeferLocalChatPushDuringSend({
        storageLoaded: false,
        sending: true,
      }),
    ).toBe(false);
  });
});

describe("mergeDeferredDesktopSyncIntent", () => {
  test("preserves reconnect catch-up intent across later ordinary pushes", () => {
    const reconnect = mergeDeferredDesktopSyncIntent(null, true);
    expect(mergeDeferredDesktopSyncIntent(reconnect, false)).toEqual({
      catchUp: true,
    });
  });

  test("upgrades an already-deferred delta to catch-up", () => {
    const push = mergeDeferredDesktopSyncIntent(null, false);
    expect(mergeDeferredDesktopSyncIntent(push, true)).toEqual({
      catchUp: true,
    });
  });
});

describe("desktopLiveConnectionSyncPlan", () => {
  test("keeps the first socket connection on the cursor delta", () => {
    expect(
      desktopLiveConnectionSyncPlan({
        reconnected: false,
        foregroundResume: false,
      }),
    ).toEqual({
      catchUp: false,
      trigger: "push-connect",
    });
  });

  test("does not duplicate the Computer surface's foreground catch-up", () => {
    expect(
      desktopLiveConnectionSyncPlan({
        reconnected: true,
        foregroundResume: true,
      }),
    ).toEqual({
      catchUp: false,
      trigger: "push-resume-connect",
    });
  });

  test("uses the bounded catch-up window after a genuine socket gap", () => {
    expect(
      desktopLiveConnectionSyncPlan({
        reconnected: true,
        foregroundResume: false,
      }),
    ).toEqual({
      catchUp: true,
      trigger: "push-reconnect",
    });
  });
});

describe("shouldStartDesktopSyncRun (mid-send gate at the coalescing point)", () => {
  test("idle threads may pull", () => {
    expect(
      shouldStartDesktopSyncRun({ sending: false, duringSend: false }),
    ).toBe(true);
  });

  test("imperative callers (resume, Force Sync) never pull mid-send", () => {
    expect(
      shouldStartDesktopSyncRun({ sending: true, duringSend: false }),
    ).toBe(false);
  });

  test("the send pipeline's own wake→sync is exempt", () => {
    expect(shouldStartDesktopSyncRun({ sending: true, duringSend: true })).toBe(
      true,
    );
  });
});

describe("desktopSyncJoinPlan", () => {
  test("shares duplicate concurrent catch-up callers", () => {
    expect(
      desktopSyncJoinPlan({
        existingCatchUp: true,
        requestedCatchUp: true,
      }),
    ).toBe("share");
  });

  test("chains a healer only when the in-flight run is a delta", () => {
    expect(
      desktopSyncJoinPlan({
        existingCatchUp: false,
        requestedCatchUp: true,
      }),
    ).toBe("chain-catch-up");
    expect(
      desktopSyncJoinPlan({
        existingCatchUp: true,
        requestedCatchUp: false,
      }),
    ).toBe("share");
  });
});

describe("desktopSyncPullPlan", () => {
  const CURSOR = "1:1700000000000:row-42";

  test("steady-state pull with a usable cursor rides the delta", () => {
    expect(
      desktopSyncPullPlan({
        catchUp: false,
        expectedConversationId: "conv-1",
        cursor: CURSOR,
      }),
    ).toEqual({ sinceCursor: CURSOR, fullWindow: false });
  });

  test("catch-up preserves a usable cursor for the fast delta path", () => {
    expect(
      desktopSyncPullPlan({
        catchUp: true,
        expectedConversationId: "conv-1",
        cursor: CURSOR,
      }),
    ).toEqual({ sinceCursor: CURSOR, fullWindow: false });
  });

  test("no known conversation or no cursor → full window either way", () => {
    expect(
      desktopSyncPullPlan({
        catchUp: false,
        expectedConversationId: null,
        cursor: CURSOR,
      }).fullWindow,
    ).toBe(true);
    expect(
      desktopSyncPullPlan({
        catchUp: false,
        expectedConversationId: "conv-1",
        cursor: null,
      }).fullWindow,
    ).toBe(true);
  });

  test("catch-up relies on the durable sequence cursor, not wall-clock order", () => {
    const desktopRows = [
      { createdAt: 2_000, id: "cursor", sequence: 10 },
      { createdAt: 1_500, id: "backdated", sequence: 11 },
      { createdAt: 2_000, id: "a-smaller-id", sequence: 12 },
    ];
    const plan = desktopSyncPullPlan({
      catchUp: true,
      expectedConversationId: "conv-1",
      cursor: "v2:10:2000:cursor",
    });
    expect(plan.sinceCursor).toBe("v2:10:2000:cursor");
    expect(desktopRows.filter((row) => row.sequence > 10)).toEqual([
      { createdAt: 1_500, id: "backdated", sequence: 11 },
      { createdAt: 2_000, id: "a-smaller-id", sequence: 12 },
    ]);
  });

  test("cursor-behind (normal case): the delta stays cheap and correct", () => {
    type Row = { createdAt: number; id: string };
    const desktopRows: Row[] = [
      { createdAt: 1_000, id: "a" },
      { createdAt: 3_000, id: "d-new" },
    ];
    const cursor = { createdAt: 2_000, id: "c" };
    const afterCursor = (row: Row) =>
      row.createdAt > cursor.createdAt ||
      (row.createdAt === cursor.createdAt && row.id > cursor.id);

    const plan = desktopSyncPullPlan({
      catchUp: false,
      expectedConversationId: "conv-1",
      cursor: "1:2000:c",
    });
    expect(plan.fullWindow).toBe(false);
    expect(desktopRows.filter(afterCursor)).toEqual([
      { createdAt: 3_000, id: "d-new" },
    ]);
  });
});
