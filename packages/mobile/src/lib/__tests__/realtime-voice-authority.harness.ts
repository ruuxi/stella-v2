import { expect, mock } from "bun:test";

(globalThis as Record<string, unknown>).__DEV__ = false;

type PostCall = {
  path: string;
  body: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
};

const postCalls: PostCall[] = [];
let recordingLease: Record<string, unknown> | null = null;
let postImpl: (
  path: string,
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown> = async () => ({
  recorded: true,
  directive: "continue",
  authorityEpoch: 7,
  authorityExpiresAt: Date.now() + 10_000,
  cancelReason: null,
});

mock.module("expo-audio", () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
  },
}));

mock.module("../http", () => ({
  postJson: async (
    path: string,
    body: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    postCalls.push({ path, body, options });
    return await postImpl(path, body, options);
  },
  postText: async () => "answer-sdp",
}));

mock.module("../desktop-realtime-voice", () => ({
  connectDesktopRealtimeVoice: async () => {
    throw new Error("unexpected desktop voice connection");
  },
  executeDesktopRealtimeVoiceTool: async () => ({ output: "" }),
  persistDesktopRealtimeVoiceTranscript: async () => undefined,
}));

mock.module("../mobile-audio-session", () => ({
  acquireRecordingAudioSession: async () => recordingLease,
  refreshRecordingAudioSession: async () => true,
  releaseRecordingAudioSession: async () => undefined,
}));

mock.module("react-native-webrtc", () => ({
  mediaDevices: {
    getUserMedia: async () => ({
      getAudioTracks: () => [],
      getTracks: () => [],
      release: () => undefined,
    }),
  },
  RTCPeerConnection: class MockPeerConnection {},
}));

const { MobileRealtimeVoiceSession, buildManagedOpenAiSdpRequest } =
  await import("../realtime-voice");

type TestSession = {
  token: {
    model: string;
    voice: string;
    clientSecret: string;
    stellaSessionId: string;
    ownerGeneration: string;
    providerDispatchId: string;
    providerAttemptId: string;
    authorityLeaseId: string;
    authorityEpoch: number;
    authorityExpiresAt: number;
  } | null;
  channel: { readyState: string; close: () => void } | null;
  pc: { close: () => void } | null;
  sdpAbortController: { abort: () => void } | null;
  stopped: boolean;
  leaseTerminalReported: boolean;
  handleServerEvent: (event: Record<string, unknown>) => void;
  reportLeaseEvent: (
    event: string,
    terminal?: { usageDisposition: string; transportClosedAt: number },
  ) => Promise<void>;
  startLeaseReporting: () => void;
  releaseConnection: () => Promise<void>;
};

const asTestSession = (
  session: InstanceType<typeof MobileRealtimeVoiceSession>,
): TestSession => session as unknown as TestSession;

const makeSession = () =>
  new MobileRealtimeVoiceSession({
    conversationId: "conversation-1",
    messages: [],
    execution: "phone",
    onSnapshot: () => undefined,
    onPerformAction: async () => null,
    onEndRequested: () => undefined,
  });

const installToken = (session: TestSession, overrides = {}) => {
  session.token = {
    model: "gpt-realtime",
    voice: "marin",
    clientSecret: "ephemeral-secret",
    stellaSessionId: "voice_openai_1",
    ownerGeneration: "generation-1",
    providerDispatchId: "dispatch-1",
    providerAttemptId: "attempt-1",
    authorityLeaseId: "authority-lease-1",
    authorityEpoch: 7,
    authorityExpiresAt: Date.now() + 10_000,
    ...overrides,
  };
};

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(label);
};

