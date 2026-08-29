import { describe, expect, it, vi } from "vitest";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import { shouldAckWorkerRunEvent } from "@stella/runtime/host";
import { RuntimeHostAdapter } from "@stella/desktop/electron/runtime-host-adapter.js";

const createAdapter = () =>
  new RuntimeHostAdapter({
    hostHandlers: {
      getDeviceIdentity: async () => ({
        deviceId: "dev-device",
        publicKey: "pub",
      }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
    },
    initializeParams: {
      clientName: "test-client",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      stellaAppDir: "/tmp/stella-test",
      stellaWorkspacePath: "/tmp/stella-test",
    },
  });

describe("RuntimeHostAdapter config batching", () => {
  it("batches same-tick auth patches into one configure call", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.started = true;
    const configure = vi.fn().mockResolvedValue({ ok: true });
    anyAdapter.host.configure = configure;

    adapter.setHasConnectedAccount(true);
    adapter.setAuthToken("fresh-token");

    await Promise.resolve();

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      hasConnectedAccount: true,
      authToken: "fresh-token",
    });
  });

  it("keeps cloud sync enabled when an older renderer requests local mode", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.started = true;
    const configure = vi.fn().mockResolvedValue({ ok: true });
    anyAdapter.host.configure = configure;

    adapter.setCloudSyncEnabled(false);
    await Promise.resolve();

    expect(configure).toHaveBeenCalledWith({ cloudSyncEnabled: true });
  });

  it("does not mark a completed startChat result as the active run", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.host.startChat = vi.fn().mockResolvedValue({ runId: "run-1" });

    await adapter.handleLocalChat(
      {
        conversationId: "conversation-1",
        userPrompt: "hello",
      },
      {
        onAssistantMessage: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
      },
    );

    expect(anyAdapter.activeRun).toBeNull();
    expect(anyAdapter.host.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        storageMode: "cloud",
      }),
    );
  });
});

describe("RuntimeHostAdapter send readiness", () => {
  it("keeps a healthy worker send-ready while its restart is pending", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.connected = true;
    anyAdapter.lastRuntimeHealth = {
      ready: true,
      pendingWorkerRestart: true,
    };
    anyAdapter.host.health = vi.fn().mockResolvedValue({
      ready: true,
      pendingWorkerRestart: true,
    });
    anyAdapter.host.healthCheck = vi.fn().mockResolvedValue({ ready: true });

    await expect(adapter.waitUntilReady(5)).resolves.toBeUndefined();
  });

  it("accepts an authoritative ready snapshot with no pending restart", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.connected = true;
    anyAdapter.host.health = vi.fn().mockResolvedValue({ ready: true });
    anyAdapter.host.healthCheck = vi.fn().mockResolvedValue({ ready: true });

    await expect(adapter.waitUntilReady(5)).resolves.toBeUndefined();
  });

  it("does not treat a healthy host socket as a ready worker runner", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.connected = true;
    anyAdapter.host.health = vi.fn().mockResolvedValue({ ready: true });
    anyAdapter.host.healthCheck = vi.fn().mockResolvedValue({
      ready: false,
      reason: "Runtime worker is not ready.",
    });

    await expect(adapter.waitUntilReady(5)).rejects.toThrow(
      "Runtime worker is not ready.",
    );
  });
});

describe("worker run-event acks", () => {
  it("keeps replay-critical terminal and synthetic events in the worker log", () => {
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
        seq: 42,
      }),
    ).toBe(true);
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
        seq: Date.now(),
      }),
    ).toBe(false);
    expect(
      shouldAckWorkerRunEvent({
        type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
        seq: 43,
      }),
    ).toBe(false);
  });
});

