import { describe, expect, it } from "vitest";
import {
  STELLA_MODELS_PATH,
  normalizeStellaSiteUrl,
  stellaApiBaseUrlFromSiteUrl,
} from "../../../src/shared/stella-api.js";

describe("Stella site URLs", () => {
  it("normalizes the backend-hosted Stella endpoints back to the site root", () => {
    expect(normalizeStellaSiteUrl("https://example.test")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl(" https://example.test/// ")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/models")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/prompts/")).toBe(
      "https://example.test",
    );
  });

  it("leaves non-Stella paths alone", () => {
    expect(normalizeStellaSiteUrl("https://example.test/other/models")).toBe(
      "https://example.test/other/models",
    );
    expect(
      normalizeStellaSiteUrl("https://model-gateway.example.test/v1/relay"),
    ).toBe("https://model-gateway.example.test/v1/relay");
  });

  it("derives the Stella API base from any accepted spelling", () => {
    expect(stellaApiBaseUrlFromSiteUrl("https://example.test/")).toBe(
      "https://example.test/api/stella",
    );
    expect(
      stellaApiBaseUrlFromSiteUrl("https://example.test/api/stella/prompts"),
    ).toBe("https://example.test/api/stella");
    expect(STELLA_MODELS_PATH).toBe("/api/stella/models");
  });
});
