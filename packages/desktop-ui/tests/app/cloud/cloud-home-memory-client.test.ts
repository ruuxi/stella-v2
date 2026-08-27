import type { CloudMemoryDocument } from "@stella/contracts/cloud-home-sync";
import { describe, expect, test } from "vitest";
import {
  beginCloudMemoryDocumentWrite,
  CloudHomeMemoryError,
  cloudMemoryDownloadPayload,
  createCloudHomeMemoryClient,
  decodeCloudMemorySnapshot,
  type CloudHomeMemoryClientIdentity,
} from "../../../src/features/cloud/cloud-home-memory-client";

const ownerSubject = "https://api.example.test|user-a";
const memoryEpoch = "memory-epoch-1";
const memoryLifecycle = {
  memoryEpoch,
  importDisposition: "automatic_allowed" as const,
};

const identity = Object.freeze({
  accountScope: "account:user-a",
  identityRevision: 7,
  expectedSubject: ownerSubject,
}) satisfies CloudHomeMemoryClientIdentity;

const sha256 = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const memoryDocument = async (
  overrides: Partial<CloudMemoryDocument> = {},
): Promise<CloudMemoryDocument> => {
  const content = overrides.content ?? "# Memory\n";
  return {
    documentId: "document-memory",
    name: "MEMORY.md",
    displayPath: "~/.stella/memories/MEMORY.md",
    kind: "memory",
    source: "desktop_user",
    revision: 3,
    versionId: "version-memory-3",
    sha256: await sha256(content),
    sizeBytes: new TextEncoder().encode(content).byteLength,
    updatedAt: 1_725_000_000_000,
    content,
    ...overrides,
  };
};

const client = (args: {
  fetch: typeof fetch;
  pinnedIdentity?: CloudHomeMemoryClientIdentity;
  getCurrentIdentity?: () => CloudHomeMemoryClientIdentity | null;
  getTokenForSubject?: (expectedSubject: string) => Promise<string>;
}) => {
  const pinnedIdentity = args.pinnedIdentity ?? identity;
  return createCloudHomeMemoryClient({
    builderOrigin: "https://builder.example.test",
    fetch: args.fetch,
    identity: pinnedIdentity,
    getCurrentIdentity: args.getCurrentIdentity ?? (() => pinnedIdentity),
    getTokenForSubject:
      args.getTokenForSubject ?? (async () => "header.payload.signature"),
  });
};

const writeAttempt = async (args: {
  identity?: CloudHomeMemoryClientIdentity;
  ownerGeneration?: string;
  memoryEpoch?: string;
  document?: CloudMemoryDocument;
  content?: string;
}) =>
  beginCloudMemoryDocumentWrite({
    identity: args.identity ?? identity,
    ownerGeneration: args.ownerGeneration ?? "generation-1",
    memoryEpoch: args.memoryEpoch ?? memoryEpoch,
    document: args.document ?? (await memoryDocument()),
    content: args.content ?? "# Updated memory\n",
    createEntropy: () => "stable-entropy",
  });

