import { describe, expect, test } from "bun:test";
import { admitSend } from "../send-admission";

describe("admitSend (synchronous queue-vs-dispatch arbiter)", () => {
  test("two synchronous back-to-back sends: first dispatches, second queues — no concurrent dispatch", () => {
    const sendingRef = { current: false };

    expect(admitSend(sendingRef)).toBe("dispatch");

    expect(admitSend(sendingRef)).toBe("queue");
    expect(admitSend(sendingRef)).toBe("queue");
    expect(sendingRef.current).toBe(true);
  });

  test("queueing neither releases nor re-claims the slot", () => {
    const sendingRef = { current: true };
    expect(admitSend(sendingRef)).toBe("queue");
    expect(sendingRef.current).toBe(true);
  });

  test("releasing the slot on finish/stop admits the next dispatch", () => {
    const sendingRef = { current: false };
    expect(admitSend(sendingRef)).toBe("dispatch");

    sendingRef.current = false;
    expect(admitSend(sendingRef)).toBe("dispatch");
    expect(sendingRef.current).toBe(true);
  });
});
