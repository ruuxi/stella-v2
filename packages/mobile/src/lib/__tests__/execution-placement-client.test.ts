import { beforeEach, describe, expect, mock, test } from "bun:test";

// Expo's module setup runs on import and expects the RN global.
(globalThis as Record<string, unknown>).__DEV__ = false;

// The placement client is HTTP-only; SecureStore and the Convex client are
// only reachable through the pairing store and the builder-origin lookup.
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
// The real pairing proof is exercised here, so expo-crypto's randomness is
// stubbed rather than the proof builder.
mock.module("expo-crypto", () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
mock.module("expo-secure-store", () => ({
  getItem: () => null,
  setItem: () => {},
  deleteItemAsync: async () => {},
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("../auth-token", () => ({
  getConvexToken: async () => "jwt-account",
  clearCachedToken: () => {},
}));
class MockHttpRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}
// bun's module mock registry is process-global and a sibling suite replaces
// `../http`. Own it here: the transport under test is the request shaping
// (route, origin, body, proof headers), which is what this stub records.
mock.module("../http", () => ({
  HttpRequestError: MockHttpRequestError,
  getJson: (path: string, options?: Record<string, unknown>) =>
    transport({ method: "GET", path, body: undefined, options: options ?? {} }),
  postJson: (path: string, body: unknown, options?: Record<string, unknown>) =>
    transport({ method: "POST", path, body, options: options ?? {} }),
}));
// Convex traffic is recorded by function name so a test can assert which
// control-plane query fenced a call, not just that one did.
let convexCalls: Array<{ kind: "query" | "mutation"; name: string }> = [];
const convexFunction = (
  kind: "query" | "mutation",
  ref: unknown,
  args: unknown,
) => {
  const name = getFunctionName(ref as FunctionReference<"query">);
  convexCalls.push({ kind, name });
  switch (name) {
    case "cloud_apps:getCloudRealtimeConfig":
      return {
        httpOrigin: BUILDER_ORIGIN,
        socketOrigin: BUILDER_ORIGIN.replace(/^http/, "ws"),
        protocol: 1,
      };
    case "cloud_apps:getMyCloudConversationIdentity":
      return { ownerId: "owner-1", ownerGeneration: "gen-1" };
    case "cloud_apps:createMyConversation":
      return {
        conversationId: `conv:${(args as { clientCreateId: string }).clientCreateId}`,
      };
    default:
      throw new Error(`unexpected convex ${kind} ${name}`);
  }
};
mock.module("../convex", () => ({
  getConvexClient: () => ({
    query: async (ref: unknown, args: unknown) =>
      convexFunction("query", ref, args),
    mutation: async (ref: unknown, args: unknown) =>
      convexFunction("mutation", ref, args),
  }),
}));

const BUILDER_ORIGIN = "https://builder.example";

const { getFunctionName } = await import("convex/server");
type FunctionReference<T extends "query" | "mutation"> = import(
  "convex/server"
).FunctionReference<T>;
const {
  cancelAutomaticExecution,
  ensureAutomaticExecutionConversation,
  getAutomaticExecutionStatus,
  listExecutionDevices,
  submitAutomaticExecution,
} = await import("../execution-placement");
const { buildAutomaticExecutionAdmission } = await import(
  "../execution-placement-core"
);
const {
  buildMobilePairingChallenge,
  canonicalDispatchPayloadJson,
  deriveMobilePairingKey,
  verifyMobilePairingProof,
} = await import("@stella/contracts/turn-plane/pairing-proof");

const access = {
  desktopDeviceId: "desktop-1",
  mobileDeviceId: "phone-1",
  pairSecret: "pair-secret",
  approvedAt: 1,
};

const dispatch = (overrides: Record<string, unknown> = {}) => ({
  dispatchId: "exec:mobile",
  idempotencyKey: "mobile:one",
  kind: "chat",
  ingress: "mobile",
  subject: "portable",
  conversationId: "conv:mobile",
  state: "offering",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

type Call = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  options: Record<string, unknown>;
};

let calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({
  protocol: 1,
  dispatch: dispatch(),
});

const transport = async (call: Call) => {
  calls.push(call);
  const answer = respond(call);
  if (answer instanceof Error) throw answer;
  return answer;
};

beforeEach(() => {
  calls = [];
  convexCalls = [];
  respond = () => ({ protocol: 1, dispatch: dispatch() });
});

const headersOf = (call: Call) =>
  (call.options.headers ?? {}) as Record<string, string>;

describe("mobile execution placement client", () => {
  test("submits to the builder's dispatch route with the pairing proof", async () => {
    respond = () => ({
      protocol: 1,
      dispatch: dispatch({ state: "computer_claimed" }),
      replayed: false,
    });
    const input = {
      idempotencyKey: "mobile:one",
      conversationId: "conv:mobile",
      kind: "chat" as const,
      prompt: "what is on my calendar",
      target: { mode: "device" as const, deviceId: "desktop-1" },
    };
    const result = await submitAutomaticExecution({ ...input, access });

    expect(result.dispatchId).toBe("exec:mobile");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/owners/me/dispatches");
    expect(calls[0]!.options.origin).toBe(BUILDER_ORIGIN);

    const admission = buildAutomaticExecutionAdmission(input);
    const headers = headersOf(calls[0]!);
    expect(headers["x-stella-mobile-device-id"]).toBe("phone-1");
    expect(headers["x-stella-mobile-desktop-device-id"]).toBe("desktop-1");
    expect(headers["x-stella-mobile-pair-proof-challenge"]).toBe(
      admission.challenge,
    );
    // The proof is the unchanged HMAC over the contract's message, so the
    // builder's own verifier accepts it against the derived pairing key.
    const verified = await verifyMobilePairingProof({
      fields: {
        mobileDeviceId: headers["x-stella-mobile-device-id"]!,
        desktopDeviceId: headers["x-stella-mobile-desktop-device-id"]!,
        challenge: headers["x-stella-mobile-pair-proof-challenge"]!,
        proof: headers["x-stella-mobile-pair-proof"]!,
        issuedAt: Number(headers["x-stella-mobile-pair-proof-issued-at"]),
      },
      publicKey: await deriveMobilePairingKey(access.pairSecret),
      expectedChallenge: buildMobilePairingChallenge({
        idempotencyKey: "mobile:one",
        conversationId: "conv:mobile",
        payloadHash: admission.payloadHash,
        kind: "chat",
        subject: "portable",
        targetMode: "device",
        targetDeviceId: "desktop-1",
      }),
    });
    expect(verified.ok).toBe(true);

    expect(calls[0]!.body).toEqual({
      protocol: 1,
      idempotencyKey: "mobile:one",
      kind: "chat",
      ingress: "mobile",
      subject: "portable",
      targetMode: "device",
      targetDeviceId: "desktop-1",
      conversationId: "conv:mobile",
      requiredCapabilities: ["chat"],
      requestingDeviceId: "phone-1",
      payload: {
        schemaVersion: 1,
        prompt: "what is on my calendar",
        conversationId: "conv:mobile",
        clientMsgId: "mobile:one",
      },
    });
    // The proof commits to exactly the payload bytes the builder will store.
    expect(admission.payloadJson).toBe(
      canonicalDispatchPayloadJson(
        (calls[0]!.body as { payload: never }).payload,
      ),
    );
  });

  test("sends no pairing proof for an explicitly hosted turn", async () => {
    await submitAutomaticExecution({
      idempotencyKey: "mobile:one",
      conversationId: "conv:mobile",
      kind: "chat",
      prompt: "summarize this lease",
      target: { mode: "cloud" },
      access,
    });
    expect(headersOf(calls[0]!)["x-stella-mobile-pair-proof"]).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ targetMode: "cloud" });
    expect(calls[0]!.body).not.toHaveProperty("requestingDeviceId");
  });

  test("refuses a computer the phone has not paired with", async () => {
    await expect(
      submitAutomaticExecution({
        idempotencyKey: "mobile:one",
        conversationId: "conv:mobile",
        kind: "chat",
        prompt: "open my notes",
        target: { mode: "device", deviceId: "desktop-other" },
        access,
      }),
    ).rejects.toThrow("not paired with this phone");
    expect(calls).toHaveLength(0);
  });

  test("reads status from the builder's dispatch route", async () => {
    respond = () => ({
      protocol: 1,
      dispatch: dispatch({ state: "completed", cloudTurnId: "turn-1" }),
    });
    const status = await getAutomaticExecutionStatus("exec:mobile");
    expect(status).toMatchObject({ state: "completed", cloudTurnId: "turn-1" });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/owners/me/dispatches/exec%3Amobile");
    expect(calls[0]!.options.origin).toBe(BUILDER_ORIGIN);
  });

  test("treats a dispatch the gate no longer owns as gone", async () => {
    respond = () => Object.assign(new Error("gone"), { status: 404 });
    expect(await getAutomaticExecutionStatus("exec:gone")).toBeNull();
  });

  test("cancels through the builder's cancel route", async () => {
    respond = () => ({
      protocol: 1,
      dispatch: dispatch({ state: "canceled" }),
    });
    const canceled = await cancelAutomaticExecution({
      dispatchId: "exec:mobile",
      cancelRequestId: "cancel:mobile:one",
      reason: "Stopped from the mobile conversation.",
    });
    expect(canceled.state).toBe("canceled");
    expect(calls[0]!.path).toBe("/owners/me/dispatches/exec%3Amobile/cancel");
    expect(calls[0]!.body).toEqual({
      protocol: 1,
      cancelRequestId: "cancel:mobile:one",
      reason: "Stopped from the mobile conversation.",
    });
  });

  test("reads the owner's execution destinations from the gate", async () => {
    respond = () => ({
      protocol: 1,
      devices: [
        {
          deviceId: "desktop-1",
          label: "Studio iMac",
          remoteExecutionEnabled: true,
          online: true,
        },
      ],
      cloud: { capabilities: ["chat"] },
    });
    const devices = await listExecutionDevices();
    expect(devices).toHaveLength(1);
    expect(calls[0]!.path).toBe("/owners/me/devices");
    expect(calls[0]!.options.origin).toBe(BUILDER_ORIGIN);
  });

  test("surfaces a refusal from the gate", async () => {
    respond = () => new Error("No computer with what this needs is online.");
    await expect(
      cancelAutomaticExecution({
        dispatchId: "exec:mobile",
        cancelRequestId: "cancel:mobile:one",
      }),
    ).rejects.toThrow("No computer with what this needs is online.");
  });

  test("fences conversation creation on the conversation identity, not device placement", async () => {
    // Hosted chat is open to the anonymous owner; the execution-placement
    // identity query refuses anonymous callers because it registers desktops
    // for remote execution. Admitting a chat conversation through it made
    // account-free mobile chat fail on its first turn.
    const conversationId = await ensureAutomaticExecutionConversation({
      threadId: "cloud",
      title: "Chat",
    });
    expect(conversationId).toBe("conv:mobile-placement:cloud");
    expect(convexCalls).toEqual([
      { kind: "query", name: "cloud_apps:getMyCloudConversationIdentity" },
      { kind: "mutation", name: "cloud_apps:createMyConversation" },
    ]);
    expect(convexCalls.map((call) => call.name)).not.toContain(
      "execution_placement:getMyExecutionPlacementIdentity",
    );
  });

  test("maps anonymous and suspended placement refusals to client copy", async () => {
    for (const [code, message] of [
      ["sign_in_required", "Sign in to Stella to use cloud agents."],
      ["owner_suspended", "This account can't use Stella's cloud right now."],
    ] as const) {
      respond = () =>
        new MockHttpRequestError("server omitted copy", 403, code);
      let refusal: unknown;
      try {
        await submitAutomaticExecution({
          idempotencyKey: `mobile:${code}`,
          conversationId: "conv:mobile",
          kind: "agent",
          prompt: "research this",
          target: { mode: "cloud" },
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code, message });
    }
  });
});
