import { describe, expect, test } from "bun:test";
import {
  CloudBuilderOverrideError,
  resolveCloudBuilderOverride,
} from "./cloud-builder-override.js";

describe("resolveCloudBuilderOverride (dev/harness-only staging routing)", () => {
  test("returns null when the override is unset (uses Convex-resolved origin)", () => {
    expect(
      resolveCloudBuilderOverride({ overrideUrl: undefined, packaged: undefined }),
    ).toBeNull();
    expect(
      resolveCloudBuilderOverride({ overrideUrl: "  ", packaged: "0" }),
    ).toBeNull();
  });

  test("returns the origin in development when set to a valid https url", () => {
    expect(
      resolveCloudBuilderOverride({
        overrideUrl: "https://stella-v2-cloud-builder-staging.lolruuxi.workers.dev/",
        packaged: "0",
      }),
    ).toBe("https://stella-v2-cloud-builder-staging.lolruuxi.workers.dev");
  });

  test("allows a localhost worker for local wrangler dev", () => {
    expect(
      resolveCloudBuilderOverride({ overrideUrl: "http://127.0.0.1:8787", packaged: undefined }),
    ).toBe("http://127.0.0.1:8787");
  });

  test("PRODUCTION ISOLATION: throws if the override is present in a packaged build", () => {
    expect(() =>
      resolveCloudBuilderOverride({
        overrideUrl: "https://stella-v2-cloud-builder-staging.lolruuxi.workers.dev",
        packaged: "1",
      }),
    ).toThrow(CloudBuilderOverrideError);
    expect(() =>
      resolveCloudBuilderOverride({
        overrideUrl: "https://x.example",
        packaged: "true",
      }),
    ).toThrow(/packaged\/production build/);
  });

  test("fails visible on a malformed url", () => {
    expect(() =>
      resolveCloudBuilderOverride({ overrideUrl: "not a url", packaged: "0" }),
    ).toThrow(CloudBuilderOverrideError);
  });

  test("rejects non-https remote origins (no downgrade to plaintext)", () => {
    expect(() =>
      resolveCloudBuilderOverride({ overrideUrl: "http://evil.example", packaged: "0" }),
    ).toThrow(/must be https/);
  });
});
