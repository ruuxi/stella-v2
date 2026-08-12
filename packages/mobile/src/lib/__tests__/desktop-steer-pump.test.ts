import { describe, expect, test } from "bun:test";
import { drainDesktopSteerAcceptanceQueue } from "../desktop-steer-pump";

describe("drainDesktopSteerAcceptanceQueue", () => {
  test("accepts rapid steers FIFO without waiting for root completion", async () => {
    const queue = ["u2", "u3"];
    const accepted: string[] = [];
    const outcome = await drainDesktopSteerAcceptanceQueue({
      peek: () => queue[0] ?? null,
      accept: async (item) => `receipt:${item}`,
      onAccepted: (item, receipt) => {
        expect(receipt).toBe(`receipt:${item}`);
        accepted.push(item);
        queue.shift();
      },
      canContinue: () => true,
    });

    expect(outcome).toBe("drained");
    expect(accepted).toEqual(["u2", "u3"]);
  });

  test("a failed head blocks later messages from overtaking", async () => {
    const queue = ["u2", "u3"];
    const invoked: string[] = [];
    const outcome = await drainDesktopSteerAcceptanceQueue({
      peek: () => queue[0] ?? null,
      accept: async (item) => {
        invoked.push(item);
        throw new Error("offline");
      },
      onAccepted: () => queue.shift(),
      canContinue: () => true,
    });

    expect(outcome).toBe("blocked");
    expect(invoked).toEqual(["u2"]);
    expect(queue).toEqual(["u2", "u3"]);
  });

  test("a stopped generation ignores a late acceptance", async () => {
    const queue = ["u2"];
    let open = true;
    const outcome = await drainDesktopSteerAcceptanceQueue({
      peek: () => queue[0] ?? null,
      accept: async () => {
        open = false;
        return "receipt";
      },
      onAccepted: () => queue.shift(),
      canContinue: () => open,
    });

    expect(outcome).toBe("stopped");
    expect(queue).toEqual(["u2"]);
  });
});
