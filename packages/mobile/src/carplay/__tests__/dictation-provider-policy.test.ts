/**
 * Source-level guard on the mobile / CarPlay speech-to-text path.
 *
 * CarPlay has no dictation stack of its own — it drives the phone's
 * `useDictation`, which posts to one backend route, which now talks to xAI
 * Grok STT. This test pins that single path and fails if any of the four
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
const mobileRoute = readFileSync(
  resolve(__dirname, "../../../../backend/convex/http_routes/mobile.ts"),
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
  test("CarPlay reuses mobile dictation and the shared route reaches xAI", () => {
    expect(carPlayBridge).toContain("useDictation({");
    expect(mobileDictation).toContain('const path = "/api/mobile/transcribe"');
    expect(mobileRoute).toContain("transcribeWithXaiRest({");
    expect(mobileRoute).toContain("model: XAI_STT_MODEL_LABEL");
  });

  test("contains no obsolete speech-to-text provider references", () => {
    const integrationSources = [
      carPlayBridge,
      mobileDictation,
      mobileRoute,
      mobileConsent,
      mobileConsentModal,
    ].join("\n");
    expect(/voxtral/i.test(integrationSources)).toBe(false);
    expect(
      /mistral[^\n]*transcri|transcri[^\n]*mistral/i.test(integrationSources),
    ).toBe(false);
  });
});
