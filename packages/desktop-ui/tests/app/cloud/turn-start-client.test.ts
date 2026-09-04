import { describe, expect, test, vi } from "vitest";
import {
  CLIENT_MSG_ID_PATTERN,
  CONVERSATION_ID_PATTERN,
  TURN_TITLE_MAX_CHARS,
  type CloudTurnStartError,
  type CloudTurnStartRequest,
  type CloudTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import {
  CloudTurnStartClientError,
  CloudTurnStartTransportError,
  cloudTurnStartRequest,
  cloudTurnTitleHint,
  newCloudConversationId,
  startCloudTurn,
  TURN_START_TIMEOUT_MS,
} from "../../../src/features/cloud/turn-start-client";

const ORIGIN = "https://builder.example.test";
const CONVERSATION_ID = "0f4b0c3e-6b0e-4f6f-9b0e-1e7a1a2b3c4d";

const request: CloudTurnStartRequest = {
  protocol: 1,
  clientMsgId: "client-msg-0001",
  prompt: "hello cloud",
  source: "desktop",
};

const receipt = (
  overrides: Partial<CloudTurnStartResponse> = {},
): CloudTurnStartResponse => ({
  protocol: 1,
  conversationId: CONVERSATION_ID,
  turnId: "turn-1",
  accepted: true,
  replayed: false,
  createdConversation: true,
  ...overrides,
});

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const errorBody = (
  error: Partial<CloudTurnStartError["error"]> &
    Pick<CloudTurnStartError["error"], "code">,
): CloudTurnStartError => ({
  error: { message: "", retryable: false, ...error },
});

const fetchMock = (...responses: Array<Response | Error>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      if (next instanceof Error) throw next;
      return next;
    },
  );
  return { calls, fetch: impl as unknown as typeof fetch };
};

const tokens = (...values: Array<string | null>) => {
  const getToken = vi.fn(async () => values.shift() ?? null);
  return getToken;
};

