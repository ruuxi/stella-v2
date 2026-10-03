import { describe, expect, test } from "bun:test";
import { GatewayError } from "../src/errors.js";
import {
  exactRoleSelector,
  parseAgentSelector,
  toPlaywrightSelector,
} from "../src/selectors.js";

describe("agent selectors", () => {
  test("pass any Playwright selector through, as on the desktop", () => {
    for (const selector of [
      "#login",
      "input[type=password]",
      'role=button[name="Sign in"]',
      "text=/sign out/i",
      ".card:has(#total) >> nth=0",
      "xpath=//form//button",
      'internal:role=link[name="Orders"s]',
    ]) {
      expect(parseAgentSelector(selector, { allowRef: true })).toBe(selector);
      expect(toPlaywrightSelector(selector)).toBe(selector);
    }
  });

  test("resolve refs and refuse malformed ones", () => {
    expect(toPlaywrightSelector("ref=e7")).toBe('[data-stella-ref="e7"]');
    for (const selector of ["ref=x1", "ref=e0", "ref=", "", "   "]) {
      expect(() => parseAgentSelector(selector, { allowRef: true })).toThrow(
        GatewayError,
      );
    }
  });

  test("keep refs out of verification, which runs in a fresh session", () => {
    expect(() => parseAgentSelector("ref=e3", { allowRef: false })).toThrow(
      GatewayError,
    );
    expect(parseAgentSelector("text=Sign out", { allowRef: false })).toBe(
      "text=Sign out",
    );
  });

  test("suggest exact role selectors the way getByRole(exact) does", () => {
    expect(exactRoleSelector("button", 'Say "hi"')).toBe(
      'internal:role=button[name="Say \\"hi\\""s]',
    );
  });
});
