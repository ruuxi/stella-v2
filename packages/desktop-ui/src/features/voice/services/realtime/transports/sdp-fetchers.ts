import { createServiceRequest } from "@/platform/http/service-request";
import type { SdpAnswerFetcher } from "./types";

export const bearerSdpFetcher =
  (endpoint: string, bearerToken: string): SdpAnswerFetcher =>
  async (sdpOffer) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/sdp",
      },
      body: sdpOffer,
    });
    if (!response.ok) {
      throw new Error(
        `SDP negotiation failed through Stella proxy: ${response.status}`,
      );
    }
    return response.text();
  };

export const stellaProxiedSdpFetcher =
  (path: string, stellaSessionId?: string): SdpAnswerFetcher =>
  async (sdpOffer) => {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/sdp",
    };
    if (stellaSessionId) {
      requestHeaders["X-Stella-Voice-Session-ID"] = stellaSessionId;
    }
    const { endpoint, headers } = await createServiceRequest(
      path,
      requestHeaders,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: sdpOffer,
    });
    if (!response.ok) {
      throw new Error(
        `SDP negotiation failed: ${response.status} ${await response.text()}`,
      );
    }
    return response.text();
  };
