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

const ownerId = "owner-1";
const ownerGeneration = "generation-1";
const memoryEpoch = "epoch-1";

describe("CloudHomeStore", () => {
  test("holds the worker owner fence through an R2-first memory CAS", async () => {
    const r2 = fakeBucket();
    const bytes = utf8Bytes("# Profile\n\n- Likes exact receipts.\n");
    const sha256 = await sha256BytesHex(bytes);
    const ownerHash = await sha256Hex(ownerId);
    const key = `agent-home/${ownerHash}/memory-versions/doc-1/ver-1/${sha256}.md`;
    const calls: string[] = [];
    let liveAssertions = 0;
    let leaseHeld = false;
    let purgeRequested = false;
    let sweepStarted = false;
    let releasePurgeWait: (() => void) | undefined;
    let purgePromise: Promise<void> | undefined;
    const requestPurge = () => {
      purgeRequested = true;
      purgePromise = (async () => {
        if (leaseHeld) {
          await new Promise<void>((resolve) => {
            releasePurgeWait = resolve;
          });
        }
        sweepStarted = true;
      })();
    };
    const prepared = {
      intentId: "memintent-1",
      status: "prepared",
      ownerGeneration,
      memoryEpoch,
      documentId: "doc-1",
      name: "memories/profile.md",
      displayPath: "~/.stella/memories/profile.md",
      kind: "profile",
      baseRevision: 0,
      versionId: "ver-1",
      nextRevision: 1,
      r2Key: key,
      sha256,
      sizeBytes: bytes.byteLength,
      expiresAt: Date.now() + 60_000,
    };
    const store = new CloudHomeStore(r2.bucket, {
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      assertExternalWrite: async () => {
        expect(leaseHeld).toBe(true);
        expect(purgeRequested).toBe(false);
        liveAssertions += 1;
      },
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        if (path.endsWith("/begin")) return Response.json(prepared);
        if (path.endsWith("/epoch/assert")) {
          return Response.json({ memoryEpoch });
        }
        if (path.endsWith("/commit")) {
          expect(leaseHeld).toBe(true);
          requestPurge();
          await Promise.resolve();
          expect(sweepStarted).toBe(false);
          return Response.json({ ...prepared, status: "committed" });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    leaseHeld = true;
    let receipt;
    try {
      receipt = await store.publishMemory({
        name: "memories/profile.md",
        kind: "profile",
        source: "remember",
        expectedRevision: 0,
        bytes,
        writer: "remember",
        idempotencyKey: "remember-turn-1",
      });
      expect(sweepStarted).toBe(false);
    } finally {
      leaseHeld = false;
      releasePurgeWait?.();
    }
    await purgePromise;

    expect(receipt.status).toBe("committed");
    expect(calls).toEqual([
      "/api/cloud/home/memory/begin",
      "/api/cloud/home/memory/epoch/assert",
      "/api/cloud/home/memory/commit",
    ]);
    expect(liveAssertions).toBe(1);
    expect(purgeRequested).toBe(true);
    expect(sweepStarted).toBe(true);
    expect(r2.putCount()).toBe(1);
    expect(utf8Text(r2.objects.get(key)!.bytes)).toContain("exact receipts");
    expect(r2.objects.get(key)!.customMetadata).toEqual({
      stellaSha256: sha256,
      stellaVersionId: "ver-1",
      stellaOwnerHash: ownerHash,
      stellaKind: "memory",
    });
  });

  test("a reset race fails closed before writing any R2 bytes", async () => {
    const r2 = fakeBucket();
    const bytes = utf8Bytes("memory");
    const sha256 = await sha256BytesHex(bytes);
    const ownerHash = await sha256Hex(ownerId);
    const store = new CloudHomeStore(r2.bucket, {
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      assertExternalWrite: async () => {
        throw new Error("owner purge began");
      },
      fetch: async () =>
        Response.json({
          intentId: "memintent-reset-race",
          status: "prepared",
          ownerGeneration,
          memoryEpoch,
          documentId: "doc-reset-race",
          name: "MEMORY.md",
          displayPath: "~/.stella/memories/MEMORY.md",
          kind: "memory",
          baseRevision: 0,
          versionId: "ver-reset-race",
          nextRevision: 1,
          r2Key: `agent-home/${ownerHash}/memory-versions/doc-reset-race/ver-reset-race/${sha256}.md`,
          sha256,
          sizeBytes: bytes.byteLength,
          expiresAt: Date.now() + 60_000,
        }),
    });

    await expect(
      store.publishMemory({
        name: "MEMORY.md",
        kind: "memory",
        source: "desktop_sync",
        expectedRevision: 0,
        bytes,
        writer: "desktop_sync",
        idempotencyKey: "reset-race",
      }),
    ).rejects.toThrow("owner purge began");
    expect(r2.putCount()).toBe(0);
    expect(r2.objects.size).toBe(0);
  });

  test("does not need a new PUT when an exact immutable object survived response loss", async () => {
    const r2 = fakeBucket();
    const bytes = utf8Bytes("same bytes");
    const sha256 = await sha256BytesHex(bytes);
    const ownerHash = await sha256Hex(ownerId);
    const key = `agent-home/${ownerHash}/memory-versions/doc-1/ver-1/${sha256}.md`;
    r2.objects.set(key, {
      bytes,
      customMetadata: {
        stellaSha256: sha256,
        stellaVersionId: "ver-1",
        stellaOwnerHash: ownerHash,
        stellaKind: "memory",
      },
    });
    const receipt = {
      intentId: "memintent-1",
      status: "committed",
      ownerGeneration,
      memoryEpoch,
      documentId: "doc-1",
      name: "MEMORY.md",
      displayPath: "~/.stella/memories/MEMORY.md",
      kind: "memory",
      baseRevision: 0,
      versionId: "ver-1",
      nextRevision: 1,
      r2Key: key,
      sha256,
      sizeBytes: bytes.byteLength,
      expiresAt: Date.now() + 60_000,
    };
    const store = new CloudHomeStore(r2.bucket, {
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      assertExternalWrite: async () => {
        throw new Error("must not be called for an existing object");
      },
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        return Response.json(path.endsWith("/commit") ? receipt : receipt);
      },
    });
    const replay = await store.publishMemory({
      name: "MEMORY.md",
      kind: "memory",
      source: "desktop_sync",
      expectedRevision: 0,
      bytes,
      writer: "desktop_sync",
      idempotencyKey: "replay-1",
    });
    expect(replay.status).toBe("committed");
    expect(r2.putCount()).toBe(0);
  });

  test("rejects cross-owner locators before touching R2", async () => {
    const r2 = fakeBucket();
    const otherHash = await sha256Hex("other-owner");
    const store = new CloudHomeStore(r2.bucket, {
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      fetch: async () =>
        Response.json({
          documentId: "doc-1",
          name: "MEMORY.md",
          displayPath: "~/.stella/memories/MEMORY.md",
          kind: "memory",
          source: "desktop_sync",
          ownerGeneration,
          memoryEpoch,
          revision: 1,
          versionId: "ver-1",
          r2Key: `agent-home/${otherHash}/memory-versions/doc-1/ver-1/x.md`,
          sha256: "0".repeat(64),
          sizeBytes: 1,
          updatedAt: 1,
        }),
    });
    await expect(
      store.readMemoryDocument("MEMORY.md", "memory"),
    ).rejects.toBeInstanceOf(CloudHomeProtocolError);
    expect(r2.getCount()).toBe(0);
  });

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
      base: "https://convex.example",
      serviceSecret: "secret",
      ownerId,
      ownerGeneration,
      fetch: async () => Response.json([entry]),
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
