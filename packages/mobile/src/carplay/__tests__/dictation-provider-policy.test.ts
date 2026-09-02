/**
 * Source-level guard on the mobile / CarPlay speech-to-text path.
 *
 * CarPlay has no dictation stack of its own — it drives the phone's
 * `useDictation`, which streams PCM through Stella's relay to Meta Muse.
 * This test pins that single path and fails if any of the files
 * files it spans drifts back to naming a retired provider (the consent copy
 * is an App Store 5.1.1(i) disclosure, so a stale provider name there is a
 * review problem, not just a stale comment).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const carPlayBridge = readFileSync(
  resolve(__dirname, "../CarPlayBridge.tsx"),
  "utf8",
);
const mobileDictation = readFileSync(
  resolve(__dirname, "../../lib/dictation.ts"),
  "utf8",
);
const mobileConsent = readFileSync(
  resolve(__dirname, "../../lib/ai-consent.ts"),
  "utf8",
);
const mobileConsentModal = readFileSync(
  resolve(__dirname, "../../components/AiConsentModal.tsx"),
  "utf8",
);

describe("mobile and CarPlay dictation provider policy", () => {
  test("CarPlay reuses mobile dictation and the shared stream reaches Muse", () => {
    expect(carPlayBridge).toContain("useDictation({");
    expect(mobileDictation).toContain("new MuseDictationStream(");
    expect(mobileDictation).toContain("sampleRate: 16_000");
    expect(mobileConsentModal).toContain("Meta Muse");
  });

  test("contains no obsolete speech-to-text provider references", () => {
    const integrationSources = [
      carPlayBridge,
      mobileDictation,
      mobileConsent,
      mobileConsentModal,
    ].join("\n");
    expect(/voxtral/i.test(integrationSources)).toBe(false);
    expect(
      /mistral[^\n]*transcri|transcri[^\n]*mistral/i.test(integrationSources),
    ).toBe(false);
    expect(
      /xAI Grok STT|transcribed directly by.*xAI/i.test(integrationSources),
    ).toBe(false);
  });
});
