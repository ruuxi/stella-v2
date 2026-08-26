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
  it("returns one durable canonical acceptance through repeated bridge invokes", async () => {
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
    let runtimeStarts = 0;
    const runner = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      handleLocalChat: vi
        .fn()
        .mockImplementation(async (payload, callbacks) => {
          runtimeStarts += 1;
          history.appendEvent({
            conversationId: payload.conversationId,
            eventId: payload.userMessageEventId,
            type: "user_message",
            timestamp: 1_000,
            payload: { text: payload.userPrompt },
          });
          callbacks.onRunStarted?.({
            runId: "run-1",
            userMessageId: payload.userMessageEventId,
          });
          return { runId: "run-1" };
        }),
    };

    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: root,
      localChatHistoryService: history,
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
    };
    const invoke = async () => {
      const response = createResponse();
      await anyBridge.handleRequest(createInvokeRequest(payload), response);
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body).result as Record<string, unknown>;
    };

    const first = await invoke();
    history.close();
    history.reopen();
    const replay = await invoke();

    expect(first).toMatchObject({
      runId: "run-1",
      userMessageId: "mobile:send-1",
      accepted: true,
    });
    expect(replay).toEqual({
      ...first,
      deduplicated: true,
    });
    expect(runtimeStarts).toBe(1);
    expect(
      history
        .syncMessages({ conversationId: "conversation-1" })
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    history.close();
  });

  it("acknowledges a durable mobile message before its steer is consumed", async () => {
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
      stellaAppDir: root,
      localChatHistoryService: history,
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
    await anyBridge.handleRequest(
      createInvokeRequest({
        conversationId: "conversation-1",
        userPrompt: "steer now",
        clientRequestId: "mobile:send-delayed",
        userMessageEventId: "mobile:send-delayed",
      }),
      response,
    );

    expect(response.statusCode).toBe(200);
    const accepted = JSON.parse(response.body).result;
    expect(accepted).toEqual({
      requestId: expect.any(String),
      userMessageId: "mobile:send-delayed",
      accepted: true,
    });
    expect(runner.handleLocalChat).toHaveBeenCalledOnce();

    const cancelResponse = createResponse();
    await anyBridge.handleRequest(
      createInvokeRequest(
        { requestId: accepted.requestId },
        "agent:cancelChat",
      ),
      cancelResponse,
    );
    expect(cancelResponse.statusCode).toBe(204);
    expect(runner.cancelLocalChat).not.toHaveBeenCalled();

    releaseSteer();
    await vi.waitFor(() => {
      expect(runner.handleLocalChat).toHaveReturned();
      expect(runner.cancelLocalChat).toHaveBeenCalledWith("run-delayed");
    });
    history.close();
  });

  it("accepts rapid distinct steers in order without waiting for root completion", async () => {
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
    let releaseRoot!: () => void;
    const rootCompletion = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let runtimeStarts = 0;
    const runner = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      handleLocalChat: vi.fn().mockImplementation(async (payload) => {
        runtimeStarts += 1;
        history.appendEvent({
          conversationId: payload.conversationId,
          eventId: payload.userMessageEventId,
          type: "user_message",
          timestamp: 1_000 + runtimeStarts,
          payload: { text: payload.userPrompt },
        });
        await rootCompletion;
        return { runId: "shared-run" };
      }),
    };

    registerAgentHandlers({
      getStellaHostRunner: () => runner as never,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: root,
      localChatHistoryService: history,
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
      accepted: true,
      deduplicated: true,
    });
    expect(runtimeStarts).toBe(2);
    expect(
      history
        .syncMessages({ conversationId: "conversation-1" })
        .messages.filter((message) => message.role === "user")
        .map((message) => message.localMessageId),
    ).toEqual(["mobile:steer-1", "mobile:steer-2"]);

    releaseRoot();
    await vi.waitFor(() => {
      expect(runner.handleLocalChat).toHaveReturnedTimes(2);
    });
    history.close();
  });
});
