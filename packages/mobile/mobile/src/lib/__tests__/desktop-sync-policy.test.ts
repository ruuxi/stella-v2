import { describe, expect, test } from "bun:test";
import {
  desktopSyncPullPlan,
  desktopSyncJoinPlan,
  DESKTOP_TASK_POLL_MS,
  DESKTOP_TASK_POLL_PUSH_VERIFY_MS,
  desktopTaskPollIntervalMs,
  shouldArmDesktopTaskPoll,
  shouldDeferLocalChatPushDuringSend,
  shouldStartDesktopSyncRun,
  shouldRunDesktopForegroundTimer,
  shouldSyncOnLocalChatPush,
} from "../desktop-sync-policy";

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

  test("catch-up ignores the cursor and pulls the full window", () => {
    expect(
      desktopSyncPullPlan({
        catchUp: true,
        expectedConversationId: "conv-1",
        cursor: CURSOR,
      }),
    ).toEqual({ sinceCursor: null, fullWindow: true });
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

  /**
   * The production failure this exists for: the desktop's delta filter is
   * strictly `(created_at, id) > cursor`, and the cursor is minted from the
   * newest *source event* the last pull saw. Rows can land at-or-behind the
   * cursor (backdated caller timestamps, same-millisecond inserts with a
   * smaller random id, >maxMessages truncation) — a "cursor-ahead" state in
   * which every delta, including Force Sync's, returns zero rows while the
   * desktop transcript plainly has them. This models the desktop filter and
   * shows the delta stays empty forever while the catch-up plan's full window
   * delivers the rows.
   */
  test("cursor-ahead: deltas are permanent no-ops, the catch-up full pull heals", () => {
    type Row = { createdAt: number; id: string };
    const desktopRows: Row[] = [
      { createdAt: 1_000, id: "a" },
      // Same-stamp row whose id sorts BELOW the cursor id — behind the cursor.
      { createdAt: 2_000, id: "b" },
      // Backdated insert: appended after the phone's last pull but stamped
      // earlier than the cursor.
      { createdAt: 1_500, id: "z-late" },
    ];
    // Cursor minted from a newer source event (e.g. a tool lifecycle row).
    const cursor = { createdAt: 2_000, id: "c-tool-event" };
    const afterCursor = (row: Row) =>
      row.createdAt > cursor.createdAt ||
      (row.createdAt === cursor.createdAt && row.id > cursor.id);

    // Every delta pull: nothing, forever.
    expect(desktopRows.filter(afterCursor)).toEqual([]);

    // The catch-up plan refuses the delta…
    const plan = desktopSyncPullPlan({
      catchUp: true,
      expectedConversationId: "conv-1",
      cursor: "1:2000:c-tool-event",
    });
    expect(plan.sinceCursor).toBeNull();
    // …and the full-window read (no cursor filter) returns all rows.
    expect(desktopRows.length).toBe(3);
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
