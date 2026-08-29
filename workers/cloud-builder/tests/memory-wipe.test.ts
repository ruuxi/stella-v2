import { describe, expect, test } from "bun:test";
import {
  MEMORY_WIPE_PROTOCOL_VERSION,
  MEMORY_WIPE_TARGET_COUNT,
  memoryWipeTargets,
  sweepMemoryWipePage,
} from "../src/memory-wipe.js";
import {
  CloudHomeStore,
  type CloudSkillCatalogEntry,
} from "../src/cloud-home-store.js";
import { materializeCloudSkillSnapshot } from "../src/cloud-skill-materializer.js";
import { createCloudSkillTools } from "../src/cloud-skill-tools.js";
import { sha256BytesHex, sha256Hex } from "../src/hash.js";

const fakeBucket = (
  initial: string[] | ReadonlyMap<string, Uint8Array>,
  failDeleteOnce = false,
) => {
  const bytes =
    initial instanceof Map
      ? new Map(initial)
      : new Map(initial.map((key) => [key, new Uint8Array([1])] as const));
  const keys = new Set(bytes.keys());
  let maxListLimit = 0;
  let shouldFail = failDeleteOnce;
  const object = (key: string) => ({
    key,
    size: bytes.get(key)?.byteLength ?? 0,
  });
  const bucket = {
    async head(key: string) {
      return keys.has(key) ? object(key) : null;
    },
    async get(key: string) {
      const value = bytes.get(key);
      if (!value) return null;
      return {
        ...object(key),
        async arrayBuffer() {
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          return copy.buffer;
        },
      };
    },
    async list(options: {
      prefix?: string;
      limit?: number;
      startAfter?: string;
    }) {
      maxListLimit = Math.max(maxListLimit, options.limit ?? 1_000);
      const matches = [...keys]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .sort()
        .filter(
          (key) => options.startAfter === undefined || key > options.startAfter,
        );
      const limit = options.limit ?? 1_000;
      const objects = matches.slice(0, limit).map(object);
      return {
        objects,
        truncated: matches.length > limit,
        delimitedPrefixes: [],
      };
    },
    async delete(input: string | string[]) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("R2_DELETE_FAILED");
      }
      for (const key of Array.isArray(input) ? input : [input]) {
        keys.delete(key);
        bytes.delete(key);
      }
    },
  } as unknown as R2Bucket;
  return { bucket, bytes, keys, maxListLimit: () => maxListLimit };
};

