import { describe, expect, test } from "bun:test";
import {
  CloudDreamWriter,
  DREAM_MEMORY_MAP_MAX_CHARS,
  DREAM_MEMORY_MAX_CHARS,
  buildDreamWritePlan,
  type CloudDreamInput,
} from "../src/cloud-dream-writer.js";
import type {
  CloudDreamClaim,
  CloudHomeStore,
  CloudMemoryHead,
} from "../src/cloud-home-store.js";
import { utf8Bytes, utf8Text } from "../src/cloud-home-store.js";
import { sha256BytesHex } from "../src/hash.js";

const input = (
  sourceKey: string,
  sourceRevision: number,
  body: Record<string, unknown>,
  updatedAt: number,
): CloudDreamInput => {
  const bytes = utf8Bytes(JSON.stringify(body));
  return {
    entry: {
      inboxId: `inbox-${sourceKey}`,
      memoryEpoch: "epoch-1",
      kind: "thread_summary",
      sourceKey,
      sourceRevision,
      title: typeof body.title === "string" ? body.title : sourceKey,
      r2Key: `agent-home/hash/dream/${sourceKey}`,
      sha256: "0".repeat(64),
      sizeBytes: bytes.byteLength,
      priority: 0,
      usageCount: 0,
      updatedAt,
    },
    bytes,
  };
};

describe("cloud Dream writer", () => {
  test("upserts source revisions and keeps the memory map pointer-only", async () => {
    const first = await buildDreamWritePlan({
      inputs: [
        input(
          "thread:roadmap",
          1,
          {
            title: "Roadmap",
            summary: "The first plan.",
            facts: ["Rahul prefers staged rollouts."],
          },
          Date.UTC(2026, 7, 1),
        ),
      ],
    });
    const second = await buildDreamWritePlan({
      memory: first.memory,
      inputs: [
        input(
          "thread:roadmap",
          2,
          {
            title: "Roadmap",
            summary: "The revised plan.",
            facts: ["Rahul prefers exact verification."],
          },
          Date.UTC(2026, 7, 2),
        ),
      ],
    });

    expect(second.activeBlocks).toBe(1);
    expect(second.memory).toContain("revision=2");
    expect(second.memory).toContain("The revised plan.");
    expect(second.memory).not.toContain("The first plan.");
    expect(second.memoryMap).toContain("MEMORY.md#roadmap-");
    expect(second.memoryMap).toContain("thread:roadmap @ revision 2");
    expect(second.memoryMap).not.toContain("The revised plan.");
  });

  test("redacts credential-shaped content before durable memory writes", async () => {
    const secret = "sk-testsecret12345678901234567890";
    const plan = await buildDreamWritePlan({
      inputs: [
        input(
          "thread:redaction",
          1,
          {
            title: `Credential ${secret}`,
            summary: `OPENAI_API_KEY=${secret}`,
            facts: [`Never retain ${secret} in memory.`],
          },
          Date.UTC(2026, 7, 3),
        ),
      ],
    });

    expect(plan.memory).not.toContain(secret);
    expect(plan.memoryMap).not.toContain(secret);
    expect(plan.memory).toContain("OPENAI_API_KEY=");
    expect(plan.memory).toContain("***");
  });

  test("rotates oldest source blocks into month archives within hard caps", async () => {
    const inputs = Array.from({ length: 8 }, (_, index) =>
      input(
        `thread:${index}`,
        1,
        {
          title: `Thread ${index}`,
          summary: `${String(index).repeat(11_000)} end-${index}`,
        },
        Date.UTC(2026, index % 2, index + 1),
      ),
    );
    const plan = await buildDreamWritePlan({ inputs });

    expect(plan.memory.length).toBeLessThanOrEqual(DREAM_MEMORY_MAX_CHARS);
    expect(plan.memoryMap.length).toBeLessThanOrEqual(
      DREAM_MEMORY_MAP_MAX_CHARS,
    );
    expect(plan.rotatedBlocks).toBeGreaterThan(0);
    expect(plan.archives.length).toBeGreaterThan(0);
    expect(
      plan.archives.every((archive) => archive.name.match(/^archive\/2026-/)),
    ).toBe(true);
    expect(plan.memoryMap).toContain("~/.stella/memories/archive/");
  });

  test("rebuilds from authoritative heads after a CAS conflict", async () => {
    type StoredDoc = { head: CloudMemoryHead; bytes: Uint8Array };
    const docs = new Map<string, StoredDoc>();
    let memoryConflict = true;
    let revision = 0;
    let completeCalls = 0;
    const home = {
      async renewDreamRun() {
        return Date.now() + 60_000;
      },
      async getMemoryHead(name: string) {
        return docs.get(name)?.head ?? null;
      },
      async readMemoryHeadBytes(head: CloudMemoryHead) {
        return docs.get(head.name)!.bytes;
      },
      async readLegacyMemoryHeadBytes(head: CloudMemoryHead) {
        return docs.get(head.name)!.bytes;
      },
      async readDreamInput() {
        return utf8Bytes(JSON.stringify({ summary: "Recovered detail." }));
      },
      async publishMemory(args: {
        name: string;
        kind: CloudMemoryHead["kind"];
        bytes: Uint8Array;
      }) {
        if (args.name === "MEMORY.md" && memoryConflict) {
          memoryConflict = false;
          return {
            status: "conflict" as const,
            versionId: "conflict",
          };
        }
        revision += 1;
        const versionId = `version-${revision}`;
        const sha256 = await sha256BytesHex(args.bytes);
        docs.set(args.name, {
          bytes: args.bytes,
          head: {
            documentId: `doc-${args.name}`,
            name: args.name,
            displayPath: `~/.stella/${args.name}`,
            kind: args.kind,
            source: "cloud_dream",
            ownerGeneration: "generation-1",
            memoryEpoch: "epoch-1",
            revision,
            versionId,
            r2Key: `agent-home/hash/${versionId}`,
            sha256,
            sizeBytes: args.bytes.byteLength,
            updatedAt: Date.now(),
          },
        });
        return { status: "committed" as const, versionId };
      },
      async completeDreamRun() {
        completeCalls += 1;
        return { processedCount: 1, supersededCount: 0 };
      },
      async failDreamRun() {
        throw new Error("must not fail");
      },
    } as unknown as CloudHomeStore;
    const claim: CloudDreamClaim = {
      runId: "run-1",
      memoryEpoch: "epoch-1",
      status: "running",
      leaseId: "lease-1",
      leaseExpiresAt: Date.now() + 60_000,
      entries: [
        {
          inboxId: "inbox-1",
          memoryEpoch: "epoch-1",
          kind: "thread_summary",
          sourceKey: "thread:1",
          sourceRevision: 1,
          title: "Thread 1",
          r2Key: "agent-home/hash/dream/1",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          priority: 0,
          usageCount: 0,
          updatedAt: Date.UTC(2026, 7, 1),
        },
      ],
    };

    const result = await new CloudDreamWriter(home).runClaim(claim);
    expect(result.processedCount).toBe(1);
    expect(result.attemptCount).toBe(2);
    expect(result.conflictRetryCount).toBe(1);
    expect(result.conflictRetryObserved).toBe(true);
    expect(completeCalls).toBe(1);
    expect(utf8Text(docs.get("MEMORY.md")!.bytes)).toContain(
      "Recovered detail.",
    );
    expect(utf8Text(docs.get("memories/memory_map.md")!.bytes)).toContain(
      "thread:1",
    );
  });
});
