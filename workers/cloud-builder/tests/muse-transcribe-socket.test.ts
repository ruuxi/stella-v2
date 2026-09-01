import { describe, expect, it } from "bun:test";
import {
  createMuseHandshake,
  isMuseEndStreamFrame,
} from "../src/muse-transcribe-socket.js";

describe("Muse transcription protocol", () => {
  it("builds the required realtime handshake", () => {
    expect(createMuseHandshake("meta-secret")).toEqual({
      authorization: { accessToken: "Bearer meta-secret" },
      audioEncoding: "PCM_16KHZ",
      model: "muse-voice-transcribe-1.0",
      mode: "PUSH_TO_TALK",
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
    });
  });

  it("only accepts a standalone endStream control frame", () => {
    expect(isMuseEndStreamFrame('{"type":"endStream"}')).toBe(true);
    expect(isMuseEndStreamFrame('{ "type": "endStream" }')).toBe(true);
    expect(isMuseEndStreamFrame('{"type":"endStream","audio":"x"}')).toBe(
      false,
    );
    expect(isMuseEndStreamFrame("endStream")).toBe(false);
  });
});
