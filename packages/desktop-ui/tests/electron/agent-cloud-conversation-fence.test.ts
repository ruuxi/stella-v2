import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electron.handles.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electron.listeners.set(channel, handler);
    }),
  },
  webContents: { fromId: () => null },
}));

const { registerAgentHandlers } = await import(
  "@stella/desktop/electron/ipc/agent-handlers.js"
);

const event = { sender: { id: 7 } };

describe("agent IPC cloud conversation fence", () => {
  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
  });

  const register = () => {
    const uiState = { conversationId: "cloud-current" };
    const runner = {
      waitUntilConnected: vi.fn().mockResolvedValue(undefined),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      sendAgentInput: vi.fn().mockResolvedValue({ ok: true }),
      listActiveRuns: vi.fn().mockResolvedValue({ runs: [] }),
      agentHealthCheck: vi.fn().mockResolvedValue({ ready: true }),
      getActiveOrchestratorRun: vi.fn().mockResolvedValue({
        runId: "run-old",
        conversationId: "cloud-old",
      }),
      handleLocalChat: vi.fn().mockImplementation(async (_payload, callbacks) => {
        callbacks.onRunStarted?.({ runId: "run-current" });
        return { runId: "run-current" };
      }),
      cancelLocalChat: vi.fn(),
    };
    registerAgentHandlers({
      getStellaHostRunner: () => runner,
      getActiveCloudConversationCacheAuthority: () => ({
        accountScope: "account:test",
        ownerGeneration: "generation:test",
      }),
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      uiState,
      stellaAppDir: "/tmp/stella-cloud-authority-test",
      assertPrivilegedSender: () => true,
    });
    return { runner, uiState };
  };

  it("rejects a stale send-input id before calling the runtime", async () => {
    const { runner } = register();
    const handler = electron.handles.get("agent:sendInput");

    await expect(
      handler?.(event, {
        conversationId: "cloud-old",
        threadId: "thread-1",
        message: "continue",
      }),
    ).rejects.toThrow("active cloud conversation changed");
    expect(runner.sendAgentInput).not.toHaveBeenCalled();
  });

  it("normalizes the selected id before forwarding send input", async () => {
    const { runner } = register();
    const handler = electron.handles.get("agent:sendInput");

    await handler?.(event, {
      conversationId: " cloud-current ",
      threadId: "thread-1",
      message: "continue",
    });

    expect(runner.sendAgentInput).toHaveBeenCalledWith({
      conversationId: "cloud-current",
      threadId: "thread-1",
      message: "continue",
    });
  });

  it("rejects stale resume requests instead of attaching the old run", async () => {
    const { runner } = register();
    const handler = electron.handles.get("agent:resume");

    await expect(
      handler?.(event, { conversationId: "cloud-old", lastSeq: 0 }),
    ).rejects.toThrow("active cloud conversation changed");
    expect(runner.listActiveRuns).not.toHaveBeenCalled();
  });

  it("does not expose an active run owned by another conversation", async () => {
    const { runner } = register();
    const handler = electron.handles.get("agent:getActiveRun");

    await expect(handler?.(event)).resolves.toBeNull();
    expect(runner.getActiveOrchestratorRun).toHaveBeenCalledOnce();
  });

  it("does not let a renderer cancel a run after selection changes", async () => {
    const { runner, uiState } = register();
    await electron.handles.get("agent:startChat")?.(event, {
      conversationId: "cloud-current",
      userPrompt: "hello",
    });

    uiState.conversationId = "cloud-next";
    electron.listeners.get("agent:cancelChat")?.(event, "run-current");

    expect(runner.cancelLocalChat).not.toHaveBeenCalled();
  });

  it("scopes client idempotency keys to the selected conversation", async () => {
    const { runner, uiState } = register();
    const start = electron.handles.get("agent:startChat");
    const first = await start?.(event, {
      conversationId: "cloud-current",
      userPrompt: "first",
      clientRequestId: "client-send-1",
    });

    uiState.conversationId = "cloud-next";
    const second = await start?.(event, {
      conversationId: "cloud-next",
      userPrompt: "second",
      clientRequestId: "client-send-1",
    });

    expect(runner.handleLocalChat).toHaveBeenCalledTimes(2);
    expect(first.requestId).not.toBe(second.requestId);
  });
});
