/**
 * Locator selectors: the semantic (`aria=`) selector encoding behind
 * getByRole/getByText/..., and the page-side resolver script every
 * non-direct locator action runs in the tab.
 */

import type { LocatorState } from "./locators.js";
import {
  assertKnownKeys,
  isPlainObject,
  requireOptions,
  requireSelectorText,
} from "./validation.js";

export const encodeSemanticSelector = (
  payload: Record<string, unknown>,
): string => `aria=${encodeURIComponent(JSON.stringify(payload))}`;

export const parseSemanticSelector = (
  selector: string,
): Record<string, unknown> | null => {
  if (!selector.startsWith("aria=")) return null;
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(selector.slice("aria=".length)),
    );
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const semanticSelector = (
  kind: "role" | "text" | "label" | "placeholder" | "testid",
  value: string,
  rawOptions: unknown,
): string => {
  const locatorOptions = requireOptions(rawOptions, `${kind} locator options`);
  assertKnownKeys(
    locatorOptions,
    kind === "role" ? ["name", "exact"] : ["exact"],
    `${kind} locator options`,
  );
  if (
    locatorOptions.exact !== undefined &&
    typeof locatorOptions.exact !== "boolean"
  ) {
    throw new TypeError("exact must be a boolean.");
  }
  const exact = locatorOptions.exact === true;
  if (kind === "role") {
    const role = requireSelectorText(value, "role");
    const payload: Record<string, unknown> = { kind, role };
    if (locatorOptions.name !== undefined) {
      payload.name = requireSelectorText(locatorOptions.name, "name");
    }
    payload.exact = exact;
    return encodeSemanticSelector(payload);
  }
  return encodeSemanticSelector({
    kind,
    value: requireSelectorText(value, kind),
    exact,
  });
};

export const semanticWithNth = (selector: string, nth: number): string => {
  const payload = parseSemanticSelector(selector);
  if (!payload) throw new TypeError("Expected a semantic selector.");
  return encodeSemanticSelector({ ...payload, nth });
};

