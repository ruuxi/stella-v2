import { describe, expect, test } from "bun:test";
import {
  AgentHome,
  buildResidentMemorySection,
} from "../src/agent-home.js";
import { utf8Bytes, utf8Text } from "../src/cloud-home-store.js";
import { sha256BytesHex, sha256Hex } from "../src/hash.js";

type Stored = { bytes: Uint8Array };

const fakeBucket = (objects: Map<string, Stored>) =>
  ({
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key,
        version: "1",
        size: stored.bytes.byteLength,
        etag: `etag-${key}`,
        httpEtag: `"etag-${key}"`,
        checksums: {},
        uploaded: new Date(0),
        storageClass: "Standard",
        body: null,
        bodyUsed: false,
        range: undefined,
        async arrayBuffer() {
          return stored.bytes.slice().buffer;
        },
        async text() {
          return utf8Text(stored.bytes);
        },
        async bytes() {
          return stored.bytes.slice();
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
  }) as unknown as R2Bucket;

const ownerId = "agent-home-authority-owner";
const ownerGeneration = "agent-home-authority-generation";
const memoryEpoch = "agent-home-authority-epoch";

const harness = async (
  content: string,
  memoryEnabled = true,
  includeHead = true,
) => {
  const [ownerHash, generationHash] = await Promise.all([
    sha256Hex(ownerId),
    sha256Hex(ownerGeneration),
  ]);
  const bytes = utf8Bytes(content);
  const digest = await sha256BytesHex(bytes);
  const r2Key =
    `agent-home/${ownerHash}/generations/${generationHash}/` +
    `memory-versions/doc-memory/version-memory/${digest}.md`;
  const objects = new Map<string, Stored>([[r2Key, { bytes }]]);
  const head = {
    documentId: "doc-memory",
    name: "MEMORY.md",
    displayPath: "~/.stella/memories/MEMORY.md",
    kind: "memory",
    source: "desktop_sync",
    ownerGeneration,
    memoryEpoch,
    revision: 1,
    versionId: "version-memory",
    r2Key,
    sha256: digest,
    sizeBytes: bytes.byteLength,
    updatedAt: 10,
  };
  const calls: string[] = [];
  const agentHome = new AgentHome(
    fakeBucket(objects),
    ownerId,
    ownerGeneration,
    {
      ownerGeneration,
      control: async (op) => {
        calls.push(op);
        const answer = (value: unknown) => ({ ok: true as const, value });
        if (op === "memory.context") {
          return answer({
            ownerGeneration,
            memoryEpoch,
            memoryEnabled,
            revision: memoryEnabled ? 0 : 1,
            updatedAt: memoryEnabled ? 0 : 5,
            documentHeads: memoryEnabled && includeHead ? [head] : [],
            personalityHead: null,
          });
        }
        if (op === "memory.epochAssert") return answer({ memoryEpoch });
        if (op === "memory.catalog") return answer(includeHead ? [head] : []);
        if (op === "memory.head") return answer(null);
        if (op === "skills.catalog") return answer([]);
        throw new Error(`unexpected control op: ${op}`);
      },
    },
  );
  return { agentHome, calls, head, objects, r2Key };
};

describe("authoritative Agent Home startup", () => {
  test("makes a stored memory document visible to a later fresh AgentHome", async () => {
    const stored = [
      "# Stella Memory",
      "",
      "## Restart receipt",
      "",
      "The exact restart receipt is durable and visible later.",
      "",
    ].join("\n");
    const first = await harness(stored);
    expect(
      (await first.agentHome.cloudStore().getMemoryContext()).preference
        .memoryEnabled,
    ).toBe(true);
    const documents = await first.agentHome.readDocuments();
    expect(buildResidentMemorySection(documents)).toContain(
      "exact restart receipt is durable and visible later",
    );

    // A new instance models a DO restart/new turn and resolves the same
    // authoritative head and immutable bytes rather than process memory.
    const restarted = await harness(stored);
    expect(
      buildResidentMemorySection(await restarted.agentHome.readDocuments()),
    ).toContain("Restart receipt");
  });

  test("blocks missing or corrupt bytes for an advertised head", async () => {
    const missing = await harness("authoritative memory");
    missing.objects.delete(missing.r2Key);
    await expect(missing.agentHome.readDocuments()).rejects.toThrow(
      "Cloud-home object is missing",
    );

    const corrupt = await harness("authoritative memory");
    corrupt.objects.set(corrupt.r2Key, {
      bytes: utf8Bytes("different bytes but the same advertised head"),
    });
    await expect(corrupt.agentHome.readDocuments()).rejects.toThrow();
  });

  test("re-reads the owner preference across restart and accepts true absence", async () => {
    const disabled = await harness("stored but disabled", false);
    const first = (await disabled.agentHome.cloudStore().getMemoryContext())
      .preference;
    const restarted = await harness("stored but disabled", false);
    const second = (await restarted.agentHome.cloudStore().getMemoryContext())
      .preference;
    expect(first).toMatchObject({ memoryEnabled: false, revision: 1 });
    expect(second).toEqual(first);

    const empty = await harness("unused", true, false);
    expect(await empty.agentHome.readDocuments()).toEqual([]);
  });
});
