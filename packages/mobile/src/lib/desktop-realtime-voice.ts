import { getBackendClient } from "./backend";
import { requestDeviceJson } from "./device-requests";
import { postJson } from "./http";
import { resolveExecutionBuilderOrigin } from "./execution-placement";
import type { StoredPhoneAccess } from "./phone-access";
import type {
  RealtimeVoiceOrchestratorConfig,
  RealtimeVoiceToolCall,
  RealtimeVoiceToolResult,
} from "./realtime-voice-protocol";

/**
 * Realtime voice in "computer" mode: the voice session runs on the phone, but
 * its instructions and tools are the paired computer's. Config and tool calls
 * go phone -> cloud -> computer (over its presence connection) and back; the
 * transcript is written straight to the cloud journal, where every device
 * reads it.
 */

const DESKTOP_VOICE_SETUP_TIMEOUT_MS = 30_000;
const DESKTOP_VOICE_TOOL_TIMEOUT_MS = 130_000;

export type DesktopRealtimeVoice = {
  access: StoredPhoneAccess;
  config: RealtimeVoiceOrchestratorConfig;
};

export const connectDesktopRealtimeVoice = async (
  access: StoredPhoneAccess,
  conversationId: string,
): Promise<DesktopRealtimeVoice> => {
  const config = await requestDeviceJson<RealtimeVoiceOrchestratorConfig>(
    access,
    "voice.config",
    { conversationId },
    { timeoutMs: DESKTOP_VOICE_SETUP_TIMEOUT_MS },
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
  return { access, config };
};

export const executeDesktopRealtimeVoiceTool = async (
  voice: DesktopRealtimeVoice,
  payload: RealtimeVoiceToolCall,
): Promise<RealtimeVoiceToolResult> =>
  requestDeviceJson<RealtimeVoiceToolResult>(
    voice.access,
    "voice.executeTool",
    payload as unknown as Record<string, unknown>,
    { timeoutMs: DESKTOP_VOICE_TOOL_TIMEOUT_MS },
  );

/** The journal's `deviceId` pattern; a stored id outside it is reshaped. */
const JOURNAL_DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const JOURNAL_APPEND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const journalDeviceId = (mobileDeviceId: string): string => {
  if (JOURNAL_DEVICE_ID_PATTERN.test(mobileDeviceId)) return mobileDeviceId;
  const cleaned = mobileDeviceId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return cleaned || "mobile";
};

const emptyVoiceUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Append one voice transcript line to the conversation's cloud journal. The
 * message shape is the one the computer's own voice runtime writes, so both
 * read back identically; `eventId` is the idempotent append id, so a retry
 * never duplicates a line.
 */
export const persistDesktopRealtimeVoiceTranscript = async (
  voice: DesktopRealtimeVoice,
  payload: {
    conversationId: string;
    /** Stable append id; the journal dedupes retries on it. */
    eventId: string;
    timestamp: number;
    role: "user" | "assistant";
    text: string;
    uiVisibility: "visible" | "hidden";
    voiceSession?: { durationMs: number };
  },
): Promise<void> => {
  const eventId = payload.eventId.trim();
  if (!JOURNAL_APPEND_ID_PATTERN.test(eventId)) {
    throw new Error("Voice transcripts need a stable append id.");
  }
  const identity = await getBackendClient().call("owner.identity", {});
  const expectedOwnerGeneration = identity.ownerGeneration.trim();
  if (!expectedOwnerGeneration) {
    throw new Error("Voice transcript could not establish owner authority.");
  }
  const message =
    payload.role === "user"
      ? {
          role: "user" as const,
          content: [{ type: "text" as const, text: payload.text }],
          source: "voice" as const,
          ...(payload.voiceSession ? { voiceSession: payload.voiceSession } : {}),
          timestamp: payload.timestamp,
        }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: payload.text }],
          api: "stella-voice",
          provider: "stella",
          model: "realtime-voice",
          usage: emptyVoiceUsage(),
          stopReason: "stop" as const,
          source: "voice" as const,
          ...(payload.voiceSession ? { voiceSession: payload.voiceSession } : {}),
          timestamp: payload.timestamp,
        };
  await postJson(
    `/conversations/${encodeURIComponent(payload.conversationId)}/journal`,
    {
      deviceId: journalDeviceId(voice.access.mobileDeviceId),
      expectedOwnerGeneration,
      localTurnId: eventId,
      source: "voice",
      records: [
        {
          kind: "message",
          role: payload.role,
          payloadJson: JSON.stringify(message),
          ...(payload.uiVisibility === "hidden" ? { hidden: true } : {}),
        },
      ],
    },
    {
      origin: await resolveExecutionBuilderOrigin(),
      timeoutMs: DESKTOP_VOICE_SETUP_TIMEOUT_MS,
    },
  );
};
