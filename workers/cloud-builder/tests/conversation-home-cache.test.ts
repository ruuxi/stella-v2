import { describe, expect, test } from "bun:test";
import { ConversationHomeCache, type ConversationHomeSnapshot, type PreparedHomeContent } from "../src/conversation-home-cache.js";
import type { OwnerHomeContext } from "../src/owner-home-context.js";

const metadata = (): OwnerHomeContext => ({
  revision: 1,
  memory: { preference: { ownerGeneration: "g1", memoryEpoch: "e1", memoryEnabled: true, revision: 1, updatedAt: 1 }, documentHeads: [], personalityHead: null },
  skills: { ownerGeneration: "g1", agentType: "orchestrator", loadedAt: 1, entries: [] },
});
function fixture() {
  let saved: ConversationHomeSnapshot | undefined;
  let purged = false;
  let reads = 0;
  const durable = { read: () => saved, write: (value: ConversationHomeSnapshot) => { saved = structuredClone(value); },
    clear: () => { saved = undefined; }, purged: () => purged };
  const args = { ownerId: "owner1", metadata: metadata(), readContent: async (): Promise<PreparedHomeContent> => {
    reads++;
    return { memoryPreference: args.metadata.memory.preference,
      memoryDocuments: args.metadata.memory.preference.memoryEnabled ? [{ name: "profile.md", displayPath: "profile.md", content: "favorite color amber" }] : [],
      personalityOverride: null, skillCatalog: args.metadata.skills };
  } };
  return { durable, args, saved: () => saved, reads: () => reads,
    purge: () => { purged = true; saved = undefined; } };
}
describe("conversation home content cache", () => {
  test("unchanged authoritative versions survive an isolate restart", async () => {
    const f = fixture(); const c = new ConversationHomeCache(f.durable);
    const first = await c.load(f.args);
    await c.load(f.args);
    expect(await new ConversationHomeCache(f.durable).load(f.args)).toEqual(first);
    expect(f.reads()).toBe(1);
  });
  test("changed policy, wipe epoch, generation and owner cannot reuse content", async () => {
    const f = fixture(); const c = new ConversationHomeCache(f.durable);
    await c.load(f.args);
    f.args.metadata.memory.preference.memoryEnabled = false;
    expect((await c.load(f.args)).memoryDocuments).toEqual([]);
    expect(f.saved()?.content.memoryDocuments).toEqual([]);
    f.args.metadata.memory.preference.memoryEpoch = "e2"; await c.load(f.args);
    f.args.metadata.memory.preference.ownerGeneration = "g2"; await c.load(f.args);
    f.args.ownerId = "owner2"; await c.load(f.args);
    expect(f.reads()).toBe(5);
  });
  test("changed document versions invalidate the copy and failed reads cannot restore old content", async () => {
    const f = fixture(); const c = new ConversationHomeCache(f.durable);
    await c.load(f.args);
    f.args.metadata.memory.personalityHead = { documentId: "personality", name: "personality.md", displayPath: "personality.md", kind: "personality", source: "test", ownerGeneration: "g1", memoryEpoch: "e1", revision: 2, r2Key: "g1/personality/2", sizeBytes: 1, updatedAt: 2 };
    await expect(c.load({ ...f.args, readContent: async () => { throw new Error("R2 unavailable"); } })).rejects.toThrow("R2 unavailable");
    expect(f.saved()).toBeUndefined();
    await c.load(f.args); expect(f.reads()).toBe(2);
  });
  test("a purge during a storage read cannot resurrect durable or resident content", async () => {
    const f = fixture(); const c = new ConversationHomeCache(f.durable);
    await expect(c.load({ ...f.args, readContent: async () => { const value = await f.args.readContent(); f.purge(); return value; } })).rejects.toThrow("purged");
    expect(f.saved()).toBeUndefined();
    await expect(c.load(f.args)).rejects.toThrow("purged");
  });
  test("oversized content remains usable without exceeding the KV value limit", async () => {
    const f = fixture(); const c = new ConversationHomeCache(f.durable);
    const args = { ...f.args, readContent: async () => ({ ...await f.args.readContent(), personalityOverride: "x".repeat(100_001) }) };
    expect((await c.load(args)).personalityOverride?.length).toBe(100_001);
    await c.load(args); expect(f.reads()).toBe(1); expect(f.saved()).toBeUndefined();
    await new ConversationHomeCache(f.durable).load(args); expect(f.reads()).toBe(2);
  });
});
