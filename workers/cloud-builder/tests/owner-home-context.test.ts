import { describe, expect, test } from "bun:test";
import {
  OwnerHomeContextCache,
  type OwnerHomeContext,
} from "../src/owner-home-context.js";

const initial = (): Omit<OwnerHomeContext, "revision"> => ({
  memory: {
    preference: {
      ownerGeneration: "gen-1",
      memoryEpoch: "epoch-1",
      memoryEnabled: true,
      revision: 0,
      updatedAt: 1,
    },
    documentHeads: [],
    personalityHead: null,
  },
  skills: {
    ownerGeneration: "gen-1",
    agentType: "orchestrator",
    loadedAt: 1,
    entries: [],
  },
});
function setup() {
  const values = new Map<string, unknown>();
  const storage = {
    transaction: async <T>(fn: (txn: DurableObjectStorage) => Promise<T>) =>
      await fn(storage),
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
  } as unknown as DurableObjectStorage;
  let reads = 0;
  let data = initial();
  const args = {
    ownerGeneration: "gen-1",
    assertPolicy: async (policy: OwnerHomeContext["memory"]["preference"]) => {
      if (
        policy.memoryEpoch !== data.memory.preference.memoryEpoch ||
        policy.revision !== data.memory.preference.revision
      )
        throw new Error("policy changed");
    },
    fetch: async () => {
      reads++;
      return structuredClone(data);
    },
  };
  return {
    cache: () => new OwnerHomeContextCache(storage),
    args,
    reads: () => reads,
    update: (next: typeof data) => {
      data = next;
    },
  };
}
describe("owner context metadata", () => {
  test("unchanged turns and an object restart reuse the durable snapshot", async () => {
    const f = setup();
    const c = f.cache();
    await c.load(f.args);
    await c.load(f.args);
    await f.cache().load(f.args);
    expect(f.reads()).toBe(1);
  });
  test("duplicates and older notifications cannot replace a newer revision", async () => {
    const f = setup();
    const c = f.cache();
    await c.load(f.args);
    await c.changed("gen-1", 3);
    await c.changed("gen-1", 2);
    expect((await c.load(f.args)).revision).toBe(3);
    await c.changed("gen-1", 3);
    await f.cache().load(f.args);
    expect(f.reads()).toBe(2);
  });
  test("policy and wipe changes reject cached memory even before a content callback arrives", async () => {
    const f = setup();
    const c = f.cache();
    await c.load(f.args);
    const next = initial();
    next.memory.preference = {
      ...next.memory.preference,
      memoryEnabled: false,
      revision: 1,
      memoryEpoch: "epoch-2",
    };
    f.update(next);
    expect((await c.load(f.args)).memory.preference).toMatchObject({
      memoryEnabled: false,
      memoryEpoch: "epoch-2",
    });
    expect(f.reads()).toBe(2);
  });
  test("a notification racing a load forces another authoritative read", async () => {
    const f = setup();
    const c = f.cache();
    let first = true;
    const result = await c.load({
      ...f.args,
      fetch: async () => {
        const data = await f.args.fetch();
        if (first) {
          first = false;
          await c.changed("gen-1", 1);
        }
        return data;
      },
    });
    expect(result.revision).toBe(1);
    expect(f.reads()).toBe(2);
  });
  test("a failed refresh fails closed and remains retryable after restart", async () => {
    const f = setup();
    const c = f.cache();
    await c.load(f.args);
    await c.changed("gen-1", 1);
    await expect(
      c.load({
        ...f.args,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect((await f.cache().load(f.args)).revision).toBe(1);
  });
});
