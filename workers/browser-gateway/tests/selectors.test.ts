import { describe, expect, test } from "bun:test";
import { GatewayError } from "../src/errors.js";
import {
  parseAgentSelector,
  toPlaywrightSelector,
} from "../src/selectors.js";

describe("agent selectors", () => {
  test("accept the desktop-style forms an agent targets elements by", () => {
    for (const selector of [
      "#login",
      ".submit-button",
      '[data-testid="account-menu"]',
      "ref=e12",
      'role=button[name="Sign in"]',
      'role=link[name="Your orders"]',
      'text="Sign out"',
    ]) {
      expect(parseAgentSelector(selector, { allowRef: true })).toBe(selector);
    }
  });

  test("refuse every form that would turn a selector into an oracle", () => {
    for (const selector of [
      '[value^="a"]',
      "text=secret",
      "text=/^a/",
      'text="a" >> nth=0',
      'role=textbox[name*="a"]',
      'role=button[name="a" i]',
      'role=button[name="a\\"b"]',
      "role=generic[name=\"x\"]",
      ".card:has(#secret)",
      "input",
      "#one, #two",
      "#one #two",
      "xpath=//input",
      "ref=x1",
      "ref=e0",
      " #login",
    ]) {
      expect(() => parseAgentSelector(selector, { allowRef: true })).toThrow(
        GatewayError,
      );
    }
  });

  test("keep refs out of verification, which runs in a fresh session", () => {
    expect(() => parseAgentSelector("ref=e3", { allowRef: false })).toThrow(
      GatewayError,
    );
    expect(
      parseAgentSelector('role=link[name="Sign out"]', { allowRef: false }),
    ).toBe('role=link[name="Sign out"]');
  });

  test("translate to exact, case-sensitive Playwright engines", () => {
    expect(toPlaywrightSelector("ref=e7")).toBe('[data-stella-ref="e7"]');
    expect(toPlaywrightSelector('role=button[name="Sign in"]')).toBe(
      'internal:role=button[name="Sign in"s]',
    );
    expect(toPlaywrightSelector('text="Sign out"')).toBe(
      'internal:text="Sign out"s',
    );
    expect(toPlaywrightSelector("#login")).toBe("#login");
  });
});
