/**
 * User-BYOK OpenAI Realtime provider.
 *
 * Token is minted in the main process using the user's stored OpenAI API key
 * (`voiceApi.createOpenAISession`) and the connection uses OpenAI's WebRTC
 * realtime endpoint.
 *
 * The Realtime API has no delegation channel, so the same two-brain shape is
 * expressed with function calling: exactly one tool, `ask_stella`, whose
 * handler runs the orchestrator. Not a tool catalog — the model still has no
 * actions of its own.
 */

import { ASK_STELLA_SESSION_TOOLS } from "../ask-stella-tool";
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
  tools: [...ASK_STELLA_SESSION_TOOLS],
  tool_choice: "auto",
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
