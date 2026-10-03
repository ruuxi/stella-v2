import { GatewayError } from "./errors.js";

/**
 * Model-authored selectors.
 *
 * The agent targets elements the way it does on the desktop: with any
 * Playwright selector (CSS, `text=`, `role=`, `internal:role=`, XPath, chains)
 * or with a ref an observation handed it. A ref is the one form the gateway
 * owns: it names an element of the page as last observed, so it cannot follow
 * into a fresh session.
 */

const REF_SELECTOR = /^ref=(e[1-9][0-9]{0,3})$/u;
const MAX_SELECTOR_LENGTH = 4_096;

export const parseAgentSelector = (
  value: unknown,
  options: Readonly<{ allowRef: boolean }>,
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > MAX_SELECTOR_LENGTH ||
    value.includes("\u0000")
  ) {
    throw new GatewayError("bad_request", 400);
  }
  if (value.startsWith("ref=")) {
    if (!options.allowRef || !REF_SELECTOR.test(value)) {
      throw new GatewayError("bad_request", 400);
    }
  }
  return value;
};

/** The attribute an observation stamps on each element it hands out a ref for. */
export const ELEMENT_REF_ATTRIBUTE = "data-stella-ref";

/** Engine selector for a validated selector: refs resolve, the rest is Playwright's. */
export const toPlaywrightSelector = (selector: string): string => {
  const ref = REF_SELECTOR.exec(selector);
  return ref ? `[${ELEMENT_REF_ATTRIBUTE}="${ref[1]}"]` : selector;
};

/**
 * An exact role-and-name selector, the durable alternative to a ref that an
 * observation suggests (Playwright's own `getByRole(..., { exact: true })`).
 */
export const exactRoleSelector = (role: string, name: string): string =>
  `internal:role=${role}[name=${JSON.stringify(name)}s]`;
