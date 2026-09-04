import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
  TURN_PLANE_PROTOCOL,
} from "@stella/contracts/turn-plane/turn-start";
import { HEADER_TURN_AUTH_KIND } from "../src/turn-start-request.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const worker = (await import("../src/index.js")).default;
mock.restore();

/**
 * The Worker half of a turn start: who may call, what reaches the Durable
 * Object, and what never does. Every refusal is asserted to happen before
 * the conversation object is addressed at all.
 */

const ISSUER = "https://deployment.convex.site";
const SERVICE_SECRET = "builder-service-secret";
const originalFetch = globalThis.fetch;

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const keyPair = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = {
  ...((await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey),
  kid: "kid-1",
};

const signJwt = async (
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "kid-1" },
): Promise<string> => {
  const encoder = new TextEncoder();
  const signingInput = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(
    encoder.encode(JSON.stringify(payload)),
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      encoder.encode(signingInput),
    ),
  );
  return `${signingInput}.${base64Url(signature)}`;
};

const userJwt = (overrides: Record<string, unknown> = {}) =>
  signJwt({
    iss: ISSUER,
    aud: "convex",
    sub: "user_1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    sessionId: "session-1",
    ...overrides,
  });

let jwksAvailable = true;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/api/auth/convex/jwks`) {
      if (!jwksAvailable) return new Response("down", { status: 503 });
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

type Forwarded = { name: string; request: Request; body: string };

const environment = (
  respond: (forwarded: Forwarded) => Response = () =>
    Response.json({ accepted: true }, { status: 202 }),
) => {
  const forwarded: Forwarded[] = [];
  const invalidated: string[] = [];
  const replaced: Array<{
    ownerId: string;
    snapshot: ReturnType<typeof sampleOwnerSnapshot>;
  }> = [];
  const submissions: unknown[] = [];
  return {
    forwarded,
    invalidated,
    replaced,
    submissions,
    env: {
      BUILDER_SERVICE_SECRET: SERVICE_SECRET,
      STELLA_CONVEX_SITE_URL: ISSUER,
      ORCHESTRATOR_SESSIONS: {
        getByName: (name: string) => ({
          fetch: async (input: string | Request, init?: RequestInit) => {
            const request =
              input instanceof Request ? input : new Request(input, init);
            const entry = { name, request, body: await request.text() };
            forwarded.push(entry);
            return respond(entry);
          },
        }),
      },
      OWNER_GATES: {
        getByName: (ownerId: string) => ({
          submit: async (input: unknown) => {
            submissions.push({ ownerId, input });
            return {
              ok: true,
              response: {
                protocol: 1,
                dispatch: {
                  dispatchId: "dispatch-1",
                  idempotencyKey: "agent-dispatch-1",
                  kind: "agent",
                  ingress: "browser",
                  subject: "cloud",
                  conversationId: "conversation-1",
                  state: "cloud_committed",
                  revision: 1,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
                replayed: false,
              },
            };
          },
          invalidate: async () => {
            invalidated.push(ownerId);
          },
          replaceSnapshot: async (
            snapshot: ReturnType<typeof sampleOwnerSnapshot>,
          ) => {
            replaced.push({ ownerId, snapshot });
          },
        }),
      },
    } as never,
  };
};

const validBody = (overrides: Record<string, unknown> = {}) => ({
  protocol: TURN_PLANE_PROTOCOL,
  clientMsgId: "client-msg-0001",
  prompt: "Hello there",
  ...overrides,
});

const post = (
  body: unknown,
  headers: Record<string, string>,
  conversationId = "11111111-2222-4333-8444-555555555555",
) =>
  new Request(`https://builder.example/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const withCf = (
  request: Request,
  cf: { asn: number; asOrganization?: string },
): Request => {
  Object.defineProperty(request, "cf", { value: cf });
  return request;
};

const errorBody = async (response: Response) =>
  (await response.json()) as {
    error: { code: string; message: string; retryable: boolean };
  };

