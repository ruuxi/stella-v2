/**
 * User-BYOK OpenAI Realtime provider.
 *
 * Token is minted in the main process using the user's stored OpenAI API key
 * (`voiceApi.createOpenAISession`) and the connection uses OpenAI's WebRTC
 * realtime endpoint.
 *
 * No tool catalog is sent: Stella's voice model never calls tools itself.
 * On this BYOK route there is no delegation channel either, so the session is
 * conversation-only.
 */

import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import { bearerSdpFetcher } from "../transports/sdp-fetchers";
import type {
  ProviderModule,
  ProviderTokenContext,
  VoiceSessionToken,
} from "./types";

const OPENAI_SDP_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

export const buildOpenAIRealtimeSessionConfig = (
  ctx: ProviderTokenContext,
): Record<string, unknown> => ({
  type: "realtime",
  instructions: ctx.instructions,
});

export const openaiProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voiceApi = window.electronAPI?.voice;
    if (!voiceApi) {
      throw new Error("Voice API is not available.");
    }
    const result = await voiceApi.createOpenAISession({
      instructions: ctx.instructions,
    });
    return {
      provider: "openai",
      transport: "openai-webrtc",
      clientSecret: result.clientSecret,
      model: result.model,
      voice: result.voice,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
    };
  },

  createTransport(token, ctx) {
    return new OpenAIWebRTCTransport({
      model: token.model,
      sdpFetch: bearerSdpFetcher(OPENAI_SDP_ENDPOINT, token.clientSecret),
      initialSessionConfig: buildOpenAIRealtimeSessionConfig(ctx),
    });
  },
};