describe("desktop Cloud Home memory client", () => {
  test("strictly decodes bounded, internally consistent snapshots", async () => {
    const document = await memoryDocument();
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [document],
        },
        ownerSubject,
      ),
    ).resolves.toEqual({
      ownerGeneration: "generation-1",
      ...memoryLifecycle,
      documents: [document],
    });

    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [{ ...document, unexpected: true }],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [{ ...document, memoryEpoch }],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [{ ...document, displayPath: "/Users/a/MEMORY.md" }],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [{ ...document, sha256: "0".repeat(64) }],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [
            document,
            {
              ...document,
              documentId: "document-duplicate-name",
              versionId: "version-duplicate-name",
            },
          ],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      decodeCloudMemorySnapshot(
        {
          subject: "https://api.example.test|user-b",
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [document],
        },
        ownerSubject,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("rejects declared and streamed GET bodies above the response bound", async () => {
    const declared = client({
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        }),
    });
    await expect(declared.listMemory()).rejects.toMatchObject({
      code: "invalid",
    });

    const streamed = client({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
        ),
    });
    await expect(streamed.listMemory()).rejects.toMatchObject({
      code: "invalid",
    });
  });

  test("reuses one frozen write attempt and the exact same payload on retry", async () => {
    const attempt = await writeAttempt({});
    const committed = await memoryDocument({
      revision: attempt.expectedRevision + 1,
      versionId: "version-memory-4",
      content: attempt.content,
      sha256: await sha256(attempt.content),
      sizeBytes: new TextEncoder().encode(attempt.content).byteLength,
    });
    const posted: unknown[] = [];
    const expectedSubjectHeaders: string[] = [];
    const memoryClient = client({
      fetch: async (input, init) => {
        expect(init?.redirect).toBe("error");
        expectedSubjectHeaders.push(
          new Headers(init?.headers).get("x-stella-expected-subject") ?? "",
        );
        const path = new URL(String(input)).pathname;
        if (path === "/cloud-home/memory/write") {
          posted.push(JSON.parse(String(init?.body)) as unknown);
          return Response.json({ status: "committed" });
        }
        return Response.json({
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [committed],
        });
      },
    });

    await expect(memoryClient.writeMemory(attempt)).resolves.toMatchObject({
      status: "committed",
    });
    await expect(memoryClient.writeMemory(attempt)).resolves.toMatchObject({
      status: "committed",
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.identity)).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual(posted[1]);
    expect(posted[0]).toMatchObject({
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: memoryEpoch,
      expectedRevision: 3,
      content: "# Updated memory\n",
      idempotencyKey: "desktop-memory-edit:stable-entropy",
    });
    expect(new Set(expectedSubjectHeaders)).toEqual(new Set([ownerSubject]));
  });

  test("authoritatively rereads after an ambiguous transport loss", async () => {
    const attempt = await writeAttempt({});
    const committed = await memoryDocument({
      revision: attempt.expectedRevision + 1,
      versionId: "version-after-loss",
      content: attempt.content,
      sha256: await sha256(attempt.content),
      sizeBytes: new TextEncoder().encode(attempt.content).byteLength,
    });
    let postCount = 0;
    let getCount = 0;
    const memoryClient = client({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/cloud-home/memory/write") {
          postCount += 1;
          throw new TypeError("socket closed after commit");
        }
        getCount += 1;
        return Response.json({
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [committed],
        });
      },
    });

    await expect(memoryClient.writeMemory(attempt)).resolves.toEqual({
      status: "committed",
      document: committed,
    });
    expect(postCount).toBe(1);
    expect(getCount).toBe(1);
  });

  test("reports committed only for the exact digest and next CAS revision", async () => {
    const attempt = await writeAttempt({});
    const wrongRevision = await memoryDocument({
      revision: attempt.expectedRevision + 2,
      versionId: "version-too-new",
      content: attempt.content,
      sha256: await sha256(attempt.content),
      sizeBytes: new TextEncoder().encode(attempt.content).byteLength,
    });
    const memoryClient = client({
      fetch: async (input) =>
        new URL(String(input)).pathname === "/cloud-home/memory/write"
          ? Response.json({ status: "committed" })
          : Response.json({
              subject: ownerSubject,
              ownerGeneration: "generation-1",
              ...memoryLifecycle,
              documents: [wrongRevision],
            }),
    });

    await expect(memoryClient.writeMemory(attempt)).resolves.toEqual({
      status: "conflict",
      document: wrongRevision,
    });
  });

  test("preserves the authoritative divergent document on conflict", async () => {
    const attempt = await writeAttempt({});
    const divergent = await memoryDocument({
      revision: 9,
      versionId: "version-cloud-authority",
      content: "# Cloud authority\n",
      sha256: await sha256("# Cloud authority\n"),
      sizeBytes: new TextEncoder().encode("# Cloud authority\n").byteLength,
    });
    const memoryClient = client({
      fetch: async (input) =>
        new URL(String(input)).pathname === "/cloud-home/memory/write"
          ? Response.json({ status: "conflict" }, { status: 409 })
          : Response.json({
              subject: ownerSubject,
              ownerGeneration: "generation-1",
              ...memoryLifecycle,
              documents: [divergent],
            }),
    });

    await expect(memoryClient.writeMemory(attempt)).resolves.toEqual({
      status: "conflict",
      document: divergent,
    });
  });

  test("rejects a stale account attempt before token or network access", async () => {
    const staleIdentity = Object.freeze({
      accountScope: "account:user-b",
      identityRevision: 8,
      expectedSubject: "user-b",
    }) satisfies CloudHomeMemoryClientIdentity;
    const attempt = await writeAttempt({ identity: staleIdentity });
    let tokenCalls = 0;
    let fetchCalls = 0;
    const memoryClient = client({
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        });
      },
      getTokenForSubject: async () => {
        tokenCalls += 1;
        return "header.payload.signature";
      },
    });

    await expect(memoryClient.writeMemory(attempt)).rejects.toEqual(
      new CloudHomeMemoryError("unauthorized"),
    );
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("discards a result when identity changes during token or HTTP work", async () => {
    const switchedIdentity = Object.freeze({
      accountScope: "account:user-b",
      identityRevision: 8,
      expectedSubject: "user-b",
    }) satisfies CloudHomeMemoryClientIdentity;
    let current: CloudHomeMemoryClientIdentity = identity;
    const requestedSubjects: string[] = [];
    let fetchCalls = 0;
    const duringToken = client({
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        });
      },
      getCurrentIdentity: () => current,
      getTokenForSubject: async (expectedSubject) => {
        requestedSubjects.push(expectedSubject);
        current = switchedIdentity;
        return "header.payload.signature";
      },
    });
    await expect(duringToken.listMemory()).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(requestedSubjects).toEqual([ownerSubject]);
    expect(fetchCalls).toBe(0);

    current = identity;
    const duringFetch = client({
      getCurrentIdentity: () => current,
      fetch: async () => {
        current = switchedIdentity;
        return Response.json({
          subject: ownerSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        });
      },
    });
    await expect(duringFetch.listMemory()).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  test("rejects an authoritative reread from another owner generation", async () => {
    const attempt = await writeAttempt({ ownerGeneration: "generation-1" });
    const memoryClient = client({
      fetch: async (input) =>
        new URL(String(input)).pathname === "/cloud-home/memory/write"
          ? Response.json({ status: "committed" })
          : Response.json({
              subject: ownerSubject,
              ownerGeneration: "generation-2",
              ...memoryLifecycle,
              documents: [],
            }),
    });

    await expect(memoryClient.writeMemory(attempt)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("rejects an authoritative reread from another Memory epoch", async () => {
    const attempt = await writeAttempt({ memoryEpoch });
    const memoryClient = client({
      fetch: async (input) =>
        new URL(String(input)).pathname === "/cloud-home/memory/write"
          ? Response.json({ status: "committed" })
          : Response.json({
              subject: ownerSubject,
              ownerGeneration: "generation-1",
              memoryEpoch: "memory-epoch-2",
              importDisposition: "explicit_required",
              documents: [],
            }),
    });

    await expect(memoryClient.writeMemory(attempt)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("builds a path-free native download payload", async () => {
    const document = await memoryDocument({
      documentId: "document-imported",
      name: "imports/2026-08/imported.md",
      displayPath: "~/.stella/imports/2026-08/imported.md",
      kind: "imported_markdown",
      content: "# Imported\n",
      sha256: await sha256("# Imported\n"),
      sizeBytes: new TextEncoder().encode("# Imported\n").byteLength,
    });

    expect(cloudMemoryDownloadPayload(document)).toEqual({
      suggestedName: "imported.md",
      content: "# Imported\n",
    });
    expect(cloudMemoryDownloadPayload(document)).not.toHaveProperty("path");
  });
});
