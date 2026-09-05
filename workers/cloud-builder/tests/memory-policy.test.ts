import { describe, expect, test } from "bun:test";
import { OwnerMemoryPolicy } from "../src/memory-policy.js";
import type {
  MemoryPolicy,
  MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";

const initial: MemoryPolicy = {
  ownerGeneration: "owner-generation",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 0,
  updatedAt: 1,
};
const change: MemoryPolicyChange = {
  kind: "preference",
  ownerId: "owner-1",
  expectedOwnerGeneration: initial.ownerGeneration,
  requestId: "change-1",
  expectedRevision: 0,
  memoryEnabled: false,
};

const fixture = () => {
  const values = new Map<string, unknown>([
    ["ownerPurgeFence", { state: "open", generation: "fence-1" }],
  ]);
  let alarm: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) =>
          values.set(key, structuredClone(value)),
        delete: (key: string) => values.delete(key),
      },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    },
    blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
      const result = tail.then(work);
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as DurableObjectState;
  let policy = { ...initial };
  let reads = 0;
  let apply = async (input: MemoryPolicyChange) => {
    if (input.kind === "preference")
      policy = { ...policy, memoryEnabled: input.memoryEnabled, revision: 1 };
  };
  const transport = {
    read: async () => {
      reads++;
      return structuredClone(policy);
    },
    apply: (input: MemoryPolicyChange) => apply(input),
  };
  return {
    values,
    coordinator: () => new OwnerMemoryPolicy(ctx, "owner-1", transport),
    reads: () => reads,
    policy: () => policy,
    setPolicy: (next: MemoryPolicy) => {
      policy = next;
    },
    setApply: (next: typeof apply) => {
      apply = next;
    },
    alarm: () => alarm,
  };
};

describe("owner memory policy", () => {
  test("loads once per fence generation and preserves the cache through restart", async () => {
    const f = fixture();
    await f.coordinator().assert(initial, "fence-1");
    await f.coordinator().assert(initial, "fence-1");
    expect(f.reads()).toBe(1);
    f.values.set("ownerPurgeFence", { state: "open", generation: "fence-2" });
    await expect(f.coordinator().assert(initial, "fence-1")).rejects.toThrow(
      "OWNER_FENCE_CHANGED",
    );
    await f.coordinator().assert(initial, "fence-2");
    expect(f.reads()).toBe(2);
  });

  test("acknowledges a setting only after committing and replacing permission state", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setApply(async () => {
      started.resolve();
      await release.promise;
      f.setPolicy({ ...initial, revision: 1, memoryEnabled: false });
    });
    await f.coordinator().assert(initial, "fence-1");
    let acknowledged = false;
    const pending = f
      .coordinator()
      .change(change)
      .then(() => {
        acknowledged = true;
      });
    await started.promise;
    expect(acknowledged).toBe(false);
    expect(f.alarm()).not.toBeNull();
    release.resolve();
    await pending;
    await expect(f.coordinator().assert(initial, "fence-1")).rejects.toThrow(
      "MEMORY_POLICY_CHANGED",
    );
    await f.coordinator().assert(f.policy(), "fence-1");
    expect(f.reads()).toBe(2);
  });

  test("a lost commit response stays closed and retries the exact request after restart", async () => {
    const f = fixture();
    const operations: MemoryPolicyChange[] = [];
    f.setApply(async (input) => {
      operations.push(input);
      f.setPolicy({ ...initial, memoryEnabled: false, revision: 1 });
      if (operations.length === 1)
        throw new Error("Lost response after commit");
    });
    await expect(f.coordinator().change(change)).rejects.toThrow(
      "Lost response",
    );
    await expect(f.coordinator().assert(initial, "fence-1")).rejects.toThrow(
      "MEMORY_POLICY_CHANGING",
    );
    await expect(
      f.coordinator().change({ ...change, requestId: "different" }),
    ).rejects.toThrow("BUSY");
    await f.coordinator().retry();
    expect(operations).toEqual([change, change]);
    await f.coordinator().assert(f.policy(), "fence-1");
  });

  test("wipe blocks memory until the completed epoch replaces the old epoch", async () => {
    const f = fixture();
    const wipe: MemoryPolicyChange = {
      kind: "wipe",
      ownerId: "owner-1",
      expectedOwnerGeneration: initial.ownerGeneration,
      expectedMemoryEpoch: initial.memoryEpoch,
      requestId: "wipe-1",
    };
    await f.coordinator().change(wipe);
    await expect(f.coordinator().assert(initial, "fence-1")).rejects.toThrow(
      "CHANGING",
    );
    await expect(f.coordinator().retry()).rejects.toThrow("WIPE_PENDING");
    f.setPolicy({ ...initial, memoryEpoch: "epoch-2" });
    await f.coordinator().retry();
    await expect(f.coordinator().assert(initial, "fence-1")).rejects.toThrow(
      "CHANGED",
    );
    await f.coordinator().assert(f.policy(), "fence-1");
  });
});
