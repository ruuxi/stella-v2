import { beforeEach, describe, expect, test } from "bun:test";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import { CLAUDE_CODE_IDENTITY } from "@stella/model-catalog/native-relay";
import { resetCapabilityKeysForTests } from "../src/capability.js";
import { resetConfigCacheForTests } from "../src/config-cache.js";
import { resetEngineAccessCacheForTests } from "../src/native-lane.js";
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
  SERVICE_SECRET,
  signSession,
  signTurn,
  sseText,
  withTestDpop,
} from "./helpers/env.js";

const anthropicTurn = (
  model = "claude-sonnet-4-6",
  reasoningEffort: "default" | "high" | "none" = "default",
) =>
  signTurn({
    credential: "anthropic",
    agentTypes: ["orchestrator", "general"],
    turn: {
      turnId: "turn_native",
      conversationId: "conv_native",
      execution: {
        engine: "anthropic",
        provider: "anthropic",
        model,
        reasoningEffort,
      },
    },
  });

const codexTurn = () =>
  signTurn({
    credential: "openai-codex",
    turn: {
      turnId: "turn_codex",
      conversationId: "conv_codex",
      execution: {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      },
    },
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
      (call) => {
        const body = JSON.parse(call.body ?? "{}") as { provider: string };
        return json(
          body.provider === "anthropic"
            ? {
                accessToken: "sk-ant-oat01-owner-token",
                expiresAt: now + 3_600_000,
              }
            : {
                accessToken: "chatgpt-oauth-token",
                accountId: "acct_123",
                expiresAt: now + 3_600_000,
              },
        );
      },
    )
    .on(
      (call) => call.url.host === "api.anthropic.com",
      () =>
        new Response(
          chunkedStream(
            sseText([
              {
                event: "message_start",
                data: { type: "message_start", message: { id: "m" } },
              },
            ]),
          ),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "request-id": "req_anthropic_1",
              "set-cookie": "nope",
            },
          },
        ),
    )
    .on(
      (call) => call.url.host === "chatgpt.com",
      () =>
        json(
          {
            id: "resp_codex",
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

  test("Claude: swaps credentials, adds the Claude Code betas, pipes SSE untouched", async () => {
    const { token, claims } = await anthropicTurn();
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
    };
    const response = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token,
        body,
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
          "x-stella-request-id": "req-native-1",
          "cf-connecting-ip": "203.0.113.5",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("request-id")).toBe("req_anthropic_1");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe(
      sseText([
        {
          event: "message_start",
          data: { type: "message_start", message: { id: "m" } },
        },
      ]),
    );

    const access = ctx.fetchMock.calls.find(
      (call) => call.url.pathname === "/api/gateway/engine-access",
    )!;
    expect(access.headers.get("authorization")).toBe(
      `Bearer ${SERVICE_SECRET}`,
    );
    expect(JSON.parse(access.body ?? "{}")).toEqual({
      ownerId: OWNER_ID,
      ownerGeneration: "gen-1",
      provider: "anthropic",
    });

    const upstream = ctx.fetchMock.callsTo("api.anthropic.com")[0]!;
    expect(upstream.url.href).toBe("https://api.anthropic.com/v1/messages");
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-owner-token",
    );
    expect(upstream.headers.get("anthropic-beta")!.split(",")).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
    ]);
    expect(upstream.headers.get("x-app")).toBe("cli");
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    for (const name of [
      "x-stella-request-id",
      "cf-connecting-ip",
      "x-api-key",
    ]) {
      expect(upstream.headers.has(name)).toBe(false);
    }
    // Native bodies are never run through cross-provider shaping.
    expect(JSON.parse(upstream.body ?? "{}")).toEqual(body);

    await ctx.harness.flush();
    expect(ctx.harness.usageEvents).toHaveLength(1);
    expect(ctx.harness.usageEvents[0] as GatewayUsageEvent).toMatchObject({
      requestId: "req-native-1",
      capabilityId: claims.jti,
      kind: "turn",
      turnId: "turn_native",
      conversationId: "conv_native",
      provider: "anthropic",
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
      chargedMicroCents: 0,
      billable: false,
      outcome: "succeeded",
      upstreamStatus: 200,
      usage: { inputTokens: 0, outputTokens: 0, reported: false },
    });
    expect(ctx.harness.ledger.objects.size).toBe(0);
  });

  test("Claude: a stella/anthropic/ model gets the Claude Code identity prepended", async () => {
    const { token } = await anthropicTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: {
          model: "stella/anthropic/claude-sonnet-4-6",
          max_tokens: 10,
          system: "Be brief.",
          messages: [],
        },
      }),
    );
    expect(response.status).toBe(200);
    const sent = JSON.parse(
      ctx.fetchMock.callsTo("api.anthropic.com")[0]!.body ?? "{}",
    ) as Record<string, unknown>;
    expect(sent.model).toBe("claude-sonnet-4-6");
    expect(sent.system).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: "Be brief." },
    ]);
  });

  test("Codex: sets chatgpt-account-id, targets the Codex backend, parses JSON usage best-effort", async () => {
    const { token } = await codexTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: {
          model: "gpt-5.6-sol",
          input: [{ role: "user", content: "hi" }],
          reasoning: { effort: "medium" },
          stream: false,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({
      id: "resp_codex",
    });
    const upstream = ctx.fetchMock.callsTo("chatgpt.com")[0]!;
    expect(upstream.url.href).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer chatgpt-oauth-token",
    );
    expect(upstream.headers.get("chatgpt-account-id")).toBe("acct_123");
    expect(JSON.parse(upstream.body ?? "{}")).toMatchObject({
      model: "gpt-5.6-sol",
      stream: false,
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

  test("engine access is cached per owner+generation+provider until its expiry margin", async () => {
    const { token } = await anthropicTurn();
    const request = () =>
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: { model: "claude-sonnet-4-6", max_tokens: 1, messages: [] },
      });
    await ctx.run(request());
    await ctx.run(request());
    expect(
      ctx.fetchMock.calls.filter(
        (call) => call.url.pathname === "/api/gateway/engine-access",
      ),
    ).toHaveLength(1);
  });

  test("refusals: session capability, engine mismatch, model mismatch, wrong path, stale generation", async () => {
    const session = await signSession({ credential: "anthropic" });
    const missingProof = await ctx.runRaw(
      relayRequest("/v1/relay/v1/messages", {
        token: session.token,
        body: { model: "claude-sonnet-4-6", messages: [] },
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
      relayRequest("/v1/relay/v1/messages", {
        token: session.token,
        body: { model: "claude-sonnet-4-6", messages: [] },
      }),
    );
    expect(sessionResponse.status).toBe(403);
    expect((await readError(sessionResponse)).error.code).toBe(
      "execution_mismatch",
    );

    const crossed = await signTurn({
      credential: "anthropic",
      turn: {
        turnId: "t",
        conversationId: "c",
        execution: {
          engine: "openai-codex",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "default",
        },
      },
    });
    const crossedResponse = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token: crossed.token,
        body: { model: "claude-sonnet-4-6", messages: [] },
      }),
    );
    expect((await readError(crossedResponse)).error.code).toBe(
      "execution_mismatch",
    );

    const { token } = await anthropicTurn("claude-opus-5");
    const wrongModel = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: { model: "claude-sonnet-4-6", messages: [] },
      }),
    );
    expect(wrongModel.status).toBe(403);
    expect((await readError(wrongModel)).error.code).toBe("execution_mismatch");

    const wrongPath = await ctx.run(
      relayRequest("/v1/relay/responses", {
        token,
        body: { model: "claude-opus-5", messages: [] },
      }),
    );
    expect(wrongPath.status).toBe(400);
    expect((await readError(wrongPath)).error.code).toBe("bad_request");
    expect(ctx.fetchMock.callsTo("api.anthropic.com")).toHaveLength(0);

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
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: { model: "claude-opus-5", messages: [] },
      }),
    );
    expect(stale.status).toBe(403);
    expect((await readError(stale)).error.code).toBe("generation_stale");
  });

  test("Convex unreachable for engine access -> 503 retryable", async () => {
    ctx.fetchMock.on(
      (call) => call.url.pathname === "/api/gateway/engine-access",
      () => new Response("down", { status: 503 }),
    );
    const { token } = await anthropicTurn();
    const response = await ctx.run(
      relayRequest("/v1/relay/v1/messages", {
        token,
        body: { model: "claude-sonnet-4-6", messages: [] },
      }),
    );
    expect(response.status).toBe(503);
    expect((await readError(response)).error).toMatchObject({
      code: "internal",
      retryable: true,
    });
  });
});
