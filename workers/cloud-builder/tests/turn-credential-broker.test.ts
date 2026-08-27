import { describe, expect, test } from "bun:test";
import {
  TURN_BROKER_AUTH_SCHEME,
  TURN_BROKER_HEADERS,
  TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
  TURN_BROKER_TURN_TOKEN_HEADER,
  type TurnBrokerHandoff,
} from "@stella/contracts/turn-credential-broker";
import { sha256Hex } from "../src/hash.js";
import {
  TURN_BROKER_MAX_RELAY_REQUESTS,
  claimTurnBrokerRequest,
  forwardTurnBrokerRequest,
  issueTurnBrokerCredential,
  preflightTurnBrokerRequest,
  readTurnBrokerRequestBody,
  revokeTurnBrokerCredential,
  turnBrokerSandboxResponseHeaders,
  turnBrokerTargetMatchesEngine,
  turnBrokerUpstreamHeaders,
  turnBrokerUpstreamUrl,
  validateTurnBrokerTarget,
  type TurnBrokerLiveFence,
  type TurnBrokerRecord,
} from "../src/turn-credential-broker.js";

const now = 1_800_000_000_000;
const identity = {
  sessionId: "session-1",
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  turnId: "turn-9",
  attemptGeneration: 3,
};

const issued = () =>
  issueTurnBrokerCredential({
    identity,
    endpoint: "https://builder.example/sessions/session-1/turn-broker",
    now,
    ttlMs: 60_000,
    randomBytes: (bytes) => bytes.fill(7),
  });

const live = (
  overrides: Partial<TurnBrokerLiveFence> = {},
): TurnBrokerLiveFence => ({
  ...identity,
  active: true,
  canceled: false,
  terminal: false,
  ...overrides,
});

const headers = (
  handoff: TurnBrokerHandoff,
  overrides: Record<string, string> = {},
): Headers =>
  new Headers({
    authorization: `${TURN_BROKER_AUTH_SCHEME} ${handoff.capability}`,
    [TURN_BROKER_HEADERS.ownerId]: identity.ownerId,
    [TURN_BROKER_HEADERS.ownerGeneration]: identity.ownerGeneration,
    [TURN_BROKER_HEADERS.turnId]: identity.turnId,
    [TURN_BROKER_HEADERS.attemptGeneration]: String(identity.attemptGeneration),
    [TURN_BROKER_HEADERS.sequence]: "1",
    [TURN_BROKER_HEADERS.requestId]: "00000000-0000-4000-8000-000000000001",
    [TURN_BROKER_HEADERS.targetMethod]: "POST",
    [TURN_BROKER_HEADERS.targetPath]: "/api/cloud/events",
    ...overrides,
  });

const claim = async (
  record: TurnBrokerRecord,
  handoff: TurnBrokerHandoff,
  options: {
    headers?: Headers;
    live?: TurnBrokerLiveFence;
    now?: number;
    bodyBytes?: number;
  } = {},
) =>
  await claimTurnBrokerRequest({
    record,
    live: options.live ?? live(),
    headers: options.headers ?? headers(handoff),
    now: options.now ?? now + 1,
    bodyBytes: options.bodyBytes ?? 2,
    bodySha256: await sha256Hex("{}"),
  });

