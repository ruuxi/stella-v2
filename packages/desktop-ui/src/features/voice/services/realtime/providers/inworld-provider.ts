import {
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_INWORLD_REALTIME_VOICE,
} from "@stella/contracts/realtime-voice-catalog";
import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import { bearerSdpFetcher } from "../transports/sdp-fetchers";
import { buildInworldSessionConfig } from "./stella-provider";
import type { ProviderModule, VoiceSessionToken } from "./types";

const INWORLD_SDP_ENDPOINT = "https://api.inworld.ai/v1/realtime/calls";

export const inworldProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voiceApi = window.electronAPI?.voice;
    if (!voiceApi?.createInworldSession) {
      throw new Error("Voice API does not support Inworld in this build.");
    }
    const [result, prefs] = await Promise.all([
      voiceApi.createInworldSession({ instructions: ctx.instructions }),
      window.electronAPI?.system?.getLocalModelPreferences?.().catch(() => null),
    ]);
    const inworldSpeed = prefs?.realtimeVoice?.inworldSpeed;
    return {
      provider: "inworld",
      transport: "inworld-webrtc",
      clientSecret: result.clientSecret,
      model: result.model || DEFAULT_INWORLD_REALTIME_MODEL,
      voice: result.voice || DEFAULT_INWORLD_REALTIME_VOICE,
      iceServers: result.iceServers,
      speed:
        typeof inworldSpeed === "number" && Number.isFinite(inworldSpeed)
          ? inworldSpeed
          : undefined,
    };
  },

  createTransport(token, ctx) {
    return new OpenAIWebRTCTransport({
      provider: "inworld",
      model: token.model,
      sdpFetch: bearerSdpFetcher(INWORLD_SDP_ENDPOINT, token.clientSecret),
      initialSessionConfig: buildInworldSessionConfig({
        model: token.model || DEFAULT_INWORLD_REALTIME_MODEL,
        voice: token.voice,
        instructions: ctx.instructions,
        tools: ctx.tools,
        speed: token.speed,
      }),
      iceServers: token.iceServers,
      waitForIceGathering: true,
      acquireMicBeforeOffer: true,
    });
  },
};
