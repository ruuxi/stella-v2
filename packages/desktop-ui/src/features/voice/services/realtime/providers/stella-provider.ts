/**
 * Stella-managed realtime voice provider.
 *
 * The backend opens a lease on a server-created OpenAI call
 * (`voice.session`); the renderer posts its SDP offer to the backend under
 * that lease and only ever sees the SDP answer, so no provider key reaches
 * the renderer. xAI and Inworld have no call revocation boundary, so the
 * backend refuses them as managed families.
 */

import type { CallArgs } from "@stella/contracts/backend/api";
import {
  DEFAULT_INWORLD_REALTIME_SPEED,
  DEFAULT_INWORLD_REALTIME_TTS_MODEL,
} from "@stella/contracts/realtime-voice-catalog";
import { backendClient } from "@/platform/backend/backend-client";
import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import { stellaProxiedSdpFetcher } from "../transports/sdp-fetchers";
import { buildOpenAIRealtimeSessionConfig } from "./openai-provider";
import type {
  ProviderModule,
  ProviderTokenContext,
  RealtimeSessionTool,
  VoiceSessionToken,
} from "./types";

/**
 * Read which voice family Stella should use and which voice id within
 * that family. Both default if missing.
 */
const readStellaVoicePrefs = async (): Promise<{
  voiceProvider: "openai" | "xai" | "inworld";
  voice?: string;
}> => {
  try {
    const prefs =
      await window.electronAPI?.system?.getLocalModelPreferences?.();
    const sub = prefs?.realtimeVoice?.stellaSubProvider;
    const voiceProvider: "openai" | "xai" | "inworld" =
      sub === "xai" ? "xai" : sub === "inworld" ? "inworld" : "openai";
    const voice = prefs?.realtimeVoice?.voices?.[voiceProvider];
    return {
      voiceProvider,
      voice:
        typeof voice === "string" && voice.trim().length > 0
          ? voice.trim()
          : undefined,
    };
  } catch {
    return { voiceProvider: "openai" };
  }
};

export const buildStellaVoiceSessionRequest = (
  ctx: Pick<ProviderTokenContext, "instructions" | "tools">,
  prefs: {
    voiceProvider: "openai" | "xai" | "inworld";
    voice?: string;
  },
): CallArgs<"voice.session"> => ({
  instructions: ctx.instructions,
  ...(ctx.tools?.length ? { tools: ctx.tools } : {}),
  voiceProvider: prefs.voiceProvider,
  ...(prefs.voice ? { voice: prefs.voice } : {}),
});

export const stellaProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const prefs = await readStellaVoicePrefs();
    const session = await backendClient.call(
      "voice.session",
      buildStellaVoiceSessionRequest(ctx, prefs),
    );
    return {
      provider: "stella",
      transport: "openai-webrtc",
      clientSecret: "",
      model: session.model,
      voice: session.voice,
      leaseId: session.leaseId,
      leaseExpiresAt: session.leaseExpiresAt,
    };
  },

  createTransport(token, ctx) {
    if (!token.leaseId) {
      throw new Error("Stella voice session is missing its lease.");
    }
    return new OpenAIWebRTCTransport({
      provider: "openai",
      model: token.model,
      sdpFetch: stellaProxiedSdpFetcher(token.leaseId),
      initialSessionConfig: buildOpenAIRealtimeSessionConfig(ctx),
    });
  },
};

/**
 * Inworld requires session config to be sent via `session.update` after
 * the data channel opens (their docs example). We assemble the standard
 * shape here so the BYOK Inworld path configures
 * the session the way Inworld documents it.
 */
export const buildInworldSessionConfig = (opts: {
  model: string;
  voice: string;
  instructions: string;
  tools?: RealtimeSessionTool[];
  /** TTS playback speed. Defaults to DEFAULT_INWORLD_REALTIME_SPEED. */
  speed?: number;
  /**
   * Inworld TTS model id. The Stella-managed path passes the server-supplied
   * value so the default is backend-owned; BYOK/omitted falls back to the
   * bundled default constant (drift there only affects BYOK, never managed).
   */
  ttsModel?: string;
}): Record<string, unknown> => ({
  type: "realtime",
  model: opts.model,
  instructions: opts.instructions,
  ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
  output_modalities: ["audio", "text"],
  audio: {
    input: {
      // semantic_vad is "backed by the STT stream" per Inworld's docs,
      // so we set an explicit STT model rather than rely on an implicit
      // default. assemblyai/u3-rt-pro is Inworld's lowest-latency
      // English/multilingual STT (<300ms).
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
