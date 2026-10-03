import { GatewayError } from "./errors.js";

/**
 * Model-authored selectors.
 *
 * The agent targets elements the way it does on the desktop: by the ref an
 * observation handed it, by role and accessible name, or by exact visible
 * text. What stays out is everything that turns a selector into a yes/no
 * oracle over data the agent was not shown — attribute operators, substring
 * or regex text, pseudos, combinators, and raw form-control selectors — so a
 * page cannot steer the agent into reading a hidden token or a redacted
 * account detail one guess at a time.
 *
 * The canonical form is the model's own syntax; `toPlaywrightSelector` is the
 * only place it becomes an engine selector, always with exact matching.
 */

const CSS_SELECTOR =
  /^(?:#[A-Za-z][A-Za-z0-9_-]*|\.[A-Za-z][A-Za-z0-9_-]*|\[data-testid="[A-Za-z0-9_.:-]{1,96}"\])$/u;
const REF_SELECTOR = /^ref=(e[1-9][0-9]{0,3})$/u;
const ROLE_SELECTOR = /^role=([a-z]+)\[name="([^"\\]{1,128})"\]$/u;
const TEXT_SELECTOR = /^text="([^"\\]{1,128})"$/u;

/** Roles an agent can name; ARIA landmarks and structure add nothing to act on. */
export const AGENT_SELECTOR_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "img",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "switch",
  "tab",
  "textbox",
]);

const visibleName = (value: string): boolean =>
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);

/**
 * Validate one selector. Refs name an element of the current page only, so a
 * trusted-verification selector, which runs again in a fresh session, may not
 * be one.
 */
export const parseAgentSelector = (
  value: unknown,
  options: Readonly<{ allowRef: boolean }>,
): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    value.trim() !== value
  ) {
    throw new GatewayError("bad_request", 400);
  }
  if (CSS_SELECTOR.test(value)) return value;
  if (REF_SELECTOR.test(value)) {
    if (!options.allowRef) throw new GatewayError("bad_request", 400);
    return value;
  }
  const role = ROLE_SELECTOR.exec(value);
  if (role) {
    if (!AGENT_SELECTOR_ROLES.has(role[1]!) || !visibleName(role[2]!)) {
      throw new GatewayError("bad_request", 400);
    }
    return value;
  }
  const text = TEXT_SELECTOR.exec(value);
  if (text && visibleName(text[1]!)) return value;
  throw new GatewayError("bad_request", 400);
};

/** The attribute an observation stamps on each element it hands out a ref for. */
export const ELEMENT_REF_ATTRIBUTE = "data-stella-ref";

/** Engine selector for a validated canonical selector, with exact matching. */
export const toPlaywrightSelector = (selector: string): string => {
  const ref = REF_SELECTOR.exec(selector);
  if (ref) return `[${ELEMENT_REF_ATTRIBUTE}="${ref[1]}"]`;
  const role = ROLE_SELECTOR.exec(selector);
  // `s` is Playwright's exact, case-sensitive name match (getByRole exact).
  if (role) return `internal:role=${role[1]}[name="${role[2]}"s]`;
  const text = TEXT_SELECTOR.exec(selector);
  if (text) return `internal:text="${text[1]}"s`;
  return selector;
};
