import { GatewayError } from "../src/errors.js";
import {
  GATEWAY_PREPARE_PATH,
  GATEWAY_MODEL_REVISION_HEADER,
  GATEWAY_MODEL_RESOLUTION_HEADER,
  gatewayModelResolutionRevision,
} from "@stella/contracts/gateway/api";
import { resolveManagedModelDescriptor } from "@stella/model-catalog/gateway-resolution";
import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import {
  GATEWAY_TRACE_HEADER,
  type GatewayModelResolution,
} from "@stella/contracts/gateway/api";
import {
  CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
  type GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import { resetCapabilityKeysForTests } from "../src/capability.js";
import { resetConfigCacheForTests } from "../src/config-cache.js";
import type { RelayTiming } from "../src/relay-timing.js";
import { GATEWAY_REPLAY_HEADER } from "../src/managed-lane.js";
import { handleRequest } from "../src/router.js";
import {
  gatewayConfigRevision,
  type SharedGatewayConfigRecord,
} from "../src/shared-config.js";
import { managedCancellationIdentity } from "../src/managed-cancellation.js";
import {
  completeConfigSnapshot,
  configSnapshot,
  createFetchMock,
  type createDurableObjectState,
  createTestEnv,
  CROF_ALIAS,
  CROF_RESOLVED,
  fakeExecutionContext,
  hangingSseResponse,
  issuers,
  json,
  MUSE_ALIAS,
  MUSE_RESOLVED,
  OWNER_ID,
  OPENROUTER_KEY,
  PROBE_SECRET,
  readError,
  relayRequest,
  signSession,
  signTurn,
  sseResponse,
  sseText,
  TEST_DEVICE_KEY_HASH,
  withTestDpop,
} from "./helpers/env.js";

const responsesFixture = () =>
  sseText([
    {
      event: "response.created",
      data: {
        type: "response.created",
        response: {
          id: "resp_1",
          object: "response",
          status: "in_progress",
          output: [],
        },
      },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: "Hello" },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "meta/muse-spark-1.3-contributor",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Hello there", annotations: [] },
              ],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            total_tokens: 19,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    },
  ]);

const completionsFixture = () =>
  sseText([
    {
      data: {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash-0731",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hi" },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash-0731",
        choices: [
          { index: 0, delta: { content: " there" }, finish_reason: "stop" },
        ],
      },
    },
    {
      data: {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash-0731",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.00001,
        },
      },
    },
    { data: "[DONE]" },
  ]);

const setup = (envOverrides: Record<string, unknown> = {}) => {
  resetConfigCacheForTests();
  resetCapabilityKeysForTests();
  const harness = createTestEnv(envOverrides);
  const fetchMock = createFetchMock()
    .on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () => json({ enforcement: { status: "ok" }, updatedAt: null }),
    )
    .on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(configSnapshot()),
    )
    .on(
      (call) =>
        call.url.host === "openrouter.ai" &&
        call.url.pathname === "/api/v1/responses",
      () => sseResponse(responsesFixture()),
    )
    .on(
      (call) =>
        call.url.host === "crof.ai" &&
        call.url.pathname === "/v1/chat/completions",
      () => sseResponse(completionsFixture()),
    );
  harness.ownerGate.setFetch((request, owner, accounting) =>
    handleRequest(
      request,
      harness.env,
      fakeExecutionContext(),
      harness.deps(fetchMock.fetch),
      {
        matchesOwner: (candidate) => candidate === owner,
        accounting,
        ownerEnforcement: (ownerId, now) =>
          accounting.admitOwnerEnforcement(ownerId, now, fetchMock.fetch),
        cancellation: {
          begin: (identity) => accounting.beginManagedRequest(identity),
          release: (key) => accounting.releaseManagedRequest(key),
        },
      },
    ),
  );
  const runRaw = (request: Request) =>
    handleRequest(
      request,
      harness.env,
      fakeExecutionContext(),
      harness.deps(fetchMock.fetch),
    );
  const run = async (request: Request) =>
    await runRaw(await withTestDpop(request));
  return { harness, fetchMock, run, runRaw };
};

const museBody = (extra: Record<string, unknown> = {}) => ({
  model: MUSE_ALIAS,
  input: [{ role: "user", content: "hi" }],
  reasoning: { effort: "high" },
  max_output_tokens: 1024,
  ...extra,
});

const agentHeaders = (extra: Record<string, string> = {}) => ({
  "x-stella-agent-type": "orchestrator",
  ...extra,
});

const ownerFor = (ctx: ReturnType<typeof setup>) =>
  ctx.harness.ownerGate.namespace.get(
    ctx.harness.ownerGate.namespace.idFromName(OWNER_ID),
  );

/** The owner object's durable state, creating the object first. */
const ownerStateFor = (ctx: ReturnType<typeof setup>) => {
  ownerFor(ctx);
  const state = ctx.harness.ownerGate.states.get(OWNER_ID);
  if (!state) throw new Error("expected owner state");
  return state;
};

/** Seeds the v1 (KV-mirror) enforcement marker; returns its update time. */
const seedLegacyEnforcement = (
  state: ReturnType<typeof createDurableObjectState>,
): number => {
  const staleUpdatedAt = Date.now() - 1_000;
  state.storage.sql.exec(
    `INSERT INTO owner_enforcement_state
      (singleton, status, until_at, updated_at, expires_at) VALUES (1, 'ok', NULL, ?, ?)`,
    staleUpdatedAt,
    staleUpdatedAt + 7 * 24 * 60 * 60 * 1_000,
  );
  state.storage.sql.exec(
    "INSERT INTO owner_enforcement_meta(singleton, initialized) VALUES (1, 1)",
  );
  return staleUpdatedAt;
};

