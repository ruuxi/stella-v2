import { describe, expect, test } from "bun:test";
import { REALTIME_VOICE_AUDIO_MODE } from "../realtime-voice-audio";

describe("mobile realtime voice audio route", () => {
  test("uses the main speaker while retaining full-duplex recording", () => {
    expect(REALTIME_VOICE_AUDIO_MODE).toEqual({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
      shouldRouteThroughEarpiece: false,
    });
  });
});
