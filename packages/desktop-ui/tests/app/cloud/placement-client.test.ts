import { describe, expect, test } from "vitest";
import {
  DISPATCH_SUBMIT_PATH,
  dispatchCancelPath,
  dispatchPath,
  type DispatchSummary,
} from "@stella/contracts/turn-plane/placement";
import {
  PlacementClientError,
  PlacementTransportError,
  cancelDispatch,
  getDispatchStatus,
  listExecutionDevices,
  submitDispatch,
} from "../../../src/features/cloud/placement-client";
import {
  browserExecutionCancelArgs,
  browserExecutionSubmitArgs,
  waitForBrowserExecutionTurn,
} from "../../../src/features/cloud/browser-execution-placement";

const ORIGIN = "https://builder.example";

const submission = {
  requestedConversationId: "conversation-browser",
  prompt: "Explain the attached chart",
  imagePaths: [] as string[],
  attachments: [] as { path: string; name: string; sizeBytes: number }[],
  locale: "en",
  execution: null,
  executionTarget: { mode: "automatic" as const },
} as const;

const dispatch = (overrides: Partial<DispatchSummary> = {}): DispatchSummary =>
  ({
    dispatchId: "exec:browser",
    idempotencyKey: "client:one",
    kind: "chat",
    ingress: "browser",
    subject: "cloud",
    conversationId: "conversation-browser",
    state: "offering",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as DispatchSummary;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit };

const recorder = (
  handler: (call: Call, index: number) => Response,
): { calls: Call[]; fetch: typeof fetch } => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as RequestInit };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
};

const token = async () => "jwt-1";