const scenarios: Record<string, () => Promise<void>> = {
  "sdp-exact-tuple": async () => {
    expect(
      buildManagedOpenAiSdpRequest({
        stellaSessionId: "session-1",
        ownerGeneration: "generation-1",
        providerDispatchId: "dispatch-1",
        providerAttemptId: "attempt-1",
      }),
    ).toEqual({
      path: "/api/voice/openai/sdp",
      headers: {
        "Content-Type": "application/sdp",
        "X-Stella-Voice-Session-ID": "session-1",
        "X-Stella-Owner-Generation": "generation-1",
        "X-Stella-Provider-Dispatch-ID": "dispatch-1",
        "X-Stella-Provider-Attempt-ID": "attempt-1",
      },
    });
  },
  "requires-authority": async () => {
    recordingLease = { id: "audio-lease-1" };
    let latestError: string | null = null;
    postImpl = async () => ({
      voiceProvider: "openai",
      transport: "openai-webrtc",
      clientSecret: "ephemeral-secret",
      model: "gpt-realtime",
      voice: "marin",
      stellaSessionId: "voice_openai_1",
      leaseExpiresAt: Date.now() + 300_000,
    });
    const session = new MobileRealtimeVoiceSession({
      conversationId: "conversation-1",
      messages: [],
      execution: "phone",
      onSnapshot: (snapshot) => {
        latestError = snapshot.error;
      },
      onPerformAction: async () => null,
      onEndRequested: () => undefined,
    });

    await session.start();

    expect(latestError).toBe(
      "Stella did not return a complete realtime voice session.",
    );
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.path).toBe("/api/voice/session");
  },

  "exact-heartbeat": async () => {
    const session = asTestSession(makeSession());
    installToken(session);
    const renewedExpiresAt = Date.now() + 20_000;
    postImpl = async () => ({
      recorded: true,
      directive: "continue",
      authorityEpoch: 7,
      authorityExpiresAt: renewedExpiresAt,
      cancelReason: null,
    });

    await session.reportLeaseEvent("heartbeat");

    expect(postCalls).toEqual([
      {
        path: "/api/voice/lease",
        body: {
          stellaSessionId: "voice_openai_1",
          event: "heartbeat",
          authorityLeaseId: "authority-lease-1",
          authorityEpoch: 7,
        },
        options: { timeoutMs: 1_500 },
      },
    ]);
    expect(session.token?.authorityExpiresAt).toBe(renewedExpiresAt);

    session.stopped = true;
    await session.releaseConnection();
  },

  "cancel-close-before-ack": async () => {
    const events: string[] = [];
    let resolveUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => {
      resolveUsage = resolve;
    });
    const sessionObject = makeSession();
    const session = asTestSession(sessionObject);
    installToken(session);
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    session.sdpAbortController = {
      abort: () => events.push("sdp-abort"),
    };
    postImpl = async (path, body) => {
      if (path === "/api/voice/usage") {
        events.push("post:usage");
        await usageGate;
        events.push("usage:drained");
        return { recorded: true };
      }
      events.push(`post:${String(body.event)}`);
      if (body.event === "heartbeat") {
        return {
          recorded: true,
          directive: "cancel",
          authorityEpoch: 8,
          authorityExpiresAt: Date.now() + 5_000,
          cancelReason: "reset",
        };
      }
      expect(events.indexOf("data-channel-close")).toBeLessThan(
        events.indexOf("post:cancel_ack"),
      );
      expect(events.indexOf("peer-close")).toBeLessThan(
        events.indexOf("post:cancel_ack"),
      );
      expect(events.indexOf("sdp-abort")).toBeLessThan(
        events.indexOf("post:cancel_ack"),
      );
      expect(events.indexOf("usage:drained")).toBeLessThan(
        events.indexOf("post:cancel_ack"),
      );
      return {
        recorded: true,
        directive: "closed",
        authorityEpoch: 8,
      };
    };

    session.handleServerEvent({
      type: "response.done",
      response: {
        id: "response-1",
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    });
    const heartbeat = session.reportLeaseEvent("heartbeat");
    await waitFor(
      () => events.includes("data-channel-close"),
      "cancellation did not close the transport",
    );
    expect(events.includes("post:cancel_ack")).toBe(false);
    resolveUsage();
    await heartbeat;

    const leaseBodies = postCalls
      .filter((call) => call.path === "/api/voice/lease")
      .map((call) => call.body);
    const cancelTransportClosedAt = leaseBodies[1]?.transportClosedAt;
    expect(typeof cancelTransportClosedAt).toBe("number");
    expect(leaseBodies).toEqual([
      {
        stellaSessionId: "voice_openai_1",
        event: "heartbeat",
        authorityLeaseId: "authority-lease-1",
        authorityEpoch: 7,
      },
      {
        stellaSessionId: "voice_openai_1",
        event: "cancel_ack",
        authorityLeaseId: "authority-lease-1",
        authorityEpoch: 8,
        usageDisposition: "drained",
        transportClosedAt: cancelTransportClosedAt,
      },
    ]);
    expect(
      postCalls.find((call) => call.path === "/api/voice/usage")?.body,
    ).toEqual({
      responseId: "response-1",
      model: "gpt-realtime",
      stellaSessionId: "voice_openai_1",
      ownerGeneration: "generation-1",
      providerDispatchId: "dispatch-1",
      providerAttemptId: "attempt-1",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      conversationId: "conversation-1",
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    expect(session.token?.authorityEpoch).toBe(8);
    expect(session.stopped).toBe(true);
    expect(session.leaseTerminalReported).toBe(true);

    await sessionObject.stop("lost");
    expect(postCalls).toHaveLength(3);
  },

  "usage-replay-exact-tuple": async () => {
    postImpl = async () => ({ recorded: true });
    const first = asTestSession(makeSession());
    const restarted = asTestSession(makeSession());
    installToken(first);
    installToken(restarted);
    const replayedResponse = {
      type: "response.done",
      response: {
        id: "response-replayed-after-restart",
        usage: { input_tokens: 21, output_tokens: 8 },
      },
    };

    first.handleServerEvent(replayedResponse);
    restarted.handleServerEvent(replayedResponse);
    await waitFor(
      () =>
        postCalls.filter((call) => call.path === "/api/voice/usage").length ===
        2,
      "replayed usage did not post twice",
    );

    const usageCalls = postCalls.filter(
      (call) => call.path === "/api/voice/usage",
    );
    expect(usageCalls[0]?.body).toEqual(usageCalls[1]?.body);
    expect(usageCalls[0]).toEqual({
      path: "/api/voice/usage",
      body: {
        responseId: "response-replayed-after-restart",
        model: "gpt-realtime",
        stellaSessionId: "voice_openai_1",
        ownerGeneration: "generation-1",
        providerDispatchId: "dispatch-1",
        providerAttemptId: "attempt-1",
        authorityLeaseId: "authority-lease-1",
        authorityEpoch: 7,
        conversationId: "conversation-1",
        usage: { input_tokens: 21, output_tokens: 8 },
      },
      options: { timeoutMs: 1_500 },
    });

    first.stopped = true;
    restarted.stopped = true;
    await Promise.all([
      first.releaseConnection(),
      restarted.releaseConnection(),
    ]);
  },

  "usage-failure-terminal": async () => {
    const events: string[] = [];
    let rejectUsage!: (error: Error) => void;
    const usageGate = new Promise<void>((_resolve, reject) => {
      rejectUsage = reject;
    });
    const sessionObject = makeSession();
    const session = asTestSession(sessionObject);
    installToken(session);
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    postImpl = async (path, body) => {
      if (path === "/api/voice/usage") {
        events.push("post:usage");
        await usageGate;
      }
      events.push(`post:${String(body.event)}`);
      return {
        recorded: true,
        directive: "closed",
        authorityEpoch: 7,
        authorityExpiresAt: Date.now(),
        cancelReason: null,
      };
    };
    session.handleServerEvent({
      type: "response.done",
      response: {
        id: "response-network-failed",
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    });

    const stopping = sessionObject.stop("ended");
    await waitFor(
      () => events.includes("data-channel-close"),
      "stop did not immediately close the data channel",
    );
    expect(events.includes("post:ended")).toBe(false);
    rejectUsage(new Error("offline"));
    await stopping;

    expect(events.indexOf("data-channel-close")).toBeLessThan(
      events.indexOf("post:ended"),
    );
    expect(events.indexOf("peer-close")).toBeLessThan(
      events.indexOf("post:ended"),
    );
    const endedBody = postCalls.find(
      (call) => call.body.event === "ended",
    )?.body;
    const endedTransportClosedAt = endedBody?.transportClosedAt;
    expect(typeof endedTransportClosedAt).toBe("number");
    expect(endedBody).toEqual({
      stellaSessionId: "voice_openai_1",
      event: "ended",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      usageDisposition: "unresolved",
      transportClosedAt: endedTransportClosedAt,
    });
  },

  "ambiguous-usage-terminal": async () => {
    const sessionObject = makeSession();
    const session = asTestSession(sessionObject);
    installToken(session);
    postImpl = async () => ({
      recorded: true,
      directive: "closed",
      authorityEpoch: 7,
      authorityExpiresAt: Date.now(),
      cancelReason: null,
    });

    session.handleServerEvent({
      type: "response.done",
      response: { id: "response-without-provider-usage", status: "completed" },
    });
    await sessionObject.stop("ended");

    const endedBody = postCalls.find(
      (call) => call.body.event === "ended",
    )?.body;
    expect(endedBody?.usageDisposition).toBe("unresolved");
    expect(typeof endedBody?.transportClosedAt).toBe("number");
    expect(postCalls.some((call) => call.path === "/api/voice/usage")).toBe(
      false,
    );
  },

  "invalid-null": async () => {
    const events: string[] = [];
    const session = asTestSession(makeSession());
    installToken(session);
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    postImpl = async () => ({
      recorded: false,
      directive: "invalid",
      authorityEpoch: null,
      authorityExpiresAt: null,
      cancelReason: null,
    });

    await session.reportLeaseEvent("heartbeat");

    expect(events).toEqual(["data-channel-close", "peer-close"]);
    expect(session.token?.authorityEpoch).toBe(7);
    expect(session.token?.authorityExpiresAt).toBeGreaterThan(Date.now());
    expect(session.stopped).toBe(true);
    expect(postCalls).toHaveLength(1);
  },

  "malformed-response": async () => {
    const events: string[] = [];
    const session = asTestSession(makeSession());
    installToken(session);
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    postImpl = async () => ({
      recorded: true,
      directive: "continue",
      authorityEpoch: 7,
      authorityExpiresAt: null,
      cancelReason: null,
    });

    await session.reportLeaseEvent("heartbeat");

    expect(events).toEqual(["data-channel-close", "peer-close"]);
    expect(session.token?.authorityEpoch).toBe(7);
    expect(session.stopped).toBe(true);
    expect(postCalls).toHaveLength(1);
  },

  "future-cancel-epoch": async () => {
    const events: string[] = [];
    const session = asTestSession(makeSession());
    installToken(session);
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    postImpl = async () => ({
      recorded: false,
      directive: "cancel",
      authorityEpoch: 70,
      authorityExpiresAt: Date.now() + 5_000,
      cancelReason: "reset",
    });

    await session.reportLeaseEvent("heartbeat");

    expect(events).toEqual(["data-channel-close", "peer-close"]);
    expect(session.token?.authorityEpoch).toBe(7);
    expect(session.stopped).toBe(true);
    expect(postCalls).toHaveLength(1);
  },

  "offline-expiry": async () => {
    const events: string[] = [];
    const session = asTestSession(makeSession());
    installToken(session, { authorityExpiresAt: Date.now() + 5 });
    session.channel = {
      readyState: "open",
      close: () => events.push("data-channel-close"),
    };
    session.pc = { close: () => events.push("peer-close") };
    postImpl = async (_path, body) => {
      events.push(`post:${String(body.event)}`);
      throw new Error("offline");
    };

    session.startLeaseReporting();
    await waitFor(
      () => postCalls.some((call) => call.body.event === "expired"),
      "authority expiry did not report its exact terminal tuple",
    );

    expect(events.indexOf("data-channel-close")).toBeLessThan(
      events.indexOf("post:expired"),
    );
    expect(events.indexOf("peer-close")).toBeLessThan(
      events.indexOf("post:expired"),
    );
    const expiredBody = postCalls.find(
      (call) => call.body.event === "expired",
    )?.body;
    const expiredTransportClosedAt = expiredBody?.transportClosedAt;
    expect(typeof expiredTransportClosedAt).toBe("number");
    expect(expiredBody).toEqual({
      stellaSessionId: "voice_openai_1",
      event: "expired",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      usageDisposition: "drained",
      transportClosedAt: expiredTransportClosedAt,
    });
    expect(session.stopped).toBe(true);
  },
};

const scenario = process.argv[2];
const run = scenario ? scenarios[scenario] : undefined;
if (!scenario || !run) {
  throw new Error(`Unknown mobile voice authority scenario: ${scenario ?? ""}`);
}
await run();
process.stdout.write(JSON.stringify({ scenario, passed: true }));
