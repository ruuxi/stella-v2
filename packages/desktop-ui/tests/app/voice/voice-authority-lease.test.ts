import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceSessionToken } from "@/features/voice/services/realtime/providers/types";
import type {
  RealtimeTransport,
  RealtimeTransportEvents,
} from "@/features/voice/services/realtime/transports/types";

const { createRealtimeTransportMock, postServiceJsonMock } = vi.hoisted(() => ({
  createRealtimeTransportMock: vi.fn(),
  postServiceJsonMock: vi.fn(),
}));

vi.mock(
  "@/features/voice/services/realtime/providers/provider-registry",
  () => ({ createRealtimeTransport: createRealtimeTransportMock }),
);
vi.mock("@/platform/http/service-request", () => ({
  postServiceJson: postServiceJsonMock,
}));

import { RealtimeVoiceSession } from "@/features/voice/services/realtime/voice-session";

const BASE_NOW = Date.UTC(2026, 7, 26, 12);

const flushPromises = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const readLeaseSignal = (options: unknown): AbortSignal => {
  const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
  if (!signal) throw new Error("Lease request did not include an abort signal");
  return signal;
};

const rejectWhenAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    const rejectAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });

const expectLeasePost = (call: number, body: Record<string, unknown>) => {
  expect(postServiceJsonMock).toHaveBeenNthCalledWith(
    call,
    "/api/voice/lease",
    body,
    expect.objectContaining({ signal: expect.anything() }),
  );
};

const managedToken = (overrides: Partial<VoiceSessionToken> = {}) =>
  ({
    provider: "stella",
    transport: "openai-webrtc",
    clientSecret: "ephemeral-secret",
    model: "gpt-realtime",
    voice: "marin",
    ownerGeneration: "owner-generation-1",
    stellaSessionId: "voice-session-1",
    providerDispatchId: "provider-dispatch-1",
    providerAttemptId: "provider-attempt-1",
    authorityLeaseId: "authority-lease-1",
    authorityEpoch: 7,
    authorityExpiresAt: BASE_NOW + 10_000,
    ...overrides,
  }) satisfies VoiceSessionToken;

const makeTransport = (disconnect = vi.fn(async () => undefined)) => {
  let events: RealtimeTransportEvents | null = null;
  const transport: RealtimeTransport = {
    provider: "openai",
    model: "gpt-realtime",
    connect: vi.fn(async (nextEvents: RealtimeTransportEvents) => {
      events = nextEvents;
    }),
    send: vi.fn(),
    setMicEnabled: vi.fn(async () => undefined),
    applySoftInputMute: vi.fn(),
    getMicAnalyser: vi.fn(() => null),
    getOutputAnalyser: vi.fn(() => null),
    interruptPlayback: vi.fn(),
    disconnect,
  };
  return { transport, disconnect, getEvents: () => events };
};

const closedResponse = (
  authorityEpoch: number,
  authorityExpiresAt = BASE_NOW,
) => ({
  recorded: true,
  directive: "closed" as const,
  authorityEpoch,
  authorityExpiresAt,
  cancelReason: null,
});

