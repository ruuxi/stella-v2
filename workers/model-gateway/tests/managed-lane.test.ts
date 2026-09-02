import { beforeEach, describe, expect, test } from "bun:test";
import {
  GATEWAY_TRACE_HEADER,
  type GatewayModelResolution,
} from "@stella/contracts/gateway/api";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import { resetCapabilityKeysForTests } from "../src/capability.js";
import { resetConfigCacheForTests } from "../src/config-cache.js";
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
  OPENROUTER_KEY,
  PROBE_SECRET,
  readError,
  relayRequest,
  signSession,
  signTurn,
  sseResponse,
  sseText,
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
          model: "meta/muse-spark-1.2-contributor",
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
  const run = (request: Request) =>
    handleRequest(
      request,
      harness.env,
      fakeExecutionContext(),
      harness.deps(fetchMock.fetch),
    );
  return { harness, fetchMock, run };
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

  test("a concurrent request with the same id while in flight -> 409 retryable", async () => {
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
    expect(second.status).toBe(409);
    const error = await readError(second);
    expect(error.error).toMatchObject({ code: "bad_request", retryable: true });
    expect((await firstPromise).status).toBe(200);
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
