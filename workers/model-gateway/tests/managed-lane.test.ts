import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import {
  GATEWAY_TRACE_HEADER,
  type GatewayModelResolution,
} from "@stella/contracts/gateway/api";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import { resetCapabilityKeysForTests } from "../src/capability.js";
import { resetConfigCacheForTests } from "../src/config-cache.js";
import type { RelayTiming } from "../src/relay-timing.js";
import { GATEWAY_REPLAY_HEADER } from "../src/managed-lane.js";
import { handleRequest } from "../src/router.js";
import {
  configSnapshot,
  createFetchMock,
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

const setup = () => {
  resetConfigCacheForTests();
  resetCapabilityKeysForTests();
  const harness = createTestEnv();
  const fetchMock = createFetchMock()
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
      expect(events).toHaveLength(0);
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

describe("owner ledger rollout", () => {
  test("new capabilities share an owner object but replay only within their own jti", async () => {
    const ctx = setup();
    const first = await signTurn({ ledgerScope: "owner-v1" });
    const second = await signTurn({ ledgerScope: "owner-v1" });
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
    const replay = await send(first.token);
    expect(replay.headers.get(GATEWAY_REPLAY_HEADER)).toBe("1");
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(2);
    expect(ctx.harness.ownerLedger.objects.size).toBe(1);
    expect(ctx.harness.ledger.objects.size).toBe(0);
  });
  test("legacy capabilities keep their old object, and owner generations never share the new one", async () => {
    const ctx = setup();
    for (const claims of [
      {},
      { ledgerScope: "owner-v1" as const },
      { ledgerScope: "owner-v1" as const, gen: "rotated-generation" },
    ]) {
      const capability = await signTurn(claims);
      const response = await ctx.run(
        relayRequest("/v1/relay/responses", {
          token: capability.token,
          body: museBody(),
          headers: agentHeaders(),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(ctx.harness.ownerLedger.objects.size).toBe(2);
    expect(ctx.harness.ledger.objects.size).toBe(1);
  });
  test("a failed owner-ledger call never falls back into a fresh legacy budget", async () => {
    const ctx = setup();
    Object.assign(ctx.harness.env, {
      OWNER_CAPABILITY_LEDGER: {
        getByName: () => {
          throw new Error("unavailable");
        },
      },
    });
    const capability = await signTurn({ ledgerScope: "owner-v1" });
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token: capability.token,
        body: museBody(),
        headers: agentHeaders(),
      }),
    );
    expect(response.status).toBe(500);
    expect(ctx.harness.ledger.objects.size).toBe(0);
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(0);
  });
});


describe("atomic owner relay accounting", () => {
  test("new scope uses the existing owner gate and preserves capability/generation replay isolation", async () => {
    const ctx = setup();
    const first = await signTurn({ ledgerScope: "owner-relay-v2" });
    const second = await signTurn({ ledgerScope: "owner-relay-v2", gen: "next-generation" });
    const send = (token: string) => ctx.run(relayRequest("/v1/relay/responses", {
      token, body: museBody(), headers: agentHeaders({ "x-stella-request-id": "same-id" }),
    }));
    expect((await send(first.token)).status).toBe(200);
    expect((await send(second.token)).status).toBe(200);
    expect((await send(first.token)).headers.get(GATEWAY_REPLAY_HEADER)).toBe("1");
    expect(ctx.fetchMock.callsTo("openrouter.ai")).toHaveLength(2);
    expect(ctx.harness.ownerLedger.objects.size).toBe(0);
    expect(ctx.harness.ledger.objects.size).toBe(0);
  });
});
