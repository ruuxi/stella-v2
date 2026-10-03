/**
 * Helpers for building SdpAnswerFetcher functions used by the WebRTC
 * transport. Providers compose these into the right shape for their
 * auth flow without each one having to repeat the same fetch boilerplate.
 *
 * Two flavours so far:
 *   - bearerSdpFetcher: POST SDP to a public endpoint with
 *     `Authorization: Bearer <secret>`. Used by OpenAI Realtime and by
 *     Inworld's WebRTC SDP endpoint (which accepts the same Bearer
 *     shape).
 *   - stellaProxiedSdpFetcher: POST SDP to the Stella backend under a
 *     managed session's lease, with the renderer's normal auth. The
 *     backend creates the provider call with its org-side API key, so no
 *     org secret ever reaches the renderer.
 */

import {
  VOICE_LEASE_HEADER,
  VOICE_OPENAI_SDP_PATH,
} from "@stella/contracts/backend/voice";
import { voiceBackendFetch } from "../../voice-backend";
import type { SdpAnswerFetcher } from "./types";

/** POST SDP to a public endpoint using a Bearer token. */
export const bearerSdpFetcher =
  (endpoint: string, bearerToken: string): SdpAnswerFetcher =>
  async (sdpOffer, signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/sdp",
      },
      body: sdpOffer,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `SDP negotiation failed through Stella proxy: ${response.status}`,
      );
    }
    return response.text();
  };

/**
 * POST SDP to the Stella backend for a managed session's lease. The backend
 * creates the provider call with its own key, so no org secret ever reaches
 * the renderer.
 */
export const stellaProxiedSdpFetcher =
  (leaseId: string): SdpAnswerFetcher =>
  async (sdpOffer, signal) => {
    const response = await voiceBackendFetch(VOICE_OPENAI_SDP_PATH, {
      body: sdpOffer,
      contentType: "application/sdp",
      headers: { [VOICE_LEASE_HEADER]: leaseId },
      signal,
    });
    return response.text();
  };
