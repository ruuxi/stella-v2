import { describe, expect, test } from "bun:test";
import {
  DESKTOP_TASK_POLL_MS,
  DESKTOP_TASK_POLL_PUSH_VERIFY_MS,
  desktopTaskPollIntervalMs,
  shouldArmDesktopTaskPoll,
  shouldDeferLocalChatPushDuringSend,
  shouldSyncOnLocalChatPush,
} from "../desktop-sync-policy";

const base = {
  isDesktopTransport: true,
  storageLoaded: true,
  hasRunningConversationTask: true,
  sending: false,
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
      shouldDeferLocalChatPushDuringSend({ storageLoaded: true, sending: true }),
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
