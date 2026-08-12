import { describe, expect, it } from "vitest";

import { resolveDictationPcmWorkletUrl } from "@/features/dictation/services/inworld-dictation";

describe("dictation PCM worklet URL", () => {
  it("resolves beside the packaged renderer entry instead of the filesystem root", () => {
    const rendererUrl =
      "file:///Applications/Stella.app/Contents/Resources/app.asar/renderer/index.html?window=full";

    expect(resolveDictationPcmWorkletUrl(rendererUrl)).toBe(
      "file:///Applications/Stella.app/Contents/Resources/app.asar/renderer/dictation-pcm-worklet.js",
    );
  });

  it("continues to resolve from the Vite development origin", () => {
    expect(
      resolveDictationPcmWorkletUrl(
        "http://127.0.0.1:57314/index.html?window=full",
      ),
    ).toBe("http://127.0.0.1:57314/dictation-pcm-worklet.js");
  });
});
