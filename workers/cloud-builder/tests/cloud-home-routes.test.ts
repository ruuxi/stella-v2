import { describe, expect, test } from "bun:test";
import { handleUserCloudHomeRoute } from "../src/cloud-home-routes.js";
import { sha256BytesHex, sha256Hex } from "../src/hash.js";

/**
 * The owner's gate as the routes see it: the snapshot's generation and the
 * cloud-home control operations. `calls` records "snapshot" and each op.
 */
const fakeGates = (
  ownerGeneration: string,
  answer: (op: string, body: Record<string, unknown>) => unknown = (op) => {
    throw new Error(`unexpected control op: ${op}`);
  },
) => {
  const calls: string[] = [];
  const OWNER_GATES = {
    getByName: () => ({
      snapshot: async () => {
        calls.push("snapshot");
        return { ownerGeneration };
      },
      homeControl: async ({ op, body }: { op: string; body: Record<string, unknown> }) => {
        calls.push(op);
        return { ok: true, value: await answer(op, body) };
      },
    }),
  } as unknown as Cloudflare.Env["OWNER_GATES"];
  return { OWNER_GATES, calls };
};

const lease = async <T>(
  _ownerId: string,
  _ownerGeneration: string,
  _activityId: string,
  operation: (assertExternalWrite: () => Promise<void>) => Promise<T>,
): Promise<T> => await operation(async () => undefined);