export const queryExpression = (
  state: Pick<LocatorState, "selector" | "index" | "textFilters">,
): string => {
  const descriptor = JSON.stringify({
    selector: state.selector,
    index: state.index,
    textFilters: state.textFilters,
  });
  return `(() => {
      const descriptor = ${descriptor};
      const normalize = value => String(value ?? "").replace(/\\s+/g, " ").trim();
      const matchesText = (actual, filter) => {
        const left = normalize(actual);
        const right = normalize(filter.value);
        const matches = filter.exact
          ? left === right
          : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
        return filter.negate ? !matches : matches;
      };
      const semantic = descriptor.selector.startsWith("aria=")
        ? JSON.parse(decodeURIComponent(descriptor.selector.slice(5)))
        : null;
      // Search the top document plus same-origin iframes and open shadow
      // roots, mirroring the daemon-side resolver in
      // packages/stella-browser/cli/src/native/selector.rs.
      const roots = [];
      const visitRoot = (root, depth) => {
        if (!root || depth > 8) return;
        roots.push(root);
        let all;
        try { all = root.querySelectorAll("*"); } catch (e) { return; }
        for (const node of all) {
          if (node.shadowRoot) visitRoot(node.shadowRoot, depth + 1);
          const tag = node.tagName;
          if (tag === "IFRAME" || tag === "FRAME") {
            let doc = null;
            try { doc = node.contentDocument; } catch (e) { doc = null; }
            if (doc) visitRoot(doc, depth + 1);
          }
        }
      };
      visitRoot(document, 0);
      const queryAll = selector => {
        const out = [];
        for (const root of roots) {
          try { out.push(...root.querySelectorAll(selector)); } catch (e) {}
        }
        return out;
      };
      const visible = element => element.tagName === "BODY" || element.getClientRects().length > 0;
      const uniqueVisible = elements => [...new Set(elements)].filter(visible);
      const labelledText = element => {
        const ids = element.getAttribute("aria-labelledby");
        if (!ids) return "";
        const scope = element.getRootNode();
        const byId = id => (scope.getElementById ? scope.getElementById(id) : null);
        return ids.split(/\\s+/).map(id => byId(id)?.textContent || "").join(" ");
      };
      const accessibleName = element => {
        const aria = element.getAttribute("aria-label");
        if (aria) return aria;
        const labelled = labelledText(element);
        if (labelled) return labelled;
        if (element.id) {
          let label = null;
          try { label = element.getRootNode().querySelector('label[for="' + CSS.escape(element.id) + '"]'); } catch (e) {}
          if (label) return label.textContent || "";
        }
        return element.alt || element.value || element.title || element.placeholder || element.textContent || "";
      };
      const stringMatches = (actual, expected, exact) => {
        const left = normalize(actual);
        const right = normalize(expected);
        return exact ? left === right : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
      };
      let elements;
      if (!semantic) {
        elements = queryAll(descriptor.selector);
      } else if (semantic.kind === "role") {
        const roleMap = {
          button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]'],
          link: ['a[href]', '[role="link"]'],
          textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
          checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
          radio: ['input[type="radio"]', '[role="radio"]'],
          combobox: ['select', '[role="combobox"]'],
          listbox: ['select[multiple]', '[role="listbox"]'],
          option: ['option', '[role="option"]'],
          heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
          img: ['img[alt]', '[role="img"]'],
          row: ['tr', '[role="row"]'],
          cell: ['td', '[role="cell"]', '[role="gridcell"]'],
          navigation: ['nav', '[role="navigation"]'],
          main: ['main', '[role="main"]'],
        };
        const selectors = roleMap[semantic.role] || ['[role="' + CSS.escape(semantic.role) + '"]'];
        elements = uniqueVisible(selectors.flatMap(selector => queryAll(selector)));
        if (semantic.name !== undefined) {
          elements = elements.filter(element => stringMatches(accessibleName(element), semantic.name, semantic.exact));
        }
      } else if (semantic.kind === "text") {
        const content = [];
        for (const root of roots) {
          const scope = root.body || root;
          try { content.push(...scope.querySelectorAll("*")); } catch (e) {}
        }
        elements = uniqueVisible(content).filter(element => {
          if (!stringMatches(element.textContent, semantic.value, semantic.exact)) return false;
          return ![...element.children].some(child => visible(child) && stringMatches(child.textContent, semantic.value, semantic.exact));
        });
      } else if (semantic.kind === "label") {
        const controls = [];
        for (const label of queryAll("label")) {
          if (!stringMatches(label.textContent, semantic.value, semantic.exact)) continue;
          const control = label.control || label.querySelector("input, textarea, select, button");
          if (control) controls.push(control);
        }
        for (const element of queryAll("[aria-label], [aria-labelledby]")) {
          if (stringMatches(accessibleName(element), semantic.value, semantic.exact)) controls.push(element);
        }
        elements = uniqueVisible(controls);
      } else if (semantic.kind === "placeholder") {
        elements = uniqueVisible(queryAll("[placeholder]")).filter(element => stringMatches(element.getAttribute("placeholder"), semantic.value, semantic.exact));
      } else if (semantic.kind === "testid") {
        elements = uniqueVisible(queryAll("[data-testid]")).filter(element => stringMatches(element.getAttribute("data-testid"), semantic.value, semantic.exact));
      } else {
        elements = [];
      }
      for (const filter of descriptor.textFilters) {
        elements = elements.filter(element => matchesText(element.textContent, filter));
      }
      const encodedNth = semantic && Number.isInteger(semantic.nth) ? semantic.nth : undefined;
      const index = descriptor.index === "last"
        ? elements.length - 1
        : descriptor.index ?? encodedNth;
      return index === undefined ? elements : (index >= 0 && index < elements.length ? [elements[index]] : []);
    })()`;
};
