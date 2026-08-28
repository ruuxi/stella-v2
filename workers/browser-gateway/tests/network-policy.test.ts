import { describe, expect, test } from "bun:test";
import { GatewayError } from "../src/errors.js";
import { browserGuardrailDomains } from "../src/network-policy.js";

describe("Browser Run network policy", () => {
  test("admits same-site API subdomains without unrelated egress", () => {
    const domains = browserGuardrailDomains(["https://www.demoblaze.com"]);
    expect(domains).toEqual(["*.demoblaze.com", "demoblaze.com"]);
    expect(domains).not.toContain("*.example.com");
    expect(domains).not.toContain("evil.example");
  });

  test("uses the public suffix list and rejects bare public suffixes", () => {
    expect(browserGuardrailDomains(["https://login.example.co.uk"])).toEqual([
      "*.example.co.uk",
      "example.co.uk",
    ]);
    expect(() => browserGuardrailDomains(["https://co.uk"])).toThrow(
      GatewayError,
    );
  });

  test("does not broaden one private-platform tenant to sibling tenants", () => {
    for (const [origin, tenant] of [
      ["https://alice.github.io", "alice.github.io"],
      ["https://stella.vercel.app", "stella.vercel.app"],
      ["https://rahul.blogspot.com", "rahul.blogspot.com"],
    ] as const) {
      expect(browserGuardrailDomains([origin])).toEqual([
        `*.${tenant}`,
        tenant,
      ]);
    }
  });
});
