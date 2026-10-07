/**
 * Helpers for building SdpAnswerFetcher functions used by the WebRTC
 * transports. Providers compose these into the right shape for their auth
 * flow without each one repeating the same fetch boilerplate.
 *
 * Two flavours:
 *   - bearerSdpFetcher: POST SDP to a public endpoint with
 *     `Authorization: Bearer …`. Used by the BYOK OpenAI Realtime path.
 *   - stellaProxiedSdpFetcher: POST SDP to the Stella backend under a managed
 *     GPT-Live session's lease, with the renderer's normal auth. The backend
 *     already created the live session with its org key, so no org secret ever
 *     reaches the renderer and the renderer only ever sees the SDP answer.
 */

import {
  VOICE_LEASE_HEADER,
  VOICE_LIVE_SDP_PATH,
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
      throw new Error(`SDP negotiation failed: ${response.status}`);
    }
    return response.text();
  };

/**
 * POST SDP to the Stella backend for a managed GPT-Live session's lease. The
 * backend created the live session with its own key, so no org secret ever
 * reaches the renderer.
 */
export const stellaProxiedSdpFetcher =
  (leaseId: string): SdpAnswerFetcher =>
  async (sdpOffer, signal) => {
    const response = await voiceBackendFetch(VOICE_LIVE_SDP_PATH, {
      body: sdpOffer,
      contentType: "application/sdp",
      headers: { [VOICE_LEASE_HEADER]: leaseId },
      signal,
    });
    return response.text();
  };
