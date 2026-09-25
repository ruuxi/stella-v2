import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("cloud-only dictation", () => {
  it("opens the dictation stream alongside recording and has no local transcription branch", () => {
    const source = read(
      "desktop-ui/src/features/dictation/services/dictation-session.ts",
    );

    expect(source).toContain("new DictationStream");
    // The relay connects while the mic starts; audio is held until it opens,
    // and stopping waits for that open before finishing.
    expect(source).toContain("this.streamOpened = stream.open()");
    expect(source).toContain("await this.streamOpened;");
    expect(source).not.toMatch(
      /transcribeLocal|warmLocal|localStatus|LocalParakeet|DICTATION_LOCAL/,
    );
  });

  it("does not expose local dictation over preload or main-process IPC", () => {
    const preload = read("desktop/electron/preload.ts");
    const handlers = read("desktop/electron/ipc/dictation-handlers.js");

    for (const source of [preload, handlers]) {
      expect(source).not.toMatch(
        /dictation:(?:downloadLocalModel|localStatus|transcribeLocal|warmLocal)/,
      );
    }
  });
});