describe("owner gate placement client", () => {
  test("submits one browser dispatch to the owner gate with the account JWT", async () => {
    const { calls, fetch } = recorder(() =>
      json({ protocol: 1, dispatch: dispatch(), replayed: false }),
    );
    const request = await browserExecutionSubmitArgs({
      clientMsgId: "client:one",
      conversationId: "conversation-browser",
      submission,
    });
    const result = await submitDispatch({
      socketOrigin: ORIGIN,
      request,
      getToken: token,
      fetch,
    });

    expect(result.dispatchId).toBe("exec:browser");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ORIGIN}${DISPATCH_SUBMIT_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer jwt-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      protocol: 1,
      idempotencyKey: "client:one",
      kind: "chat",
      ingress: "browser",
      subject: "cloud",
      conversationId: "conversation-browser",
      requiredCapabilities: ["chat"],
      targetMode: "automatic",
      payload: {
        schemaVersion: 1,
        prompt: "Explain the attached chart",
        conversationId: "conversation-browser",
        clientMsgId: "client:one",
        locale: "en",
      },
    });
  });

  test("polls the dispatch status route until placement names a cloud turn", async () => {
    const states = ["offering", "cloud_committed", "cloud_running"];
    const { calls, fetch } = recorder((_call, index) =>
      json({
        protocol: 1,
        dispatch: dispatch({
          state: states[index] ?? "cloud_running",
          ...(index === 2 ? { cloudTurnId: "turn-1" } : {}),
        }),
      }),
    );
    const settled = await waitForBrowserExecutionTurn({
      dispatchId: "exec:browser",
      queryStatus: (dispatchId) =>
        getDispatchStatus({
          socketOrigin: ORIGIN,
          dispatchId,
          getToken: token,
          fetch,
        }),
      isCurrentAccount: () => true,
      delay: async () => undefined,
    });
    expect(settled).toMatchObject({ status: "started", turnId: "turn-1" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(`${ORIGIN}${dispatchPath("exec:browser")}`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("reports a terminal dispatch instead of waiting for a turn", async () => {
    const { fetch } = recorder(() =>
      json({
        protocol: 1,
        dispatch: dispatch({ state: "failed", errorMessage: "no capacity" }),
      }),
    );
    const settled = await waitForBrowserExecutionTurn({
      dispatchId: "exec:browser",
      queryStatus: (dispatchId) =>
        getDispatchStatus({
          socketOrigin: ORIGIN,
          dispatchId,
          getToken: token,
          fetch,
        }),
      isCurrentAccount: () => true,
      delay: async () => undefined,
    });
    expect(settled).toMatchObject({
      status: "terminal",
      dispatch: { state: "failed" },
    });
  });

  test("a dispatch the gate no longer owns reads as gone, not as an outage", async () => {
    const { fetch } = recorder(() => new Response(null, { status: 404 }));
    await expect(
      getDispatchStatus({
        socketOrigin: ORIGIN,
        dispatchId: "exec:missing",
        getToken: token,
        fetch,
      }),
    ).resolves.toBeNull();
  });

  test("cancels through the gate's cancel route with a stable request id", async () => {
    const { calls, fetch } = recorder(() =>
      json({ protocol: 1, dispatch: dispatch({ state: "canceled" }) }),
    );
    const result = await cancelDispatch({
      socketOrigin: ORIGIN,
      getToken: token,
      fetch,
      ...browserExecutionCancelArgs("exec:browser"),
    });
    expect(result.state).toBe("canceled");
    expect(calls[0]!.url).toBe(
      `${ORIGIN}${dispatchCancelPath("exec:browser")}`,
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      protocol: 1,
      cancelRequestId: "cancel:exec:browser",
      reason: "Canceled by the user.",
    });
  });

  test("retries exactly once with a freshly minted token after a 401", async () => {
    const tokens = ["stale", "fresh"];
    let issued = 0;
    const { calls, fetch } = recorder((_call, index) =>
      index === 0
        ? json({ error: { code: "unauthorized", message: "expired" } }, 401)
        : json({ protocol: 1, dispatch: dispatch(), replayed: true }),
    );
    const result = await submitDispatch({
      socketOrigin: ORIGIN,
      request: await browserExecutionSubmitArgs({
        clientMsgId: "client:one",
        conversationId: "conversation-browser",
        submission,
      }),
      getToken: async () => tokens[issued++] ?? "fresh",
      fetch,
    });
    expect(result.dispatchId).toBe("exec:browser");
    expect(calls).toHaveLength(2);
    expect(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer stale");
    expect(
      (calls[1]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer fresh");
  });

  test("surfaces a quota refusal as a typed, definitive error", async () => {
    const { fetch } = recorder(() =>
      json(
        {
          error: {
            code: "quota_daily",
            message: "Daily limit reached.",
            retryable: false,
          },
        },
        429,
      ),
    );
    await expect(
      submitDispatch({
        socketOrigin: ORIGIN,
        request: await browserExecutionSubmitArgs({
          clientMsgId: "client:one",
          conversationId: "conversation-browser",
          submission,
        }),
        getToken: token,
        fetch,
      }),
    ).rejects.toMatchObject({
      name: "PlacementClientError",
      code: "quota_daily",
      isQuota: true,
    });
  });

  test("maps anonymous and suspended cloud-agent refusals", () => {
    expect(
      new PlacementClientError({ code: "sign_in_required", status: 403 }),
    ).toMatchObject({
      message: "Sign in to Stella to use cloud agents.",
      isAuth: true,
    });
    expect(
      new PlacementClientError({ code: "owner_suspended", status: 403 })
        .message,
    ).toBe("This account can't use Stella's cloud right now.");
  });

  test("keeps a dropped request distinct from a refusal", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      getDispatchStatus({
        socketOrigin: ORIGIN,
        dispatchId: "exec:browser",
        getToken: token,
        fetch: fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PlacementTransportError);
  });

  test("refuses to send without an account token", async () => {
    const { calls, fetch } = recorder(() => json({}));
    await expect(
      getDispatchStatus({
        socketOrigin: ORIGIN,
        dispatchId: "exec:browser",
        getToken: async () => null,
        fetch,
      }),
    ).rejects.toBeInstanceOf(PlacementClientError);
    expect(calls).toHaveLength(0);
  });

  test("reads the owner's execution destinations with live presence", async () => {
    const { calls, fetch } = recorder(() =>
      json({
        protocol: 1,
        devices: [
          {
            deviceId: "desktop-1",
            label: "Studio iMac",
            remoteExecutionEnabled: true,
            online: true,
            availability: {
              ready: true,
              chatSlots: 1,
              agentSlots: 1,
              capabilities: ["chat", "agent"],
            },
          },
        ],
        cloud: { capabilities: ["chat", "agent", "attachments"] },
      }),
    );
    const response = await listExecutionDevices({
      socketOrigin: ORIGIN,
      getToken: token,
      fetch,
    });
    expect(calls[0]!.url).toBe(`${ORIGIN}/owners/me/devices`);
    expect(response.devices[0]).toMatchObject({
      deviceId: "desktop-1",
      label: "Studio iMac",
      online: true,
    });
    expect(response.cloud.capabilities).toContain("agent");
  });
});