describe("POST /conversations/:id/turns", () => {
  test("forwards a signed-in user's turn with the verified identity on trusted headers only", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      post(validBody({ locale: "es", attachments: ["Photos/a.png"] }), {
        authorization: `Bearer ${await userJwt()}`,
        // A client can never assert its own identity.
        "x-stella-owner": "attacker",
        "x-stella-turn-auth": "service",
        [TURN_OWNER_GENERATION_HEADER]: "forged",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    const { name, request, body } = forwarded[0]!;
    expect(name).toBe("11111111-2222-4333-8444-555555555555");
    expect(request.url).toBe("https://orchestrator-session/turn");
    expect(request.headers.get("x-stella-owner")).toBe(`${ISSUER}|user_1`);
    expect(request.headers.get(HEADER_TURN_AUTH_KIND)).toBe("user");
    expect(request.headers.get("x-stella-conversation-id")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(Number(request.headers.get("x-stella-token-exp"))).toBeGreaterThan(
      Date.now(),
    );
    expect(request.headers.get(TURN_OWNER_GENERATION_HEADER)).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(JSON.parse(body)).toEqual(
      validBody({ locale: "es", attachments: ["Photos/a.png"] }),
    );
  });

  test("allows an anonymous JWT to start a chat-lane turn", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      post(validBody(), {
        authorization: `Bearer ${await userJwt({ isAnonymous: true })}`,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.request.headers.get(HEADER_TURN_AUTH_KIND)).toBe(
      "user",
    );
  });

  test("refuses an anonymous hosting network before addressing the conversation", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      withCf(
        post(validBody(), {
          authorization: `Bearer ${await userJwt({ isAnonymous: true })}`,
        }),
        { asn: 16_509, asOrganization: "Amazon.com, Inc." },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toEqual({
      error: {
        code: "sign_in_required",
        message: "Sign in to Stella to continue from this network.",
        retryable: false,
      },
    });
    expect(forwarded).toHaveLength(0);
  });

  test("forwards a service caller with the owner and generation it named", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      post(
        validBody({
          lane: "schedule",
          source: "schedule",
          hiddenMessage: true,
        }),
        {
          authorization: `Bearer ${SERVICE_SECRET}`,
          [TURN_OWNER_ID_HEADER]: `${ISSUER}|user_9`,
          [TURN_OWNER_GENERATION_HEADER]: "generation-4",
        },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(202);
    const { request } = forwarded[0]!;
    expect(request.headers.get("x-stella-owner")).toBe(`${ISSUER}|user_9`);
    expect(request.headers.get(HEADER_TURN_AUTH_KIND)).toBe("service");
    expect(request.headers.get(TURN_OWNER_GENERATION_HEADER)).toBe(
      "generation-4",
    );
    expect(request.headers.get("x-stella-token-exp")).toBeNull();

    const missing = await worker.fetch(
      post(validBody(), { authorization: `Bearer ${SERVICE_SECRET}` }),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(400);
    expect((await errorBody(missing)).error.code).toBe("bad_request");
    expect(forwarded).toHaveLength(1);
  });

  test("refuses missing, malformed, and unverifiable credentials before addressing the object", async () => {
    const { env, forwarded } = environment();
    const none = await worker.fetch(
      post(validBody(), {}),
      env,
      {} as ExecutionContext,
    );
    expect(none.status).toBe(401);
    expect(await errorBody(none)).toEqual({
      error: {
        code: "unauthorized",
        message: "Sign in to send messages.",
        retryable: false,
      },
    });
    const forged = await worker.fetch(
      post(validBody(), {
        authorization: `Bearer ${await userJwt({ aud: "someone-else" })}`,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(forged.status).toBe(401);
    const wrongSecret = await worker.fetch(
      post(validBody(), { authorization: "Bearer not-the-secret" }),
      env,
      {} as ExecutionContext,
    );
    expect(wrongSecret.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  test("a JWKS outage is a retryable internal refusal, never an unauthorized one", async () => {
    const { env, forwarded } = environment();
    jwksAvailable = false;
    try {
      const response = await worker.fetch(
        post(
          validBody(),
          {
            authorization: `Bearer ${await userJwt()}`,
            // An unknown kid forces a JWKS refetch past the cache.
          },
          "22222222-2222-4333-8444-555555555555",
        ),
        env,
        {} as ExecutionContext,
      );
      // The kid is cached from the earlier tests, so this still verifies;
      // force the miss with a rotated kid instead.
      expect([202, 503]).toContain(response.status);
      const rotated = await signJwt(
        {
          iss: ISSUER,
          aud: "convex",
          sub: "user_1",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        { alg: "RS256", typ: "JWT", kid: "kid-rotated" },
      );
      const outage = await worker.fetch(
        post(validBody(), { authorization: `Bearer ${rotated}` }),
        env,
        {} as ExecutionContext,
      );
      expect(outage.status).toBe(503);
      expect((await errorBody(outage)).error).toMatchObject({
        code: "internal",
        retryable: true,
      });
    } finally {
      jwksAvailable = true;
    }
    expect(
      forwarded.filter((entry) => entry.request.url.endsWith("/turn")).length,
    ).toBeLessThanOrEqual(1);
  });

  test("a user may not set service-only fields", async () => {
    const { env, forwarded } = environment();
    const token = await userJwt();
    for (const [overrides, field] of [
      [
        {
          lane: "wake",
          agentThreadControl: {
            threadId: "t",
            attemptGeneration: 1,
            threadUpdatedAt: 1,
            status: "completed",
          },
        },
        "lane",
      ],
      [{ lane: "schedule" }, "lane"],
      [{ hiddenMessage: true }, "hiddenMessage"],
      [{ source: "schedule" }, "source"],
      [{ source: "agent-thread" }, "source"],
      [
        {
          agentThreadControl: {
            threadId: "thread-1",
            attemptGeneration: 1,
            threadUpdatedAt: 1,
            status: "completed",
          },
        },
        "agentThreadControl",
      ],
    ] as const) {
      const response = await worker.fetch(
        post(validBody(overrides as Record<string, unknown>), {
          authorization: `Bearer ${token}`,
        }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(403);
      const body = await errorBody(response);
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toContain(field);
    }
    expect(forwarded).toHaveLength(0);
  });

  test("validates the body shape and the conversation id before forwarding", async () => {
    const { env, forwarded } = environment();
    const token = await userJwt();
    for (const body of [
      "{not json",
      {},
      validBody({ protocol: 2 }),
      validBody({ clientMsgId: "short" }),
      validBody({ clientMsgId: "has spaces in it" }),
      validBody({ prompt: "" }),
      validBody({ prompt: "x".repeat(8_001) }),
      validBody({ attachments: ["a", "b", "c", "d", "e"] }),
      validBody({ attachments: [""] }),
      validBody({ locale: "not a locale!" }),
      validBody({
        execution: {
          engine: "stella",
          provider: "anthropic",
          model: "m",
          reasoningEffort: "default",
        },
      }),
      validBody({ title: "t".repeat(121) }),
      validBody({ lane: "build" }),
      validBody({ source: "user" }),
    ]) {
      const response = await worker.fetch(
        post(body, { authorization: `Bearer ${token}` }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(400);
      expect((await errorBody(response)).error.code).toBe("bad_request");
    }
    const badId = await worker.fetch(
      post(validBody(), { authorization: `Bearer ${token}` }, "short"),
      env,
      {} as ExecutionContext,
    );
    expect(badId.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  test("passes the Durable Object's verdict through untouched", async () => {
    const { env } = environment(() =>
      Response.json(
        {
          error: {
            code: "internal",
            message: "try again",
            retryable: true,
            retryAfterMs: 4_000,
          },
        },
        { status: 503, headers: { "retry-after": "4" } },
      ),
    );
    const response = await worker.fetch(
      post(validBody(), { authorization: `Bearer ${await userJwt()}` }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("4");
    expect((await errorBody(response)).error.code).toBe("internal");
  });
});

describe("POST /owners/me/dispatches", () => {
  test("refuses an anonymous hosting network before addressing the owner gate", async () => {
    const { env, submissions } = environment();
    const response = await worker.fetch(
      withCf(
        new Request("https://builder.example/owners/me/dispatches", {
          method: "POST",
          headers: {
            authorization: `Bearer ${await userJwt({ isAnonymous: true })}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ malformed: "body is not read" }),
        }),
        { asn: 13_335, asOrganization: "Cloudflare, Inc." },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error).toMatchObject({
      code: "sign_in_required",
      message: "Sign in to Stella to continue from this network.",
      retryable: false,
    });
    expect(submissions).toHaveLength(0);
  });

  test("refuses an anonymous agent dispatch before addressing the owner gate", async () => {
    const { env, submissions } = environment();
    const response = await worker.fetch(
      new Request("https://builder.example/owners/me/dispatches", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await userJwt({ isAnonymous: true })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: 1,
          idempotencyKey: "agent-dispatch-1",
          kind: "agent",
          ingress: "browser",
          subject: "cloud",
          targetMode: "cloud",
          conversationId: "conversation-1",
          threadId: "thread-1",
          requiredCapabilities: ["agent"],
          payload: {
            schemaVersion: 1,
            prompt: "Research this",
            conversationId: "conversation-1",
            clientMsgId: "agent-dispatch-1",
            description: "Research this",
          },
        }),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toEqual({
      error: {
        code: "sign_in_required",
        message: "Sign in to Stella to use cloud agents.",
        retryable: false,
      },
    });
    expect(submissions).toHaveLength(0);
  });
});

describe("POST /internal/owners/snapshot-changed", () => {
  test("replaces a gate from a snapshot push and invalidates without one", async () => {
    const { env, invalidated, replaced } = environment();
    const request = (headers: Record<string, string>, body: unknown) =>
      new Request("https://builder.example/internal/owners/snapshot-changed", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const unauthenticated = await worker.fetch(
      request({}, { ownerId: "owner-1", reason: "billing" }),
      env,
      {} as ExecutionContext,
    );
    expect(unauthenticated.status).toBe(401);
    const ok = await worker.fetch(
      request(
        { authorization: `Bearer ${SERVICE_SECRET}` },
        { ownerId: "owner-1", reason: "billing" },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(ok.status).toBe(200);
    expect(invalidated).toEqual(["owner-1"]);

    const snapshot = sampleOwnerSnapshot({
      ownerId: "owner-2",
      ownerGeneration: "generation-2",
      fetchedAt: Date.now(),
    });
    const replacedResponse = await worker.fetch(
      request(
        { authorization: `Bearer ${SERVICE_SECRET}` },
        { ownerId: "owner-2", reason: "generation", snapshot },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(replacedResponse.status).toBe(200);
    expect(replaced).toEqual([{ ownerId: "owner-2", snapshot }]);

    const malformed = await worker.fetch(
      request({ authorization: `Bearer ${SERVICE_SECRET}` }, { reason: "x" }),
      env,
      {} as ExecutionContext,
    );
    expect(malformed.status).toBe(400);
    const mismatchedSnapshot = await worker.fetch(
      request(
        { authorization: `Bearer ${SERVICE_SECRET}` },
        { ownerId: "owner-3", reason: "manual", snapshot },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(mismatchedSnapshot.status).toBe(400);
    expect(replaced).toHaveLength(1);
  });
});

describe("queue consumer export", () => {
  test("delivers a batch to Convex and acks it", async () => {
    let posted: unknown;
    let ackedAll = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(`${ISSUER}/api/cloud/outbox`);
      posted = JSON.parse(String(init?.body));
      return Response.json({
        applied: ["turn.event:k"],
        duplicate: [],
        rejected: [],
      });
    }) as typeof fetch;
    try {
      await worker.queue(
        {
          queue: "stella-v2-turn-outbox-dev",
          messages: [
            {
              body: {
                v: 1,
                kind: "turn.event",
                key: "k",
                ownerId: "owner-1",
                ownerGeneration: "generation-1",
                emittedAt: 1,
                turnId: "turn-1",
                sessionId: "chat-1",
                eventSeq: 1,
                eventKind: "started",
                payload: {},
                terminal: false,
                createdAt: 1,
              },
              ack: () => undefined,
            },
          ],
          ackAll: () => {
            ackedAll += 1;
          },
          retryAll: () => undefined,
        } as unknown as MessageBatch<unknown>,
        environment().env,
        {} as ExecutionContext,
      );
    } finally {
      globalThis.fetch = previous;
    }
    expect((posted as { events: unknown[] }).events).toHaveLength(1);
    expect(ackedAll).toBe(1);
  });
});
