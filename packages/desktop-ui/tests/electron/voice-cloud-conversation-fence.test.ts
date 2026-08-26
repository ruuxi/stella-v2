import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_VOICE_EXECUTE_MOBILE_TOOL,
  IPC_VOICE_ORCHESTRATOR_CONFIG,
} from "@stella/contracts/desktop/ipc-channels";

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

  const register = () => {
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
    registerVoiceHandlers({
      uiState,
      getAppReady: () => true,
      windowManager: {
        getAllWindows: () => [],
        getFullWindow: () => null,
      },
      getPetWindow: () => null,
      togglePetVoice: () => undefined,
      getStellaHostRunner: () => runner,
      stellaAppDir: "/tmp/stella-cloud-authority-test",
      stellaDataDirPath: "/tmp/stella-cloud-authority-test",
    });
    return { runner, uiState };
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
      expect.stringContaining("active cloud conversation changed"),
    );
  });

  it("normalizes the selected id for transcript and config calls", async () => {
    const { runner } = register();
    electron.listeners.get("voice:persistTranscript")?.({}, {
      conversationId: " cloud-current ",
      role: "assistant",
      text: "current",
    });
    await Promise.resolve();

    expect(runner.persistVoiceTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "cloud-current" }),
    );

    await electron.handles.get(IPC_VOICE_ORCHESTRATOR_CONFIG)?.({}, {
      conversationId: " cloud-current ",
    });
    expect(runner.getVoiceOrchestratorConfig).toHaveBeenCalledWith({
      conversationId: "cloud-current",
    });
  });

  it("rejects stale orchestrator and tool calls before runtime dispatch", async () => {
    const { runner } = register();

    await expect(
      electron.handles.get("voice:orchestratorChat")?.({}, {
        conversationId: "cloud-old",
        message: "hello",
      }),
    ).rejects.toThrow("active cloud conversation changed");
    await expect(
      electron.handles.get(IPC_VOICE_EXECUTE_MOBILE_TOOL)?.({}, {
        conversationId: "cloud-old",
        requestId: "voice-1",
        callId: "call-1",
        name: "search",
        args: {},
      }),
    ).rejects.toThrow("active cloud conversation changed");

    expect(runner.handleVoiceChat).not.toHaveBeenCalled();
    expect(runner.executeVoiceTool).not.toHaveBeenCalled();
  });
});
