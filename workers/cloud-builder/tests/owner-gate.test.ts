import { afterEach, describe, expect, mock, test } from "bun:test";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const {
  OWNER_GATE_BACKGROUND_SNAPSHOT_TIMEOUT_MS,
  OWNER_GATE_BURST_WINDOW_MS,
  OWNER_GATE_DAILY_WINDOW_MS,
  OWNER_GATE_RUNNING_GRACE_MS,
  OWNER_GATE_SNAPSHOT_TIMEOUT_MS,
  OwnerGate,
  OwnerGateSnapshotError,
  parseOwnerSnapshot,
  snapshotAllowsExecutionEngine,
} = await import("../src/owner-gate.js");
mock.restore();

/**
 * The owner gate decides admission from its own SQLite plus one cached
 * control-plane read. These tests drive the real class with an in-memory
 * SQLite and a scripted snapshot transport: the windows, the concurrency
 * ceiling, the one-agent-per-workspace rule, the write fence, the generation
 * check, and the cache's failure policy are all exercised without Convex.
 */

const NOW = 1_800_000_000_000;
const TURN_TIMEOUT_MS = 900_000;

const deferred = <T>() => {
  let resolve = (_value: T): void => {
    throw new Error("Deferred promise was resolved before initialization.");
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const readImmediately = async <T>(read: Promise<T>): Promise<T> => {
  const outcome = await Promise.race([
    read.then((value) => ({ kind: "value" as const, value })),
    new Promise<{ kind: "blocked" }>((resolve) => {
      setTimeout(() => resolve({ kind: "blocked" }), 0);
    }),
  ]);
  expect(outcome.kind).toBe("value");
  if (outcome.kind === "blocked") {
    throw new Error("Snapshot read blocked on its background refresh.");
  }
  return outcome.value;
};

const gateHarness = (
  options: {
    snapshot?: ReturnType<typeof sampleOwnerSnapshot>;
    fetch?: (
      timeoutMs: number,
    ) => Promise<ReturnType<typeof sampleOwnerSnapshot>>;
    values?: Map<string, unknown>;
  } = {},
) => {
  const values = options.values ?? new Map<string, unknown>();
  const sqlFake = openSqlStorageFake();
  const storage = {
    sql: sqlFake.sql,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
  };
  const instance = Object.create(OwnerGate.prototype) as InstanceType<
    typeof OwnerGate
  > &
    Record<string, unknown>;
  let fetches = 0;
  const fetchTimeouts: number[] = [];
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  Object.assign(instance, {
    ctx: { storage, id: { name: "owner-1", toString: () => "owner-1" } },
    env: {
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      BUILDER_SERVICE_SECRET: "secret",
      TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS),
    },
    fetchSnapshot: async (_ownerId: string, timeoutMs: number) => {
      fetches += 1;
      fetchTimeouts.push(timeoutMs);
      if (options.fetch) return await options.fetch(timeoutMs);
      return snapshot;
    },
  });
  return {
    instance,
    values,
    fetches: () => fetches,
    fetchTimeouts: () => [...fetchTimeouts],
    close: () => sqlFake.close(),
  };
};

const chat = (turnId: string, now = NOW, extra: Record<string, unknown> = {}) =>
  ({
    lane: "chat" as const,
    turnId,
    conversationId: "conversation-1",
    now,
    ...extra,
  }) as const;

const harnesses: Array<{ close: () => void }> = [];
const open = (...args: Parameters<typeof gateHarness>) => {
  const harness = gateHarness(...args);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("OwnerGate admission", () => {
  test("admits within quota, registers the run, and replays the same turn id", async () => {
    const { instance } = open();
    const first = await instance.admit(chat("turn-1"));
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) return;
    expect(first.snapshot.allowance.audience).toBe("pro");
    const replay = await instance.admit(chat("turn-1"));
    expect(replay).toMatchObject({ ok: true, replayed: true });
    const status = await instance.status(NOW);
    expect(status.running).toHaveLength(1);
    expect(status.starts.chat).toBe(1);
    await instance.release({ turnId: "turn-1" });
    expect((await instance.status(NOW)).running).toHaveLength(0);
    // Releasing again, or an unknown turn, is a no-op.
    await instance.release({ turnId: "turn-1" });
    await instance.release({ turnId: "never-admitted" });
  });

  test("refuses the burst window with the time until the oldest start expires", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        quotas: {
          chat: { burstStarts: 2, dailyTurns: 100, concurrent: 10 },
          agent: { burstStarts: 10, dailyTurns: 100, concurrent: 2 },
        },
      }),
    });
    expect((await instance.admit(chat("t1", NOW))).ok).toBe(true);
    await instance.release({ turnId: "t1" });
    expect((await instance.admit(chat("t2", NOW + 60_000))).ok).toBe(true);
    await instance.release({ turnId: "t2" });
    const refused = await instance.admit(chat("t3", NOW + 120_000));
    expect(refused).toMatchObject({
      ok: false,
      code: "quota_burst",
      retryable: true,
      retryAfterMs: OWNER_GATE_BURST_WINDOW_MS - 120_000,
    });
    // Once the oldest start leaves the window a slot frees.
    const later = await instance.admit(
      chat("t4", NOW + OWNER_GATE_BURST_WINDOW_MS + 1),
    );
    expect(later.ok).toBe(true);
  });

  test("refuses the daily window and prunes starts older than 24 hours", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        quotas: {
          chat: { burstStarts: 100, dailyTurns: 2, concurrent: 10 },
          agent: { burstStarts: 10, dailyTurns: 100, concurrent: 2 },
        },
      }),
    });
    expect((await instance.admit(chat("d1", NOW))).ok).toBe(true);
    await instance.release({ turnId: "d1" });
    expect((await instance.admit(chat("d2", NOW + 3_600_000))).ok).toBe(true);
    await instance.release({ turnId: "d2" });
    const refused = await instance.admit(chat("d3", NOW + 7_200_000));
    expect(refused).toMatchObject({
      ok: false,
      code: "quota_daily",
      retryAfterMs: OWNER_GATE_DAILY_WINDOW_MS - 7_200_000,
    });
    const nextDay = await instance.admit(
      chat("d4", NOW + OWNER_GATE_DAILY_WINDOW_MS + 1),
    );
    expect(nextDay.ok).toBe(true);
    expect(
      (await instance.status(NOW + OWNER_GATE_DAILY_WINDOW_MS + 1)).starts.chat,
    ).toBe(2);
  });

  test("an unlimited plan skips the windows but never the concurrency ceiling", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        unlimited: true,
        quotas: {
          chat: { burstStarts: 0, dailyTurns: 0, concurrent: 1 },
          agent: { burstStarts: 0, dailyTurns: 0, concurrent: 1 },
        },
      }),
    });
    expect((await instance.admit(chat("u1"))).ok).toBe(true);
    const busy = await instance.admit(chat("u2"));
    expect(busy).toMatchObject({ ok: false, code: "quota_concurrency" });
    await instance.release({ turnId: "u1" });
    expect((await instance.admit(chat("u2"))).ok).toBe(true);
  });

  test("concurrency counts per lane and a run older than the timeout plus grace is presumed released", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        quotas: {
          chat: { burstStarts: 100, dailyTurns: 100, concurrent: 1 },
          agent: { burstStarts: 100, dailyTurns: 100, concurrent: 1 },
        },
      }),
    });
    expect((await instance.admit(chat("c1"))).ok).toBe(true);
    const refused = await instance.admit(chat("c2", NOW + 1_000));
    expect(refused).toMatchObject({
      ok: false,
      code: "quota_concurrency",
      retryable: true,
    });
    if (refused.ok) return;
    expect(refused.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(30_000);
    // The agent lane has its own ceiling.
    const agent = await instance.admit({
      lane: "agent",
      turnId: "a1",
      conversationId: "conversation-1",
      workspace: "world",
      now: NOW + 1_000,
    });
    expect(agent.ok).toBe(true);
    // A chat run whose isolate died is treated as released after the grace.
    const stale = NOW + TURN_TIMEOUT_MS + OWNER_GATE_RUNNING_GRACE_MS + 1;
    expect((await instance.admit(chat("c3", stale))).ok).toBe(true);
  });

  test("one running agent per workspace, independent of the agent ceiling", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        quotas: {
          chat: { burstStarts: 100, dailyTurns: 100, concurrent: 10 },
          agent: { burstStarts: 100, dailyTurns: 100, concurrent: 10 },
        },
      }),
    });
    const spawn = (turnId: string, workspace: string, now = NOW) =>
      instance.admit({
        lane: "agent",
        turnId,
        conversationId: "conversation-1",
        workspace,
        now,
      });
    expect((await spawn("a1", "world")).ok).toBe(true);
    const busy = await spawn("a2", "world");
    expect(busy).toMatchObject({ ok: false, code: "quota_concurrency" });
    if (busy.ok) return;
    expect(busy.message).toContain("workspace");
    expect((await spawn("a3", "other-workspace")).ok).toBe(true);
    await instance.release({ turnId: "a1" });
    expect((await spawn("a2", "world")).ok).toBe(true);
  });

  test("a bypass admission registers the run without consulting windows or ceilings", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({
        quotas: {
          chat: { burstStarts: 1, dailyTurns: 1, concurrent: 1 },
          agent: { burstStarts: 1, dailyTurns: 1, concurrent: 1 },
        },
      }),
    });
    expect((await instance.admit(chat("b1"))).ok).toBe(true);
    expect((await instance.admit(chat("b2"))).ok).toBe(false);
    const wake = await instance.admit(chat("wake-1", NOW, { quota: "bypass" }));
    expect(wake).toMatchObject({ ok: true, replayed: false });
    const status = await instance.status(NOW);
    expect(status.running.map((row) => row.turnId)).toEqual(["b1", "wake-1"]);
    // The wake occupied a slot but did not spend a start the user chose.
    expect(status.starts.chat).toBe(1);
    await instance.release({ turnId: "b1" });
    await instance.release({ turnId: "wake-1" });
    expect((await instance.admit(chat("b3", NOW + 1))).ok).toBe(false);
    expect(
      (await instance.admit(chat("b4", NOW + OWNER_GATE_DAILY_WINDOW_MS + 1)))
        .ok,
    ).toBe(true);
  });

  test("anonymous owners may chat but cannot enter the agent lane, even with quota bypass", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({ isAnonymous: true }),
    });
    expect((await instance.admit(chat("anonymous-chat"))).ok).toBe(true);
    await instance.release({ turnId: "anonymous-chat" });
    for (const quota of ["enforce", "bypass"] as const) {
      await expect(
        instance.admit({
          lane: "agent",
          turnId: `anonymous-agent-${quota}`,
          conversationId: "conversation-1",
          workspace: "world",
          quota,
          now: NOW,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "sign_in_required",
        retryable: false,
      });
    }
  });

  test("maps a suspended owner to owner_suspended for turns and dispatches", async () => {
    const snapshot = sampleOwnerSnapshot({
      writable: false,
      enforcement: { status: "suspended", reason: "manual review" },
    });
    const { instance } = open({ snapshot });
    await expect(instance.admit(chat("suspended-chat"))).resolves.toMatchObject(
      {
        ok: false,
        code: "owner_suspended",
        retryable: false,
      },
    );
    await expect(
      instance.submit({
        request: {
          protocol: 1,
          idempotencyKey: "suspended-dispatch",
          kind: "chat",
          ingress: "browser",
          subject: "cloud",
          conversationId: "conversation-1",
          requiredCapabilities: ["chat"],
          payload: {
            schemaVersion: 1,
            prompt: "hello",
            conversationId: "conversation-1",
            clientMsgId: "suspended-dispatch",
          },
        },
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_suspended", retryable: false },
    });
  });

  test("refuses a non-writable owner and a definitely purged owner", async () => {
    const fenced = open({ snapshot: sampleOwnerSnapshot({ writable: false }) });
    expect(await fenced.instance.admit(chat("f1"))).toMatchObject({
      ok: false,
      code: "owner_purged",
      retryable: false,
    });
    const gone = open({
      fetch: async () => {
        throw new OwnerGateSnapshotError("owner_purged", "gone", false);
      },
    });
    expect(await gone.instance.admit(chat("g1"))).toMatchObject({
      ok: false,
      code: "owner_purged",
    });
  });

  test("a stale service generation is refused only after one forced refresh", async () => {
    let generation = "generation-1";
    let fetchedAt = NOW;
    const { instance, fetches } = open({
      fetch: async () =>
        sampleOwnerSnapshot({ ownerGeneration: generation, fetchedAt }),
    });
    expect((await instance.admit(chat("s1"))).ok).toBe(true);
    expect(fetches()).toBe(1);
    // Convex rotated the generation and the push was lost: the caller is
    // newer than the cache, so the gate refreshes before deciding.
    generation = "generation-2";
    fetchedAt += 1;
    const refreshed = await instance.admit(
      chat("s2", NOW, { expectedGeneration: "generation-2" }),
    );
    expect(refreshed.ok).toBe(true);
    expect(fetches()).toBe(2);
    const stale = await instance.admit(
      chat("s3", NOW, { expectedGeneration: "generation-1" }),
    );
    expect(stale).toMatchObject({ ok: false, code: "generation_stale" });
    expect(fetches()).toBe(3);
  });
});