describe("RuntimeHostAdapter resumed chat sessions", () => {
  const emitRunEvent = (
    adapter: ReturnType<typeof createAdapter>,
    event: Record<string, unknown>,
  ) => {
    (
      adapter.host as unknown as {
        events: { emit: (name: string, event: unknown) => void };
      }
    ).events.emit("run-event", event);
  };

  const createCallbacks = () => ({
    onRunFinished: vi.fn(),
    onAssistantMessage: vi.fn(),
    onProviderLifecycle: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
  });

  it("routes resumed run events by conversation and run when the old request session is gone", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        active: true,
      },
      callbacks,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
      runId: "run-1",
      seq: 1,
      conversationId: "conversation-1",
      assistantMessageText: "still here",
    });

    expect(callbacks.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageText: "still here" }),
    );
  });

  it("forwards hash-only provider lifecycle receipts to the owning chat session", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        active: true,
      },
      callbacks,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.PROVIDER_LIFECYCLE,
      runId: "run-1",
      seq: 1,
      conversationId: "conversation-1",
      providerLifecyclePhase: "transport-joined",
      providerRequestIdSha256: "a".repeat(64),
      providerPhysicalAttempt: 1,
      providerStreamOrdinal: 1,
      providerName: "openai",
      providerModelId: "gpt-test",
      providerOutcome: "canceled",
    });

    expect(callbacks.onProviderLifecycle).toHaveBeenCalledOnce();
    expect(callbacks.onProviderLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        providerLifecyclePhase: "transport-joined",
        providerRequestIdSha256: "a".repeat(64),
      }),
    );
  });

  it("does not double-dispatch when a resumed event still carries the original request id", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        requestId: "request-1",
        active: true,
      },
      callbacks,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
      runId: "run-1",
      seq: 1,
      conversationId: "conversation-1",
      requestId: "request-1",
      assistantMessageText: "live",
    });

    expect(callbacks.onAssistantMessage).toHaveBeenCalledTimes(1);
  });

  it("streams a visible follow-up run that reuses the preserved request id", () => {
    const adapter = createAdapter();
    const callbacks = createCallbacks();
    const onRunStarted = vi.fn();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "root-run",
        requestId: "request-1",
        active: true,
      },
      { ...callbacks, onRunStarted },
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
      runId: "follow-up-run",
      seq: 1,
      conversationId: "conversation-1",
      requestId: "request-1",
      userMessageId: "message-1",
    });
    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
      runId: "follow-up-run",
      seq: 2,
      conversationId: "conversation-1",
      requestId: "request-1",
      userMessageId: "message-1",
      assistantMessageText: "visible reply",
    });

    expect(onRunStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageText: "visible reply" }),
    );
  });

  it("transfers same-run callback ownership to the consumed steer request", () => {
    const adapter = createAdapter();
    const first = createCallbacks();
    const second = createCallbacks();

    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        requestId: "request-1",
        active: true,
      },
      first,
    );
    adapter.attachResumedLocalChatSession(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        requestId: "request-2",
        active: false,
      },
      second,
    );

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
      runId: "run-1",
      seq: 2,
      conversationId: "conversation-1",
      requestId: "request-2",
      userMessageId: "message-2",
    });

    const sessions = (adapter as any).localChatSessions as Map<
      string,
      { activeRunIds: Set<string>; knownRunIds: Set<string> }
    >;
    expect(sessions.get("request-1")?.activeRunIds.has("run-1")).toBe(false);
    expect(sessions.get("request-1")?.knownRunIds.has("run-1")).toBe(false);
    expect(sessions.get("request-2")?.activeRunIds.has("run-1")).toBe(true);

    emitRunEvent(adapter, {
      type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
      runId: "run-1",
      seq: 3,
      conversationId: "conversation-1",
      requestId: "request-2",
      outcome: "completed",
    });

    expect(first.onRunFinished).not.toHaveBeenCalled();
    expect(second.onRunFinished).toHaveBeenCalledTimes(1);
    expect(sessions.get("request-2")?.activeRunIds.has("run-1")).toBe(false);
  });
});
