import { describe, expect, it } from "bun:test";

import { buildXaiRealtimeClientSecretRequest as buildSharedXaiRequest } from "../../contracts/realtime-voice-catalog";
import { buildXaiRealtimeClientSecretRequest as buildBackendXaiRequest } from "../convex/http_shared/xai_realtime";

describe("realtime voice session contracts", () => {
  it("sends only expiry configuration when minting an xAI client secret", () => {
    const body = buildBackendXaiRequest();

    expect(body).toEqual({ expires_after: { seconds: 300 } });
    expect(body).not.toHaveProperty("session");
    expect(body).toEqual(buildSharedXaiRequest());
  });

  it("normalizes the requested xAI client-secret lifetime", () => {
    expect(buildBackendXaiRequest(12.9)).toEqual({
      expires_after: { seconds: 60 },
    });
    expect(buildBackendXaiRequest(Number.NaN)).toEqual({
      expires_after: { seconds: 300 },
    });
    expect(buildBackendXaiRequest(12.9)).toEqual(buildSharedXaiRequest(12.9));
    expect(buildBackendXaiRequest(Number.NaN)).toEqual(
      buildSharedXaiRequest(Number.NaN),
    );
  });
});
