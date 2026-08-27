import { postServiceJson } from "@/platform/http/service-request";
import {
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_INWORLD_REALTIME_SPEED,
  DEFAULT_INWORLD_REALTIME_TTS_MODEL,
} from "@stella/contracts/realtime-voice-catalog";
import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import {
  bearerSdpFetcher,
  stellaProxiedSdpFetcher,
} from "../transports/sdp-fetchers";
import { XaiWebSocketTransport } from "../transports/xai-websocket-transport";
import { buildOpenAIRealtimeSessionConfig } from "./openai-provider";
import type {
  ProviderModule,
  ProviderTokenContext,
  RealtimeSessionTool,
  RealtimeTransportKind,
  VoiceSessionToken,
} from "./types";

const STELLA_INWORLD_SDP_PATH = "/api/voice/inworld/sdp";

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

const readStellaVoicePrefs = async (): Promise<{
  voiceProvider: "openai" | "xai" | "inworld";
  voice?: string;
  inworldSpeed?: number;
}> => {
  try {
    const prefs =
      await window.electronAPI?.system?.getLocalModelPreferences?.();
    const sub = prefs?.realtimeVoice?.stellaSubProvider;
    const voiceProvider: "openai" | "xai" | "inworld" =
      sub === "xai" ? "xai" : sub === "inworld" ? "inworld" : "openai";
    const voice = prefs?.realtimeVoice?.voices?.[voiceProvider];
    const inworldSpeed = prefs?.realtimeVoice?.inworldSpeed;
    return {
      voiceProvider,
      voice:
        typeof voice === "string" && voice.trim().length > 0
          ? voice.trim()
          : undefined,
      inworldSpeed:
        typeof inworldSpeed === "number" && Number.isFinite(inworldSpeed)
          ? inworldSpeed
          : undefined,
    };
  } catch {
    return { voiceProvider: "openai" };
  }
};

export const buildStellaVoiceSessionRequest = (
  ctx: Pick<ProviderTokenContext, "conversationId" | "instructions" | "tools">,
  prefs: {
    voiceProvider: "openai" | "xai" | "inworld";
    voice?: string;
  },
): Record<string, unknown> => {
  const convexConversationId = toConvexConversationId(ctx.conversationId);
  return {
    ...(convexConversationId ? { conversationId: convexConversationId } : {}),
    instructions: ctx.instructions,
    ...(ctx.tools?.length ? { tools: ctx.tools } : {}),
    voiceProvider: prefs.voiceProvider,
    ...(prefs.voice ? { voice: prefs.voice } : {}),
  };
};

type StellaSessionResponse = {
  voiceProvider?: "openai" | "xai" | "inworld";
  transport?: RealtimeTransportKind;
  clientSecret?: unknown;
  model?: unknown;
  voice?: unknown;

  ttsModel?: unknown;
  expiresAt?: unknown;
  sessionId?: unknown;
  stellaSessionId?: unknown;
  leaseExpiresAt?: unknown;

  iceServers?: unknown;
};

const normalizeIceServers = (value: unknown): RTCIceServer[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value as RTCIceServer[];
};

const inferTransport = (
  raw: StellaSessionResponse,
  voiceProvider: "openai" | "xai" | "inworld",
): RealtimeTransportKind => {
  if (
    raw.transport === "xai-websocket" ||
    raw.transport === "openai-webrtc" ||
    raw.transport === "inworld-webrtc"
  ) {
    return raw.transport;
  }
  switch (raw.voiceProvider ?? voiceProvider) {
    case "xai":
      return "xai-websocket";
    case "inworld":
      return "inworld-webrtc";
    default:
      return "openai-webrtc";
  }
};

