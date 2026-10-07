import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electron.handles.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electron.listeners.set(channel, handler);
    }),
  },
}));

const { registerVoiceHandlers } = await import(
  "@stella/desktop/electron/ipc/voice-handlers.js"
);

describe("voice IPC cloud conversation fence", () => {
  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.restoreAllMocks();
  });

  const register = (authority: { ownerGeneration: string } | null = {
    ownerGeneration: "gen-1",
  }) => {
    const uiState = {
      conversationId: "cloud-current",
      isVoiceRtcActive: true,
    };
    const runner = {
      persistVoiceTranscript: vi.fn().mockResolvedValue(undefined),
      handleVoiceChat: vi.fn().mockResolvedValue("ok"),
      getVoiceOrchestratorConfig: vi.fn().mockResolvedValue({
        instructions: "test",
        tools: [],
      }),
      executeVoiceTool: vi.fn().mockResolvedValue({ output: "ok" }),
    };
    const phone = registerVoiceHandlers({
      uiState,
      getAppReady: () => true,
      windowManager: {
        getAllWindows: () => [],
        getFullWindow: () => null,
      },
      toggleRealtimeVoice: () => undefined,
      assertPrivilegedSender: () => true,
      getStellaHostRunner: () => runner,
      getActiveCloudConversationCacheAuthority: () => authority,
      stellaAppDir: "/tmp/stella-cloud-authority-test",
      stellaDataDirPath: "/tmp/stella-cloud-authority-test",
    });
    return { runner, uiState, phone };
  };

  it("drops stale fire-and-forget transcript events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runner } = register();
    const handler = electron.listeners.get("voice:persistTranscript");

    handler?.({}, {
      conversationId: "cloud-old",
      role: "user",
      text: "stale",
    });
    await Promise.resolve();

    expect(runner.persistVoiceTranscript).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[voice] Rejected stale transcript:",
      expect.stringContaining("The active conversation changed"),
    );
  });

  it("rejects a stale orchestrator call before runtime dispatch", async () => {
    const { runner } = register();

    await expect(
      electron.handles.get("voice:orchestratorChat")?.({}, {
        conversationId: "cloud-old",
        message: "hello",
      }),
    ).rejects.toThrow("The active conversation changed");

    expect(runner.handleVoiceChat).not.toHaveBeenCalled();
  });

  it("authorizes a paired phone against the conversation it requested", async () => {
    const { runner, phone } = register();

    await phone.configForRequest({
      conversationId: " phone-selected ",
    });
    expect(runner.getVoiceOrchestratorConfig).toHaveBeenCalledWith({
      conversationId: "phone-selected",
    });

    await phone.executeToolForRequest({
      conversationId: "phone-selected",
      requestId: "voice-1",
      callId: "call-1",
      name: "search",
      args: {},
    });
    expect(runner.executeVoiceTool).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "phone-selected" }),
    );
  });

  it("still requires a conversation id and a ready cloud authority for phone requests", async () => {
    const { runner, phone } = register(null);

    await expect(
      phone.configForRequest({
        conversationId: "phone-selected",
      }),
    ).rejects.toThrow("Cloud conversation authority is not ready");
    await expect(
      phone.executeToolForRequest({
        conversationId: "  ",
        requestId: "voice-1",
        callId: "call-1",
        name: "search",
        args: {},
      }),
    ).rejects.toThrow("A cloud conversation id is required.");
    expect(runner.getVoiceOrchestratorConfig).not.toHaveBeenCalled();
    expect(runner.executeVoiceTool).not.toHaveBeenCalled();
  });
});