const bucketWithPutCounter = () => {
  let puts = 0;
  const bucket = {
    async put() {
      puts += 1;
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts: () => puts };
};

describe("Cloud Home user route bounds", () => {
  test("rejects an oversized chunked memory write while it is streaming", async () => {
    const gates = fakeGates("generation-1");
    const chunks = [
      new Uint8Array(600 * 1024).fill(123),
      new Uint8Array(600 * 1024).fill(125),
    ];
    const request = new Request(
      "https://builder.example.test/cloud-home/memory/write",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-expected-subject": "owner-1",
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await handleUserCloudHomeRoute({
      request,
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "Cloud home request is too large.",
    });
    expect(gates.calls).toEqual(["snapshot"]);
  });

  test("rejects a delayed account-A memory request after the token switches to B", async () => {
    const gates = fakeGates("generation-1");
    let leaseCalls = 0;
    const response = await handleUserCloudHomeRoute({
      request: new Request("https://builder.example.test/cloud-home/memory", {
        headers: { "x-stella-expected-subject": "account-a" },
      }),
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "account-b",
      subject: "account-b",
      withLease: async () => {
        leaseCalls += 1;
        throw new Error("lease must not start");
      },
    });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      code: "SESSION_IDENTITY_MISMATCH",
    });
    expect(leaseCalls).toBe(0);
    expect(gates.calls).toEqual([]);
  });

  test("rejects a stale editor generation before memory begin or R2", async () => {
    const gates = fakeGates("generation-current");
    const response = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/memory/write",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-expected-subject": "owner-1",
          },
          body: JSON.stringify({
            expectedOwnerGeneration: "generation-stale",
            expectedMemoryEpoch: "epoch-stale",
            name: "MEMORY.md",
            kind: "memory",
            source: "settings",
            expectedRevision: 0,
            content: "must not write",
            writer: "user_edit",
            idempotencyKey: "stale-editor",
          }),
        },
      ),
      env: { AGENT_HOME: bucketWithPutCounter().bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });
    expect(response?.status).toBe(412);
    expect(await response?.json()).toMatchObject({
      code: "OWNER_DATA_GENERATION_STALE",
    });
    expect(gates.calls).toEqual(["snapshot"]);
  });

  test("returns the memory epoch only as top-level authority", async () => {
    const bytes = new TextEncoder().encode("authoritative memory");
    const ownerHash = await sha256Hex("owner-1");
    const r2Key = `agent-home/${ownerHash}/generations/generation-hash/memory-versions/version-1`;
    const digest = await sha256BytesHex(bytes);
    const gates = fakeGates("generation-1", (op) => {
      if (op === "memory.catalog") {
        return [
          {
            documentId: "document-1",
            name: "MEMORY.md",
            displayPath: "MEMORY.md",
            kind: "memory",
            source: "settings",
            ownerGeneration: "generation-1",
            memoryEpoch: "epoch-1",
            revision: 1,
            versionId: "version-1",
            r2Key,
            sha256: digest,
            sizeBytes: bytes.byteLength,
            updatedAt: 10,
          },
        ];
      }
      if (op === "memory.wipeStatus") {
        return {
          subject: "owner-1",
          ownerGeneration: "generation-1",
          state: "open",
          memoryEpoch: "epoch-1",
          importDisposition: "automatic_allowed",
          job: null,
        };
      }
      if (op === "memory.epochAssert") return { memoryEpoch: "epoch-1" };
      throw new Error(`unexpected control op: ${op}`);
    });
    const bucket = {
      async get(key: string) {
        if (key !== r2Key) return null;
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            return bytes.slice().buffer;
          },
        };
      },
    } as unknown as R2Bucket;
    const response = await handleUserCloudHomeRoute({
      request: new Request("https://builder.example.test/cloud-home/memory", {
        headers: { "x-stella-expected-subject": "owner-1" },
      }),
      env: { AGENT_HOME: bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      subject: "owner-1",
      ownerGeneration: "generation-1",
      memoryEpoch: "epoch-1",
    });
    expect(body.documents).toEqual([
      {
        documentId: "document-1",
        name: "MEMORY.md",
        displayPath: "MEMORY.md",
        kind: "memory",
        source: "settings",
        revision: 1,
        versionId: "version-1",
        sha256: digest,
        sizeBytes: bytes.byteLength,
        updatedAt: 10,
        content: "authoritative memory",
      },
    ]);
  });

  test("rejects aggregate skill bytes before control-plane begin or R2 PUT", async () => {
    const gates = fakeGates("generation-1");
    const r2 = bucketWithPutCounter();
    const fourAndHalfMiB = Buffer.alloc(4.5 * 1024 * 1024).toString("base64");
    const files = Array.from({ length: 6 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `assets/file-${index}.bin`,
      contentType:
        index === 0
          ? "text/markdown; charset=utf-8"
          : "application/octet-stream",
      base64: fourAndHalfMiB,
    }));
    const request = new Request(
      "https://builder.example.test/cloud-home/skills/upload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "too-large",
          name: "Too large",
          description: "Aggregate rejection fixture",
          source: "desktop_sync",
          availability: "both",
          expectedRevision: 0,
          idempotencyKey: "aggregate-limit-test",
          files,
        }),
      },
    );

    const response = await handleUserCloudHomeRoute({
      request,
      env: { AGENT_HOME: r2.bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "Skill package exceeds the total size limit.",
    });
    expect(gates.calls).toEqual(["snapshot"]);
    expect(r2.puts()).toBe(0);
  });

  test("redacts unexpected exception messages", async () => {
    const gates = fakeGates("generation-1");
    const response = await handleUserCloudHomeRoute({
      request: new Request("https://builder.example.test/cloud-home/memory", {
        headers: { "x-stella-expected-subject": "owner-1" },
      }),
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: async () => {
        throw new Error(
          "https://internal.example/agent-home/private-key?token=secret",
        );
      },
    });

    expect(response?.status).toBe(500);
    const text = await response?.text();
    expect(text).toContain("Cloud home request failed.");
    expect(text).not.toContain("internal.example");
    expect(text).not.toContain("private-key");
    expect(text).not.toContain("secret");
  });

  test("rejects an invalid skill agentType instead of changing its meaning", async () => {
    const gates = fakeGates("generation-1");
    const response = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/skills/export?agentType=admin",
      ),
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "agentType was invalid." });
    expect(gates.calls).toEqual(["snapshot"]);
  });
});
