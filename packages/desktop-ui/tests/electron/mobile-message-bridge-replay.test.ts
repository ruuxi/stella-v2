import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronMocks.handle,
    on: electronMocks.on,
  },
  webContents: { fromId: () => null },
}));

const roots = new Set<string>();

type FakeResponse = {
  statusCode: number | null;
  body: string;
  headersSent: boolean;
  writeHead: (status: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: unknown) => void;
};

const createResponse = (): FakeResponse => {
  const response: FakeResponse = {
    statusCode: null,
    body: "",
    headersSent: false,
    writeHead: (status) => {
      response.statusCode = status;
      response.headersSent = true;
    },
    setHeader: () => undefined,
    end: (chunk) => {
      if (chunk !== undefined) response.body = String(chunk);
    },
  };
  return response;
};

const createInvokeRequest = (
  payload: Record<string, unknown>,
  channel = "agent:startChat",
) => {
  const request = Readable.from([
    Buffer.from(JSON.stringify({ args: [payload] })),
  ]) as Readable & {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  request.url = `/bridge/ipc/${encodeURIComponent(channel)}`;
  request.method = "POST";
  request.headers = {};
  return request;
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("mobile bridge replay end to end", () => {
  it("ignores legacy SQLite receipts and forces cloud storage at admission", async () => {
    const { startCapturingHandlers } =
      await import("@stella/desktop/electron/services/mobile-bridge/handler-registry.js");
    const stopCapturing = startCapturingHandlers();
    const [
      { registerAgentHandlers },
      { LocalChatHistoryService },
      { MobileBridgeService },
    ] = await Promise.all([
      import("@stella/desktop/electron/ipc/agent-handlers.js"),
      import("@stella/desktop/electron/services/local-chat-history-service.js"),
      import("@stella/desktop/electron/services/mobile-bridge/service.js"),
    ]);

    const root = path.join(
      os.tmpdir(),
      `stella-mobile-bridge-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.add(root);
    const history = new LocalChatHistoryService({ stellaAppDir: root });
    history.appendEvent({
      conversationId: "conversation-1",
      eventId: "mobile:send-1",
      type: "user_message",
      timestamp: 999,
      payload: { text: "stale local receipt" },
    });
    let runtimeStarts = 0;
    let admittedPayload: Record<string, unknown> | null = null;
    const runner = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      handleLocalChat: vi
        .fn()
        .mockImplementation(async (payload, callbacks) => {
          runtimeStarts += 1;
          admittedPayload = payload;
          callbacks.onRunStarted?.({
            runId: "run-1",
            userMessageId: payload.userMessageEventId,
          });
          return { runId: "run-1" };
        }),
    };

    const uiState = { conversationId: "conversation-1" };
    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      uiState,
      stellaAppDir: root,
      assertPrivilegedSender: () => true,
    });
    stopCapturing();

    const bridge = new MobileBridgeService({
      electronDir: path.join(root, "desktop/electron"),
      isDev: false,
      getDevServerUrl: () => "http://127.0.0.1:5173",
    });
    const anyBridge = bridge as any;
    anyBridge.registrationState = "healthy";
    anyBridge.registrationLeaseExpiresAt = Date.now() + 60_000;
    anyBridge.hostAuthToken = "token";
    anyBridge.convexSiteUrl = "https://example.convex.site";
    anyBridge.deviceId = "desktop-device";
    anyBridge.ensureAuthorized = vi.fn().mockResolvedValue({});

    const payload = {
      conversationId: "conversation-1",
      userPrompt: "hello",
      clientRequestId: "mobile:send-1",
      userMessageEventId: "mobile:send-1",
      storageMode: "local",
    };
    const response = createResponse();
    await anyBridge.handleRequest(createInvokeRequest(payload), response);
    expect(response.statusCode).toBe(200);
    const first = JSON.parse(response.body).result as Record<string, unknown>;

    expect(first).toMatchObject({
      runId: "run-1",
      userMessageId: "mobile:send-1",
      accepted: true,
    });
    expect(runtimeStarts).toBe(1);
    expect(admittedPayload).toMatchObject({
      conversationId: "conversation-1",
      storageMode: "cloud",
    });

    uiState.conversationId = "conversation-2";
    const staleResponse = createResponse();
    await anyBridge.handleRequest(
      createInvokeRequest({
        ...payload,
        clientRequestId: "mobile:send-stale",
        userMessageEventId: "mobile:send-stale",
      }),
      staleResponse,
    );
    expect(staleResponse.statusCode).toBe(500);
    expect(staleResponse.body).toContain("active cloud conversation changed");
    expect(runtimeStarts).toBe(1);
    history.close();
  });

  it("does not acknowledge from SQLite while cloud admission is pending", async () => {
    const { startCapturingHandlers } =
      await import("@stella/desktop/electron/services/mobile-bridge/handler-registry.js");
    const stopCapturing = startCapturingHandlers();
    const [
      { registerAgentHandlers },
      { LocalChatHistoryService },
      { MobileBridgeService },
    ] = await Promise.all([
      import("@stella/desktop/electron/ipc/agent-handlers.js"),
      import("@stella/desktop/electron/services/local-chat-history-service.js"),
      import("@stella/desktop/electron/services/mobile-bridge/service.js"),
    ]);

    const root = path.join(
      os.tmpdir(),
      `stella-mobile-bridge-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.add(root);
    const history = new LocalChatHistoryService({ stellaAppDir: root });
    let releaseSteer!: () => void;
    const steerConsumed = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const runner = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      cancelLocalChat: vi.fn(),
      handleLocalChat: vi
        .fn()
        .mockImplementation(async (payload, callbacks) => {
          history.appendEvent({
            conversationId: payload.conversationId,
            eventId: payload.userMessageEventId,
            type: "user_message",
            timestamp: 1_000,
            payload: { text: payload.userPrompt },
          });
          await steerConsumed;
          callbacks.onRunStarted?.({
            runId: "run-delayed",
            userMessageId: payload.userMessageEventId,
          });
          return { runId: "run-delayed" };
        }),
    };

    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      uiState: { conversationId: "conversation-1" },
      stellaAppDir: root,
      assertPrivilegedSender: () => true,
    });
    stopCapturing();

    const bridge = new MobileBridgeService({
      electronDir: path.join(root, "desktop/electron"),
      isDev: false,
      getDevServerUrl: () => "http://127.0.0.1:5173",
    });
    const anyBridge = bridge as any;
    anyBridge.registrationState = "healthy";
    anyBridge.registrationLeaseExpiresAt = Date.now() + 60_000;
    anyBridge.hostAuthToken = "token";
    anyBridge.convexSiteUrl = "https://example.convex.site";
    anyBridge.deviceId = "desktop-device";
    anyBridge.ensureAuthorized = vi.fn().mockResolvedValue({});

    const response = createResponse();
    const pendingRequest = anyBridge.handleRequest(
      createInvokeRequest({
        conversationId: "conversation-1",
        userPrompt: "steer now",
        clientRequestId: "mobile:send-delayed",
        userMessageEventId: "mobile:send-delayed",
        storageMode: "local",
      }),
      response,
    );

    await vi.waitFor(() => {
      expect(
        history.hasEventId({
          eventId: "mobile:send-delayed",
          type: "user_message",
        }),
      ).toBe(true);
    });
    expect(response.statusCode).toBeNull();

    releaseSteer();
    await pendingRequest;
    expect(response.statusCode).toBe(200);
    const accepted = JSON.parse(response.body).result;
    expect(accepted).toMatchObject({
      requestId: expect.any(String),
      runId: "run-delayed",
      userMessageId: "mobile:send-delayed",
      accepted: true,
    });
    expect(runner.handleLocalChat).toHaveBeenCalledOnce();
    expect(runner.handleLocalChat).toHaveBeenCalledWith(
      expect.objectContaining({ storageMode: "cloud" }),
      expect.any(Object),
    );
    history.close();
  });

  it("accepts rapid distinct cloud admissions in order", async () => {
    const { startCapturingHandlers } =
      await import("@stella/desktop/electron/services/mobile-bridge/handler-registry.js");
    const stopCapturing = startCapturingHandlers();
    const [
      { registerAgentHandlers },
      { LocalChatHistoryService },
      { MobileBridgeService },
    ] = await Promise.all([
      import("@stella/desktop/electron/ipc/agent-handlers.js"),
      import("@stella/desktop/electron/services/local-chat-history-service.js"),
      import("@stella/desktop/electron/services/mobile-bridge/service.js"),
    ]);

    const root = path.join(
      os.tmpdir(),
      `stella-mobile-bridge-steers-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.add(root);
    const history = new LocalChatHistoryService({ stellaAppDir: root });
    let runtimeStarts = 0;
    const runner = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      handleLocalChat: vi.fn().mockImplementation(async (payload) => {
        runtimeStarts += 1;
        expect(payload.storageMode).toBe("cloud");
        return { runId: "shared-run" };
      }),
    };

    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      uiState: { conversationId: "conversation-1" },
      stellaAppDir: root,
      assertPrivilegedSender: () => true,
    });
    stopCapturing();

    const bridge = new MobileBridgeService({
      electronDir: path.join(root, "desktop/electron"),
      isDev: false,
      getDevServerUrl: () => "http://127.0.0.1:5173",
    });
    const anyBridge = bridge as any;
    anyBridge.registrationState = "healthy";
    anyBridge.registrationLeaseExpiresAt = Date.now() + 60_000;
    anyBridge.hostAuthToken = "token";
    anyBridge.convexSiteUrl = "https://example.convex.site";
    anyBridge.deviceId = "desktop-device";
    anyBridge.ensureAuthorized = vi.fn().mockResolvedValue({});

    const invoke = async (id: string, text: string) => {
      const response = createResponse();
      await anyBridge.handleRequest(
        createInvokeRequest({
          conversationId: "conversation-1",
          userPrompt: text,
          clientRequestId: id,
          userMessageEventId: id,
          storageMode: "local",
        }),
        response,
      );
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body).result as Record<string, unknown>;
    };

    const first = await invoke("mobile:steer-1", "first");
    const second = await invoke("mobile:steer-2", "second");
    const replaySecond = await invoke("mobile:steer-2", "second");

    expect(first).toMatchObject({
      userMessageId: "mobile:steer-1",
      accepted: true,
    });
    expect(second).toMatchObject({
      userMessageId: "mobile:steer-2",
      accepted: true,
    });
    expect(replaySecond).toMatchObject({
      userMessageId: "mobile:steer-2",
      accepted: false,
      deduplicated: true,
    });
    expect(runtimeStarts).toBe(2);
    history.close();
  });
});
