import { describe, expect, it } from "bun:test";
import {
  BuilderTurnError,
  startBuilderAgentTurn,
  startBuilderTurn,
} from "../../convex/lib/builder_turns";

const endpoint = { url: "https://builder.test", secret: "service-secret" };

const capture = (
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return await responder(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
};

describe("startBuilderTurn", () => {
  it("posts the contract request with the service secret and owner headers", async () => {
    const { calls, fetchImpl } = capture(() =>
      Response.json(
        {
          protocol: 1,
          conversationId: "conv-1",
          turnId: "turn-1",
          accepted: true,
          replayed: false,
          createdConversation: true,
        },
        { status: 202 },
      ),
    );
    const result = await startBuilderTurn({
      endpoint,
      fetch: fetchImpl,
      ownerId: "owner-1",
      ownerGeneration: "gen-1",
      conversationId: "conv 1",
      request: {
        clientMsgId: "sched-fire-0001",
        prompt: "run the report",
        lane: "schedule",
        source: "schedule",
        title: "Daily report",
      },
    });
    expect(result).toEqual({
      protocol: 1,
      conversationId: "conv-1",
      turnId: "turn-1",
      accepted: true,
      replayed: false,
      createdConversation: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://builder.test/conversations/conv%201/turns",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer service-secret");
    expect(headers["x-stella-owner-id"]).toBe("owner-1");
    expect(headers["x-stella-owner-generation"]).toBe("gen-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      protocol: 1,
      clientMsgId: "sched-fire-0001",
      prompt: "run the report",
      lane: "schedule",
      source: "schedule",
      title: "Daily report",
    });
  });

  it("maps contract errors to typed, retryability-aware failures", async () => {
    const refused = capture(() =>
      Response.json(
        {
          error: {
            code: "generation_stale",
            message: "Generation changed.",
            retryable: false,
          },
        },
        { status: 403 },
      ),
    );
    const failure = await startBuilderTurn({
      endpoint,
      fetch: refused.fetchImpl,
      ownerId: "o",
      ownerGeneration: "g",
      conversationId: "c",
      request: { clientMsgId: "client-msg-0001", prompt: "x" },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BuilderTurnError);
    expect(failure).toMatchObject({
      code: "generation_stale",
      status: 403,
      retryable: false,
      message: "Generation changed.",
    });

    const outage = capture(() => new Response("bad gateway", { status: 502 }));
    const transient = await startBuilderTurn({
      endpoint,
      fetch: outage.fetchImpl,
      ownerId: "o",
      ownerGeneration: "g",
      conversationId: "c",
      request: { clientMsgId: "client-msg-0001", prompt: "x" },
    }).catch((error: unknown) => error);
    expect(transient).toMatchObject({
      code: "internal",
      status: 502,
      retryable: true,
    });

    const malformed = capture(() => Response.json({ accepted: true }));
    const bad = await startBuilderTurn({
      endpoint,
      fetch: malformed.fetchImpl,
      ownerId: "o",
      ownerGeneration: "g",
      conversationId: "c",
      request: { clientMsgId: "client-msg-0001", prompt: "x" },
    }).catch((error: unknown) => error);
    expect(bad).toMatchObject({ code: "internal", retryable: false });
  });

  it("fails fast when the builder is not configured", async () => {
    const { calls, fetchImpl } = capture(() => Response.json({}));
    const failure = await startBuilderTurn({
      endpoint: null,
      fetch: fetchImpl,
      ownerId: "o",
      ownerGeneration: "g",
      conversationId: "c",
      request: { clientMsgId: "client-msg-0001", prompt: "x" },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "unconfigured",
      status: 503,
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("startBuilderAgentTurn", () => {
  it("posts an agent turn to the session route and adopts the requested turn id", async () => {
    const { calls, fetchImpl } = capture(() =>
      Response.json({
        turnId: "turn-9",
        threadId: "thr-1",
        attemptGeneration: 1,
        replayed: true,
      }),
    );
    const result = await startBuilderAgentTurn({
      endpoint,
      fetch: fetchImpl,
      request: {
        ownerId: "owner-1",
        ownerGeneration: "gen-1",
        conversationId: "conv-1",
        threadId: "thr-1",
        attemptGeneration: 1,
        turnId: "turn-9",
        prompt: "do it",
        description: "Do it",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "default",
        },
        audience: "pro",
        budgetMicroCents: 1_000,
        source: "desktop",
        clientMsgId: "spawn-client-0001",
        originDeviceId: "desktop-1",
        originConversationId: "local-1",
      },
    });
    expect(result).toEqual({
      protocol: 1,
      threadId: "thr-1",
      turnId: "turn-9",
      attemptGeneration: 1,
      accepted: true,
      replayed: true,
    });
    expect(calls[0]!.url).toBe("https://builder.test/sessions/thr-1/turns");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      protocol: 1,
      kind: "agent",
      threadId: "thr-1",
      turnId: "turn-9",
      audience: "pro",
      budgetMicroCents: 1_000,
      source: "desktop",
    });
  });

  it("refuses a receipt that names a different turn than requested", async () => {
    const { fetchImpl } = capture(() => Response.json({ turnId: "other" }));
    const failure = await startBuilderAgentTurn({
      endpoint,
      fetch: fetchImpl,
      request: {
        ownerId: "o",
        ownerGeneration: "g",
        conversationId: "c",
        threadId: "t",
        attemptGeneration: 1,
        turnId: "turn-1",
        prompt: "p",
        description: "d",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "default",
        },
        audience: "free",
        budgetMicroCents: 0,
        source: "placement",
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "idempotency_conflict",
      retryable: false,
    });
  });
});
