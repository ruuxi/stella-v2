import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("composer realtime voice control", () => {
  it("mirrors the mobile empty-composer waveform action", () => {
    const composer = readSource("app/chat/Composer.tsx");
    const primitives = readSource("features/chat/ComposerPrimitives.jsx");
    const styles = readSource("app/chat/full-shell.composer.css");

    expect(composer).toContain("!hasText");
    expect(composer).toContain("!hasAttachedChips");
    expect(composer).toContain("!dictationInFlight");
    expect(composer).toContain("window.electronAPI?.voice?.toggleRtc?.()");
    expect(composer.indexOf("<ComposerMicButton")).toBeLessThan(
      composer.indexOf("<ComposerRealtimeVoiceButton"),
    );
    expect(composer).toMatch(
      /showRealtimeVoice\s*\?\s*null\s*:\s*\(\s*<ComposerSubmitButton/,
    );
    expect(primitives).toContain("<AudioLines");
    expect(primitives).toContain("aria-pressed={active}");
    expect(styles).toContain(".composer-realtime-voice {");
  });
});