describe("RealtimeVoiceSession server authority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
    vi.stubGlobal("window", {
      electronAPI: {
        localChat: {
          onUpdated: vi.fn(() => vi.fn()),
        },
        voice: {
          getOrchestratorConfig: vi.fn(async () => null),
          getCoreMemory: vi.fn(async () => null),
        },
      },
    });
    createRealtimeTransportMock.mockReset();
    postServiceJsonMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renews every two seconds with the exact authority tuple", async () => {
    const { transport } = makeTransport();
    const leaseSignals: AbortSignal[] = [];
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event: string }, options: unknown) => {
        leaseSignals.push(readLeaseSignal(options));
        return body.event === "heartbeat"
          ? {
              recorded: true,
              directive: "continue",
              authorityEpoch: 7,
              authorityExpiresAt: Date.now() + 10_000,
              cancelReason: null,
            }
          : closedResponse(7);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await flushPromises();

    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
    expectLeasePost(1, {
      stellaSessionId: "voice-session-1",
      event: "heartbeat",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
    expect(leaseSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(2);
    expectLeasePost(2, {
      stellaSessionId: "voice-session-1",
      event: "heartbeat",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
    });

    await session.disconnect();
  });

  it("posts the exact attempt tuple and drains replayed usage before ended", async () => {
    const firstUsage = deferred<unknown>();
    const replayedUsage = deferred<unknown>();
    const { transport, disconnect, getEvents } = makeTransport();
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    let usagePostCount = 0;
    postServiceJsonMock.mockImplementation(
      async (path: string, body: { event?: string }) => {
        if (path === "/api/voice/usage") {
          usagePostCount += 1;
          return usagePostCount === 1
            ? firstUsage.promise
            : replayedUsage.promise;
        }
        return body.event === "heartbeat"
          ? {
              recorded: true,
              directive: "continue",
              authorityEpoch: 7,
              authorityExpiresAt: BASE_NOW + 10_000,
              cancelReason: null,
            }
          : closedResponse(7);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await flushPromises();
    const response = {
      type: "response.done",
      response: {
        id: "provider-response-1",
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    };
    getEvents()?.onEvent(response);
    getEvents()?.onEvent(response);
    await flushPromises();

    expect(postServiceJsonMock).toHaveBeenNthCalledWith(
      2,
      "/api/voice/usage",
      {
        responseId: "provider-response-1",
        model: "gpt-realtime",
        ownerGeneration: "owner-generation-1",
        stellaSessionId: "voice-session-1",
        providerDispatchId: "provider-dispatch-1",
        providerAttemptId: "provider-attempt-1",
        authorityLeaseId: "authority-lease-1",
        authorityEpoch: 7,
        conversationId: "conversation-1",
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      expect.objectContaining({
        parseResponse: false,
        signal: expect.anything(),
      }),
    );

    const disconnectPromise = session.disconnect();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(
      postServiceJsonMock.mock.calls.some(
        ([, body]) => (body as { event?: string }).event === "ended",
      ),
    ).toBe(false);

    // Reverse completion order: authority must remain open until both exact
    // reports, including a provider replay, have settled.
    replayedUsage.resolve(undefined);
    await flushPromises();
    expect(
      postServiceJsonMock.mock.calls.some(
        ([, body]) => (body as { event?: string }).event === "ended",
      ),
    ).toBe(false);
    firstUsage.resolve(undefined);
    await disconnectPromise;

    expectLeasePost(4, {
      stellaSessionId: "voice-session-1",
      event: "ended",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      usageDisposition: "drained",
      transportClosedAt: BASE_NOW,
    });
  });

  it("fences a replayed provider response to the new physical attempt after restart", async () => {
    const first = makeTransport();
    const second = makeTransport();
    createRealtimeTransportMock
      .mockResolvedValueOnce({
        transport: first.transport,
        token: managedToken(),
        providerKey: "stella",
      })
      .mockResolvedValueOnce({
        transport: second.transport,
        token: managedToken({
          stellaSessionId: "voice-session-2",
          providerDispatchId: "provider-dispatch-2",
          providerAttemptId: "provider-attempt-2",
          authorityLeaseId: "authority-lease-2",
          authorityEpoch: 9,
        }),
        providerKey: "stella",
      });
    postServiceJsonMock.mockImplementation(
      async (
        path: string,
        body: { event?: string; authorityEpoch?: number },
      ) => {
        if (path === "/api/voice/usage") return undefined;
        return body.event === "heartbeat"
          ? {
              recorded: true,
              directive: "continue",
              authorityEpoch: body.authorityEpoch,
              authorityExpiresAt: BASE_NOW + 10_000,
              cancelReason: null,
            }
          : closedResponse(body.authorityEpoch ?? 7);
      },
    );
    const replayedResponse = {
      type: "response.done",
      response: {
        id: "provider-replayed-response",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    };

    const firstSession = new RealtimeVoiceSession();
    await firstSession.connect("conversation-1");
    first.getEvents()?.onEvent(replayedResponse);
    await flushPromises();
    await firstSession.disconnect();

    const restartedSession = new RealtimeVoiceSession();
    await restartedSession.connect("conversation-1");
    second.getEvents()?.onEvent(replayedResponse);
    await flushPromises();
    await restartedSession.disconnect();

    const usageBodies = postServiceJsonMock.mock.calls
      .filter(([path]) => path === "/api/voice/usage")
      .map(([, body]) => body as Record<string, unknown>);
    expect(usageBodies).toHaveLength(2);
    expect(usageBodies[0]).toEqual(
      expect.objectContaining({
        responseId: "provider-replayed-response",
        stellaSessionId: "voice-session-1",
        providerDispatchId: "provider-dispatch-1",
        providerAttemptId: "provider-attempt-1",
        authorityLeaseId: "authority-lease-1",
        authorityEpoch: 7,
      }),
    );
    expect(usageBodies[1]).toEqual(
      expect.objectContaining({
        responseId: "provider-replayed-response",
        stellaSessionId: "voice-session-2",
        providerDispatchId: "provider-dispatch-2",
        providerAttemptId: "provider-attempt-2",
        authorityLeaseId: "authority-lease-2",
        authorityEpoch: 9,
      }),
    );
  });

  it("closes a connected transport, then reports unresolved cancel after usage failure", async () => {
    const heartbeat = deferred<unknown>();
    const usageReport = deferred<unknown>();
    const { transport, disconnect, getEvents } = makeTransport();
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (path: string, body: { event?: string }) => {
        if (path === "/api/voice/usage") return usageReport.promise;
        if (body.event === "heartbeat") return heartbeat.promise;
        return closedResponse(8);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    getEvents()?.onEvent({
      type: "response.done",
      response: {
        id: "provider-response-2",
        usage: { input_tokens: 8, output_tokens: 3 },
      },
    });
    await flushPromises();

    heartbeat.resolve({
      recorded: false,
      directive: "cancel",
      authorityEpoch: 8,
      authorityExpiresAt: BASE_NOW + 10_000,
      cancelReason: "owner_lifecycle",
    });
    await flushPromises();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(
      postServiceJsonMock.mock.calls.some(
        ([, body]) => (body as { event?: string }).event === "cancel_ack",
      ),
    ).toBe(false);

    usageReport.reject(new Error("usage endpoint offline"));
    await flushPromises();
    const cancelAckCall = postServiceJsonMock.mock.calls.find(
      ([, body]) => (body as { event?: string }).event === "cancel_ack",
    );
    expect(cancelAckCall?.[1]).toEqual({
      stellaSessionId: "voice-session-1",
      event: "cancel_ack",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 8,
      usageDisposition: "unresolved",
      transportClosedAt: BASE_NOW,
    });
    expect(session.state).toBe("error");
  });

  it("bounds a black-holed usage drain and still reports terminal authority", async () => {
    const { transport, getEvents } = makeTransport();
    let usageSignal: AbortSignal | null = null;
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      (path: string, body: { event?: string }, options: unknown) => {
        if (path === "/api/voice/usage") {
          usageSignal = readLeaseSignal(options);
          return rejectWhenAborted(usageSignal);
        }
        return body.event === "heartbeat"
          ? {
              recorded: true,
              directive: "continue",
              authorityEpoch: 7,
              authorityExpiresAt: BASE_NOW + 10_000,
              cancelReason: null,
            }
          : closedResponse(7);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    getEvents()?.onEvent({
      type: "response.done",
      response: {
        id: "provider-response-timeout",
        usage: { input_tokens: 1 },
      },
    });
    await flushPromises();
    const disconnectPromise = session.disconnect();
    expect(usageSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await disconnectPromise;

    expect(usageSignal?.aborted).toBe(true);
    const endedCall = postServiceJsonMock.mock.calls.find(
      ([, body]) => (body as { event?: string }).event === "ended",
    );
    expect(endedCall?.[1]).toEqual({
      stellaSessionId: "voice-session-1",
      event: "ended",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      usageDisposition: "unresolved",
      transportClosedAt: BASE_NOW,
    });
  });

  it("never posts a provider response that arrives after usage intake closes", async () => {
    const transportClosed = deferred<void>();
    const disconnect = vi.fn(() => transportClosed.promise);
    const { transport, getEvents } = makeTransport(disconnect);
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event?: string }) =>
        body.event === "heartbeat"
          ? {
              recorded: true,
              directive: "continue",
              authorityEpoch: 7,
              authorityExpiresAt: BASE_NOW + 10_000,
              cancelReason: null,
            }
          : closedResponse(7),
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await flushPromises();
    const disconnectPromise = session.disconnect();
    getEvents()?.onEvent({
      type: "response.done",
      response: {
        id: "too-late",
        usage: { input_tokens: 2 },
      },
    });
    expect(
      postServiceJsonMock.mock.calls.some(
        ([path]) => path === "/api/voice/usage",
      ),
    ).toBe(false);

    transportClosed.resolve();
    await disconnectPromise;
    const endedCall = postServiceJsonMock.mock.calls.find(
      ([, body]) => (body as { event?: string }).event === "ended",
    );
    expect(endedCall?.[1]).toEqual(
      expect.objectContaining({ usageDisposition: "unresolved" }),
    );
  });

  it("closes before attempting a server cancel ack and bounds ack failure", async () => {
    const heartbeat = deferred<unknown>();
    const transportClosed = deferred<void>();
    const disconnect = vi.fn(() => transportClosed.promise);
    const { transport, getEvents } = makeTransport(disconnect);
    let cancelAckSignal: AbortSignal | null = null;
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event: string }, options: unknown) => {
        if (body.event === "heartbeat") {
          return heartbeat.promise;
        }
        cancelAckSignal = readLeaseSignal(options);
        return rejectWhenAborted(cancelAckSignal);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    heartbeat.resolve({
      recorded: false,
      directive: "cancel",
      authorityEpoch: 8,
      authorityExpiresAt: BASE_NOW + 10_000,
      cancelReason: "new_lease",
    });
    await flushPromises();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
    getEvents()?.onClose("transport closed");
    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);

    transportClosed.resolve();
    await flushPromises();
    expect(postServiceJsonMock).toHaveBeenCalledTimes(2);
    expectLeasePost(2, {
      stellaSessionId: "voice-session-1",
      event: "cancel_ack",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 8,
      usageDisposition: "drained",
      transportClosedAt: BASE_NOW,
    });
    expect(cancelAckSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(cancelAckSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(cancelAckSignal?.aborted).toBe(true);
    expect(session.state).toBe("error");
    expect(
      postServiceJsonMock.mock.calls.some(
        ([, body]) =>
          (body as { event?: string }).event === "lost" ||
          (body as { event?: string }).event === "ended",
      ),
    ).toBe(false);
  });

  it("enforces cancellation while the transport handshake is still pending", async () => {
    const connection = deferred<void>();
    const { transport, disconnect } = makeTransport();
    transport.connect = vi.fn(() => connection.promise);
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event: string }) =>
        body.event === "heartbeat"
          ? {
              recorded: false,
              directive: "cancel",
              authorityEpoch: 8,
              authorityExpiresAt: BASE_NOW + 10_000,
              cancelReason: "owner_lifecycle",
            }
          : closedResponse(8),
    );

    const session = new RealtimeVoiceSession();
    const connectPromise = session.connect("conversation-1");
    const connectOutcome = connectPromise.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await flushPromises();

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expectLeasePost(2, {
      stellaSessionId: "voice-session-1",
      event: "cancel_ack",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 8,
      usageDisposition: "drained",
      transportClosedAt: BASE_NOW,
    });

    connection.resolve();
    const { error } = await connectOutcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("owner_lifecycle");
    expect(session.state).not.toBe("connected");
  });

  it("fails closed on an invalid response without adopting its null tuple", async () => {
    const heartbeat = deferred<unknown>();
    const transportClosed = deferred<void>();
    const disconnect = vi.fn(() => transportClosed.promise);
    const { transport } = makeTransport(disconnect);
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken(),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event: string }) =>
        body.event === "heartbeat" ? heartbeat.promise : closedResponse(7),
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    heartbeat.resolve({
      recorded: false,
      directive: "invalid",
      authorityEpoch: null,
      authorityExpiresAt: null,
      cancelReason: null,
    });
    await flushPromises();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
    transportClosed.resolve();
    await flushPromises();
    expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("error");
  });

  it("does not open a managed transport without the complete authority tuple", async () => {
    const { transport, disconnect } = makeTransport();
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken({ authorityLeaseId: undefined }),
      providerKey: "stella",
    });

    const session = new RealtimeVoiceSession();
    await expect(session.connect("conversation-1")).rejects.toThrow(
      "did not include valid authority fields",
    );
    expect(transport.connect).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(postServiceJsonMock).not.toHaveBeenCalled();
  });

  it("closes at local expiry, then reports expired and acknowledges a cancel race", async () => {
    const heartbeat = deferred<unknown>();
    let heartbeatCount = 0;
    const transportClosed = deferred<void>();
    const disconnect = vi.fn(() => transportClosed.promise);
    const { transport } = makeTransport(disconnect);
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken({ authorityExpiresAt: BASE_NOW + 60_000 }),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      async (_path: string, body: { event: string }) => {
        if (body.event === "heartbeat") {
          heartbeatCount += 1;
          if (heartbeatCount === 1) throw new Error("offline");
          return heartbeat.promise;
        }
        if (body.event === "expired") {
          return {
            recorded: false,
            directive: "cancel",
            authorityEpoch: 8,
            authorityExpiresAt: BASE_NOW + 10_000,
            cancelReason: "authority_expired",
          };
        }
        return closedResponse(8);
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await flushPromises();

    await vi.advanceTimersByTimeAsync(8_999);
    expect(disconnect).not.toHaveBeenCalled();
    expect(postServiceJsonMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(2);

    transportClosed.resolve();
    await flushPromises();
    expectLeasePost(3, {
      stellaSessionId: "voice-session-1",
      event: "expired",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 7,
      usageDisposition: "drained",
      transportClosedAt: BASE_NOW + 9_000,
    });
    expectLeasePost(4, {
      stellaSessionId: "voice-session-1",
      event: "cancel_ack",
      authorityLeaseId: "authority-lease-1",
      authorityEpoch: 8,
      usageDisposition: "drained",
      transportClosedAt: BASE_NOW + 9_000,
    });

    heartbeat.resolve({
      recorded: true,
      directive: "continue",
      authorityEpoch: 7,
      authorityExpiresAt: BASE_NOW + 30_000,
      cancelReason: null,
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(postServiceJsonMock).toHaveBeenCalledTimes(4);
  });

  it("aborts a black-holed lease request and still closes at local expiry", async () => {
    const { transport, disconnect } = makeTransport();
    const leaseSignals: AbortSignal[] = [];
    let heartbeatCount = 0;
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken({ authorityExpiresAt: BASE_NOW + 60_000 }),
      providerKey: "stella",
    });
    postServiceJsonMock.mockImplementation(
      (_path: string, body: { event: string }, options: unknown) => {
        const signal = readLeaseSignal(options);
        leaseSignals.push(signal);
        if (body.event !== "heartbeat") return closedResponse(7);
        heartbeatCount += 1;
        if (heartbeatCount === 1) return rejectWhenAborted(signal);
        throw new Error("offline");
      },
    );

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await flushPromises();

    expect(leaseSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(leaseSignals[0]?.aborted).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(leaseSignals[0]?.aborted).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(7_499);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(
      postServiceJsonMock.mock.calls.some(
        ([, body]) => (body as { event?: string }).event === "expired",
      ),
    ).toBe(true);

    // Resolved/rejected posts clear their own deadline instead of letting a
    // stale timeout mutate an already-completed request signal later.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(leaseSignals.slice(1).every((signal) => !signal.aborted)).toBe(true);
  });

  it.each([
    { directive: "continue", authorityEpoch: 8 },
    { directive: "cancel", authorityEpoch: 6 },
    { directive: "cancel", authorityEpoch: 9 },
    { directive: "closed", authorityEpoch: 8 },
  ] as const)(
    "fails closed on an unexpected $directive response epoch $authorityEpoch",
    async ({ directive, authorityEpoch }) => {
      const heartbeat = deferred<unknown>();
      const { transport, disconnect } = makeTransport();
      createRealtimeTransportMock.mockResolvedValue({
        transport,
        token: managedToken(),
        providerKey: "stella",
      });
      postServiceJsonMock.mockImplementation(
        async (_path: string, body: { event: string }) =>
          body.event === "heartbeat" ? heartbeat.promise : closedResponse(7),
      );

      const session = new RealtimeVoiceSession();
      await session.connect("conversation-1");
      heartbeat.resolve({
        recorded: directive === "continue",
        directive,
        authorityEpoch,
        authorityExpiresAt: BASE_NOW + 10_000,
        cancelReason: null,
      });
      await flushPromises();

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(postServiceJsonMock).toHaveBeenCalledTimes(1);
      expect(session.state).toBe("error");
    },
  );

  it("leaves BYOK sessions outside the authority protocol", async () => {
    const { transport, disconnect } = makeTransport();
    createRealtimeTransportMock.mockResolvedValue({
      transport,
      token: managedToken({
        provider: "openai",
        ownerGeneration: undefined,
        stellaSessionId: undefined,
        providerDispatchId: undefined,
        providerAttemptId: undefined,
        authorityLeaseId: undefined,
        authorityEpoch: undefined,
        authorityExpiresAt: undefined,
      }),
      providerKey: "openai",
    });

    const session = new RealtimeVoiceSession();
    await session.connect("conversation-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(postServiceJsonMock).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });
});
