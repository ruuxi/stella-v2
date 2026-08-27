import { describe, expect, test } from "bun:test";

import { createMobileTranscriptionRequestId } from "../mobile-request-id";

describe("mobile transcription request identity", () => {
  test("creates one bounded service request id from caller-owned entropy", () => {
    expect(createMobileTranscriptionRequestId(() => "recording-attempt-1")).toBe(
      "mobile-stt:recording-attempt-1",
    );
    expect(
      createMobileTranscriptionRequestId(() => "recording-attempt-1").length,
    ).toBeLessThanOrEqual(256);
  });
});
