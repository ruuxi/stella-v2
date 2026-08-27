/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("paid managed callsite receipt inventory", () => {
  it("keeps every synthesis stage receipt-authoritative, including authenticated anonymous owners", () => {
    const source = read("./http_routes/synthesis.ts");
    expect(source.match(/billing:\s+await createSynthesisModelBilling/g)).toHaveLength(
      4,
    );
    expect(source).toContain(
      "every authenticated principal\n          // receives an exact-attempt usage receipt",
    );
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("usageSummaryFromAssistant");
    expect(source).not.toContain("const billingOwnerId = !isAnonymousIdentity");
  });

  it("joins Store metadata image bodies and model usage before provider-attempt settlement", () => {
    const source = read("./data/store_asset_metadata.ts");
    expect(source).toContain("runManagedDispatchAttempt({");
    expect(source).toContain("fetch(url, { signal })");
    expect(source).toContain("billing: await createAssetMetadataBilling");
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("usageSummaryFromAssistant");
  });

  it("bills every Store security/image-review primary and failover attempt from its own receipt", () => {
    const source = read("./lib/store_release_reviews.ts");
    expect(source).toContain("billing: await createStoreReviewBilling");
    expect(source).toContain("withModelFailoverAsync(");
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("logStoreReviewUsage");
  });
});
