import { describe, expect, test } from "bun:test";
import {
  SENSITIVE_OBSERVATION_SELECTOR,
  redactVisibleText,
  sanitizePageUrl,
} from "../src/safe-observation.js";

describe("model-visible browser observations", () => {
  test("drops query capabilities and redacts common identity/secret text", () => {
    expect(
      sanitizePageUrl(
        "https://user:pass@app.example/account?token=private#private",
      ),
    ).toBe("https://app.example/account");
    const visible = redactVisibleText(
      "rahul@example.com password: hunter2 +1 602-555-0123",
    );
    expect(visible).not.toContain("rahul@example.com");
    expect(visible).not.toContain("hunter2");
    expect(visible).not.toContain("602-555-0123");
  });

  test("removes form controls and username/account echo elements before text extraction", () => {
    expect(SENSITIVE_OBSERVATION_SELECTOR).toContain("input");
    expect(SENSITIVE_OBSERVATION_SELECTOR).toContain('[id*="user" i]');
    expect(SENSITIVE_OBSERVATION_SELECTOR).toContain('[class*="account" i]');
    // Demoblaze's post-login username echo is #nameofuser and is covered by
    // the trusted case-insensitive id substring rule above.
    expect("nameofuser".includes("user")).toBe(true);
  });
});