describe("managed lane: authorization matrix", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("no bearer -> 401 unauthorized", async () => {
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(401);
    expect((await readError(response)).error.code).toBe("unauthorized");
    expect(response.headers.get(GATEWAY_TRACE_HEADER)).toBeTruthy();
  });

  test("session capabilities require a valid device-key hash claim", async () => {
    for (const dpk of [undefined, "not-a-device-key-hash"]) {
      const { token } = await signSession({ dpk });
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders(),
        }),
      );
      expect(response.status).toBe(401);
      expect((await readError(response)).error.code).toBe("capability_invalid");
    }
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.harness.networkGate.objects.size).toBe(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);
  });

  test("rejects missing, stale, mismatched-key, and bad-signature request proofs before gates", async () => {
    const { token } = await signSession();
    const request = () =>
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "dpop-refusal" }),
      });

    const missing = await ctx.runRaw(request());
    expect(missing.status).toBe(401);
    expect((await readError(missing)).error.code).toBe("dpop_invalid");

    const staleRequest = await withTestDpop(request(), {
      now: Date.now() - 6 * 60_000,
    });
    const stale = await ctx.runRaw(staleRequest);
    expect((await readError(stale)).error).toMatchObject({
      code: "dpop_invalid",
      retryable: false,
    });

    const mismatchedRequest = await withTestDpop(request());
    mismatchedRequest.headers.set("x-stella-dpop-key", "A".repeat(43));
    const mismatched = await ctx.runRaw(mismatchedRequest);
    expect((await readError(mismatched)).error.code).toBe("dpop_invalid");

    const badSignatureRequest = await withTestDpop(request());
    badSignatureRequest.headers.set("x-stella-dpop", "A".repeat(86));
    const badSignature = await ctx.runRaw(badSignatureRequest);
    expect((await readError(badSignature)).error.code).toBe("dpop_invalid");

    expect(ctx.harness.enforcementCalls).toHaveLength(0);
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.harness.networkGate.objects.size).toBe(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("suspended owners stop at KV before any gate or provider", async () => {
    ctx.harness.enforcementValues.set(
      OWNER_ID,
      JSON.stringify({ status: "suspended", updatedAt: Date.now() }),
    );
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("owner_suspended");
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("releases owner concurrency when validation fails", async () => {
    const { token } = await signSession({
      audience: "anonymous",
      maxRequests: 1,
    });
    const headers = agentHeaders({ "cf-connecting-ip": "203.0.113.31" });
    const malformed = await ctx.run(
      relayRequest("/v1/relay/responses", { token, headers }),
    );
    expect(malformed.status).toBe(400);
    const valid = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers,
      }),
    );
    expect(valid.status).toBe(200);
  });

  test("tier breaker errors identify tier scope for anonymous and free", async () => {
    for (const audience of ["anonymous", "free"] as const) {
      resetConfigCacheForTests();
      ctx = setup();
      ctx.fetchMock.on(
        (call) => call.url.pathname === "/api/gateway/config",
        () =>
          json(
            configSnapshot({
              tierCeilings: [
                {
                  audience,
                  hourlyMicroCents: 1,
                  dailyMicroCents: 1,
                },
              ],
            }),
          ),
      );
      const { token } = await signSession({ audience });
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders({ "cf-connecting-ip": "203.0.113.32" }),
        }),
      );
      expect(response.status).toBe(audience === "anonymous" ? 403 : 429);
      expect((await readError(response)).error).toMatchObject({
        code: audience === "anonymous" ? "sign_in_required" : "tier_paused",
        quota: { scope: "tier" },
      });
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
      expect(ctx.harness.ledger.objects.size).toBe(0);
    }
  });

  test("expired capability -> 401 capability_expired", async () => {
    const { token } = await signSession(
      {},
      { now: Date.now() - 3 * 60 * 60_000, ttlMs: 60_000 },
    );
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(401);
    expect((await readError(response)).error.code).toBe("capability_expired");
  });

  test("signed by an unknown key or by the wrong issuer's key -> 401 capability_invalid", async () => {
    const rogue = await signSession({}, { key: issuers.rogue.signing });
    const rogueResponse = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token: rogue.token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(rogueResponse.status).toBe(401);
    expect((await readError(rogueResponse)).error.code).toBe(
      "capability_invalid",
    );

    // Claims say Convex, signature is cloud-builder's real key: issuer_mismatch.
    const crossed = await signSession(
      {},
      { key: issuers.cloudBuilder.signing },
    );
    const crossedResponse = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token: crossed.token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(crossedResponse.status).toBe(401);
    expect((await readError(crossedResponse)).error.code).toBe(
      "capability_invalid",
    );
  });

  test("missing agent type header -> 400 bad_request", async () => {
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", { token, body: museBody() }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("bad_request");
  });

  test("agent type outside the capability's list -> 403 agent_type_forbidden", async () => {
    const { token } = await signTurn({ agentTypes: ["general"] });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("agent_type_forbidden");
  });

  test("turn capability pinned to another model -> 403 execution_mismatch", async () => {
    const { token } = await signTurn({
      turn: {
        turnId: "t",
        conversationId: "c",
        execution: {
          engine: "stella",
          provider: "stella",
          model: CROF_ALIAS,
          reasoningEffort: "high",
        },
      },
    });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("execution_mismatch");
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("turn capability asking for more reasoning than admitted -> 403 execution_mismatch", async () => {
    const { token } = await signTurn({
      turn: {
        turnId: "t",
        conversationId: "c",
        execution: {
          engine: "stella",
          provider: "stella",
          model: MUSE_ALIAS,
          reasoningEffort: "low",
        },
      },
    });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody({ reasoning: { effort: "xhigh" } }),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("execution_mismatch");
  });

  test("stream: true -> 400 stream_unsupported", async () => {
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody({ stream: true }),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("stream_unsupported");
  });

  test("budget exhausted -> 402 budget_exhausted, nothing sent upstream", async () => {
    const { token } = await signSession({ budgetMicroCents: 10 });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(402);
    expect((await readError(response)).error.code).toBe("budget_exhausted");
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("request limit -> 429 request_limit after maxRequests", async () => {
    const { token } = await signSession({
      audience: "anonymous",
      maxRequests: 1,
    });
    const first = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "cf-connecting-ip": "203.0.113.9" }),
      }),
    );
    expect(first.status).toBe(200);
    const second = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "cf-connecting-ip": "203.0.113.9" }),
      }),
    );
    expect(second.status).toBe(429);
    expect((await readError(second)).error.code).toBe("request_limit");
    expect(ctx.harness.limiter.keys).toEqual(["203.0.113.9", "203.0.113.9"]);
  });

  test("anonymous per-IP limiter -> 429 rate_limited", async () => {
    ctx.harness.limiter.success = false;
    const { token } = await signSession({
      audience: "anonymous",
      maxRequests: 5,
    });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(429);
    expect((await readError(response)).error.code).toBe("rate_limited");
  });

  test("an anonymous hosting network is refused before relay gates", async () => {
    const { token } = await signSession({
      audience: "anonymous",
      maxRequests: 5,
    });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
        cf: { asn: 16_509, asOrganization: "Amazon.com, Inc." },
      }),
    );
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("sign_in_required");
    expect(ctx.harness.limiter.keys).toHaveLength(0);
    expect(ctx.harness.networkGate.objects.size).toBe(0);
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("a model without a price -> 500 internal", async () => {
    resetConfigCacheForTests();
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(configSnapshot({ prices: [] })),
    );
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(500);
    const body = await readError(response);
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toContain("has no price");
  });

  test("a relay path the model's provider does not serve -> 400 bad_request", async () => {
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: { model: CROF_ALIAS, input: [{ role: "user", content: "hi" }] },
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("bad_request");
  });

  test("unknown relay path -> 404 bad_request", async () => {
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/v1/embeddings", {
        token,
        body: {},
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe("managed lane: completion, metering, replay", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("assembles the Responses object, meters reported usage, settles, enqueues", async () => {
    const { token, claims } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-abc" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      status: string;
      output: unknown[];
    };
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);

    const upstream = ctx.fetchMock.callsTo("openrouter.ai")[0]!;
    expect(upstream.headers.get("authorization")).toBe(
      `Bearer ${OPENROUTER_KEY}`,
    );
    expect(upstream.headers.get("accept")).toBe("text/event-stream");
    expect(upstream.headers.has("x-stella-agent-type")).toBe(false);
    expect(upstream.headers.has("x-stella-request-id")).toBe(false);
    const sent = JSON.parse(upstream.body ?? "{}") as Record<string, unknown>;
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe(MUSE_RESOLVED);

    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(1);
    const event = ctx.harness.usageEvents[0] as GatewayUsageEvent;
    // 12 in @ $0.1/M + 4 text out @ $0.2/M + 3 reasoning @ $0.2/M = $2.6e-6 = 260 micro-cents.
    expect(event).toMatchObject({
      v: 1,
      requestId: "req-abc",
      capabilityId: claims.jti,
      kind: "session",
      deviceKeyHash: TEST_DEVICE_KEY_HASH,
      audience: "pro",
      agentType: "orchestrator",
      provider: "openrouter",
      protocol: "openai-responses",
      requestedModel: MUSE_ALIAS,
      resolvedModel: MUSE_RESOLVED,
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cachedInputTokens: 0,
        reasoningTokens: 3,
        reported: true,
      },
      chargedMicroCents: 260,
      outcome: "succeeded",
      networkClass: "unknown",
      upstreamStatus: 200,
      billable: true,
    });
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({
      spentMicroCents: 260,
      reservedMicroCents: 0,
      requests: 1,
    });
  });

  test("halves free hosting caps and records the network class", async () => {
    const relayAdmissions: Array<{ audience: string; capShare: number }> = [];
    Object.assign(ctx.harness.env, {
      NETWORK_GATE: {
        idFromName: (name: string) => ({ name, toString: () => name }),
        get: () => ({
          admitRelay: async (input: { audience: string; capShare: number }) => {
            relayAdmissions.push(input);
            return { ok: true };
          },
        }),
      },
    });
    const { token } = await signSession({ audience: "free" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "cf-connecting-ip": "203.0.113.50" }),
        cf: { asn: 16_509, asOrganization: "Amazon.com, Inc." },
      }),
    );
    expect(response.status).toBe(200);
    expect(relayAdmissions).toEqual([{ audience: "free", capShare: 0.5 }]);
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents[0]).toMatchObject({
      audience: "free",
      networkClass: "hosting",
    });
  });

  test("replays a completed result for the same request id without calling upstream again", async () => {
    const { token } = await signSession();
    const request = () =>
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-replay" }),
      });
    const first = await ctx.run(request());
    const firstBody = await first.text();
    const second = await ctx.run(request());
    expect(second.status).toBe(200);
    expect(second.headers.get(GATEWAY_REPLAY_HEADER)).toBe("1");
    expect(await second.text()).toBe(firstBody);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(1);
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(1);
  });

  test("a concurrent request with the same id is stopped by the owner gate", async () => {
    const { token } = await signSession();
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      async (call) => {
        // Hold the first request open until the second has been answered.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return sseResponse(responsesFixture());
      },
    );
    const request = () =>
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-race" }),
      });
    const firstPromise = ctx.run(request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await ctx.run(request());
    // The owner gate passes the duplicate id through; the capability ledger
    // owns idempotency and reports the request as still in flight.
    expect(second.status).toBe(409);
    const error = await readError(second);
    expect(error.error).toMatchObject({ retryable: true });
    expect((await firstPromise).status).toBe(200);
    // The retry must not have released the first request's slot early: a
    // fresh id is admitted only once the first request has finished.
    const third = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-after-race" }),
      }),
    );
    expect(third.status).toBe(200);
  });

  test("assembles a ChatCompletion from Crof and bills the provider-exact cost", async () => {
    const { token, claims } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/chat/completions", {
        token,
        body: {
          model: CROF_ALIAS,
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        },
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe("Hi there");
    const upstream = ctx.fetchMock.callsTo("crof.ai")[0]!;
    const sent = JSON.parse(upstream.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("deepseek-v4-flash-0731");
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    await ctx.harness.flush();
    const event = ctx.harness.usageEvents[0] as GatewayUsageEvent;
    expect(event).toMatchObject({
      provider: "crof",
      protocol: "openai-completions",
      resolvedModel: CROF_RESOLVED,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        costMicroCents: 1_000,
        reported: true,
      },
      chargedMicroCents: 1_000,
      outcome: "succeeded",
    });
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({
      spentMicroCents: 1_000,
      reservedMicroCents: 0,
    });
  });

  test("a provider 429 passes through scrubbed and settles as failed with zero usage", async () => {
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () =>
        json(
          {
            error: {
              message: `Rate limited for key ${OPENROUTER_KEY}`,
              code: 429,
              metadata: { headers: { authorization: "Bearer leaked" } },
            },
          },
          429,
        ),
    );
    const { token, claims } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).not.toContain(OPENROUTER_KEY);
    expect(text).not.toContain("leaked");
    expect(JSON.parse(text)).toEqual({
      error: {
        message: "Rate limited for key [redacted]",
        code: 429,
        metadata: {},
      },
    });
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents[0]).toMatchObject({
      outcome: "failed",
      chargedMicroCents: 0,
      upstreamStatus: 429,
      usage: { reported: false },
    });
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({
      spentMicroCents: 0,
      reservedMicroCents: 0,
    });
    expect(await ledger.replay({ requestId: "anything" })).toBeNull();
  });

  test("a provider failure before output refunds the capability request count", async () => {
    let providerCalls = 0;
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () => {
        providerCalls += 1;
        return providerCalls === 1
          ? json({ error: { message: "busy" } }, 429)
          : sseResponse(responsesFixture());
      },
    );
    const { token, claims } = await signSession({ maxRequests: 1 });
    const first = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "refund-first" }),
      }),
    );
    expect(first.status).toBe(429);
    const second = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "refund-second" }),
      }),
    );
    expect(second.status).toBe(200);
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({ requests: 1 });
  });

  test("aborts an SSE stream when its running cost crosses the capability budget", async () => {
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () =>
        sseResponse(
          sseText([
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                delta: "x".repeat(40),
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                delta: "this frame must never be needed",
              },
            },
          ]),
          { chunkSize: 4_096 },
        ),
    );
    const { token, claims } = await signSession({ budgetMicroCents: 100 });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody({ max_output_tokens: 1 }),
        headers: agentHeaders({ "x-stella-request-id": "hard-stop" }),
      }),
    );
    expect(response.status).toBe(402);
    expect((await readError(response)).error).toMatchObject({
      code: "budget_exhausted",
      quota: { scope: "capability" },
    });
    expect(ctx.fetchMock.callsTo("openrouter.ai")[0]!.signal?.aborted).toBe(
      true,
    );
    await ctx.harness.flush();
    const event = ctx.harness.usageEvents[0] as GatewayUsageEvent;
    expect(event).toMatchObject({
      requestId: "hard-stop",
      outcome: "failed",
      usage: { reported: false },
    });
    expect(event.usage.outputTokens).toBeGreaterThan(0);
    expect(event.chargedMicroCents).toBeGreaterThan(100);
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({
      requests: 1,
      spentMicroCents: event.chargedMicroCents,
      reservedMicroCents: 0,
    });
  });

  test("runs enforcement, network, owner, tier, and ledger admission in order", async () => {
    const order: string[] = [];
    const namespace = (stub: object) => ({
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => stub,
    });
    Object.assign(ctx.harness.env, {
      OWNER_ENFORCEMENT: {
        get: async () => {
          order.push("enforcement");
          return null;
        },
      },
      NETWORK_GATE: namespace({
        admitRelay: async () => {
          order.push("network");
          return { ok: true };
        },
      }),
      OWNER_RELAY_GATE: namespace({
        admitRelay: async () => {
          order.push("owner");
          return { ok: true };
        },
        releaseRelay: async () => {
          order.push("owner-release");
        },
      }),
      TIER_BUDGET: namespace({
        reserve: async () => {
          order.push("tier");
          return { ok: true, minute: 1 };
        },
        settle: async () => {
          order.push("tier-settle");
        },
      }),
      CAPABILITY_LEDGER: namespace({
        reserve: async () => {
          order.push("ledger");
          return { kind: "reserved", remainingMicroCents: 1_000_000 };
        },
        settle: async () => ({
          ok: true,
          spentMicroCents: 1,
          reservedMicroCents: 0,
          cached: true,
        }),
      }),
    });
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/config",
      () =>
        json(
          configSnapshot({
            tierCeilings: [
              {
                audience: "free",
                hourlyMicroCents: 1_000_000,
                dailyMicroCents: 10_000_000,
              },
            ],
          }),
        ),
    );
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () => {
        order.push("provider");
        return sseResponse(responsesFixture());
      },
    );
    const { token } = await signSession({ audience: "free" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "cf-connecting-ip": "203.0.113.44" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(order.slice(0, 6)).toEqual([
      "enforcement",
      "network",
      "owner",
      "tier",
      "ledger",
      "provider",
    ]);
    expect(order).toContain("tier-settle");
    expect(order.at(-1)).toBe("owner-release");
  });

  test("a provider 401 is reported as 502 upstream_error, never as the caller's problem", async () => {
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () => json({ error: { message: "bad key" } }, 401),
    );
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(502);
    expect((await readError(response)).error).toMatchObject({
      code: "upstream_error",
      upstreamStatus: 401,
    });
  });

  test("a stream that ends without a terminal event -> 502 upstream_error, no cached result", async () => {
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      () =>
        sseResponse(
          sseText([
            {
              event: "response.created",
              data: { type: "response.created", response: { id: "r" } },
            },
          ]),
        ),
    );
    const { token, claims } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-trunc" }),
      }),
    );
    expect(response.status).toBe(502);
    expect((await readError(response)).error).toMatchObject({
      code: "upstream_error",
      retryable: true,
    });
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.replay({ requestId: "req-trunc" })).toBeNull();
  });

  test("client abort -> upstream aborted, settled as aborted charging the estimate", async () => {
    const abort = new AbortController();
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      (call) => {
        setTimeout(() => abort.abort(), 10);
        return hangingSseResponse(
          sseText([
            {
              event: "response.created",
              data: { type: "response.created", response: { id: "r" } },
            },
          ]),
          call.signal,
        );
      },
    );
    const { token, claims } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "req-abort" }),
        signal: abort.signal,
      }),
    );
    expect(response.status).toBe(499);
    expect((await readError(response)).error.code).toBe("canceled");
    expect(ctx.fetchMock.callsTo("openrouter.ai")[0]!.signal?.aborted).toBe(
      true,
    );
    await ctx.harness.flush();
    const event = ctx.harness.usageEvents[0] as GatewayUsageEvent;
    expect(event.outcome).toBe("aborted");
    expect(event.usage.reported).toBe(false);
    expect(event.chargedMicroCents).toBeGreaterThan(0);
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({
      spentMicroCents: event.chargedMicroCents,
      reservedMicroCents: 0,
    });
    expect(await ledger.replay({ requestId: "req-abort" })).toBeNull();
  });

  test("client abort before the first provider byte refunds the request count", async () => {
    let providerCalls = 0;
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      (call) => {
        providerCalls += 1;
        if (providerCalls > 1) return sseResponse(responsesFixture());
        return new Promise<Response>((_resolve, reject) => {
          const rejectAborted = () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          if (call.signal?.aborted) rejectAborted();
          else
            call.signal?.addEventListener("abort", rejectAborted, {
              once: true,
            });
        });
      },
    );
    const abort = new AbortController();
    const { token, claims } = await signSession({ maxRequests: 1 });
    setTimeout(() => abort.abort(), 5);
    const canceled = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "abort-before-byte" }),
        signal: abort.signal,
      }),
    );
    expect(canceled.status).toBe(499);
    const retry = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "after-abort" }),
      }),
    );
    expect(retry.status).toBe(200);
    const ledger = ctx.harness.ledger.namespace.get({ name: claims.jti });
    expect(await ledger.snapshot()).toMatchObject({ requests: 1 });
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents[0]).toMatchObject({
      requestId: "abort-before-byte",
      outcome: "aborted",
      chargedMicroCents: 0,
    });
  });

  test("the probe secret grants a synthetic pro capability with no ledger and no usage events", async () => {
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        body: museBody(),
        headers: agentHeaders({ "x-stella-relay-probe-secret": PROBE_SECRET }),
      }),
    );
    expect(response.status).toBe(200);
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);

    const wrong = await ctx.run(
      relayRequest("/v1/relay/responses", {
        body: museBody(),
        headers: agentHeaders({ "x-stella-relay-probe-secret": "nope" }),
      }),
    );
    expect(wrong.status).toBe(401);
  });
});