describe("cloud turn start client", () => {
  test("mints conversation ids that satisfy the contract pattern", () => {
    const id = newCloudConversationId();
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    expect(id).not.toBe(newCloudConversationId());
  });

  test("builds the wire body from the frozen submission only", () => {
    const submission = {
      requestedConversationId: CONVERSATION_ID,
      prompt: "decorated prompt\n\nAttached in my drive:\n- a.png",
      imagePaths: ["a.png"],
      attachments: [{ path: "a.png", name: "a.png", sizeBytes: 1 }],
      locale: "fr",
      execution: {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      } as const,
    };
    const body = cloudTurnStartRequest(
      "client-msg-0001",
      submission,
      "  hi\n there ",
    );
    expect(body).toEqual({
      protocol: 1,
      clientMsgId: "client-msg-0001",
      prompt: submission.prompt,
      execution: submission.execution,
      locale: "fr",
      attachments: ["a.png"],
      source: "desktop",
      title: "hi there",
    });
    expect(body.clientMsgId).toMatch(CLIENT_MSG_ID_PATTERN);
    expect(
      cloudTurnStartRequest(
        "client-msg-0002",
        { ...submission, locale: null, execution: null, imagePaths: [] },
        "",
      ),
    ).toEqual({
      protocol: 1,
      clientMsgId: "client-msg-0002",
      prompt: submission.prompt,
      source: "desktop",
    });
  });

  test("caps the title hint at the contract limit", () => {
    expect(cloudTurnTitleHint("   ")).toBeUndefined();
    expect(cloudTurnTitleHint("x".repeat(500))).toHaveLength(
      TURN_TITLE_MAX_CHARS,
    );
  });

  test("posts the body to the conversation's turn route with the bearer JWT", async () => {
    const { calls, fetch } = fetchMock(jsonResponse(202, receipt()));
    const getToken = tokens("jwt-1");
    const result = await startCloudTurn({
      socketOrigin: `${ORIGIN}/`,
      conversationId: CONVERSATION_ID,
      request,
      getToken,
      fetch,
    });
    expect(result).toEqual(receipt());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${ORIGIN}/conversations/${CONVERSATION_ID}/turns`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      Authorization: "Bearer jwt-1",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(request);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledWith();
    expect(TURN_START_TIMEOUT_MS).toBe(30_000);
  });

  test("treats a replayed admission as success", async () => {
    const { fetch } = fetchMock(
      jsonResponse(
        202,
        receipt({ replayed: true, createdConversation: false }),
      ),
    );
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch,
      }),
    ).resolves.toMatchObject({ replayed: true, turnId: "turn-1" });
  });

  test("refreshes the token once after a 401 and retries", async () => {
    const { calls, fetch } = fetchMock(
      jsonResponse(401, errorBody({ code: "unauthorized" })),
      jsonResponse(202, receipt()),
    );
    const getToken = tokens("jwt-stale", "jwt-fresh");
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken,
        fetch,
      }),
    ).resolves.toEqual(receipt());
    expect(getToken).toHaveBeenNthCalledWith(1);
    expect(getToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(
      calls.map(
        (call) => (call.init.headers as Record<string, string>).Authorization,
      ),
    ).toEqual(["Bearer jwt-stale", "Bearer jwt-fresh"]);
  });

  test("surfaces a second 401 as an auth error without a third attempt", async () => {
    const { calls, fetch } = fetchMock(
      jsonResponse(401, errorBody({ code: "unauthorized" })),
      jsonResponse(401, errorBody({ code: "unauthorized" })),
      jsonResponse(202, receipt()),
    );
    const error = await startCloudTurn({
      socketOrigin: ORIGIN,
      conversationId: CONVERSATION_ID,
      request,
      getToken: tokens("jwt-stale", "jwt-fresh"),
      fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudTurnStartClientError);
    expect(error).toMatchObject({ code: "unauthorized", status: 401 });
    expect((error as CloudTurnStartClientError).isAuth).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("does not retry a 401 when no fresher token exists", async () => {
    const { calls, fetch } = fetchMock(
      jsonResponse(401, errorBody({ code: "unauthorized" })),
    );
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1", "jwt-1"),
        fetch,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toHaveLength(1);
  });

  test("refuses to send without a token", async () => {
    const { calls, fetch } = fetchMock();
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens(null),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      status: 0,
      message: "Sign in to Stella to send cloud messages.",
    });
    expect(calls).toHaveLength(0);
  });

  test("maps anonymous and suspended cloud-agent refusals", () => {
    expect(
      new CloudTurnStartClientError({
        code: "sign_in_required",
        status: 403,
      }),
    ).toMatchObject({
      message: "Sign in to Stella to use cloud agents.",
      isAuth: true,
    });
    expect(
      new CloudTurnStartClientError({
        code: "owner_suspended",
        status: 403,
      }).message,
    ).toBe("This account can't use Stella's cloud right now.");
  });

  test("maps 409 bodies to the conflict codes with the server message", async () => {
    const { fetch } = fetchMock(
      jsonResponse(
        409,
        errorBody({
          code: "idempotency_conflict",
          message: "Same clientMsgId, different prompt.",
        }),
      ),
    );
    const error = await startCloudTurn({
      socketOrigin: ORIGIN,
      conversationId: CONVERSATION_ID,
      request,
      getToken: tokens("jwt-1"),
      fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudTurnStartClientError);
    expect(error).toMatchObject({
      code: "idempotency_conflict",
      status: 409,
      message: "Same clientMsgId, different prompt.",
      retryable: false,
    });
    expect((error as CloudTurnStartClientError).isConflict).toBe(true);

    const locked = fetchMock(
      jsonResponse(
        409,
        errorBody({ code: "conversation_locked", retryable: true }),
      ),
    );
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch: locked.fetch,
      }),
    ).rejects.toMatchObject({
      code: "conversation_locked",
      retryable: true,
      message:
        "This conversation is busy. Wait for the current turn to finish, then try again.",
    });
  });

  test("falls back to a status-derived code when the body is not a contract error", async () => {
    const { fetch } = fetchMock(new Response("boom", { status: 503 }));
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "internal",
      status: 503,
      retryable: true,
      message: "That didn't send. Try again.",
    });
    const forbidden = fetchMock(new Response(null, { status: 403 }));
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch: forbidden.fetch,
      }),
    ).rejects.toMatchObject({ code: "forbidden", retryable: false });
  });

  test("rejects a receipt for a different conversation or protocol", async () => {
    const { fetch } = fetchMock(
      jsonResponse(202, receipt({ conversationId: "someone-elses-conv" })),
    );
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch,
      }),
    ).rejects.toMatchObject({ code: "internal", status: 202 });
  });

  test("classifies network failures and timeouts as transport errors", async () => {
    const network = fetchMock(new TypeError("fetch failed"));
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch: network.fetch,
      }),
    ).rejects.toBeInstanceOf(CloudTurnStartTransportError);

    const timeout = new DOMException("timed out", "TimeoutError");
    const timedOut = fetchMock(timeout);
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: CONVERSATION_ID,
        request,
        getToken: tokens("jwt-1"),
        fetch: timedOut.fetch,
      }),
    ).rejects.toMatchObject({
      name: "CloudTurnStartTransportError",
      message: "The cloud turn request timed out. Try again.",
    });
  });

  test("refuses a conversation id outside the contract pattern before any request", async () => {
    const { calls, fetch } = fetchMock();
    await expect(
      startCloudTurn({
        socketOrigin: ORIGIN,
        conversationId: "bad/id",
        request,
        getToken: tokens("jwt-1"),
        fetch,
      }),
    ).rejects.toMatchObject({ code: "bad_request", status: 0 });
    expect(calls).toHaveLength(0);
  });
});
