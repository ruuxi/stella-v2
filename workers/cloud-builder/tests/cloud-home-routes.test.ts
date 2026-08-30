import { afterEach, describe, expect, test } from "bun:test";
import { handleUserCloudHomeRoute } from "../src/cloud-home-routes.js";
import { sha256BytesHex, sha256Hex } from "../src/hash.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  test("rejects an oversized chunked control request while it is streaming", async () => {
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({ ownerGeneration: "generation-1" });
    };
    const chunks = [
      new Uint8Array(40 * 1024).fill(123),
      new Uint8Array(40 * 1024).fill(125),
    ];
    const request = new Request(
      "https://builder.example.test/cloud-home/memory/wipe/start",
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
      env: {
        AGENT_HOME: {} as R2Bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "Cloud home request is too large.",
    });
    expect(paths).toEqual(["/api/cloud/home/access"]);
  });

  test("rejects a delayed account-A memory request after the token switches to B", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("a subject mismatch must stop before owner access");
    };
    let leaseCalls = 0;
    const response = await handleUserCloudHomeRoute({
      request: new Request("https://builder.example.test/cloud-home/memory", {
        headers: { "x-stella-expected-subject": "account-a" },
      }),
      env: {
        AGENT_HOME: {} as R2Bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
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
    expect(fetchCalls).toBe(0);
  });

  test("starts and polls a subject-fenced memory wipe without exposing locators", async () => {
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/cloud/home/access") {
        return Response.json({ ownerGeneration: "generation-1" });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        ownerId: "owner-1",
        ownerGeneration: "generation-1",
      });
      return Response.json({
        subject: "owner-1",
        ownerGeneration: "generation-1",
        state: path.endsWith("/start") ? "wiping" : "open",
        memoryEpoch: "epoch-1",
        importDisposition: "automatic_allowed",
        job: path.endsWith("/start")
          ? {
              operationId: "memorywipe-1",
              stage: "sweeping",
              attempts: 0,
              nextRetryAt: 1,
              objectsDeleted: 0,
              rowsDeleted: 0,
              updatedAt: 1,
            }
          : null,
      });
    };
    const env = {
      AGENT_HOME: {} as R2Bucket,
      BUILDER_SERVICE_SECRET: "service-secret",
      STELLA_CONVEX_SITE_URL: "https://convex.example.test",
    };
    const start = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/memory/wipe/start",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-expected-subject": "owner-1",
          },
          body: JSON.stringify({
            expectedOwnerGeneration: "generation-1",
            expectedMemoryEpoch: "epoch-1",
            requestId: "wipe-request-1",
          }),
        },
      ),
      env,
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });
    expect(start?.status).toBe(202);
    expect(await start?.json()).toMatchObject({
      subject: "owner-1",
      state: "wiping",
      job: { operationId: "memorywipe-1" },
    });
    const status = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/memory/wipe/status",
        { headers: { "x-stella-expected-subject": "owner-1" } },
      ),
      env,
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: async () => {
        throw new Error("status must remain available while R2 is fenced");
      },
    });
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({
      subject: "owner-1",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "epoch-1",
      job: null,
    });
    expect(paths).toEqual([
      "/api/cloud/home/access",
      "/api/cloud/home/memory/wipe/start",
      "/api/cloud/home/access",
      "/api/cloud/home/memory/wipe/status",
    ]);
  });

  test("rejects a stale editor generation before memory begin or R2", async () => {
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({ ownerGeneration: "generation-current" });
    };
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
      env: {
        AGENT_HOME: bucketWithPutCounter().bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });
    expect(response?.status).toBe(412);
    expect(await response?.json()).toMatchObject({
      code: "OWNER_DATA_GENERATION_STALE",
    });
    expect(paths).toEqual(["/api/cloud/home/access"]);
  });

  test("returns the memory epoch only as top-level authority", async () => {
    const bytes = new TextEncoder().encode("authoritative memory");
    const ownerHash = await sha256Hex("owner-1");
    const r2Key = `agent-home/${ownerHash}/generations/generation-hash/memory-versions/version-1`;
    const digest = await sha256BytesHex(bytes);
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/cloud/home/access") {
        return Response.json({ ownerGeneration: "generation-1" });
      }
      if (path === "/api/cloud/home/memory/catalog") {
        return Response.json([
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
        ]);
      }
      if (path === "/api/cloud/home/memory/wipe/status") {
        return Response.json({
          subject: "owner-1",
          ownerGeneration: "generation-1",
          state: "open",
          memoryEpoch: "epoch-1",
          importDisposition: "automatic_allowed",
          job: null,
        });
      }
      if (path === "/api/cloud/home/memory/epoch/assert") {
        return Response.json({ memoryEpoch: "epoch-1" });
      }
      throw new Error(`unexpected control path: ${path}`);
    };
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
      env: {
        AGENT_HOME: bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
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
    const accessPaths: string[] = [];
    globalThis.fetch = async (input) => {
      accessPaths.push(new URL(String(input)).pathname);
      return Response.json({ ownerGeneration: "generation-1" });
    };
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
      env: {
        AGENT_HOME: r2.bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "Skill package exceeds the total size limit.",
    });
    expect(accessPaths).toEqual(["/api/cloud/home/access"]);
    expect(r2.puts()).toBe(0);
  });

  test("redacts unexpected exception messages", async () => {
    globalThis.fetch = async () =>
      Response.json({ ownerGeneration: "generation-1" });
    const response = await handleUserCloudHomeRoute({
      request: new Request("https://builder.example.test/cloud-home/memory", {
        headers: { "x-stella-expected-subject": "owner-1" },
      }),
      env: {
        AGENT_HOME: {} as R2Bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
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
    const accessPaths: string[] = [];
    globalThis.fetch = async (input) => {
      accessPaths.push(new URL(String(input)).pathname);
      return Response.json({ ownerGeneration: "generation-1" });
    };
    const response = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/skills/export?agentType=admin",
      ),
      env: {
        AGENT_HOME: {} as R2Bucket,
        BUILDER_SERVICE_SECRET: "service-secret",
        STELLA_CONVEX_SITE_URL: "https://convex.example.test",
      },
      ownerId: "owner-1",
      subject: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "agentType was invalid." });
    expect(accessPaths).toEqual(["/api/cloud/home/access"]);
  });
});
