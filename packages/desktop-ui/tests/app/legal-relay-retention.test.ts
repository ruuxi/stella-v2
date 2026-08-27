import { describe, expect, it } from "vitest";

import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
} from "../../src/global/legal/legal-text.js";
import {
  PRIVACY_POLICY as MOBILE_PRIVACY_POLICY,
  TERMS_OF_SERVICE as MOBILE_TERMS_OF_SERVICE,
} from "../../../mobile/src/lib/legal-text.js";

const RENDERED_LEGAL_DOCUMENTS = [
  TERMS_OF_SERVICE,
  PRIVACY_POLICY,
  MOBILE_TERMS_OF_SERVICE,
  MOBILE_PRIVACY_POLICY,
];

describe("cloud and local data legal disclosure", () => {
  it("identifies cloud authority, rebuildable local caches, and external processing", () => {
    for (const document of RENDERED_LEGAL_DOCUMENTS) {
      expect(document).toContain("cloud-authoritative");
      expect(document).toContain("encrypted in transit and at rest");
      expect(document).toContain("rebuildable");
      expect(document).toContain("connected integration");
    }

    for (const policy of [PRIVACY_POLICY, MOBILE_PRIVACY_POLICY]) {
      expect(policy).toContain(
        "conversations, event transcripts, tool outputs, activity records, and saved memory",
      );
      expect(policy).toContain("does not promise a fixed retention period");
    }
  });

  it("does not regress to device-only conversation or memory claims", () => {
    const forbiddenClaims = [
      "no fromyou-hosted conversation history",
      "no cloud storage of conversations",
      "your conversations are not stored on our servers",
      "your canonical conversation history is stored locally",
      "stored entirely on your device and is never transmitted",
      "all data related to these activities is processed and stored entirely",
      "the vast majority of your data is stored locally",
      "avoid routing prompts through our infrastructure entirely",
    ];

    for (const document of RENDERED_LEGAL_DOCUMENTS) {
      const normalized = document.toLowerCase();
      for (const forbidden of forbiddenClaims) {
        expect(normalized).not.toContain(forbidden);
      }
    }
  });

  it("keeps provider retention separate from Stella's cloud record", () => {
    for (const document of RENDERED_LEGAL_DOCUMENTS) {
      expect(document).toContain(
        "cloud-authoritative conversation record remains",
      );
      expect(document).toMatch(
        /(?:providers? may .*retain|may be retained by the selected provider)/i,
      );
      expect(document).not.toContain("recovery buffer");
      expect(document).not.toContain("1 MiB");
      expect(document).not.toContain("resume API");
    }

    expect(PRIVACY_POLICY).toContain("US East (Northern Virginia)");
  });
});
