import { describe, expect, it } from "vitest";
import {
  STELLA_MODELS_PATH,
  STELLA_PROMPTS_PATH,
  normalizeStellaSiteUrl,
  stellaApiBaseUrlFromSiteUrl,
  stellaPromptEndpointFromSiteUrl,
} from "../../../src/shared/stella-api.js";

describe("Stella site URLs", () => {
  it("normalizes the Convex-hosted Stella endpoints back to the site root", () => {
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

  it("derives the Stella API and prompt endpoints from any accepted spelling", () => {
    expect(stellaApiBaseUrlFromSiteUrl("https://example.test/")).toBe(
      "https://example.test/api/stella",
    );
    expect(
      stellaPromptEndpointFromSiteUrl("https://example.test/api/stella/models"),
    ).toBe(`https://example.test${STELLA_PROMPTS_PATH}`);
    expect(
      stellaApiBaseUrlFromSiteUrl("https://example.test/api/stella/prompts"),
    ).toBe("https://example.test/api/stella");
    expect(STELLA_MODELS_PATH).toBe("/api/stella/models");
  });
});
