import type { StoredPhoneAccess } from "./phone-access";
import {
  invokeDesktopBridge,
  resolveDesktopBridge,
  type DesktopBridgeConnection,
} from "./desktop-bridge-chat";
import type {
  RealtimeVoiceOrchestratorConfig,
  RealtimeVoiceToolCall,
  RealtimeVoiceToolResult,
} from "./realtime-voice-protocol";

const DESKTOP_VOICE_SETUP_TIMEOUT_MS = 30_000;
const DESKTOP_VOICE_TOOL_TIMEOUT_MS = 120_000;

export type DesktopRealtimeVoice = {
  bridge: DesktopBridgeConnection;
  config: RealtimeVoiceOrchestratorConfig;
};

export const connectDesktopRealtimeVoice = async (
  access: StoredPhoneAccess,
  conversationId: string,
): Promise<DesktopRealtimeVoice> => {
  const bridge = await resolveDesktopBridge(access);
  const config = await invokeDesktopBridge<RealtimeVoiceOrchestratorConfig>(
    bridge,
    "voice:orchestratorConfig",
    [{ conversationId }],
    DESKTOP_VOICE_SETUP_TIMEOUT_MS,
  );
  if (
    !config ||
    typeof config.instructions !== "string" ||
    !Array.isArray(config.tools)
  ) {
    throw new Error(
      "The connected computer did not return a valid voice configuration.",
    );
  }
  return { bridge, config };
};

export const executeDesktopRealtimeVoiceTool = async (
  bridge: DesktopBridgeConnection,
  payload: RealtimeVoiceToolCall,
): Promise<RealtimeVoiceToolResult> =>
  invokeDesktopBridge<RealtimeVoiceToolResult>(
    bridge,
    "voice:executeMobileTool",
    [payload],
    DESKTOP_VOICE_TOOL_TIMEOUT_MS,
  );

export const persistDesktopRealtimeVoiceTranscript = async (
  bridge: DesktopBridgeConnection,
  payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    uiVisibility: "visible" | "hidden";
    voiceSession?: { durationMs: number };
  },
): Promise<void> => {
  await invokeDesktopBridge(
    bridge,
    "voice:persistTranscript",
    [payload],
    DESKTOP_VOICE_SETUP_TIMEOUT_MS,
  );
};
