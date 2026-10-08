import { describe, expect, test } from "bun:test";
import {
  CloudHomeProtocolError,
  CloudHomeStore,
  utf8Bytes,
  utf8Text,
} from "../src/cloud-home-store.js";
import { sha256BytesHex, sha256Hex } from "../src/hash.js";

type Stored = {
  bytes: Uint8Array;
  customMetadata?: Record<string, string>;
  contentType?: string;
};

const fakeBucket = () => {
  const objects = new Map<string, Stored>();
  let puts = 0;
  let gets = 0;
  const object = (key: string, stored: Stored) => ({
    key,
    version: "1",
    size: stored.bytes.byteLength,
    etag: `etag-${key}`,
    httpEtag: `\"etag-${key}\"`,
    checksums: {},
    uploaded: new Date(0),
    customMetadata: stored.customMetadata,
    httpMetadata: stored.contentType
      ? { contentType: stored.contentType }
      : undefined,
    storageClass: "Standard",
  });
  const bucket = {
    async head(key: string) {
      const stored = objects.get(key);
      return stored ? object(key, stored) : null;
    },
    async get(key: string) {
      gets += 1;
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        ...object(key, stored),
        body: null,
        bodyUsed: false,
        range: undefined,
        async arrayBuffer() {
          const copy = new Uint8Array(stored.bytes.byteLength);
          copy.set(stored.bytes);
          return copy.buffer;
        },
        async bytes() {
          return stored.bytes;
        },
        async text() {
          return utf8Text(stored.bytes);
        },
        async json() {
          return JSON.parse(utf8Text(stored.bytes));
        },
        async blob() {
          return new Blob([stored.bytes]);
        },
        writeHttpMetadata() {},
      };
    },
    async put(key: string, value: Uint8Array, options?: R2PutOptions) {
      puts += 1;
      if (objects.has(key) && options?.onlyIf) return null;
      const bytes = new Uint8Array(value.byteLength);
      bytes.set(value);
      objects.set(key, {
        bytes,
        customMetadata: options?.customMetadata,
        contentType: options?.httpMetadata?.contentType,
      });
      return object(key, objects.get(key)!);
    },
  } as unknown as R2Bucket;
  return {
    bucket,
    objects,
    putCount: () => puts,
    getCount: () => gets,
  };
};

/** A `HomeControl` answering each operation from `answer`. */
const control =
  (answer: (op: string, body: Record<string, unknown>) => unknown | Promise<unknown>) =>
  async (op: string, body: Record<string, unknown>) => ({
    ok: true as const,
    value: await answer(op, body),
  });

const ownerId = "owner-1";
const ownerGeneration = "generation-1";
const memoryEpoch = "epoch-1";

describe("CloudHomeStore", () => {
  test("pins exact mirrored skill files for discovery and use", async () => {
    const r2 = fakeBucket();
    const ownerHash = await sha256Hex(ownerId);
    const bytes = utf8Bytes("# Calendar\n\nUse the calendar tool.\n");
    const digest = await sha256BytesHex(bytes);
    const key = `agent-home/${ownerHash}/skills/skill-calendar/version-1/files/SKILL.md`;
    r2.objects.set(key, { bytes });
    const entry = {
      skillId: "skill-calendar",
      slug: "calendar",
      name: "Calendar",
      description: "Manage calendar events",
      source: "desktop_sync",
      availability: "both",
      revision: 1,
      versionId: "version-1",
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      fileCount: 1,
      totalSizeBytes: bytes.byteLength,
      files: [
        {
          path: "SKILL.md",
          r2Key: key,
          sha256: digest,
          sizeBytes: bytes.byteLength,
          contentType: "text/markdown; charset=utf-8",
        },
      ],
      updatedAt: 1,
    };
    const store = new CloudHomeStore(r2.bucket, {
      ownerId,
      ownerGeneration,
      control: control(() => [entry]),
    });
    const snapshot = await store.loadSkillCatalog("orchestrator");
    expect(
      store.searchSkills(snapshot, "calendar").map((skill) => skill.slug),
    ).toEqual(["calendar"]);
    expect(
      await store.readSkillText(snapshot, "skill-calendar", "SKILL.md"),
    ).toContain("calendar tool");
    await expect(
      store.readSkillText(snapshot, "skill-calendar", "../../secret"),
    ).rejects.toBeInstanceOf(CloudHomeProtocolError);
  });
});

test("loads the memory policy in one request and rejects a stale generation", async () => {
  const r2 = fakeBucket();
  let calls = 0;
  let response: Record<string, unknown> = {
    ownerGeneration, memoryEpoch, memoryEnabled: false, revision: 1, updatedAt: 1,
  };
  const store = new CloudHomeStore(r2.bucket, {
    ownerId, ownerGeneration,
    control: control((op) => {
      calls += 1;
      expect(op).toBe("memory.context");
      return response;
    }),
  });
  expect(await store.getMemoryContext()).toEqual({
    preference: { ownerGeneration, memoryEpoch, memoryEnabled: false, revision: 1, updatedAt: 1 },
  });
  expect(calls).toBe(1);
  response = { ...response, ownerGeneration: "stale" };
  await expect(store.getMemoryContext()).rejects.toThrow("stale");
});
