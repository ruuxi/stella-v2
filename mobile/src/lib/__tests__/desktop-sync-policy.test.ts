import { describe, expect, test } from "bun:test";
import {
  shouldArmDesktopTaskPoll,
  shouldSyncOnLocalChatPush,
} from "../desktop-sync-policy";

const base = {
  isDesktopTransport: true,
  storageLoaded: true,
  hasRunningConversationTask: true,
  sending: false,
  livePushConnected: false,
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

  test("never polls mid-send (05e5bf6), even without push", () => {
    expect(shouldArmDesktopTaskPoll({ ...base, sending: true })).toBe(false);
    expect(
      shouldArmDesktopTaskPoll({
        ...base,
        sending: true,
        livePushConnected: true,
      }),
    ).toBe(false);
  });

  test("stands down while the push socket is connected (no double delivery)", () => {
    expect(
      shouldArmDesktopTaskPoll({ ...base, livePushConnected: true }),
    ).toBe(false);
    // Push drops → poll resumes: the version-mismatch / disconnect handoff.
    expect(
      shouldArmDesktopTaskPoll({ ...base, livePushConnected: false }),
    ).toBe(true);
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
