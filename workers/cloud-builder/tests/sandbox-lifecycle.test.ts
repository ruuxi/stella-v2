import { describe, expect, test } from "bun:test";
import {
  SANDBOX_DESTROY_RETRY_MAX_MS,
  advanceSandboxDestroyDebt,
  clearSandboxDestroyDebt,
  createSandboxDestroyDebt,
  isSandboxDestroyDue,
  isSandboxDestroyDebtKey,
  listSandboxDestroyDebts,
  parseSandboxDestroyDebt,
  parseSandboxDestroyDebtEntries,
  persistSandboxDestroyDebt,
  readSandboxDestroyDebt,
  reconcileSandboxInventory,
  sandboxLifecycleFailureFields,
  sandboxLifecycleId,
  sandboxDestroyDebtKey,
  sandboxDestroyRetryDelayMs,
  summarizeSandboxInventory,
  type SandboxLifecycleStorage,
  type SandboxTarget,
} from "../src/sandbox-lifecycle.js";

const TARGET: SandboxTarget = {
  sandboxId: "agent:turn/one ✓",
  size: "small",
  workload: "resident-attachment",
};

class MemoryStorage implements SandboxLifecycleStorage {
  readonly values = new Map<string, unknown>();
  readonly calls: string[] = [];
  alarm: number | undefined;
  failTransactionAlarm = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.calls.push(`put:${key}`);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.calls.push(`delete:${key}`);
    return this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    this.calls.push("getAlarm");
    return this.alarm ?? null;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.calls.push(`alarm:${scheduledTime}`);
    this.alarm = scheduledTime;
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()].filter(([key]) =>
        key.startsWith(options.prefix),
      ),
    ) as Map<string, T>;
  }

  async transaction<T>(
    closure: (transaction: {
      put<V>(key: string, value: V): Promise<void>;
      getAlarm(): Promise<number | null>;
      setAlarm(scheduledTime: number): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const staged = new Map(this.values);
    let stagedAlarm = this.alarm;
    const result = await closure({
      put: async <V>(key: string, value: V) => {
        this.calls.push(`put:${key}`);
        staged.set(key, value);
      },
      getAlarm: async () => {
        this.calls.push("getAlarm");
        return stagedAlarm ?? null;
      },
      setAlarm: async (scheduledTime: number) => {
        this.calls.push(`alarm:${scheduledTime}`);
        if (this.failTransactionAlarm) throw new Error("alarm fault");
        stagedAlarm = scheduledTime;
      },
    });
    this.values.clear();
    for (const [key, value] of staged) this.values.set(key, value);
    this.alarm = stagedAlarm;
    return result;
  }
}

describe("sandbox destroy debt", () => {
  test("keys and parses the exact sandbox, size, and workload tuple", () => {
    const created = createSandboxDestroyDebt(TARGET, 10_000);

    expect(parseSandboxDestroyDebt(created)).toEqual(created);
    expect(sandboxDestroyDebtKey(TARGET)).not.toBe(
      sandboxDestroyDebtKey({ ...TARGET, size: "large" }),
    );
    expect(sandboxDestroyDebtKey(TARGET)).not.toBe(
      sandboxDestroyDebtKey({ ...TARGET, workload: "agent" }),
    );
    expect(sandboxDestroyDebtKey(TARGET)).not.toBe(
      sandboxDestroyDebtKey({ ...TARGET, sandboxId: `${TARGET.sandboxId}:2` }),
    );
  });

  test("rejects malformed records instead of guessing lifecycle identity", () => {
    const valid = createSandboxDestroyDebt(TARGET, 10_000);
    const malformed = [
      null,
      { ...valid, schemaVersion: 2 },
      { ...valid, kind: "destroyed" },
      { ...valid, target: { ...TARGET, sandboxId: "" } },
      { ...valid, target: { ...TARGET, size: "standard-4" } },
      { ...valid, target: { ...TARGET, workload: "preview" } },
      { ...valid, attemptCount: -1 },
      { ...valid, nextAttemptAt: 9_999 },
      { ...valid, lastAttemptAt: 11_000, nextAttemptAt: 10_500 },
    ];

    for (const value of malformed) {
      expect(parseSandboxDestroyDebt(value)).toBeNull();
    }
  });

  test("retries indefinitely with bounded exponential delay", () => {
    expect([0, 1, 2, 3, 4].map(sandboxDestroyRetryDelayMs)).toEqual([
      0, 1_000, 2_000, 4_000, 8_000,
    ]);
    expect(sandboxDestroyRetryDelayMs(1_000_000)).toBe(
      SANDBOX_DESTROY_RETRY_MAX_MS,
    );

    let debt = createSandboxDestroyDebt(TARGET, 10_000);
    for (let attempt = 0; attempt < 256; attempt += 1) {
      debt = advanceSandboxDestroyDebt(debt, 10_000 + attempt);
    }
    expect(debt.attemptCount).toBe(256);
    expect(debt.nextAttemptAt - debt.lastAttemptAt!).toBe(
      SANDBOX_DESTROY_RETRY_MAX_MS,
    );
    expect(isSandboxDestroyDue(debt, debt.nextAttemptAt - 1)).toBe(false);
    expect(isSandboxDestroyDue(debt, debt.nextAttemptAt)).toBe(true);
  });

  test("persists the tombstone before arming its alarm and reads it exactly", async () => {
    const storage = new MemoryStorage();
    const debt = advanceSandboxDestroyDebt(
      createSandboxDestroyDebt(TARGET, 10_000),
      12_000,
    );

    await persistSandboxDestroyDebt(storage, debt);

    expect(storage.calls).toEqual([
      `put:${sandboxDestroyDebtKey(TARGET)}`,
      "getAlarm",
      `alarm:${debt.nextAttemptAt}`,
    ]);
    expect(storage.alarm).toBe(debt.nextAttemptAt);
    expect(await readSandboxDestroyDebt(storage, TARGET)).toEqual(debt);
    expect(
      await readSandboxDestroyDebt(storage, { ...TARGET, size: "large" }),
    ).toBeNull();
    expect(await clearSandboxDestroyDebt(storage, debt)).toBe(true);
    expect(await readSandboxDestroyDebt(storage, TARGET)).toBeNull();
  });

  test("never postpones an earlier watchdog or terminal alarm", async () => {
    const storage = new MemoryStorage();
    storage.alarm = 10_500;
    const debt = advanceSandboxDestroyDebt(
      createSandboxDestroyDebt(TARGET, 10_000),
      12_000,
    );

    await persistSandboxDestroyDebt(storage, debt);

    expect(debt.nextAttemptAt).toBe(13_000);
    expect(storage.alarm).toBe(10_500);
    expect(storage.calls.at(-1)).toBe("alarm:10500");
  });

  test("rolls back the tombstone if alarm scheduling faults in the transaction", async () => {
    const storage = new MemoryStorage();
    storage.failTransactionAlarm = true;
    const debt = createSandboxDestroyDebt(TARGET, 10_000);

    await expect(persistSandboxDestroyDebt(storage, debt)).rejects.toThrow(
      "alarm fault",
    );
    expect(await readSandboxDestroyDebt(storage, TARGET)).toBeNull();
    expect(storage.alarm).toBeUndefined();
  });

  test("lists only self-consistent debt rows under the exported prefix", async () => {
    const storage = new MemoryStorage();
    const debt = createSandboxDestroyDebt(TARGET, 10_000);
    const other = createSandboxDestroyDebt(
      { sandboxId: "build-2", size: "large", workload: "app-build" },
      11_000,
    );
    storage.values.set(sandboxDestroyDebtKey(TARGET), debt);
    storage.values.set(sandboxDestroyDebtKey(other.target), other);
    storage.values.set(
      sandboxDestroyDebtKey({ ...TARGET, size: "large" }),
      debt,
    );
    storage.values.set("unrelated", debt);
    storage.values.set(`${sandboxDestroyDebtKey(TARGET)}:malformed`, {
      nope: true,
    });

    expect(isSandboxDestroyDebtKey(sandboxDestroyDebtKey(TARGET))).toBe(true);
    expect(isSandboxDestroyDebtKey("unrelated")).toBe(false);
    expect(parseSandboxDestroyDebtEntries(storage.values.entries())).toEqual([
      debt,
      other,
    ]);
    expect(await listSandboxDestroyDebts(storage)).toEqual([debt, other]);
  });
});

describe("sandbox lifecycle identity and safe diagnostics", () => {
  const exact = {
    ownerId: "owner-a",
    ownerGeneration: "generation-1",
    turnId: "reused-turn",
    turnToken: "opaque-turn-token-a",
    attemptGeneration: 1,
  };

  test("is stable for exact replay and distinct across ABA successors", async () => {
    const current = await sandboxLifecycleId("agent", exact);
    expect(await sandboxLifecycleId("agent", exact)).toBe(current);
    expect(
      await sandboxLifecycleId("agent", {
        ...exact,
        attemptGeneration: 2,
      }),
    ).not.toBe(current);
    expect(
      await sandboxLifecycleId("agent", {
        ...exact,
        ownerGeneration: "generation-2",
      }),
    ).not.toBe(current);
    expect(
      await sandboxLifecycleId("agent", {
        ...exact,
        turnToken: "opaque-turn-token-b",
      }),
    ).not.toBe(current);
    expect(current).toMatch(/^agent-[a-f0-9]{40}$/);
  });

  test("serializes only an allowlisted code and bounded byte count", () => {
    const sensitive =
      "https://provider.invalid/private?token=secret <html>provider failure</html>";
    const captured = JSON.stringify({
      event: "sandbox_destroy_deferred",
      ...sandboxLifecycleFailureFields(new Error(sensitive)),
    });
    expect(captured).not.toContain("provider.invalid");
    expect(captured).not.toContain("secret");
    expect(captured).not.toContain("html");
    expect(JSON.parse(captured)).toEqual({
      event: "sandbox_destroy_deferred",
      failureCode: "sandbox_rpc_failed",
      detailBytes: new TextEncoder().encode(`Error:${sensitive}`).byteLength,
      detailBytesCapped: false,
    });
  });
});

describe("sandbox inventory reconciliation", () => {
  const appBuild: SandboxTarget = {
    sandboxId: "build-one",
    size: "large",
    workload: "app-build",
  };
  const agent: SandboxTarget = {
    sandboxId: "agent-one",
    size: "small",
    workload: "agent",
  };
  const retiring: SandboxTarget = {
    sandboxId: "resident-old",
    size: "small",
    workload: "resident-attachment",
  };

  test("classifies owned, live, orphan, missing, and retiring snapshots", () => {
    const orphan: SandboxTarget = {
      sandboxId: "acceptance-leak",
      size: "large",
      workload: "agent",
    };
    const durable = [
      { target: appBuild, lifecycle: "owned" as const },
      { target: agent, lifecycle: "owned" as const },
      { target: retiring, lifecycle: "retiring" as const },
    ];
    const inventory = [appBuild, retiring, orphan];
    const durableBefore = structuredClone(durable);
    const inventoryBefore = structuredClone(inventory);

    const result = reconcileSandboxInventory(durable, inventory);

    expect(result).toEqual({
      owned: [appBuild, agent],
      live: [appBuild],
      orphan: [orphan],
      missing: [agent],
      retiring: [retiring],
    });
    expect(durable).toEqual(durableBefore);
    expect(inventory).toEqual(inventoryBefore);
    expect(summarizeSandboxInventory(result)).toEqual({
      owned: 2,
      live: 1,
      orphan: 1,
      missing: 1,
      retiring: 1,
    });
  });

  test("never treats a matching id with a different size or workload as owned", () => {
    const result = reconcileSandboxInventory(
      [{ target: appBuild, lifecycle: "owned" }],
      [
        { ...appBuild, size: "small" },
        { ...appBuild, workload: "agent" },
      ],
    );

    expect(result.live).toEqual([]);
    expect(result.missing).toEqual([appBuild]);
    expect(result.orphan).toEqual([
      { ...appBuild, size: "small" },
      { ...appBuild, workload: "agent" },
    ]);
  });

  test("count telemetry contains no ids or owner fields", () => {
    const summary = summarizeSandboxInventory(
      reconcileSandboxInventory(
        [{ target: agent, lifecycle: "owned" }],
        [agent],
      ),
    );

    expect(JSON.stringify(summary)).not.toContain(agent.sandboxId);
    expect(Object.keys(summary).sort()).toEqual([
      "live",
      "missing",
      "orphan",
      "owned",
      "retiring",
    ]);
  });
});
