import { describe, expect, test } from "bun:test";
import { admitSend } from "../send-admission";

describe("admitSend (synchronous queue-vs-dispatch arbiter)", () => {
  test("two synchronous back-to-back sends: first dispatches, second queues — no concurrent dispatch", () => {
    const sendingRef = { current: false };
    // First send claims the dispatch slot...
    expect(admitSend(sendingRef)).toBe("dispatch");
    // ...and the claim is visible IMMEDIATELY, before any render/effect has
    // run — a second imperative send in the same tick must queue, never
    // start a concurrent turn (the render-state `sending` would still read
    // false here).
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
    // markSending(false) — finishDispatch / stop / stopped-dispatch returns.
    sendingRef.current = false;
    expect(admitSend(sendingRef)).toBe("dispatch");
    expect(sendingRef.current).toBe(true);
  });
});
