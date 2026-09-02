/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("paid managed callsite receipt inventory", () => {
  it("keeps every synthesis stage receipt-authoritative, including authenticated anonymous owners", () => {
    const source = read("./http_routes/synthesis.ts");
    expect(
      source.match(/billing:\s+await createSynthesisModelBilling/g),
    ).toHaveLength(5);
    expect(source).toContain(
      "every authenticated principal\n          // receives an exact-attempt usage receipt",
    );
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("usageSummaryFromAssistant");
    expect(source).not.toContain("const billingOwnerId = !isAnonymousIdentity");
  });

  it("joins asset metadata image bodies and model usage before provider-attempt settlement", () => {
    const source = read("./data/asset_metadata.ts");
    expect(source).toContain("runManagedDispatchAttempt({");
    expect(source).toContain("fetch(url, { signal })");
    expect(source).toContain("billing: await createAssetMetadataBilling");
    expect(source).not.toContain("scheduleManagedUsage");
    expect(source).not.toContain("usageSummaryFromAssistant");
  });
});