describe("BuildSession turn credential broker", () => {
  test("persists only a hash while handing the executor an expiring opaque capability", async () => {
    const { handoff, record } = await issued();
    expect(handoff.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.capabilityHash).toBe(await sha256Hex(handoff.capability));
    expect(JSON.stringify(record)).not.toContain(handoff.capability);
    expect(record).toMatchObject({
      ...identity,
      expiresAt: now + 60_000,
      nextSequence: 1,
      state: "active",
    });
  });

  test("authenticates before a bounded streaming body read", async () => {
    const { handoff, record } = await issued();
    expect(
      await preflightTurnBrokerRequest({
        record,
        headers: headers(handoff, {
          authorization: `${TURN_BROKER_AUTH_SCHEME} ${"Z".repeat(43)}`,
        }),
        now: now + 1,
      }),
    ).toMatchObject({ ok: false, code: "unauthorized" });

    const request = new Request("https://builder.example/turn-broker", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }),
      // Required by Node-compatible Request implementations for streams;
      // ignored by Workers and Bun.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readTurnBrokerRequestBody(request, 5)).rejects.toThrow(
      "exceeded",
    );
  });

  test("consumes one exact owner, generation, turn, and attempt sequence", async () => {
    const { handoff, record } = await issued();
    const accepted = await claim(record, handoff);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.code);
    expect(accepted.disposition).toBe("claim");
    expect(accepted.target).toEqual({
      kind: "callback",
      method: "POST",
      path: "/api/cloud/events",
      maxBodyBytes: 16 * 1024 * 1024,
    });
    expect(accepted.record).toMatchObject({
      nextSequence: 2,
      requestCount: 1,
      relayRequestCount: 0,
      lastClaim: {
        sequence: 1,
        requestId: "00000000-0000-4000-8000-000000000001",
        targetPath: "/api/cloud/events",
      },
    });

    const replay = await claim(accepted.record, handoff);
    expect(replay).toMatchObject({ ok: false, status: 409, code: "replay" });
    const gap = await claim(accepted.record, handoff, {
      headers: headers(handoff, {
        [TURN_BROKER_HEADERS.sequence]: "3",
      }),
    });
    expect(gap).toMatchObject({
      ok: false,
      status: 409,
      code: "out_of_order",
    });
  });

  test("replays only a byte-identical committed-checkpoint claim", async () => {
    const { handoff, record } = await issued();
    const checkpointHeaders = headers(handoff, {
      [TURN_BROKER_HEADERS.requestId]: "00000000-0000-5000-8000-000000000009",
      [TURN_BROKER_HEADERS.targetPath]:
        TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
    });
    const first = await claim(record, handoff, { headers: checkpointHeaders });
    expect(first).toMatchObject({ ok: true, disposition: "claim" });
    if (!first.ok) throw new Error(first.code);

    const replay = await claim(first.record, handoff, {
      headers: checkpointHeaders,
    });
    expect(replay).toMatchObject({
      ok: true,
      disposition: "replay",
      record: { nextSequence: 2, requestCount: 1 },
    });
    const replacement = await claim(first.record, handoff, {
      headers: headers(handoff, {
        [TURN_BROKER_HEADERS.requestId]: "00000000-0000-5000-8000-000000000010",
        [TURN_BROKER_HEADERS.targetPath]:
          TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
      }),
    });
    expect(replacement).toMatchObject({ ok: false, code: "replay" });
  });

  test("fails closed on expired, stale-generation, stale-attempt, and canceled authority", async () => {
    const { handoff, record } = await issued();
    expect(
      await claim(record, handoff, { now: record.expiresAt }),
    ).toMatchObject({ ok: false, code: "expired" });
    expect(
      await claim(record, handoff, {
        headers: headers(handoff, {
          [TURN_BROKER_HEADERS.ownerGeneration]: "generation-8",
        }),
      }),
    ).toMatchObject({ ok: false, code: "wrong_generation" });
    expect(
      await claim(record, handoff, {
        headers: headers(handoff, {
          [TURN_BROKER_HEADERS.attemptGeneration]: "4",
        }),
      }),
    ).toMatchObject({ ok: false, code: "wrong_attempt" });
    expect(
      await claim(record, handoff, { live: live({ canceled: true }) }),
    ).toMatchObject({ ok: false, code: "canceled" });
    expect(
      await claim(record, handoff, { live: live({ terminal: true }) }),
    ).toMatchObject({ ok: false, code: "terminal" });
    expect(
      await claim(revokeTurnBrokerCredential(record, now + 2), handoff),
    ).toMatchObject({ ok: false, code: "inactive" });
  });

  test("fails closed on malformed live booleans and inconsistent revocation state", async () => {
    const { handoff, record } = await issued();
    expect(
      await claim(record, handoff, {
        live: {
          ...live(),
          active: "yes",
          canceled: 0,
          terminal: 0,
        } as unknown as TurnBrokerLiveFence,
      }),
    ).toMatchObject({ ok: false, status: 400, code: "malformed" });
    expect(
      await preflightTurnBrokerRequest({
        record: { ...record, revokedAt: now + 1 },
        headers: headers(handoff),
        now: now + 1,
      }),
    ).toMatchObject({ ok: false, status: 400, code: "malformed" });
  });

  test("does not let a valid capability escape its callback and relay allowlist", async () => {
    const { handoff, record } = await issued();
    for (const deniedPath of [
      "/api/cloud/projects/credentials",
      "/api/cloud/events?redirect=/api/stella/relay/responses",
      "/api/stella/relay/../../cloud/projects/credentials",
      "/api/stella/relay/%2e%2e/cloud/projects/credentials",
      "https://attacker.example/api/stella/relay/responses",
    ]) {
      const denied = await claim(record, handoff, {
        headers: headers(handoff, {
          [TURN_BROKER_HEADERS.targetPath]: deniedPath,
        }),
      });
      expect(denied).toMatchObject({
        ok: false,
        status: 403,
        code: "target_denied",
      });
    }

    expect(
      validateTurnBrokerTarget("POST", "/api/stella/cloud-model"),
    ).toMatchObject({ kind: "model-resolution" });
    expect(
      validateTurnBrokerTarget(
        "POST",
        TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
      ),
    ).toMatchObject({ kind: "builder-callback" });
    expect(
      validateTurnBrokerTarget(
        "GET",
        "/api/stella/relay/responses/request_123?cursor=next",
      ),
    ).toMatchObject({ kind: "model-relay", method: "GET" });
  });

  test("bounds body size and relay-call amplification", async () => {
    const { handoff, record } = await issued();
    const relayHeaders = headers(handoff, {
      [TURN_BROKER_HEADERS.targetPath]: "/api/stella/relay/v1/messages",
    });
    expect(
      await claim(record, handoff, {
        headers: relayHeaders,
        bodyBytes: 24 * 1024 * 1024 + 1,
      }),
    ).toMatchObject({ ok: false, status: 413, code: "body_too_large" });
    expect(
      await claim(
        {
          ...record,
          nextSequence: TURN_BROKER_MAX_RELAY_REQUESTS + 1,
          requestCount: TURN_BROKER_MAX_RELAY_REQUESTS,
          relayRequestCount: TURN_BROKER_MAX_RELAY_REQUESTS,
          lastClaim: {
            sequence: TURN_BROKER_MAX_RELAY_REQUESTS,
            requestId: "00000000-0000-4000-8000-000000000008",
            method: "POST",
            targetPath: "/api/stella/relay/v1/messages",
            bodySha256: await sha256Hex("{}"),
          },
        },
        handoff,
        {
          headers: headers(handoff, {
            [TURN_BROKER_HEADERS.sequence]: String(
              TURN_BROKER_MAX_RELAY_REQUESTS + 1,
            ),
            [TURN_BROKER_HEADERS.targetPath]: "/api/stella/relay/v1/messages",
          }),
        },
      ),
    ).toMatchObject({ ok: false, status: 429, code: "limit_exceeded" });
  });

  test("Builder strips caller credentials, injects the raw token once, and scrubs the response", () => {
    const upstream = turnBrokerUpstreamHeaders(
      new Headers({
        authorization: "Bearer attacker-controlled",
        "x-api-key": "attacker-controlled",
        cookie: "session=attacker-controlled",
        [TURN_BROKER_TURN_TOKEN_HEADER]: "attacker-controlled",
        [TURN_BROKER_HEADERS.sequence]: "99",
        "x-stella-owner": "attacker-controlled",
        "content-type": "application/json",
        "x-stella-llm-credential": "anthropic",
      }),
      "builder-held-raw-authority",
      "anthropic",
    );
    expect(upstream.get("authorization")).toBeNull();
    expect(upstream.get("x-api-key")).toBeNull();
    expect(upstream.get("cookie")).toBeNull();
    expect(upstream.get(TURN_BROKER_HEADERS.sequence)).toBeNull();
    expect(upstream.get("x-stella-owner")).toBeNull();
    expect(upstream.get(TURN_BROKER_TURN_TOKEN_HEADER)).toBe(
      "builder-held-raw-authority",
    );
    expect(upstream.get("x-stella-llm-credential")).toBe("anthropic");
    expect(upstream.get("x-stella-agent-type")).toBe("general");

    const response = turnBrokerSandboxResponseHeaders(
      new Headers({
        "content-type": "application/json",
        "set-cookie": "backend=secret",
        [TURN_BROKER_TURN_TOKEN_HEADER]: "never-return",
        "x-stella-broker-debug": "never-return",
        "x-request-id": "safe-request-id",
      }),
    );
    expect(response.get("set-cookie")).toBeNull();
    expect(response.get(TURN_BROKER_TURN_TOKEN_HEADER)).toBeNull();
    expect(response.get("x-stella-broker-debug")).toBeNull();
    expect(response.get("x-request-id")).toBe("safe-request-id");
  });

  test("constructs upstream URLs only on the pinned Convex origin", () => {
    const target = validateTurnBrokerTarget(
      "POST",
      "/api/stella/relay/responses?stream=true",
    );
    if (!target) throw new Error("missing target");
    expect(
      turnBrokerUpstreamUrl(
        "https://tenant.convex.site",
        "https://tenant.convex.site",
        target,
      ),
    ).toBe("https://tenant.convex.site/api/stella/relay/responses?stream=true");
    expect(() =>
      turnBrokerUpstreamUrl(
        "http://tenant.convex.site",
        "https://tenant.convex.site",
        target,
      ),
    ).toThrow("HTTPS");
    expect(() =>
      turnBrokerUpstreamUrl(
        "https://attacker.example",
        "https://tenant.convex.site",
        target,
      ),
    ).toThrow("HTTPS");
  });

  test("binds relay shapes to the exact dispatched engine", () => {
    const anthropic = validateTurnBrokerTarget(
      "POST",
      "/api/stella/relay/v1/messages",
    );
    const codex = validateTurnBrokerTarget(
      "POST",
      "/api/stella/relay/responses",
    );
    const resolver = validateTurnBrokerTarget(
      "POST",
      "/api/stella/cloud-model",
    );
    if (!anthropic || !codex || !resolver) throw new Error("missing target");
    expect(turnBrokerTargetMatchesEngine(anthropic, "anthropic")).toBe(true);
    expect(turnBrokerTargetMatchesEngine(codex, "anthropic")).toBe(false);
    expect(turnBrokerTargetMatchesEngine(codex, "openai-codex")).toBe(true);
    expect(turnBrokerTargetMatchesEngine(anthropic, "openai-codex")).toBe(
      false,
    );
    expect(turnBrokerTargetMatchesEngine(resolver, "stella")).toBe(true);
    expect(turnBrokerTargetMatchesEngine(resolver, "anthropic")).toBe(false);
  });

  test("mediates the complete upstream call without returning raw authority", async () => {
    const target = validateTurnBrokerTarget(
      "POST",
      "/api/stella/relay/v1/messages",
    );
    if (!target) throw new Error("missing target");
    let observedUrl = "";
    let observedHeaders = new Headers();
    const response = await forwardTurnBrokerRequest({
      target,
      body: new TextEncoder().encode("{}"),
      incomingHeaders: new Headers({
        authorization: "Bearer local-dummy",
        "content-type": "application/json",
      }),
      convexCallbackBase: "https://tenant.convex.site",
      expectedConvexOrigin: "https://tenant.convex.site",
      rawTurnToken: "builder-only-authority",
      engine: "anthropic",
      signal: new AbortController().signal,
      fetchImpl: (async (input, init) => {
        observedUrl = String(input);
        observedHeaders = new Headers(init?.headers);
        return new Response('{"ok":true}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "backend=secret",
            "x-request-id": "request-1",
          },
        });
      }) as typeof fetch,
    });
    expect(observedUrl).toBe(
      "https://tenant.convex.site/api/stella/relay/v1/messages",
    );
    expect(observedHeaders.get("authorization")).toBeNull();
    expect(observedHeaders.get(TURN_BROKER_TURN_TOKEN_HEADER)).toBe(
      "builder-only-authority",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(TURN_BROKER_TURN_TOKEN_HEADER)).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  test("never follows an upstream redirect carrying raw turn authority", async () => {
    const target = validateTurnBrokerTarget(
      "POST",
      "/api/stella/relay/v1/messages",
    );
    if (!target) throw new Error("missing target");
    let observedRedirect: RequestRedirect | undefined;
    let calls = 0;
    await expect(
      forwardTurnBrokerRequest({
        target,
        body: new TextEncoder().encode("{}"),
        incomingHeaders: new Headers({
          authorization: "Bearer local-only",
          "content-type": "application/json",
        }),
        convexCallbackBase: "https://tenant.convex.site",
        expectedConvexOrigin: "https://tenant.convex.site",
        rawTurnToken: "builder-only-authority",
        engine: "anthropic",
        signal: new AbortController().signal,
        fetchImpl: (async (_input, init) => {
          calls += 1;
          observedRedirect = init?.redirect;
          expect(
            new Headers(init?.headers).get(TURN_BROKER_TURN_TOKEN_HEADER),
          ).toBe("builder-only-authority");
          return new Response(null, {
            status: 307,
            headers: { location: "https://attacker.example/stolen" },
          });
        }) as typeof fetch,
      }),
    ).rejects.toThrow("redirect");
    expect(calls).toBe(1);
    expect(observedRedirect).toBe("manual");
  });
});
