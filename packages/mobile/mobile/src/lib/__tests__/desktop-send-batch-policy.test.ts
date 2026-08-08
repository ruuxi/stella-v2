import { describe, expect, test } from "bun:test";
import {
  canReuseDesktopSendBatch,
  shouldReuseQueuedReplayBatch,
} from "../desktop-send-batch-policy";

describe("queued desktop replay batch policy", () => {
  test("reuses one prepared bridge only for the same live desktop", () => {
    const batch = { desktopDeviceId: "desktop-1", closed: false };
    expect(canReuseDesktopSendBatch(batch, "desktop-1")).toBe(true);
    expect(canReuseDesktopSendBatch(batch, "desktop-2")).toBe(false);
    expect(
      canReuseDesktopSendBatch({ ...batch, closed: true }, "desktop-1"),
    ).toBe(false);
  });

  test("skips repeated initial catch-up only for durable queued replay items", () => {
    expect(
      shouldReuseQueuedReplayBatch({ queueSequence: 1, batchReady: true }),
    ).toBe(true);
    expect(
      shouldReuseQueuedReplayBatch({
        queueSequence: undefined,
        batchReady: true,
      }),
    ).toBe(false);
    expect(
      shouldReuseQueuedReplayBatch({ queueSequence: 2, batchReady: false }),
    ).toBe(false);
  });
});
