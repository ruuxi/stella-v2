import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  MobileCloudHomeError,
  createMobileCloudHomeClient,
  summarizeCloudMemory,
  type MobileCloudHomeClientIdentity,
  type MobileCloudMemoryAuthority,
  type MobileCloudMemoryDocument,
} from "../cloud-home";

const ownerSubjectA = "https://issuer.example.test|user-a";
const ownerSubjectB = "https://issuer.example.test|user-b";
const identityA: MobileCloudHomeClientIdentity = Object.freeze({
  accountScope: "account:user-a",
  identityKey: "account:user-a:session:session-a",
  identityRevision: 1,
  expectedSubject: ownerSubjectA,
});
const identityB: MobileCloudHomeClientIdentity = Object.freeze({
  accountScope: "account:user-b",
  identityKey: "account:user-b:session:session-b",
  identityRevision: 2,
  expectedSubject: ownerSubjectB,
});
const authorityA: MobileCloudMemoryAuthority = Object.freeze({
  subject: ownerSubjectA,
  ownerGeneration: "generation-1",
  memoryEpoch: "memory-epoch-1",
  importDisposition: "automatic_allowed",
});

const content = "# User Profile\n\n- Name: Ada\n";
const digestFor = (value: string): string =>
  bytesToHex(sha256(utf8ToBytes(value)));

const document = (
  overrides: Partial<MobileCloudMemoryDocument> = {},
): MobileCloudMemoryDocument => {
  const nextContent = overrides.content ?? content;
  return {
    documentId: "memdoc-profile",
    name: "memories/profile.md",
    displayPath: "~/.stella/memories/profile.md",
    kind: "profile",
    source: "mobile_user",
    revision: 2,
    versionId: "memver-2",
    sha256: overrides.sha256 ?? digestFor(nextContent),
    sizeBytes: overrides.sizeBytes ?? utf8ToBytes(nextContent).byteLength,
    updatedAt: 2,
    content: nextContent,
    ...overrides,
  };
};

const clientForSnapshot = (snapshot: unknown) =>
  createMobileCloudHomeClient({
    builderOrigin: "https://builder.example.test",
    identity: identityA,
    getCurrentIdentity: () => identityA,
    getToken: async () => "mobile-jwt",
    fetch: async () => Response.json(snapshot),
  });

const memorySnapshot = (
  documents: unknown[] = [],
  overrides: Partial<{
    subject: string;
    ownerGeneration: string;
    memoryEpoch: string;
    importDisposition:
      | "automatic_allowed"
      | "explicit_required"
      | "explicit_allowed";
    lastWipedEpoch: string;
    lastWipeCompletedAt: number;
  }> = {},
) => ({
  ...authorityA,
  documents,
  ...overrides,
});

