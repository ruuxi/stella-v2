import { describe, expect, it } from "vitest";

import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
} from "../../src/global/legal/legal-text.js";

describe("relay recovery privacy disclosure", () => {
  it("prominently discloses transient response content and physical deletion limits", () => {
    // Both documents must disclose the recovery buffer, its plaintext
    // exposure, and that physical deletion can lag logical expiry.
    for (const document of [TERMS_OF_SERVICE, PRIVACY_POLICY]) {
      expect(document).toContain("recovery buffer");
      expect(document).toContain("not end-to-end encrypted");
      expect(document).toContain("provider-managed backups");
    }
    // The Terms summarize; the Privacy Policy carries the full detail:
    // content classes, size caps, retention windows, and the explicit
    // no-absolute-deadline caveat.
    expect(PRIVACY_POLICY).toContain("tool-call arguments");
    expect(PRIVACY_POLICY).toContain("1 MiB");
    expect(PRIVACY_POLICY).toContain("two minutes");
    expect(PRIVACY_POLICY).toContain("ten minutes");
    expect(PRIVACY_POLICY).toContain("absolute physical-deletion");
    expect(PRIVACY_POLICY).toContain("US East (Northern Virginia)");
  });
});
