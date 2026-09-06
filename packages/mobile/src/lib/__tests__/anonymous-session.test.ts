import { describe, expect, test } from "bun:test";
import { createAnonymousSessionStarter } from "../anonymous-session";

const guest = {
  data: { user: { id: "existing-guest", isAnonymous: true } },
  error: null,
};

describe("anonymous session entry", () => {
  test("keeps the current guest owner without creating another session", async () => {
    let creates = 0;
    const enter = createAnonymousSessionStarter({
      getSession: async () => guest,
      createSession: async () => { creates++; return guest; },
    });

    expect(await enter()).toBe(guest);
    expect(creates).toBe(0);
  });

  test("does not replace a connected account that appeared while login was open", async () => {
    const connected = { data: { user: { id: "account", isAnonymous: false } } };
    let creates = 0;
    const enter = createAnonymousSessionStarter({
      getSession: async () => connected,
      createSession: async () => { creates++; return guest; },
    });

    expect(await enter()).toBe(connected);
    expect(creates).toBe(0);
  });

  test("creates a guest only after confirming there is no session", async () => {
    const calls: string[] = [];
    const enter = createAnonymousSessionStarter({
      getSession: async () => { calls.push("lookup"); return { data: null }; },
      createSession: async () => { calls.push("create"); return guest; },
    });

    expect(await enter()).toBe(guest);
    expect(calls).toEqual(["lookup", "create"]);
  });

  test("a failed lookup cannot create a replacement owner, and can be retried", async () => {
    const failure = { data: null, error: { message: "Connection interrupted" } };
    let lookups = 0;
    let creates = 0;
    const enter = createAnonymousSessionStarter({
      getSession: async () => ++lookups === 1 ? failure : guest,
      createSession: async () => { creates++; return guest; },
    });

    expect(await enter()).toBe(failure);
    expect(await enter()).toBe(guest);
    expect(creates).toBe(0);
  });

  test("a thrown network failure preserves the owner and releases the pending attempt", async () => {
    let lookups = 0;
    let creates = 0;
    const enter = createAnonymousSessionStarter({
      getSession: async () => {
        if (++lookups === 1) throw new Error("Network unavailable");
        return guest;
      },
      createSession: async () => { creates++; return guest; },
    });

    await expect(enter()).rejects.toThrow("Network unavailable");
    expect(await enter()).toBe(guest);
    expect(creates).toBe(0);
  });

  test("concurrent login and bootstrap attempts share one session creation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lookups = 0;
    let creates = 0;
    const enter = createAnonymousSessionStarter({
      getSession: async () => { lookups++; await gate; return { data: null }; },
      createSession: async () => { creates++; return guest; },
    });

    const first = enter();
    const second = enter();
    expect(first).toBe(second);
    release();
    expect(await first).toBe(guest);
    expect(lookups).toBe(1);
    expect(creates).toBe(1);
  });
});