describe("OwnerGate snapshot cache", () => {
  test("uses separate synchronous and background snapshot deadlines", async () => {
    const initial = sampleOwnerSnapshot();
    const { instance, fetchTimeouts } = open({ snapshot: initial });
    await instance.snapshot({ now: NOW });
    await instance.snapshot({ now: NOW + initial.ttlMs + 1 });
    await Promise.resolve();
    expect(fetchTimeouts()).toEqual([
      OWNER_GATE_SNAPSHOT_TIMEOUT_MS,
      OWNER_GATE_BACKGROUND_SNAPSHOT_TIMEOUT_MS,
    ]);
  });

  test("serves a stale copy immediately while one background refresh runs", async () => {
    const refresh = deferred<ReturnType<typeof sampleOwnerSnapshot>>();
    let refreshing = false;
    const initial = sampleOwnerSnapshot();
    const { instance, fetches } = open({
      fetch: async () => (refreshing ? await refresh.promise : initial),
    });
    await instance.snapshot({ now: NOW });
    expect(fetches()).toBe(1);
    refreshing = true;
    const staleAt = NOW + initial.ttlMs + 1;
    const first = await readImmediately(instance.snapshot({ now: staleAt }));
    const second = await readImmediately(
      instance.snapshot({ now: staleAt + 1 }),
    );
    expect(first.fetchedAt).toBe(initial.fetchedAt);
    expect(second.fetchedAt).toBe(initial.fetchedAt);
    expect(fetches()).toBe(2);

    const refreshed = sampleOwnerSnapshot({
      fetchedAt: initial.fetchedAt + 1,
      plan: "go",
    });
    refresh.resolve(refreshed);
    expect(
      (await instance.snapshot({ refresh: true, now: staleAt + 2 })).plan,
    ).toBe("go");
  });

  test("invalidation marks the copy stale and the next read does not wait", async () => {
    const refresh = deferred<ReturnType<typeof sampleOwnerSnapshot>>();
    let refreshing = false;
    const initial = sampleOwnerSnapshot();
    const { instance, fetches, values } = open({
      fetch: async () => (refreshing ? await refresh.promise : initial),
    });
    await instance.snapshot({ now: NOW });
    await instance.invalidate();
    expect(values.get("ownerSnapshot")).toMatchObject({ stale: true });

    refreshing = true;
    const cached = await readImmediately(
      instance.snapshot({ now: NOW + 1_000 }),
    );
    expect(cached.fetchedAt).toBe(initial.fetchedAt);
    expect(fetches()).toBe(2);

    const refreshed = sampleOwnerSnapshot({ fetchedAt: initial.fetchedAt + 1 });
    refresh.resolve(refreshed);
    await instance.snapshot({ refresh: true, now: NOW + 1_001 });
    expect(values.get("ownerSnapshot")).not.toMatchObject({ stale: true });
  });

  test("a pushed snapshot replaces the cache and an older push is ignored", async () => {
    const initial = sampleOwnerSnapshot({ fetchedAt: 100 });
    const { instance, fetches, values } = open({ snapshot: initial });
    await instance.snapshot({ now: Date.now() });
    await instance.invalidate();

    const newer = sampleOwnerSnapshot({
      ownerGeneration: "generation-2",
      fetchedAt: 200,
      plan: "go",
    });
    await instance.replaceSnapshot(newer);
    expect(values.get("ownerSnapshot")).toMatchObject({
      snapshot: { ownerGeneration: "generation-2", fetchedAt: 200, plan: "go" },
    });
    expect(values.get("ownerSnapshot")).not.toMatchObject({ stale: true });

    await instance.replaceSnapshot(
      sampleOwnerSnapshot({
        ownerGeneration: "generation-1",
        fetchedAt: 150,
        plan: "free",
      }),
    );
    await instance.replaceSnapshot(
      sampleOwnerSnapshot({
        ownerGeneration: "generation-3",
        fetchedAt: 200,
        plan: "free",
      }),
    );
    const stored = await instance.snapshot({ now: Date.now() });
    expect(stored).toMatchObject({
      ownerGeneration: "generation-2",
      fetchedAt: 200,
      plan: "go",
    });
    expect(fetches()).toBe(1);
  });

  test("the hard ceiling still fails closed when its synchronous refresh fails", async () => {
    let fail = false;
    const { instance, fetches } = open({
      fetch: async () => {
        if (fail) {
          throw new OwnerGateSnapshotError("internal", "convex down", true);
        }
        return sampleOwnerSnapshot();
      },
    });
    expect((await instance.admit(chat("k1", NOW))).ok).toBe(true);
    fail = true;
    // ttl 300 s: at 2.5 ttls the stale copy still admits.
    const stale = await instance.admit(chat("k2", NOW + 750_000));
    expect(stale.ok).toBe(true);
    expect(fetches()).toBe(2);
    await Promise.resolve();
    const tooOld = await instance.admit(chat("k3", NOW + 900_001));
    expect(tooOld).toMatchObject({
      ok: false,
      code: "internal",
      retryable: true,
    });
    expect(fetches()).toBe(3);
  });

  test("a definite purge discovered in the background removes the stale copy", async () => {
    let purged = false;
    const { instance } = open({
      fetch: async () => {
        if (purged) {
          throw new OwnerGateSnapshotError("owner_purged", "gone", false);
        }
        return sampleOwnerSnapshot();
      },
    });
    await instance.snapshot({ now: NOW });
    purged = true;
    expect(
      (await readImmediately(instance.snapshot({ now: NOW + 300_001 })))
        .writable,
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(await instance.admit(chat("purged", NOW + 300_002))).toMatchObject({
      ok: false,
      code: "owner_purged",
      retryable: false,
    });
  });

  test("a gate with no snapshot waits for its initial fetch", async () => {
    const initial = deferred<ReturnType<typeof sampleOwnerSnapshot>>();
    const { instance, fetches } = open({
      fetch: async () => await initial.promise,
    });
    let settled = false;
    const read = instance.snapshot({ now: NOW }).then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetches()).toBe(1);
    expect(settled).toBe(false);
    initial.resolve(sampleOwnerSnapshot());
    expect((await read).ownerGeneration).toBe("generation-1");
  });

  test("a snapshot fetch failure with no cache fails closed as internal", async () => {
    const { instance } = open({
      fetch: async () => {
        throw new Error("network");
      },
    });
    expect(await instance.admit(chat("n1"))).toMatchObject({
      ok: false,
      code: "internal",
      retryable: true,
    });
  });

  test("the cached snapshot survives an isolate restart", async () => {
    const values = new Map<string, unknown>();
    const first = open({ values });
    expect((await first.instance.admit(chat("r1", NOW))).ok).toBe(true);
    const restarted = open({
      values,
      fetch: async () => {
        throw new Error("must serve the cache");
      },
    });
    const snapshot = await restarted.instance.snapshot({ now: NOW + 1_000 });
    expect(snapshot.ownerGeneration).toBe("generation-1");
    expect(restarted.fetches()).toBe(0);
  });
});