const expectErrorCode = async (
  promise: Promise<unknown>,
  code: MobileCloudHomeError["code"],
) => {
  try {
    await promise;
    throw new Error("Expected Cloud Home request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MobileCloudHomeError);
    expect((error as MobileCloudHomeError).code).toBe(code);
  }
};

describe("mobile Cloud Home client", () => {
  test("lists and reads memory with the signed-in JWT and no object locators", async () => {
    const calls: {
      url: string;
      authorization: string | null;
      expectedSubject: string | null;
      redirect: RequestRedirect | undefined;
    }[] = [];
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          authorization: headers.get("authorization"),
          expectedSubject: headers.get("x-stella-expected-subject"),
          redirect: init?.redirect,
        });
        return Response.json(memorySnapshot([document()]));
      },
    });

    const snapshot = await client.listMemory();
    const profile = await client.readMemory("memories/profile.md");
    expect(snapshot.documents).toHaveLength(1);
    expect("memoryEpoch" in snapshot.documents[0]!).toBe(false);
    expect(profile.document?.content).toBe(content);
    expect(profile.authority).toEqual(authorityA);
    expect(calls).toEqual([
      {
        url: "https://builder.example.test/cloud-home/memory",
        authorization: "Bearer mobile-jwt",
        expectedSubject: ownerSubjectA,
        redirect: "error",
      },
      {
        url: "https://builder.example.test/cloud-home/memory",
        authorization: "Bearer mobile-jwt",
        expectedSubject: ownerSubjectA,
        redirect: "error",
      },
    ]);
    expect(JSON.stringify(snapshot).includes("r2Key")).toBe(false);
    expect(summarizeCloudMemory(snapshot)).toEqual([
      {
        name: "memories/profile.md",
        displayPath: "~/.stella/memories/profile.md",
        kind: "profile",
        revision: 2,
        sizeBytes: utf8ToBytes(content).byteLength,
        updatedAt: 2,
      },
    ]);
    expect(
      JSON.stringify(summarizeCloudMemory(snapshot)).includes(content),
    ).toBe(false);
  });

  test("re-reads after a lost write response and reports only a verified commit", async () => {
    let head: MobileCloudMemoryDocument | null = null;
    let postedBody: Record<string, unknown> | null = null;
    const requestSubjects: {
      path: string;
      subject: string | null;
      redirect: RequestRedirect | undefined;
    }[] = [];
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requestSubjects.push({
          path: url.pathname,
          subject: new Headers(init?.headers).get("x-stella-expected-subject"),
          redirect: init?.redirect,
        });
        if (url.pathname.endsWith("/write")) {
          postedBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          head = document();
          throw new Error("response lost");
        }
        return Response.json(memorySnapshot(head ? [head] : []));
      },
    });

    const result = await client.writeMemory({
      authority: authorityA,
      name: "memories/profile.md",
      kind: "profile",
      content,
      expectedRevision: 1,
    });
    expect(result.status).toBe("committed");
    expect(postedBody).toMatchObject({
      name: "memories/profile.md",
      expectedRevision: 1,
      source: "mobile_user",
      writer: "user_edit",
      expectedOwnerGeneration: authorityA.ownerGeneration,
      expectedMemoryEpoch: authorityA.memoryEpoch,
    });
    expect(
      /^mobile-memory-[0-9a-f]{48}$/u.test(
        String(postedBody && postedBody["idempotencyKey"]),
      ),
    ).toBe(true);
    expect(requestSubjects).toEqual([
      {
        path: "/cloud-home/memory/write",
        subject: ownerSubjectA,
        redirect: "error",
      },
      {
        path: "/cloud-home/memory",
        subject: ownerSubjectA,
        redirect: "error",
      },
    ]);
  });

  test("returns the authoritative cloud head on a CAS conflict", async () => {
    const competing = document({
      revision: 3,
      versionId: "memver-competing",
      content: "cloud edit",
    });
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async (input) => {
        const url = new URL(String(input));
        return url.pathname.endsWith("/write")
          ? Response.json(
              { code: "CLOUD_HOME_REVISION_CONFLICT" },
              { status: 409 },
            )
          : Response.json(memorySnapshot([competing]));
      },
    });

    const result = await client.writeMemory({
      authority: authorityA,
      name: "memories/profile.md",
      kind: "profile",
      content,
      expectedRevision: 2,
    });
    expect(result).toEqual({ status: "conflict", document: competing });
  });

  test("normalizes a write name once for the body, idempotency key, and re-read", async () => {
    const writeWithName = async (name: string) => {
      let posted: Record<string, unknown> | null = null;
      let head: MobileCloudMemoryDocument | null = null;
      const client = createMobileCloudHomeClient({
        builderOrigin: "https://builder.example.test",
        identity: identityA,
        getCurrentIdentity: () => identityA,
        getToken: async () => "mobile-jwt",
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname.endsWith("/write")) {
            posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
            head = document({
              documentId: "memdoc-cafe",
              name: "markdown/caf\u00e9.md",
              displayPath: "~/.stella/markdown/caf\u00e9.md",
              kind: "user_markdown",
              revision: 1,
              versionId: "memver-cafe",
              content: "hello",
            });
            return Response.json({ status: "committed" });
          }
          return Response.json(memorySnapshot(head ? [head] : []));
        },
      });
      const result = await client.writeMemory({
        authority: authorityA,
        name,
        kind: "user_markdown",
        content: "hello",
        expectedRevision: 0,
      });
      return { posted: posted as unknown as Record<string, unknown>, result };
    };

    const decomposed = await writeWithName(" ./markdown/cafe\u0301.md ");
    const normalized = await writeWithName("markdown/caf\u00e9.md");
    expect(decomposed.result.status).toBe("committed");
    expect(decomposed.posted.name).toBe("markdown/caf\u00e9.md");
    expect(decomposed.posted.idempotencyKey).toBe(
      normalized.posted.idempotencyKey,
    );
  });

  test("runtime-validates write kind, source, writer, idempotency, and content", async () => {
    let requests = 0;
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async () => {
        requests += 1;
        return Response.json(memorySnapshot());
      },
    });
    const unsafeWrites = [
      {
        name: "memories/profile.md",
        kind: "memory",
        content,
        expectedRevision: 1,
      },
      {
        name: "memories/profile.md",
        kind: "profile",
        source: "bad source",
        content,
        expectedRevision: 1,
      },
      {
        name: "memories/profile.md",
        kind: "profile",
        writer: "dream",
        content,
        expectedRevision: 1,
      },
      {
        name: "memories/profile.md",
        kind: "profile",
        idempotencyKey: "bad/key",
        content,
        expectedRevision: 1,
      },
      {
        name: "memories/profile.md",
        kind: "profile",
        content: "",
        expectedRevision: 1,
      },
    ];
    for (const input of unsafeWrites) {
      await expectErrorCode(
        client.writeMemory({
          authority: authorityA,
          ...(input as Omit<
            Parameters<typeof client.writeMemory>[0],
            "authority"
          >),
        }),
        "invalid",
      );
    }
    expect(requests).toBe(0);
  });

  test("blocks passive mobile sync while reimport requires explicit authorization", async () => {
    let requests = 0;
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async () => {
        requests += 1;
        return Response.json(memorySnapshot());
      },
    });
    await expectErrorCode(
      client.writeMemory({
        authority: {
          ...authorityA,
          importDisposition: "explicit_required",
        },
        name: "memories/profile.md",
        kind: "profile",
        content,
        expectedRevision: 1,
        writer: "mobile_sync",
      }),
      "unavailable",
    );
    expect(requests).toBe(0);
  });

  test("allows a current-epoch user edit while passive reimport is blocked", async () => {
    let head: MobileCloudMemoryDocument | null = null;
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async (input) => {
        if (new URL(String(input)).pathname.endsWith("/write")) {
          head = document();
          return Response.json({ subject: ownerSubjectA, status: "committed" });
        }
        return Response.json(
          memorySnapshot(head ? [head] : [], {
            importDisposition: "explicit_required",
          }),
        );
      },
    });

    const result = await client.writeMemory({
      authority: {
        ...authorityA,
        importDisposition: "explicit_required",
      },
      name: "memories/profile.md",
      kind: "profile",
      content,
      expectedRevision: 1,
      writer: "user_edit",
    });
    expect(result.status).toBe("committed");
  });

  test("rejects a write authority captured for another owner", async () => {
    let requests = 0;
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async () => {
        requests += 1;
        return Response.json(memorySnapshot());
      },
    });
    await expectErrorCode(
      client.writeMemory({
        authority: { ...authorityA, subject: ownerSubjectB },
        name: "memories/profile.md",
        kind: "profile",
        content,
        expectedRevision: 1,
      }),
      "unauthorized",
    );
    expect(requests).toBe(0);
  });

  test("never republishes an edit across a memory epoch rotation", async () => {
    const paths: string[] = [];
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return path.endsWith("/write")
          ? Response.json({ code: "CLOUD_MEMORY_EPOCH_STALE" }, { status: 412 })
          : Response.json(
              memorySnapshot([], { memoryEpoch: "memory-epoch-2" }),
            );
      },
    });

    await expectErrorCode(
      client.writeMemory({
        authority: authorityA,
        name: "memories/profile.md",
        kind: "profile",
        content,
        expectedRevision: 1,
      }),
      "unavailable",
    );
    expect(paths).toEqual(["/cloud-home/memory/write", "/cloud-home/memory"]);
  });

  test("rejects unbounded, inconsistent, duplicate, and locator-bearing snapshots", async () => {
    const invalidSnapshots: unknown[] = [
      {
        subject: ownerSubjectA,
        ownerGeneration: "generation-1",
        importDisposition: "automatic_allowed",
        documents: [],
      },
      {
        subject: ownerSubjectA,
        ownerGeneration: "generation-1",
        memoryEpoch: "memory-epoch-1",
        documents: [],
      },
      memorySnapshot([], { importDisposition: "invalid" as never }),
      memorySnapshot([], { lastWipedEpoch: "bad epoch" }),
      memorySnapshot([], { lastWipeCompletedAt: -1 }),
      { ...memorySnapshot(), locator: "private" },
      memorySnapshot([{ ...document(), memoryEpoch: authorityA.memoryEpoch }]),
      memorySnapshot([], { ownerGeneration: "x".repeat(513) }),
      memorySnapshot([], { ownerGeneration: " generation-1" }),
      memorySnapshot([{ ...document(), r2Key: "private/object" }]),
      memorySnapshot([document({ documentId: "bad/id" })]),
      memorySnapshot([document({ name: "../secret.md" })]),
      memorySnapshot([document({ displayPath: "/private/path" })]),
      memorySnapshot([document({ kind: "memory" })]),
      memorySnapshot([document({ source: "bad source" })]),
      memorySnapshot([document({ versionId: "bad/version" })]),
      memorySnapshot([document({ sha256: "A".repeat(64) })]),
      memorySnapshot([document({ revision: -1 })]),
      memorySnapshot([document({ sizeBytes: -1 })]),
      memorySnapshot([document({ updatedAt: -1 })]),
      memorySnapshot([document({ sizeBytes: 1 })]),
      memorySnapshot([document({ sha256: "0".repeat(64) })]),
      memorySnapshot([document(), document()]),
      memorySnapshot(Array.from({ length: 101 }, () => document())),
      memorySnapshot([
        document({
          content: "x".repeat(32 * 1024 + 1),
        }),
      ]),
    ];
    for (const snapshot of invalidSnapshots) {
      await expectErrorCode(
        clientForSnapshot(snapshot).listMemory(),
        "invalid",
      );
    }
  });

  test("rejects a response whose echoed owner subject does not match the request", async () => {
    const client = clientForSnapshot(
      memorySnapshot([document()], { subject: ownerSubjectB }),
    );
    await expectErrorCode(client.listMemory(), "invalid");
  });

  test("rejects a late GET result after the account or session identity changes", async () => {
    let currentIdentity: MobileCloudHomeClientIdentity | null = identityA;
    let releaseResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const response = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const client = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => currentIdentity,
      getToken: async () => "mobile-jwt",
      fetch: async () => {
        markFetchStarted();
        return await response;
      },
    });

    const pending = client.listMemory();
    await fetchStarted;
    currentIdentity = identityB;
    releaseResponse(Response.json(memorySnapshot([document()])));

    await expectErrorCode(pending, "unauthorized");
  });

  test("maps authentication and lifecycle response statuses distinctly", async () => {
    for (const status of [401, 403]) {
      const client = createMobileCloudHomeClient({
        builderOrigin: "https://builder.example.test",
        identity: identityA,
        getCurrentIdentity: () => identityA,
        getToken: async () => "mobile-jwt",
        fetch: async () => new Response("sign in", { status }),
      });
      await expectErrorCode(client.listMemory(), "unauthorized");
    }
    const lifecycleClient = createMobileCloudHomeClient({
      builderOrigin: "https://builder.example.test",
      identity: identityA,
      getCurrentIdentity: () => identityA,
      getToken: async () => "mobile-jwt",
      fetch: async () =>
        Response.json({ code: "OWNER_LIFECYCLE_FENCED" }, { status: 409 }),
    });
    await expectErrorCode(lifecycleClient.listMemory(), "unavailable");
  });

  test("rejects non-TLS remote origins before requesting a token", async () => {
    let tokenReads = 0;
    expect(() =>
      createMobileCloudHomeClient({
        builderOrigin: "http://attacker.example",
        identity: identityA,
        getCurrentIdentity: () => identityA,
        getToken: async () => {
          tokenReads += 1;
          return "token";
        },
      }),
    ).toThrow(MobileCloudHomeError);
    expect(tokenReads).toBe(0);
  });
});