describe("memory-only R2 wipe", () => {
  test("sweeps exact memory namespaces while preserving Skills and other owners", async () => {
    const ownerId = "memory-wipe-owner";
    const ownerGeneration = "memory-wipe-generation";
    const [ownerHash, generationHash] = await Promise.all([
      sha256Hex(ownerId),
      sha256Hex(ownerGeneration),
    ]);
    const [sourceHash, sourceGenerationHash] = await Promise.all([
      sha256Hex("anonymous-memory-source"),
      sha256Hex("anonymous-memory-generation"),
    ]);
    const root = `agent-home/${ownerHash}/`;
    const generationRoot = `${root}generations/${generationHash}/`;
    const importedGenerationRoot =
      `${root}__stella_imported__/${sourceHash}/generations/` +
      `${sourceGenerationHash}/`;
    const memoryKeys = [
      `${generationRoot}memory-versions/doc/version/body.md`,
      `${generationRoot}dream-inbox/inbox/1.json`,
      `${generationRoot}memories/profile.md`,
      `${generationRoot}PERSONALITY.md`,
      `${generationRoot}core-memory.md`,
      `${importedGenerationRoot}memory-versions/document/version/body.md`,
      `${importedGenerationRoot}dream-inbox/inbox/1.json`,
      `${importedGenerationRoot}memories/MEMORY.md`,
      `${importedGenerationRoot}PERSONALITY.md`,
      `${root}__stella_imported__/${sourceHash}/memories/profile.md`,
      `${root}memories/MEMORY.md`,
      `${root}PERSONALITY.md`,
      `${root}core-memory.md`,
    ];
    const preserved = [
      `${generationRoot}skills/skill-1/version-1/manifest.json`,
      `${generationRoot}skills/skill-1/version-1/files/SKILL.md`,
      `${importedGenerationRoot}skills/skill-2/version-1/manifest.json`,
      `${importedGenerationRoot}skills/skill-2/version-1/files/SKILL.md`,
      `${importedGenerationRoot}skills/skill-2/version-1/files/memories/MEMORY.md`,
      `${root}__stella_imported__/${sourceHash}/unknown.bin`,
      `agent-home/${await sha256Hex("another-owner")}/memories/MEMORY.md`,
    ];
    const state = fakeBucket([...memoryKeys, ...preserved]);
    let cursor = 0;
    let complete = false;
    let calls = 0;
    while (!complete) {
      const page = await sweepMemoryWipePage(state.bucket, {
        ownerId,
        ownerGeneration,
        cursor,
      });
      cursor = page.cursor;
      complete = page.complete;
      calls += 1;
      expect(calls).toBeLessThan(20);
    }
    expect(cursor).toBe(MEMORY_WIPE_TARGET_COUNT);
    expect(memoryKeys.some((key) => state.keys.has(key))).toBe(false);
    expect(preserved.every((key) => state.keys.has(key))).toBe(true);
  });

  test("keeps a migrated Skill discoverable, readable, and materializable after a zero-residue Memory wipe", async () => {
    const ownerId = "connected-owner";
    const ownerGeneration = "connected-generation";
    const [ownerHash, sourceOwnerHash, sourceGenerationHash] =
      await Promise.all([
        sha256Hex(ownerId),
        sha256Hex("anonymous-owner"),
        sha256Hex("anonymous-generation"),
      ]);
    // This is the exact destination locator shape produced by the anonymous
    // to connected owner migration: only the owner prefix is rewritten.
    const importedGenerationRoot =
      `agent-home/${ownerHash}/__stella_imported__/${sourceOwnerHash}/` +
      `generations/${sourceGenerationHash}/`;
    const skillRoot = `${importedGenerationRoot}skills/skill-calendar/version-1/`;
    const skillBytes = new TextEncoder().encode(
      "---\nname: Calendar\ndescription: Plan a week\n---\nUse the calendar.list tool.",
    );
    const referenceBytes = new TextEncoder().encode(
      "Never mistake this Skill asset for an imported Memory document.",
    );
    const manifestBytes = new TextEncoder().encode(
      '{"name":"Calendar","version":1}',
    );
    const memoryKeys = [
      `${importedGenerationRoot}memory-versions/doc-1/version-1/body.md`,
      `${importedGenerationRoot}memories/MEMORY.md`,
      `${importedGenerationRoot}dream-inbox/inbox-1.json`,
      `${importedGenerationRoot}PERSONALITY.md`,
      `${importedGenerationRoot}core-memory.md`,
    ];
    const manifestKey = `${skillRoot}manifest.json`;
    const skillKey = `${skillRoot}files/SKILL.md`;
    const referenceKey = `${skillRoot}files/memories/MEMORY.md`;
    const skillKeys = [manifestKey, skillKey, referenceKey];
    const objects = new Map<string, Uint8Array>([
      ...memoryKeys.map(
        (key) => [key, new TextEncoder().encode(`private:${key}`)] as const,
      ),
      [manifestKey, manifestBytes],
      [skillKey, skillBytes],
      [referenceKey, referenceBytes],
    ]);
    const state = fakeBucket(objects);

    let cursor = 0;
    let startAfter: string | undefined;
    for (
      let pass = 0;
      pass < 20 && cursor < MEMORY_WIPE_TARGET_COUNT;
      pass += 1
    ) {
      const page = await sweepMemoryWipePage(state.bucket, {
        ownerId,
        ownerGeneration,
        cursor,
        startAfter,
      });
      cursor = page.cursor;
      startAfter = page.startAfter;
    }
    expect(cursor).toBe(MEMORY_WIPE_TARGET_COUNT);
    expect(startAfter).toBeUndefined();
    expect([...state.keys].sort()).toEqual([...skillKeys].sort());
    expect(memoryKeys.some((key) => state.keys.has(key))).toBe(false);

    const files = [
      {
        path: "SKILL.md",
        r2Key: skillKey,
        sha256: await sha256BytesHex(skillBytes),
        sizeBytes: skillBytes.byteLength,
        contentType: "text/markdown; charset=utf-8",
      },
      {
        path: "memories/MEMORY.md",
        r2Key: referenceKey,
        sha256: await sha256BytesHex(referenceBytes),
        sizeBytes: referenceBytes.byteLength,
        contentType: "text/markdown; charset=utf-8",
      },
    ];
    const catalogEntry: CloudSkillCatalogEntry = {
      skillId: "skill-calendar",
      slug: "calendar-imported",
      name: "Calendar",
      description: "Plan a week with the imported calendar workflow",
      source: "owner_migration",
      availability: "both",
      revision: 1,
      versionId: "version-1",
      manifestSha256: await sha256BytesHex(manifestBytes),
      treeSha256: "f".repeat(64),
      fileCount: files.length,
      totalSizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      files,
      updatedAt: 1,
    };
    const home = new CloudHomeStore(state.bucket, {
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      fetch: async () => Response.json([catalogEntry]),
    });
    const snapshot = await home.loadSkillCatalog("general");
    expect(home.searchSkills(snapshot, "calendar")).toHaveLength(1);

    const tools = createCloudSkillTools(home, snapshot);
    const searchReceipt = await tools
      .find((tool) => tool.name === "skill_search")!
      .execute("search-call", { query: "calendar" });
    expect(JSON.stringify(searchReceipt)).toContain("version-1");
    const readReceipt = await tools
      .find((tool) => tool.name === "skill_read")!
      .execute("read-call", { skill_id: "skill-calendar" });
    expect(JSON.stringify(readReceipt)).toContain("calendar.list");

    const writes = new Map<string, Uint8Array>();
    const materialized = await materializeCloudSkillSnapshot({
      home,
      snapshot,
      session: {
        async mkdir() {},
        async writeFile(path, content, options) {
          expect(options).toEqual({ encoding: "base64" });
          writes.set(
            path,
            Uint8Array.from(atob(content), (character) =>
              character.charCodeAt(0),
            ),
          );
          return { success: true };
        },
      },
      assertActive: () => undefined,
    });
    const materializedRoot = materialized.entries[0]!.root;
    expect(writes.get(`${materializedRoot}/SKILL.md`)).toEqual(skillBytes);
    expect(writes.get(`${materializedRoot}/memories/MEMORY.md`)).toEqual(
      referenceBytes,
    );
    expect([...state.keys].sort()).toEqual([...skillKeys].sort());
  });

  test("deletes one bounded page and resumes the same prefix after restart", async () => {
    const ownerId = "bounded-owner";
    const ownerGeneration = "bounded-generation";
    const firstTarget = (await memoryWipeTargets(ownerId, ownerGeneration))[0]!;
    if (firstTarget.kind !== "prefix")
      throw new Error("prefix fixture changed");
    const keys = Array.from(
      { length: 251 },
      (_, index) =>
        `${firstTarget.value}${index.toString().padStart(3, "0")}.md`,
    );
    const state = fakeBucket(keys);
    const first = await sweepMemoryWipePage(state.bucket, {
      ownerId,
      ownerGeneration,
      cursor: 0,
    });
    expect(first).toEqual({
      protocolVersion: MEMORY_WIPE_PROTOCOL_VERSION,
      targetCount: MEMORY_WIPE_TARGET_COUNT,
      complete: false,
      cursor: 0,
      deleted: 250,
    });
    expect(state.keys.size).toBe(1);
    const resumed = await sweepMemoryWipePage(state.bucket, {
      ownerId,
      ownerGeneration,
      cursor: first.cursor,
    });
    expect(resumed).toEqual({
      protocolVersion: MEMORY_WIPE_PROTOCOL_VERSION,
      targetCount: MEMORY_WIPE_TARGET_COUNT,
      complete: false,
      cursor: 1,
      deleted: 1,
    });
    expect(state.keys.size).toBe(0);
    expect(state.maxListLimit()).toBe(250);
  });

  test("does not advance or report success when R2 deletion fails", async () => {
    const ownerId = "failure-owner";
    const ownerGeneration = "failure-generation";
    const firstTarget = (await memoryWipeTargets(ownerId, ownerGeneration))[0]!;
    if (firstTarget.kind !== "prefix")
      throw new Error("prefix fixture changed");
    const key = `${firstTarget.value}body.md`;
    const state = fakeBucket([key], true);
    await expect(
      sweepMemoryWipePage(state.bucket, {
        ownerId,
        ownerGeneration,
        cursor: 0,
      }),
    ).rejects.toThrow("R2_DELETE_FAILED");
    expect(state.keys.has(key)).toBe(true);
    const retried = await sweepMemoryWipePage(state.bucket, {
      ownerId,
      ownerGeneration,
      cursor: 0,
    });
    expect(retried).toEqual({
      protocolVersion: MEMORY_WIPE_PROTOCOL_VERSION,
      targetCount: MEMORY_WIPE_TARGET_COUNT,
      complete: false,
      cursor: 1,
      deleted: 1,
    });
    expect(state.keys.has(key)).toBe(false);
  });

  test("paginates past retained imported Skills and reaches later imported Memory", async () => {
    const ownerId = "imported-pagination-owner";
    const ownerGeneration = "imported-pagination-generation";
    const ownerHash = await sha256Hex(ownerId);
    const root = `agent-home/${ownerHash}/`;
    const importedTargetIndex = (
      await memoryWipeTargets(ownerId, ownerGeneration)
    ).findIndex((target) => target.kind === "filtered-prefix");
    expect(importedTargetIndex).toBeGreaterThanOrEqual(0);
    const earlierSource = "0".repeat(64);
    const laterSource = "f".repeat(64);
    const sourceGeneration = "a".repeat(64);
    const retainedSkills = Array.from(
      { length: 260 },
      (_, index) =>
        `${root}__stella_imported__/${earlierSource}/generations/` +
        `${sourceGeneration}/skills/skill-${index.toString().padStart(3, "0")}/` +
        "version/files/memories/MEMORY.md",
    );
    const laterMemory =
      `${root}__stella_imported__/${laterSource}/generations/` +
      `${sourceGeneration}/memories/MEMORY.md`;
    const state = fakeBucket([...retainedSkills, laterMemory]);

    const first = await sweepMemoryWipePage(state.bucket, {
      ownerId,
      ownerGeneration,
      cursor: importedTargetIndex,
    });
    expect(first).toMatchObject({
      complete: false,
      cursor: importedTargetIndex,
      deleted: 0,
    });
    expect(first.startAfter).toBe(retainedSkills[249]);
    expect(state.keys.has(laterMemory)).toBe(true);

    const resumed = await sweepMemoryWipePage(state.bucket, {
      ownerId,
      ownerGeneration,
      cursor: first.cursor,
      startAfter: first.startAfter,
    });
    expect(resumed).toMatchObject({
      complete: false,
      cursor: importedTargetIndex + 1,
      deleted: 1,
    });
    expect(resumed.startAfter).toBeUndefined();
    expect(state.keys.has(laterMemory)).toBe(false);
    expect(retainedSkills.every((key) => state.keys.has(key))).toBe(true);
    expect(state.maxListLimit()).toBe(250);
  });
});
