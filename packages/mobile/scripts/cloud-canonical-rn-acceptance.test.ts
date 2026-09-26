import { describe, expect, test } from "bun:test";

import {
  assertBun14,
  assertHashOnlyAcceptanceResult,
  minimalChildSystemEnvironment,
  stableJson,
} from "./cloud-canonical-rn-acceptance.mjs";

describe("mounted mobile cloud-canonical acceptance contract", () => {
  test("fails closed outside the acceptance Bun 1.4 runtime", () => {
    expect(assertBun14("1.4.0")).toBe("1.4.0");
    expect(assertBun14("1.4.3+build")).toBe("1.4.3+build");
    expect(() => assertBun14("1.3.14")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14("2.0.0")).toThrow("Bun 1.4.x is required");
  });

  test("rejects raw authority fields, sensitive values, and malformed hashes", () => {
    const digest = "a".repeat(64);
    expect(
      assertHashOnlyAcceptanceResult(
        {
          receipts: [
            {
              surface: "mobile-http",
              operation: "mobile.execution.submit",
              outcome: "accepted",
              requestIdSha256: digest,
            },
          ],
          summarySha256: digest,
        },
        { sensitiveValues: ["raw-secret-authority"] },
      ),
    ).toBeTruthy();
    expect(() =>
      assertHashOnlyAcceptanceResult({ conversationId: "raw-conversation" }),
    ).toThrow("forbidden in a hash-only acceptance result");
    expect(() =>
      assertHashOnlyAcceptanceResult(
        { outcome: "raw-secret-authority" },
        { sensitiveValues: ["raw-secret-authority"] },
      ),
    ).toThrow("exposed a raw acceptance authority value");
    expect(() =>
      assertHashOnlyAcceptanceResult({ requestIdSha256: "not-a-hash" }),
    ).toThrow("is not a SHA-256 digest");
  });

  test("passes only a minimal system environment into mounted children", () => {
    const child = minimalChildSystemEnvironment({
      PATH: "/acceptance/bin",
      TMPDIR: "/acceptance/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      CLOUDFLARE_API_TOKEN: "must-not-cross",
      CONVEX_DEPLOY_KEY: "must-not-cross",
    });
    expect(child).toEqual({
      PATH: "/acceptance/bin",
      TMPDIR: "/acceptance/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      NODE_ENV: "test",
      NO_COLOR: "1",
    });
    expect(JSON.stringify(child)).not.toContain("must-not-cross");
  });

  test("uses the driver's code-point canonical order for phase summaries", () => {
    expect(
      stableJson({
        identitySwitch: {
          actualHookRerendered: true,
          accountsDiffer: true,
          aToBToA: true,
        },
      }),
    ).toBe(
      '{"identitySwitch":{"aToBToA":true,"accountsDiffer":true,"actualHookRerendered":true}}',
    );
  });

});
