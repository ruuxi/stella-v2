/**
 * Stella-managed realtime voice provider — GPT-Live in client delegation mode.
 *
 * `voice.session` opens a lease and has the backend create the GPT-Live
 * session with its own key, storing the conversation brief, the chosen voice
 * and the startup history server-side. The renderer then posts its SDP offer
 * to the backend under that lease and only ever sees the SDP answer, so no
 * provider key reaches the renderer.
 *
 * The voice model gets no tools and no system prompt here: it carries the
 * spoken conversation and delegates everything else to Stella's text
 * orchestrator through `session.delegation.created`.
 */

import type { CallArgs } from "@stella/contracts/backend/api";
import { GPT_LIVE_MODEL } from "@stella/contracts/backend/voice";
import { backendClient } from "@/platform/backend/backend-client";
import { GptLiveWebRTCTransport } from "../transports/gpt-live-webrtc-transport";
import { stellaProxiedSdpFetcher } from "../transports/sdp-fetchers";
import type {
  ProviderModule,
  ProviderTokenContext,
  VoiceSessionToken,
} from "./types";

/**
 * The user's GPT-Live voice selection. Unknown ids still pass through — a
 * custom voice authorized on the org is an opaque string to us — but an empty
 * selection is omitted so the backend applies its own default.
 */
const readGptLiveVoice = async (): Promise<string | undefined> => {
  try {
    const prefs =
      await window.electronAPI?.system?.getLocalModelPreferences?.();
    const voice = prefs?.realtimeVoice?.voices?.gptlive;
    const trimmed = typeof voice === "string" ? voice.trim() : "";
    return trimmed || undefined;
  } catch {
    return undefined;
  }
};

export const buildStellaVoiceSessionRequest = (
  ctx: Pick<ProviderTokenContext, "instructions" | "history">,
  voice?: string,
): CallArgs<"voice.session"> => ({
  instructions: ctx.instructions,
  ...(ctx.history?.length ? { history: ctx.history } : {}),
  ...(voice ? { voice } : {}),
});

export const stellaProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voice = await readGptLiveVoice();
    const session = await backendClient.call(
      "voice.session",
      buildStellaVoiceSessionRequest(ctx, voice),
    );
    return {
      provider: "stella",
      transport: "gptlive-webrtc",
      clientSecret: "",
      model: session.model || GPT_LIVE_MODEL,
      voice: session.voice,
      leaseId: session.leaseId,
      leaseExpiresAt: session.leaseExpiresAt,
    };
  },

  createTransport(token) {
    if (!token.leaseId) {
      throw new Error("Stella voice session is missing its lease.");
    }
    return new GptLiveWebRTCTransport({
      model: token.model,
      sdpFetch: stellaProxiedSdpFetcher(token.leaseId),
    });
  },
};