describe("owner snapshot parsing", () => {
  test("accepts a well-formed snapshot for the addressed owner only", () => {
    expect(parseOwnerSnapshot(sampleOwnerSnapshot(), "owner-1")).toMatchObject({
      ownerId: "owner-1",
      quotas: { chat: { burstStarts: 20 } },
    });
    expect(parseOwnerSnapshot(sampleOwnerSnapshot(), "owner-2")).toBeNull();
  });

  test("rejects malformed quotas, allowances, executions, and engines", () => {
    const base = sampleOwnerSnapshot();
    for (const broken of [
      { ...base, v: 2 },
      { ...base, ownerGeneration: "" },
      { ...base, writable: "yes" },
      { ...base, isAnonymous: "yes" },
      { ...base, enforcement: { status: "blocked" } },
      { ...base, enforcement: { status: "suspended", until: "later" } },
      { ...base, plan: "enterprise" },
      { ...base, quotas: { chat: base.quotas.chat } },
      {
        ...base,
        quotas: {
          ...base.quotas,
          chat: { ...base.quotas.chat, concurrent: -1 },
        },
      },
      { ...base, allowance: { ...base.allowance, audience: "vip" } },
      { ...base, allowance: { ...base.allowance, budgetMicroCents: NaN } },
      { ...base, execution: { ...base.execution, provider: "anthropic" } },
      { ...base, execution: { ...base.execution, model: "" } },
      { ...base, connectedEngines: ["gemini"] },
      { ...base, ttlMs: 0 },
    ]) {
      expect(parseOwnerSnapshot(broken, "owner-1")).toBeNull();
    }
  });

  test("execution availability follows the connected engines list", () => {
    expect(snapshotAllowsExecutionEngine({}, "stella")).toBe(true);
    expect(snapshotAllowsExecutionEngine({}, "anthropic")).toBe(false);
    expect(
      snapshotAllowsExecutionEngine(
        { connectedEngines: ["anthropic"] },
        "anthropic",
      ),
    ).toBe(true);
    expect(
      snapshotAllowsExecutionEngine(
        { connectedEngines: ["anthropic"] },
        "openai-codex",
      ),
    ).toBe(false);
  });
});
