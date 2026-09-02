import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  PLACEMENT_PROTOCOL,
  type DispatchSubmitRequest,
} from "@stella/contracts/turn-plane/placement";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
} from "@stella/contracts/turn-plane/turn-start";
import {
  buildMobilePairingChallenge,
  canonicalDispatchPayloadJson,
  deriveMobilePairingKey,
  mobilePairingProofHeaders,
  sha256Hex,
  signMobilePairingProof,
  MOBILE_PAIRING_HEADERS,
} from "@stella/contracts/turn-plane/pairing-proof";
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
 * Who may reach placement, and as what. Every refusal below is asserted to
 * happen before the owner gate is addressed at all, and the one path that
 * upgrades a caller's ingress — a phone's pairing proof — is asserted to
 * reach the gate with the phone and the desktop the proof actually named.
 */

// A distinct issuer and kid: the JWKS cache is module-global, so sharing
// them with another suite would serve its keys to this one.
const ISSUER = "https://placement.convex.site";
const SERVICE_SECRET = "builder-service-secret";
const PAIR_SECRET = "pair-secret-abcdefghijklmnop";
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
  kid: "placement-kid-1",
};

const userJwt = async (): Promise<string> => {
  const encoder = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT", kid: "placement-kid-1" };
  const payload = {
    iss: ISSUER,
    aud: "convex",
    sub: "user_1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    sessionId: "session-1",
  };
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

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/api/auth/convex/jwks`) {
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

type Submitted = { ownerId: string; input: Record<string, unknown> };

const environment = async (
  options: {
    pairingKey?: string;
    submit?: (input: Submitted) => unknown;
  } = {},
) => {
  const submits: Submitted[] = [];
  const statuses: Array<{ ownerId: string; dispatchId: string }> = [];
  const cancels: Array<{ ownerId: string; input: Record<string, unknown> }> = [];
  const snapshot = sampleOwnerSnapshot({
    pairedDevices: [
      {
        mobileDeviceId: "phone-1",
        desktopDeviceId: "desk-1",
        mobilePublicKey:
          options.pairingKey ?? (await deriveMobilePairingKey(PAIR_SECRET)),
      },
    ],
  });
  return {
    submits,
    statuses,
    cancels,
    snapshot,
    env: {
      BUILDER_SERVICE_SECRET: SERVICE_SECRET,
      STELLA_CONVEX_SITE_URL: ISSUER,
      OWNER_GATES: {
        getByName: (ownerId: string) => ({
          snapshot: async () => snapshot,
          submit: async (input: Record<string, unknown>) => {
            submits.push({ ownerId, input });
            return (
              options.submit?.({ ownerId, input }) ?? {
                ok: true,
                response: {
                  protocol: PLACEMENT_PROTOCOL,
                  dispatch: { dispatchId: "dsp:1", state: "offering" },
                  replayed: false,
                },
              }
            );
          },
          dispatchStatus: async (dispatchId: string) => {
            statuses.push({ ownerId, dispatchId });
            return {
              ok: true,
              response: {
                protocol: PLACEMENT_PROTOCOL,
                dispatch: { dispatchId, state: "cloud_running" },
              },
            };
          },
          cancelDispatch: async (input: Record<string, unknown>) => {
            cancels.push({ ownerId, input });
            return {
              ok: true,
              response: {
                protocol: PLACEMENT_PROTOCOL,
                dispatch: { dispatchId: input.dispatchId, state: "cancel_pending" },
              },
            };
          },
          devices: async () => ({
            protocol: PLACEMENT_PROTOCOL,
            devices: [],
            cloud: { capabilities: ["chat", "agent", "attachments"] },
          }),
        }),
      },
    } as never,
  };
};

const body = (
  overrides: Partial<DispatchSubmitRequest> = {},
): DispatchSubmitRequest => ({
  protocol: PLACEMENT_PROTOCOL,
  idempotencyKey: "idem-0001-abcd",
  kind: "chat",
  ingress: "browser",
  subject: "cloud",
  conversationId: "conversation-1",
  requiredCapabilities: [],
  payload: {
    schemaVersion: 1,
    prompt: "Hello there",
    conversationId: "conversation-1",
    clientMsgId: "client-msg-0001",
  },
  ...overrides,
});

const post = (
  path: string,
  payload: unknown,
  headers: Record<string, string>,
) =>
  new Request(`https://builder.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const errorBody = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

const proofHeaders = async (
  request: DispatchSubmitRequest,
  overrides: {
    pairSecret?: string;
    issuedAt?: number;
    mobileDeviceId?: string;
    desktopDeviceId?: string;
    challenge?: string;
  } = {},
) => {
  const pairingKey = await deriveMobilePairingKey(
    overrides.pairSecret ?? PAIR_SECRET,
  );
  const payloadHash = await sha256Hex(
    canonicalDispatchPayloadJson(request.payload),
  );
  const challenge =
    overrides.challenge ??
    buildMobilePairingChallenge({
      idempotencyKey: request.idempotencyKey,
      conversationId: request.conversationId,
      payloadHash,
      kind: request.kind,
      subject: request.subject,
      ...(request.targetMode !== undefined
        ? { targetMode: request.targetMode }
        : {}),
      ...(request.targetDeviceId
        ? { targetDeviceId: request.targetDeviceId }
        : {}),
    });
  const fields = {
    mobileDeviceId: overrides.mobileDeviceId ?? "phone-1",
    desktopDeviceId: overrides.desktopDeviceId ?? "desk-1",
    challenge,
  };
  const signed = await signMobilePairingProof({
    ...fields,
    pairingKey,
    ...(overrides.issuedAt !== undefined ? { issuedAt: overrides.issuedAt } : {}),
  });
  return mobilePairingProofHeaders({ ...fields, ...signed });
};

describe("POST /owners/me/dispatches", () => {
  test("a signed-in user may submit browser and desktop ingress", async () => {
    const { env, submits } = await environment();
    for (const ingress of ["browser", "desktop"] as const) {
      const response = await worker.fetch(
        post(
          "/owners/me/dispatches",
          body({
            ingress,
            subject: ingress === "desktop" ? "portable" : "cloud",
            ...(ingress === "desktop" ? { requestingDeviceId: "desk-1" } : {}),
          }),
          { authorization: `Bearer ${await userJwt()}` },
        ),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(201);
    }
    expect(submits).toHaveLength(2);
    expect(submits[0]!.ownerId).toBe(`${ISSUER}|user_1`);
    expect(submits[0]!.input).not.toHaveProperty("expectedGeneration");
    expect(submits[0]!.input).not.toHaveProperty("pairGrantDeviceId");
  });

  test("a signed-in user cannot claim a service ingress", async () => {
    const { env, submits } = await environment();
    for (const ingress of ["mobile", "cloud", "schedule"] as const) {
      const response = await worker.fetch(
        post("/owners/me/dispatches", body({ ingress, subject: "cloud" }), {
          authorization: `Bearer ${await userJwt()}`,
        }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(403);
      expect((await errorBody(response)).error.code).toBe("forbidden");
    }
    expect(submits).toHaveLength(0);
  });

  test("an unauthenticated caller is refused before the gate is addressed", async () => {
    const { env, submits } = await environment();
    const response = await worker.fetch(
      post("/owners/me/dispatches", body(), {}),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect((await errorBody(response)).error.code).toBe("unauthorized");
    expect(submits).toHaveLength(0);
  });

  test("the service secret may submit any ingress and pins its generation", async () => {
    const { env, submits } = await environment();
    const response = await worker.fetch(
      post("/owners/me/dispatches", body({ ingress: "schedule" }), {
        authorization: `Bearer ${SERVICE_SECRET}`,
        [TURN_OWNER_ID_HEADER]: "owner-9",
        [TURN_OWNER_GENERATION_HEADER]: "generation-3",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(201);
    expect(submits[0]).toMatchObject({
      ownerId: "owner-9",
      input: { expectedGeneration: "generation-3" },
    });
  });

  test("a service caller without owner headers is a bad request", async () => {
    const { env, submits } = await environment();
    const response = await worker.fetch(
      post("/owners/me/dispatches", body({ ingress: "schedule" }), {
        authorization: `Bearer ${SERVICE_SECRET}`,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
    expect(submits).toHaveLength(0);
  });

  test("a valid pairing proof upgrades the caller to mobile ingress", async () => {
    const { env, submits } = await environment();
    const request = body({ ingress: "mobile", subject: "portable" });
    const response = await worker.fetch(
      post("/owners/me/dispatches", request, {
        authorization: `Bearer ${await userJwt()}`,
        ...(await proofHeaders(request)),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(201);
    expect(submits).toHaveLength(1);
    expect(submits[0]!.input).toMatchObject({
      pairGrantDeviceId: "desk-1",
      request: { ingress: "mobile", requestingDeviceId: "phone-1" },
    });
  });

  test("refuses a proof for another payload, another phone, or another secret", async () => {
    const request = body({ ingress: "mobile", subject: "portable" });
    const cases: Array<[string, Record<string, string>]> = [
      [
        "a proof over different bytes",
        await proofHeaders(
          body({
            ingress: "mobile",
            subject: "portable",
            payload: { ...request.payload, prompt: "different" },
          }),
        ),
      ],
      [
        "a phone that is not paired",
        await proofHeaders(request, { mobileDeviceId: "phone-9" }),
      ],
      [
        "a desktop the phone is not paired to",
        await proofHeaders(request, { desktopDeviceId: "desk-9" }),
      ],
      ["another pairing secret", await proofHeaders(request, { pairSecret: "nope" })],
      [
        "a stale proof",
        await proofHeaders(request, { issuedAt: Date.now() - 10 * 60_000 }),
      ],
    ];
    for (const [, headers] of cases) {
      const { env, submits } = await environment();
      const response = await worker.fetch(
        post("/owners/me/dispatches", request, {
          authorization: `Bearer ${await userJwt()}`,
          ...headers,
        }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(403);
      expect((await errorBody(response)).error.message).toBe(
        "This phone credential is invalid.",
      );
      expect(submits).toHaveLength(0);
    }
  });

  test("an incomplete proof header set is refused rather than ignored", async () => {
    const { env, submits } = await environment();
    const response = await worker.fetch(
      post("/owners/me/dispatches", body(), {
        authorization: `Bearer ${await userJwt()}`,
        [MOBILE_PAIRING_HEADERS.mobileDeviceId]: "phone-1",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error.message).toBe(
      "This phone credential is incomplete.",
    );
    expect(submits).toHaveLength(0);
  });

  test("a malformed body never reaches the gate", async () => {
    const { env, submits } = await environment();
    for (const payload of [
      "{",
      JSON.stringify({ ...body(), protocol: 2 }),
      JSON.stringify({ ...body(), idempotencyKey: "no" }),
    ]) {
      const response = await worker.fetch(
        post("/owners/me/dispatches", payload, {
          authorization: `Bearer ${await userJwt()}`,
        }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(400);
    }
    expect(submits).toHaveLength(0);
  });

  test("a replay answers 200 and a gate refusal keeps its contract status", async () => {
    const replayed = await environment({
      submit: () => ({
        ok: true,
        response: {
          protocol: PLACEMENT_PROTOCOL,
          dispatch: { dispatchId: "dsp:1", state: "offering" },
          replayed: true,
        },
      }),
    });
    expect(
      (
        await worker.fetch(
          post("/owners/me/dispatches", body(), {
            authorization: `Bearer ${await userJwt()}`,
          }),
          replayed.env,
          {} as ExecutionContext,
        )
      ).status,
    ).toBe(200);

    for (const [code, status] of [
      ["conflict", 409],
      ["owner_purged", 410],
      ["generation_stale", 403],
      ["quota_concurrency", 429],
      ["capability_unavailable", 409],
      ["internal", 503],
    ] as const) {
      const refused = await environment({
        submit: () => ({
          ok: false,
          error: { code, message: "no", retryable: false },
        }),
      });
      const response = await worker.fetch(
        post("/owners/me/dispatches", body(), {
          authorization: `Bearer ${await userJwt()}`,
        }),
        refused.env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(status);
      expect((await errorBody(response)).error.code).toBe(code);
    }
  });
});

describe("dispatch status and cancel", () => {
  test("a signed-in user reads only their own owner's dispatch", async () => {
    const { env, statuses } = await environment();
    const response = await worker.fetch(
      new Request("https://builder.example/owners/me/dispatches/dsp:abc", {
        headers: { authorization: `Bearer ${await userJwt()}` },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(statuses).toEqual([
      { ownerId: `${ISSUER}|user_1`, dispatchId: "dsp:abc" },
    ]);
  });

  test("a service caller reads with the owner header it names", async () => {
    const { env, statuses } = await environment();
    const response = await worker.fetch(
      new Request("https://builder.example/owners/me/dispatches/dsp:abc", {
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          [TURN_OWNER_ID_HEADER]: "owner-9",
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(statuses[0]!.ownerId).toBe("owner-9");
  });

  test("an unauthenticated read is refused", async () => {
    const { env, statuses } = await environment();
    const response = await worker.fetch(
      new Request("https://builder.example/owners/me/dispatches/dsp:abc"),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(statuses).toHaveLength(0);
  });

  test("cancel requires an id and forwards it to the gate", async () => {
    const { env, cancels } = await environment();
    const bad = await worker.fetch(
      post("/owners/me/dispatches/dsp:abc/cancel", {}, {
        authorization: `Bearer ${await userJwt()}`,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(bad.status).toBe(400);
    const response = await worker.fetch(
      post(
        "/owners/me/dispatches/dsp:abc/cancel",
        { cancelRequestId: "cancel-1", reason: "stop" },
        { authorization: `Bearer ${await userJwt()}` },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(cancels).toEqual([
      {
        ownerId: `${ISSUER}|user_1`,
        input: {
          dispatchId: "dsp:abc",
          cancelRequestId: "cancel-1",
          reason: "stop",
        },
      },
    ]);
  });

  test("the wrong method on either control route is rejected", async () => {
    const { env } = await environment();
    expect(
      (
        await worker.fetch(
          post("/owners/me/dispatches/dsp:abc", {}, {
            authorization: `Bearer ${await userJwt()}`,
          }),
          env,
          {} as ExecutionContext,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await worker.fetch(
          new Request(
            "https://builder.example/owners/me/dispatches/dsp:abc/cancel",
            { headers: { authorization: `Bearer ${await userJwt()}` } },
          ),
          env,
          {} as ExecutionContext,
        )
      ).status,
    ).toBe(405);
  });
});

describe("GET /owners/me/devices", () => {
  test("answers the owner's destinations for a signed-in user only", async () => {
    const { env } = await environment();
    const response = await worker.fetch(
      new Request("https://builder.example/owners/me/devices", {
        headers: { authorization: `Bearer ${await userJwt()}` },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol: PLACEMENT_PROTOCOL,
      devices: [],
      cloud: { capabilities: ["chat", "agent", "attachments"] },
    });
    expect(
      (
        await worker.fetch(
          new Request("https://builder.example/owners/me/devices"),
          env,
          {} as ExecutionContext,
        )
      ).status,
    ).toBe(401);
  });
});

describe("GET /owners/me/devices/:deviceId/presence", () => {
  test("speaks WebSocket only and refuses an unauthenticated upgrade", async () => {
    const { env } = await environment();
    const plain = await worker.fetch(
      new Request(
        "https://builder.example/owners/me/devices/desk-1/presence",
        { headers: { authorization: `Bearer ${await userJwt()}` } },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(plain.status).toBe(426);
  });
});
