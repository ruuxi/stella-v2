import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

describe("AI consent cloud-retention disclosure", () => {
  it("does not describe cloud-authoritative messages as transit-only", () => {
    const source = readFileSync(
      new URL("./AiConsentModal.tsx", import.meta.url).pathname,
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain("cloud-authoritative conversation record");
    expect(normalized).toContain("may retain that data");
    expect(normalized).not.toContain(
      "Stella does not permanently store your messages on its servers",
    );
    expect(normalized).not.toContain("passes through in transit");
  });
});