export const stellaProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const { voiceProvider, voice, inworldSpeed } = await readStellaVoicePrefs();

    const body = buildStellaVoiceSessionRequest(ctx, { voiceProvider, voice });

    const raw = await postServiceJson<StellaSessionResponse>(
      "/api/voice/session",
      body,
      {

        errorMessage: async (response) => {
          const detail = await response.text().catch(() => "");
          let parsed = "";
          try {
            const json = JSON.parse(detail) as { error?: unknown };
            if (typeof json?.error === "string") parsed = json.error.trim();
          } catch {
            parsed = detail.trim();
          }
          if (response.status === 401 || response.status === 403) {
            return parsed || "Sign in to Stella to use voice.";
          }
          return `Failed to create voice session: ${response.status}${
            parsed ? ` ${parsed}` : ""
          }`;
        },
      },
    );

    const transport = inferTransport(raw, voiceProvider);

    const clientSecret =
      transport === "inworld-webrtc"
        ? ""
        : typeof raw.clientSecret === "string"
          ? raw.clientSecret
          : "";
    if (transport !== "inworld-webrtc" && !clientSecret) {
      throw new Error(
        "Stella voice session response did not include a client secret.",
      );
    }

    return {
      provider: "stella",
      transport,
      clientSecret,
      model: typeof raw.model === "string" ? raw.model : "",
      voice:
        typeof raw.voice === "string" && raw.voice.length > 0
          ? raw.voice
          : (voice ?? ""),
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      stellaSessionId:
        typeof raw.stellaSessionId === "string"
          ? raw.stellaSessionId
          : undefined,
      leaseExpiresAt:
        typeof raw.leaseExpiresAt === "number" ? raw.leaseExpiresAt : undefined,
      iceServers: normalizeIceServers(raw.iceServers),
      speed: inworldSpeed,
      ttsModel:
        typeof raw.ttsModel === "string" && raw.ttsModel.trim().length > 0
          ? raw.ttsModel.trim()
          : undefined,
    };
  },

  createTransport(token, ctx) {
    if (token.transport === "xai-websocket") {
      return new XaiWebSocketTransport({
        clientSecret: token.clientSecret,
        model: token.model,
        voice: token.voice,
        instructions: ctx.instructions,
        tools: ctx.tools,
      });
    }

    if (token.transport === "inworld-webrtc") {

      return new OpenAIWebRTCTransport({
        provider: "inworld",
        model: token.model,
        sdpFetch: stellaProxiedSdpFetcher(
          STELLA_INWORLD_SDP_PATH,
          token.stellaSessionId,
        ),
        initialSessionConfig: buildInworldSessionConfig({
          model: token.model || DEFAULT_INWORLD_REALTIME_MODEL,
          voice: token.voice,
          instructions: ctx.instructions,
          tools: ctx.tools,
          speed: token.speed,
          ttsModel: token.ttsModel,
        }),
        iceServers: token.iceServers,
        waitForIceGathering: true,
        acquireMicBeforeOffer: true,
      });
    }

    return new OpenAIWebRTCTransport({
      provider: "openai",
      model: token.model,
      sdpFetch: bearerSdpFetcher(
        "https://api.openai.com/v1/realtime/calls",
        token.clientSecret,
      ),
      initialSessionConfig: buildOpenAIRealtimeSessionConfig(ctx),
    });
  },
};

export const buildInworldSessionConfig = (opts: {
  model: string;
  voice: string;
  instructions: string;
  tools?: RealtimeSessionTool[];

  speed?: number;

  ttsModel?: string;
}): Record<string, unknown> => ({
  type: "realtime",
  model: opts.model,
  instructions: opts.instructions,
  ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
  output_modalities: ["audio", "text"],
  audio: {
    input: {

      transcription: {
        model: "assemblyai/u3-rt-pro",
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    },
    output: {
      voice: opts.voice,
      model: opts.ttsModel ?? DEFAULT_INWORLD_REALTIME_TTS_MODEL,
      speed: opts.speed ?? DEFAULT_INWORLD_REALTIME_SPEED,
    },
  },
});
