/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORE_LISTING_TEXT_SAFETY_POLICY } from "./lib/text_moderation";

describe("Store listing text safety policy", () => {
  it("is an explicit bounded unbilled control-plane exception", () => {
    expect(STORE_LISTING_TEXT_SAFETY_POLICY).toEqual({
      billing: "unbilled",
      purpose: "safety_control_plane",
      maxInputChars: 4_250,
      rateLimitKey: "store_package_create_first_release",
      classifierOutcomes: ["clean", "censored", "failed"],
      dispatchAuditOutcomes: [
        "succeeded",
        "failed",
        "aborted",
        "timed_out",
        "outcome_unknown",
      ],
    });
  });

  it("keeps the Store callsite rate-limited and physically fenced without usage billing", () => {
    const storeSource = readFileSync(
      new URL("./data/store_packages.ts", import.meta.url),
      "utf8",
    );
    const moderationSource = readFileSync(
      new URL("./lib/text_moderation.ts", import.meta.url),
      "utf8",
    );

    expect(storeSource).toContain(
      '"store_package_create_first_release",\n      ownerId,\n      RATE_VERY_EXPENSIVE',
    );
    expect(storeSource).toMatch(
      /dispatchGuard: createManagedUsageDispatchGuard\(ctx, \{\s*ownerId,\s*ownerGeneration,\s*beforeDispatch: assertStoreDispatch,\s*\}\)/u,
    );
    expect(moderationSource).toContain("dispatchGuard: options.dispatchGuard");
    expect(moderationSource).toContain(
      "composite.length > STORE_LISTING_TEXT_SAFETY_POLICY.maxInputChars",
    );
    expect(moderationSource).not.toContain("scheduleManagedUsage");
  });
});
