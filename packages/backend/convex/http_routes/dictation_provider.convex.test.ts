import { describe, expect, it } from "vitest";
import { MUSE_DICTATION_MODEL, MUSE_STT_USD_PER_SECOND } from "./dictation";

describe("Muse realtime dictation", () => {
  it("pins the public model id and accepted list rate", () => {
    expect(MUSE_DICTATION_MODEL).toBe("muse-voice-transcribe-1.0");
    expect(MUSE_STT_USD_PER_SECOND * 60).toBeCloseTo(0.003);
    expect(MUSE_STT_USD_PER_SECOND * 3600).toBeCloseTo(0.18);
  });
});
