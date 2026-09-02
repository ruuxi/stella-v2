import { describe, expect, it } from "bun:test";

import { getAuthIpRateLimitPolicy } from "../convex/lib/auth_ip_rate_limit";

describe("Better Auth IP rate-limit policy", () => {
  it("limits only anonymous and magic-link account creation routes", () => {
    expect(getAuthIpRateLimitPolicy("/sign-in/anonymous")).toEqual({
      kind: "anonymous",
      limit: 20,
      periodMs: 24 * 60 * 60_000,
    });
    expect(getAuthIpRateLimitPolicy("/sign-in/magic-link")).toEqual({
      kind: "magic_link",
      limit: 10,
      periodMs: 60 * 60_000,
    });
    expect(getAuthIpRateLimitPolicy("/sign-in/social")).toBeNull();
    expect(getAuthIpRateLimitPolicy("/callback/google")).toBeNull();
  });
});
