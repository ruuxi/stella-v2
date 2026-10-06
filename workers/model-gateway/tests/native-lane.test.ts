import { beforeEach, describe, expect, test } from "bun:test";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import { GATEWAY_SUBSCRIPTION_LIMIT_HEADER } from "@stella/contracts/gateway/api";
import { resetCapabilityKeysForTests } from "../src/capability.js";
import { resetConfigCacheForTests } from "../src/config-cache.js";
import {
  resetEngineAccessCacheForTests,
  subscriptionLimitOf,
} from "../src/native-lane.js";
import { handleRequest } from "../src/router.js";
import {
  chunkedStream,
  createFetchMock,
  createTestEnv,
  fakeExecutionContext,
  json,
  OWNER_ID,
  readError,
  relayRequest,
  signSession,
  signTurn,
  sseText,
  withTestDpop,
} from "./helpers/env.js";

const chatGptTurn = (model = "gpt-5.6-sol") =>
  signTurn({
    credential: "chatgpt",
    turn: {
      turnId: "turn_chatgpt",
      conversationId: "conv_chatgpt",
      execution: {
        engine: "chatgpt",
        provider: "chatgpt",
        model,
        reasoningEffort: "medium",
      },
    },
  });

const chatGptBody = (model = "gpt-5.6-sol") => ({
  model,
  input: [{ role: "user", content: "hi" }],
  reasoning: { effort: "medium" },
  store: false,
  stream: true,
});

const setup = () => {
  resetConfigCacheForTests();
  resetCapabilityKeysForTests();
  resetEngineAccessCacheForTests();
  const harness = createTestEnv();
  const now = Date.now();
  const fetchMock = createFetchMock()
    .on(
      (call) => call.url.pathname === "/api/gateway/engine-access",
      () =>
        json({
          accessToken: "chatgpt-oauth-token",
          expiresAt: now + 3_600_000,
        }),
    )
    .on(
      (call) => call.url.host === "api.openai.com",
      () =>
        json(
          {
            id: "resp_chatgpt",
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 5,
              output_tokens: 9,
              total_tokens: 14,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
          200,
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

describe("native lane", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test("ChatGPT: bears the cloud's Sign in with ChatGPT token to the public Responses API, parses JSON usage best-effort", async () => {
    const { token } = await chatGptTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: {
          model: "gpt-5.6-sol",
          input: [{ role: "user", content: "hi" }],
          reasoning: { effort: "medium" },
          store: false,
          stream: true,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({
      id: "resp_chatgpt",
    });
    const upstream = ctx.fetchMock.callsTo("api.openai.com")[0]!;
    expect(upstream.url.href).toBe("https://api.openai.com/v1/responses");
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer chatgpt-oauth-token",
    );
    expect(JSON.parse(upstream.body ?? "{}")).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
    });

    await ctx.harness.flush();
    expect(ctx.harness.usageEvents[0] as GatewayUsageEvent).toMatchObject({
      provider: "openai",
      protocol: "openai-responses",
      billable: false,
      chargedMicroCents: 0,
      usage: {
        inputTokens: 5,
        outputTokens: 9,
        reasoningTokens: 2,
        reported: true,
      },
    });
  });

  test("ChatGPT at its usage limit: passes the 429 through, marked, and never switches", async () => {
    ctx.fetchMock.on(
      (call) => call.url.host === "api.openai.com",
      () =>
        json(
          {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Usage limit reached.",
            },
          },
          429,
        ),
    );
    const { token } = await chatGptTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", { token, body: chatGptBody() }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get(GATEWAY_SUBSCRIPTION_LIMIT_HEADER)).toBe(
      "chatgpt",
    );
    expect(ctx.fetchMock.callsTo("api.openai.com")).toHaveLength(1);
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/engine-access",
      ),
    ).toHaveLength(1);
  });

  test("an ordinary rate limit is not treated as a subscription limit", () => {
    expect(
      subscriptionLimitOf(
        429,
        JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
      ),
    ).toBe(false);
    expect(
      subscriptionLimitOf(
        429,
        JSON.stringify({
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        }),
      ),
    ).toBe(true);
    expect(subscriptionLimitOf(500, "{}")).toBe(false);
  });

  test("engine access is cached per owner+generation+provider until its expiry margin", async () => {
    const { token } = await chatGptTurn();
    const request = () =>
      relayRequest("/v1/relay/responses", { token, body: chatGptBody() });
    await ctx.run(request());
    await ctx.run(request());
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/engine-access",
      ),
    ).toHaveLength(1);
  });

  test("refusals: session capability, engine mismatch, model mismatch, wrong path, stale generation", async () => {
    const session = await signSession({ credential: "chatgpt" });
    const missingProof = await ctx.runRaw(
      relayRequest("/v1/relay/responses", {
        token: session.token,
        body: chatGptBody(),
      }),
    );
    expect(missingProof.status).toBe(401);
    expect((await readError(missingProof)).error.code).toBe("dpop_invalid");
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/engine-access",
      ),
    ).toHaveLength(0);

    const sessionResponse = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token: session.token,
        body: chatGptBody(),
      }),
    );
    expect(sessionResponse.status).toBe(403);
    expect((await readError(sessionResponse)).error.code).toBe(
      "execution_mismatch",
    );

    const crossed = await signTurn({
      credential: "chatgpt",
      turn: {
        turnId: "t",
        conversationId: "c",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "default",
        },
      },
    });
    const crossedResponse = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token: crossed.token,
        body: chatGptBody(),
      }),
    );
    expect((await readError(crossedResponse)).error.code).toBe(
      "execution_mismatch",
    );

    const { token } = await chatGptTurn("gpt-5.6-terra");
    const wrongModel = await ctx.run(
      relayRequest("/v1/relay/responses", { token, body: chatGptBody() }),
    );
    expect(wrongModel.status).toBe(403);
    expect((await readError(wrongModel)).error.code).toBe("execution_mismatch");

    const wrongPath = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: chatGptBody("gpt-5.6-terra"),
      }),
    );
    expect(wrongPath.status).toBe(400);
    expect((await readError(wrongPath)).error.code).toBe("bad_request");
    expect(ctx.fetchMock.callsTo("api.openai.com")).toHaveLength(0);

    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/engine-access",
      () =>
        json(
          {
            error: {
              code: "generation_stale",
              message: "stale",
              retryable: false,
            },
          },
          409,
        ),
    );
    const stale = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: chatGptBody("gpt-5.6-terra"),
      }),
    );
    expect(stale.status).toBe(403);
    expect((await readError(stale)).error.code).toBe("generation_stale");
  });

  test("billing control unreachable for engine access -> 503 retryable", async () => {
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/engine-access",
      () => new Response("down", { status: 503 }),
    );
    const { token } = await chatGptTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", { token, body: chatGptBody() }),
    );
    expect(response.status).toBe(503);
    expect((await readError(response)).error).toMatchObject({
      code: "internal",
      retryable: true,
    });
  });
});
