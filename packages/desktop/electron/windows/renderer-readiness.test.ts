import { describe, expect, test } from "bun:test";
import { RendererReadinessWaiters } from "./renderer-readiness.js";

describe("RendererReadinessWaiters", () => {
  test("accepts only the exact sender, mode, and one-time activation token", () => {
    const waiters = new RendererReadinessWaiters();
    let mountedCount = 0;
    waiters.register({
      senderId: 42,
      mode: "mini",
      token: "current-token",
      onMounted: () => {
        mountedCount += 1;
      },
    });

    expect(
      waiters.signal({
        senderId: 41,
        mode: "mini",
        token: "current-token",
      }),
    ).toBe(false);
    expect(
      waiters.signal({
        senderId: 42,
        mode: "full",
        token: "current-token",
      }),
    ).toBe(false);
    expect(
      waiters.signal({ senderId: 42, mode: "mini", token: "stale-token" }),
    ).toBe(false);
    expect(mountedCount).toBe(0);

    expect(
      waiters.signal({
        senderId: 42,
        mode: "mini",
        token: "current-token",
      }),
    ).toBe(true);
    expect(mountedCount).toBe(1);
    expect(
      waiters.signal({
        senderId: 42,
        mode: "mini",
        token: "current-token",
      }),
    ).toBe(false);
    expect(mountedCount).toBe(1);
  });

  test("cleanup cannot remove a newer waiter for the same sender", () => {
    const waiters = new RendererReadinessWaiters();
    const removeOld = waiters.register({
      senderId: 7,
      mode: "full",
      token: "old",
      onMounted: () => undefined,
    });
    let mounted = false;
    waiters.register({
      senderId: 7,
      mode: "full",
      token: "new",
      onMounted: () => {
        mounted = true;
      },
    });

    removeOld();
    expect(waiters.signal({ senderId: 7, mode: "full", token: "new" })).toBe(
      true,
    );
    expect(mounted).toBe(true);
  });
});