describe("POST /v1/models/resolve", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("resolves an alias for the capability's audience", async () => {
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v1/models/resolve", {
        token,
        body: { model: CROF_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as GatewayModelResolution).toEqual({
      requestedModel: CROF_ALIAS,
      resolvedModel: CROF_RESOLVED,
      provider: "crof",
      protocol: "openai-completions",
      reasoning: true,
      supportsImages: false,
    });
  });

  test("resolve verifies session proof over its own path and supports an empty request-id component", async () => {
    const { token } = await signSession();
    const request = () =>
      relayRequest("/v1/models/resolve", {
        token,
        body: { model: CROF_ALIAS, agentType: "orchestrator" },
      });

    const missing = await ctx.runRaw(request());
    expect(missing.status).toBe(401);
    expect((await readError(missing)).error.code).toBe("dpop_invalid");

    const noRequestId = await withTestDpop(request(), { requestId: null });
    expect(noRequestId.headers.has("x-stella-request-id")).toBe(false);
    expect((await ctx.runRaw(noRequestId)).status).toBe(200);
  });

  test("a restricted audience falls back to the agent default; a turn capability fails closed", async () => {
    const free = await signSession({ audience: "free" });
    const fallback = await ctx.run(
      relayRequest("/v1/models/resolve", {
        token: free.token,
        body: { model: "stella/openai/gpt-5.6-sol", agentType: "orchestrator" },
      }),
    );
    expect(fallback.status).toBe(200);
    expect((await fallback.json()) as GatewayModelResolution).toMatchObject({
      requestedModel: "stella/default",
      resolvedModel: MUSE_RESOLVED,
      provider: "openrouter",
      protocol: "openai-responses",
      supportsImages: false,
    });

    const proFallback = await signSession({ audience: "pro_fallback" });
    const fallbackPicker = await ctx.run(
      relayRequest("/v1/models/resolve", {
        token: proFallback.token,
        body: { model: CROF_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(fallbackPicker.status).toBe(200);
    expect(
      (await fallbackPicker.json()) as GatewayModelResolution,
    ).toMatchObject({
      requestedModel: "stella/default",
      resolvedModel: MUSE_RESOLVED,
    });

    const turn = await signTurn();
    const mismatch = await ctx.run(
      relayRequest("/v1/models/resolve", {
        token: turn.token,
        body: { model: CROF_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(mismatch.status).toBe(403);
    expect((await readError(mismatch)).error.code).toBe("execution_mismatch");

    const pinned = await ctx.run(
      relayRequest("/v1/models/resolve", {
        token: turn.token,
        body: { model: MUSE_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(pinned.status).toBe(200);
  });

  test("GET /healthz", async () => {
    const response = await ctx.run(new Request("https://gateway.test/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("gateway phase timing", () => {
  test("waits for durable dispatch readiness before sending provider bytes", async () => {
    const ctx = setup();
    const { token } = await signTurn();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = handleRequest(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
      ctx.harness.env,
      fakeExecutionContext(),
      {
        ...ctx.harness.deps(ctx.fetchMock.fetch),
        beforeProviderDispatch: async () => {
          entered();
          await durable;
        },
      },
    );
    try {
      await waiting;
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
      release();
      expect((await work).status).toBe(200);
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(1);
    } finally {
      release();
    }
  });
  test("reports completion after awaited cleanup, with actual stream milestones and no payload", async () => {
    const ctx = setup();
    let releaseEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });
    let finishRelease!: () => void;
    const release = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    Object.assign(ctx.harness.env, {
      OWNER_RELAY_GATE: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          admitRelay: async () => ({ ok: true }),
          releaseRelay: async () => {
            releaseEntered();
            await release;
          },
        }),
      },
    });
    const events: Array<
      ReturnType<RelayTiming["snapshot"]> & { event: string; traceId: string }
    > = [];
    const logger = spyOn(console, "info").mockImplementation((line) => {
      if (typeof line === "string") events.push(JSON.parse(line));
    });
    try {
      const { token } = await signTurn();
      const responseWork = ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders(),
        }),
      );
      await entered;
      expect(
        events.filter((event) => event.event === "gateway_relay_timing"),
      ).toHaveLength(0);
      finishRelease();
      const response = await responseWork;
      expect(response.status).toBe(200);
      const timing = events.find(
        (event) => event.event === "gateway_relay_timing",
      );
      expect(timing).toBeDefined();
      expect(timing!.traceId).toBe(response.headers.get(GATEWAY_TRACE_HEADER));
      const m = timing!.milestonesMs;
      expect(m.providerDispatch).toBeGreaterThanOrEqual(m.authenticated);
      expect(m.providerDispatchReady).toBeGreaterThanOrEqual(
        m.providerDispatch,
      );
      expect(m.firstUpstreamByte).toBeGreaterThanOrEqual(m.upstreamHeaders);
      expect(m.upstreamBodyComplete).toBeGreaterThanOrEqual(
        m.firstUpstreamByte,
      );
      expect(m.resultPersisted).toBeGreaterThanOrEqual(m.assemblyComplete);
      expect(timing!.elapsedMs).toBeGreaterThanOrEqual(m.resultPersisted);
      expect(timing!.durationsMs.ownerReleaseMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(events)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain("Hello there");
    } finally {
      finishRelease();
      logger.mockRestore();
    }
  });
  test("authentication refusals produce timing without imaginary provider milestones", async () => {
    const ctx = setup();
    const events: Array<
      ReturnType<RelayTiming["snapshot"]> & { event: string; traceId: string }
    > = [];
    const logger = spyOn(console, "info").mockImplementation((line) => {
      if (typeof line === "string") events.push(JSON.parse(line));
    });
    try {
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", { body: museBody() }),
      );
      expect(response.status).toBe(401);
      expect(events[0]).toMatchObject({
        event: "gateway_relay_timing",
        status: 401,
        milestonesMs: {},
      });
    } finally {
      logger.mockRestore();
    }
  });
});

describe("atomic owner relay accounting", () => {
  test("new scope uses the existing owner gate and preserves capability/generation replay isolation", async () => {
    const ctx = setup();
    const first = await signTurn({ ledgerScope: "owner-relay-v2" });
    const second = await signTurn({
      ledgerScope: "owner-relay-v2",
      gen: "next-generation",
    });
    const send = (token: string) =>
      ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders({ "x-stella-request-id": "same-id" }),
        }),
      );
    expect((await send(first.token)).status).toBe(200);
    expect((await send(second.token)).status).toBe(200);
    expect((await send(first.token)).headers.get(GATEWAY_REPLAY_HEADER)).toBe(
      "1",
    );
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(2);
    expect(ctx.harness.ledger.objects.size).toBe(0);
  });
});

describe("owner-local model execution", () => {
  test("bootstraps authoritative enforcement once for repeated owner requests", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const send = () =>
      ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders(),
        }),
      );
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      ),
    ).toHaveLength(1);
    expect(
      ctx.harness.enforcementCalls.filter((call) => call.kind === "get"),
    ).toHaveLength(0);
  });

  test("upgrades a legacy KV-seeded marker through the authoritative read", async () => {
    const ctx = setup();
    seedLegacyEnforcement(ownerStateFor(ctx));
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () =>
        json({ enforcement: { status: "suspended" }, updatedAt: Date.now() }),
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      ),
    ).toHaveLength(1);
  });

  test("does not let a delayed push certify a newer legacy seed", async () => {
    const ctx = setup();
    const owner = ownerFor(ctx);
    const staleUpdatedAt = seedLegacyEnforcement(ownerStateFor(ctx));
    await owner.applyOwnerEnforcement({
      status: "ok",
      updatedAt: staleUpdatedAt - 1,
      expiresAt: staleUpdatedAt + 7 * 24 * 60 * 60 * 1_000,
    });
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () =>
        json({ enforcement: { status: "suspended" }, updatedAt: Date.now() }),
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    expect(
      (
        await ctx.run(
          relayRequest("/v1/relay/responses", {
            token,
            body: museBody(),
            headers: agentHeaders(),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      ),
    ).toHaveLength(1);
  });

  test("uses authoritative suspension state rather than an eventual KV mirror", async () => {
    const ctx = setup();
    ctx.harness.enforcementValues.set(
      OWNER_ID,
      JSON.stringify({ status: "ok", updatedAt: 1 }),
    );
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () =>
        json({
          enforcement: { status: "suspended" },
          updatedAt: Date.now() - 1_000,
        }),
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
    expect(
      ctx.harness.enforcementCalls.filter((call) => call.kind === "get"),
    ).toHaveLength(0);
  });

  test("keeps the seven-day expiry anchored to the authoritative update", async () => {
    const ctx = setup();
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () =>
        json({
          enforcement: { status: "suspended" },
          updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1_000 - 1,
        }),
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    expect(
      (
        await ctx.run(
          relayRequest("/v1/relay/responses", {
            token,
            body: museBody(),
            headers: agentHeaders(),
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("fails closed on malformed authoritative enforcement", async () => {
    const responses = [
      { enforcement: { status: "suspended" }, updatedAt: "not-a-timestamp" },
      { enforcement: { status: "unknown" }, updatedAt: Date.now() },
      {
        enforcement: { status: "ok", until: "not-a-timestamp" },
        updatedAt: Date.now(),
      },
      { enforcement: { status: "ok", reason: 1 }, updatedAt: Date.now() },
      { enforcement: { status: "suspended" }, updatedAt: null },
    ];
    for (const body of responses) {
      const ctx = setup();
      ctx.fetchMock.on(
        (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
        () => json(body),
      );
      const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders(),
        }),
      );
      expect(response.status).toBe(500);
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
    }
  });

  test("uses ordered durable enforcement without an authoritative read after push", async () => {
    const ctx = setup();
    const owner = ownerFor(ctx);
    const expiresAt = Date.now() + 60_000;
    await owner.applyOwnerEnforcement({
      status: "suspended",
      updatedAt: 20,
      expiresAt,
    });
    expect(
      await owner.applyOwnerEnforcement({
        status: "ok",
        updatedAt: 21,
        expiresAt,
      }),
    ).toMatchObject({ status: "ok", updatedAt: 21 });
    expect(
      await owner.applyOwnerEnforcement({
        status: "suspended",
        updatedAt: 20,
        expiresAt,
      }),
    ).toMatchObject({ status: "ok", updatedAt: 21 });

    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      ),
    ).toHaveLength(0);
  });

  test("an expired durable suspension allows dispatch but rejects stale revival", async () => {
    const ctx = setup();
    const owner = ownerFor(ctx);
    await owner.applyOwnerEnforcement({
      status: "suspended",
      updatedAt: 30,
      expiresAt: Date.now() - 1,
    });
    expect(
      await owner.applyOwnerEnforcement({
        status: "suspended",
        updatedAt: 29,
        expiresAt: Date.now() + 60_000,
      }),
    ).toMatchObject({ updatedAt: 30 });
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    expect(
      (
        await ctx.run(
          relayRequest("/v1/relay/responses", {
            token,
            body: museBody(),
            headers: agentHeaders(),
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("fails closed when the one-time enforcement bootstrap fails", async () => {
    const ctx = setup();
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      () => {
        throw new Error("Convex unavailable");
      },
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(500);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("a push arriving during bootstrap wins over the delayed authoritative read", async () => {
    const ctx = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    ctx.fetchMock.on(
      (call) => call.url.pathname === CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
      async () => {
        entered.resolve();
        return await release.promise;
      },
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const pending = ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    await entered.promise;
    const owner = ownerFor(ctx);
    await owner.applyOwnerEnforcement({
      status: "ok",
      updatedAt: 41,
      expiresAt: Date.now() + 60_000,
    });
    release.resolve(
      json({
        enforcement: { status: "suspended" },
        updatedAt: 40,
      }),
    );
    expect((await pending).status).toBe(200);
  });

  test("a pre-arrival cancellation tombstone blocks the exact request before provider dispatch", async () => {
    const ctx = setup();
    const { token, claims } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const identity = managedCancellationIdentity({
      claims,
      requestId: "req-pre-cancel",
    });
    if (!identity) throw new Error("expected managed cancellation identity");
    const owner = ownerFor(ctx);
    expect(await owner.cancelManagedRequest(identity)).toEqual({
      canceled: true,
    });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": identity.requestId }),
      }),
    );
    expect(response.status).toBe(499);
    expect((await readError(response)).error.code).toBe("canceled");
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("cancellation after local authentication aborts the matching upstream only", async () => {
    const ctx = setup();
    const upstreamStarted = Promise.withResolvers<void>();
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamStarted.resolve();
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (call.signal?.aborted) abort();
          else call.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const { token, claims } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const requestId = "req-active-cancel";
    const identity = managedCancellationIdentity({ claims, requestId });
    if (!identity) throw new Error("expected managed cancellation identity");
    const pending = ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": requestId }),
      }),
    );
    await upstreamStarted.promise;
    const owner = ownerFor(ctx);
    expect(await owner.cancelManagedRequest(identity)).toEqual({
      canceled: true,
    });
    const response = await pending;
    expect(response.status).toBe(499);
    expect((await readError(response)).error.code).toBe("canceled");
    expect(ctx.harness.usageEvents[0]).toMatchObject({ outcome: "aborted" });
  });

  test("the live cancellation controller remains registered until the response body settles", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const owner = ownerFor(ctx);
    const release = spyOn(owner, "releaseManagedRequest");
    try {
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", {
          token,
          body: museBody(),
          headers: agentHeaders({
            "x-stella-request-id": "req-response-settle",
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(release).not.toHaveBeenCalled();
      await response.text();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      release.mockRestore();
    }
  });

  test("cancellation identity is isolated by owner, generation, capability, turn, and request", async () => {
    const ctx = setup();
    const { claims } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const identity = managedCancellationIdentity({
      claims,
      requestId: "req-one",
    });
    if (!identity) throw new Error("expected managed cancellation identity");
    const owner = ownerFor(ctx);
    expect(
      await owner.cancelManagedRequest({ ...identity, ownerId: "wrong|owner" }),
    ).toEqual({ canceled: false });
    expect(await owner.cancelManagedRequest(identity)).toEqual({
      canceled: true,
    });
    for (const changed of [
      { ...identity, requestId: "req-two" },
      { ...identity, capabilityId: `${identity.capabilityId}-other` },
      { ...identity, ownerGeneration: `${identity.ownerGeneration}-other` },
      { ...identity, turnId: `${identity.turnId}-other` },
    ]) {
      const begun = owner.beginManagedRequest(changed);
      expect(begun.canceled).toBe(false);
      if (!begun.canceled) owner.releaseManagedRequest(begun.key);
    }
    const retryIdentity = { ...identity, requestId: "req-retry" };
    const firstRetry = owner.beginManagedRequest(retryIdentity);
    const secondRetry = owner.beginManagedRequest(retryIdentity);
    if (firstRetry.canceled || secondRetry.canceled) {
      throw new Error("active retry should not be pre-canceled");
    }
    owner.releaseManagedRequest(secondRetry.key);
    await owner.cancelManagedRequest(retryIdentity);
    expect(firstRetry.signal.aborted).toBe(true);
    owner.releaseManagedRequest(firstRetry.key);
    expect(owner.beginManagedRequest(identity)).toEqual({ canceled: true });
  });

  test("rejects a capability routed to another owner object before provider or accounting work", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const wrong = ctx.harness.ownerGate.namespace.get({ name: "wrong-owner" });
    const response = await wrong.fetch(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(403);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
    expect(ctx.harness.usageEvents).toHaveLength(0);
  });

  test("direct owner binding still authenticates and preserves exact request replay", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const gate = ownerFor(ctx);
    const request = (bearer?: string) =>
      relayRequest("/v1/relay/responses", {
        token: bearer,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "direct-owner-replay" }),
      });
    expect((await gate.fetch(request())).status).toBe(401);
    const parts = token.split(".");
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    expect((await gate.fetch(request(parts.join(".")))).status).toBe(401);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
    const first = await gate.fetch(request(token));
    expect(first.status).toBe(200);
    const body = await first.text();
    const replay = await gate.fetch(request(token));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(body);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(1);
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(1);
  });

  test("rejects unscoped capabilities and non-relay endpoints at the owner executor", async () => {
    const ctx = setup();
    const { token } = await signTurn();
    const gate = ownerFor(ctx);
    const unscoped = await gate.fetch(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(unscoped.status).toBe(403);
    expect(
      (await gate.fetch(new Request("https://gateway.test/healthz"))).status,
    ).toBe(404);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("canceling a forwarded request aborts the provider and settles the same owner ledger", async () => {
    const ctx = setup();
    const abort = new AbortController();
    ctx.fetchMock.on(
      (call) => call.url.host === "openrouter.ai",
      (call) => {
        setTimeout(() => abort.abort(), 10);
        return hangingSseResponse(
          sseText([
            {
              event: "response.created",
              data: { type: "response.created", response: { id: "r" } },
            },
          ]),
          call.signal,
        );
      },
    );
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ "x-stella-request-id": "owner-abort" }),
        signal: abort.signal,
      }),
    );
    expect(response.status).toBe(499);
    expect(ctx.fetchMock.callsTo("openrouter.ai")[0]!.signal?.aborted).toBe(
      true,
    );
    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(1);
    expect(ctx.harness.usageEvents[0]).toMatchObject({ outcome: "aborted" });
    expect(ctx.harness.ledger.objects.size).toBe(0);
    // Every slot is reusable after cancellation. A leaked admission would
    // reject the eighth request for this owner's Pro concurrency limit.
    const gate = ownerFor(ctx);
    for (let i = 0; i < 8; i++)
      expect(
        (
          await gate.admitRelay({
            audience: "pro",
            requestId: `after-abort-${i}`,
            throttled: false,
          })
        ).ok,
      ).toBe(true);
  });
});

describe("validated descriptor relay", () => {
  test("rejects a changed descriptor before any accounting or provider request", async () => {
    const ctx = setup();
    const { token } = await signSession();
    const response = await ctx.run(
      relayRequest("/v2/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({ [GATEWAY_MODEL_REVISION_HEADER]: "v1:old" }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe(
      "model_revision_mismatch",
    );
    expect(response.headers.get("x-should-retry")).toBe("false");
    const encoded = response.headers.get(GATEWAY_MODEL_RESOLUTION_HEADER);
    expect(encoded).toBeTruthy();
    const descriptor = JSON.parse(decodeURIComponent(encoded!));
    expect(descriptor.requestedModel).toBe(MUSE_ALIAS);
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.harness.networkGate.objects.size).toBe(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });

  test("versioned routes require a descriptor and valid descriptors retain normal relay behavior", async () => {
    const ctx = setup();
    const { token } = await signSession();
    const missing = await ctx.run(
      relayRequest("/v2/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(missing.status).toBe(400);
    const descriptor = resolveManagedModelDescriptor({
      agentType: "orchestrator",
      requestedModel: MUSE_ALIAS,
      audience: "pro",
    });
    const response = await ctx.run(
      relayRequest("/v2/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({
          [GATEWAY_MODEL_REVISION_HEADER]:
            await gatewayModelResolutionRevision(descriptor),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(1);
  });
});

describe("acknowledged owner preparation", () => {
  test("owner preparation restores shared config after enforcement was already pushed", async () => {
    const snapshot = completeConfigSnapshot();
    const record: SharedGatewayConfigRecord = {
      version: 1,
      source: "https://outgoing-bulldog-865.convex.site",
      originalFetchedAt: Date.now() - 1_000,
      revision: await gatewayConfigRevision(snapshot),
      snapshot,
    };
    let sharedReads = 0;
    const ctx = setup({
      CONFIG_SNAPSHOT: {
        get: async () => {
          sharedReads += 1;
          return record;
        },
      },
    });
    const owner = ownerFor(ctx);
    await owner.applyOwnerEnforcement({
      status: "ok",
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await owner.prepare(OWNER_ID, "shared-prepare-test");
    expect(sharedReads).toBe(1);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/config",
      ),
    ).toHaveLength(0);
  });

  test("prepare waits for owner completion while resolve stays nonblocking, without accounting", async () => {
    for (const path of [GATEWAY_PREPARE_PATH, "/v1/models/resolve"]) {
      const ctx = setup();
      const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
      const owner = ownerFor(ctx);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const prepare = spyOn(owner, "prepare").mockImplementation(
        async (ownerId, traceId) => {
          expect(ownerId).toBe(OWNER_ID);
          expect(traceId).toBeTruthy();
          started.resolve();
          await release.promise;
        },
      );
      const admission = spyOn(owner, "admitRelay");
      const reservation = spyOn(owner, "admitAndReserve");
      let completed = false;
      const pending = ctx
        .run(
          relayRequest(path, {
            token,
            body: { model: MUSE_ALIAS, agentType: "orchestrator" },
          }),
        )
        .then((response) => {
          completed = true;
          return response;
        });
      await started.promise;
      if (path === GATEWAY_PREPARE_PATH) expect(completed).toBe(false);
      else expect((await pending).status).toBe(200);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        requestedModel: MUSE_ALIAS,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(admission).not.toHaveBeenCalled();
      expect(reservation).not.toHaveBeenCalled();
      expect(ctx.harness.networkGate.objects.size).toBe(0);
      expect(ctx.harness.ledger.objects.size).toBe(0);
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
      prepare.mockRestore();
      admission.mockRestore();
      reservation.mockRestore();
    }
  });

  test("prepare reports preparation failure instead of acknowledging success", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const owner = ownerFor(ctx);
    const prepare = spyOn(owner, "prepare").mockRejectedValue(
      new GatewayError(
        503,
        "internal",
        "Model pricing is temporarily unavailable.",
      ),
    );
    try {
      const response = await ctx.run(
        relayRequest(GATEWAY_PREPARE_PATH, {
          token,
          body: { model: MUSE_ALIAS, agentType: "orchestrator" },
        }),
      );
      expect(response.status).toBe(503);
      expect((await readError(response)).error.code).toBe("internal");
      expect(ctx.harness.ledger.objects.size).toBe(0);
      expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
    } finally {
      prepare.mockRestore();
    }
  });

  test("invalid admission or agent selection cannot trigger preparation", async () => {
    const ctx = setup();
    const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
    const missing = await ctx.run(
      relayRequest(GATEWAY_PREPARE_PATH, {
        body: { model: MUSE_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(missing.status).toBe(401);
    const mismatch = await ctx.run(
      relayRequest(GATEWAY_PREPARE_PATH, {
        token,
        body: { model: CROF_ALIAS, agentType: "orchestrator" },
      }),
    );
    expect(mismatch.status).toBe(403);
    const forbidden = await ctx.run(
      relayRequest(GATEWAY_PREPARE_PATH, {
        token,
        body: { model: MUSE_ALIAS, agentType: "general" },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(ctx.harness.ownerGate.objects.size).toBe(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });
});

test("cached owner result survives a paused tier", async () => {
  const ctx = setup();
  let ceiling = 100_000_000;
  ctx.fetchMock.on(
    (call) => call.url.pathname === "/api/gateway/config",
    () =>
      json(
        configSnapshot({
          tierCeilings: [
            {
              audience: "pro",
              hourlyMicroCents: ceiling,
              dailyMicroCents: ceiling,
            },
          ],
        }),
      ),
  );
  const { token } = await signTurn({ ledgerScope: "owner-relay-v2" });
  const send = () =>
    ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: museBody(),
        headers: agentHeaders({
          "x-stella-request-id": "review-replay-paused",
        }),
      }),
    );
  const first = await send();
  expect(first.status).toBe(200);
  const body = await first.text();
  ceiling = 0;
  resetConfigCacheForTests();
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(body);
  expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(1);
});
