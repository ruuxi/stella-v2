const refMaps = new Map();
const SEMANTIC_SELECTOR_PREFIX = "aria=";
const MAX_SEMANTIC_SELECTOR_LENGTH = 8192;
const MAX_SEMANTIC_VALUE_LENGTH = 1024;
const MAX_SEMANTIC_ROLE_LENGTH = 128;
const MAX_SEMANTIC_NTH = 10000;
const SEMANTIC_KINDS = new Set([
  "role",
  "text",
  "label",
  "placeholder",
  "testid",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBoundedString(
  value,
  field,
  maxLength,
  { optional = false } = {},
) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Semantic selector field '${field}' must be a non-empty string`,
    );
  }
  if (value.length > maxLength) {
    throw new Error(
      `Semantic selector field '${field}' exceeds ${maxLength} characters`,
    );
  }
  return value;
}

function normalizeSemanticSelector(value) {
  if (!isPlainObject(value)) {
    throw new Error("Semantic selector payload must be a JSON object");
  }

  const kind = requireBoundedString(value.kind, "kind", 32);
  if (!SEMANTIC_KINDS.has(kind)) {
    throw new Error(`Unsupported semantic selector kind: ${kind}`);
  }

  const allowedKeys = new Set(
    kind === "role"
      ? ["kind", "role", "name", "nth", "exact"]
      : ["kind", "value", "nth", "exact"],
  );
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Unknown semantic selector field '${key}' for kind '${kind}'`,
      );
    }
  }

  if (value.nth !== undefined) {
    if (
      !Number.isInteger(value.nth) ||
      value.nth < 0 ||
      value.nth > MAX_SEMANTIC_NTH
    ) {
      throw new Error(
        `Semantic selector field 'nth' must be an integer from 0 to ${MAX_SEMANTIC_NTH}`,
      );
    }
  }
  if (value.exact !== undefined && typeof value.exact !== "boolean") {
    throw new Error("Semantic selector field 'exact' must be a boolean");
  }

  if (kind === "role") {
    const role = requireBoundedString(
      value.role,
      "role",
      MAX_SEMANTIC_ROLE_LENGTH,
    );
    if (!/^[a-z][a-z0-9-]*$/.test(role)) {
      throw new Error("Semantic selector field 'role' has an invalid format");
    }
    return {
      kind,
      role,
      name: requireBoundedString(
        value.name,
        "name",
        MAX_SEMANTIC_VALUE_LENGTH,
        {
          optional: true,
        },
      ),
      nth: value.nth,
      exact: value.exact === true,
    };
  }

  return {
    kind,
    value: requireBoundedString(
      value.value,
      "value",
      MAX_SEMANTIC_VALUE_LENGTH,
    ),
    nth: value.nth,
    exact: value.exact === true,
  };
}

export function encodeSemanticSelector(value) {
  const normalized = normalizeSemanticSelector(value);
  const selector = `${SEMANTIC_SELECTOR_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`;
  if (selector.length > MAX_SEMANTIC_SELECTOR_LENGTH) {
    throw new Error(
      `Semantic selector exceeds the ${MAX_SEMANTIC_SELECTOR_LENGTH} character limit`,
    );
  }
  return selector;
}

export function parseSemanticSelector(selector) {
  if (
    typeof selector !== "string" ||
    !selector.startsWith(SEMANTIC_SELECTOR_PREFIX)
  ) {
    return null;
  }
  if (selector.length > MAX_SEMANTIC_SELECTOR_LENGTH) {
    throw new Error(
      `Semantic selector exceeds the ${MAX_SEMANTIC_SELECTOR_LENGTH} character limit`,
    );
  }

  const encoded = selector.slice(SEMANTIC_SELECTOR_PREFIX.length);
  if (!encoded) throw new Error("Semantic selector payload is empty");

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error("Semantic selector payload is not valid percent-encoding");
  }

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("Semantic selector payload is not valid JSON");
  }
  return normalizeSemanticSelector(parsed);
}

function normalizeOwnerId(ownerId) {
  if (typeof ownerId !== "string") return "default";
  const trimmed = ownerId.trim();
  return trimmed || "default";
}

function getOwnerRefMap(ownerId, createIfMissing = false) {
  const normalized = normalizeOwnerId(ownerId);
  if (!refMaps.has(normalized) && createIfMissing) {
    refMaps.set(normalized, new Map());
  }
  return refMaps.get(normalized);
}

export function setRefMap(ownerId, tabId, refs) {
  if (!Number.isInteger(tabId)) return;
  const ownerMap = getOwnerRefMap(ownerId, true);
  ownerMap.set(tabId, refs || {});
}

export function getRefMap(ownerId, tabId) {
  if (!Number.isInteger(tabId)) return {};
  return getOwnerRefMap(ownerId)?.get(tabId) || {};
}

export function clearOwnerRefMaps(ownerId) {
  if (ownerId === undefined) {
    refMaps.clear();
    return;
  }
  refMaps.delete(normalizeOwnerId(ownerId));
}

export function clearTabRefMap(ownerId, tabId) {
  if (!Number.isInteger(tabId)) return;
  const ownerMap = getOwnerRefMap(ownerId);
  if (!ownerMap) return;
  ownerMap.delete(tabId);
  if (ownerMap.size === 0) {
    refMaps.delete(normalizeOwnerId(ownerId));
  }
}

export function isRef(selector) {
  if (typeof selector !== "string") return false;
  if (selector.startsWith("@")) return true;
  if (selector.startsWith("ref=")) return true;
  if (/^e\d+$/.test(selector)) return true;
  return false;
}

export function parseRef(selector) {
  if (typeof selector !== "string") return null;
  if (selector.startsWith("@")) return selector.slice(1);
  if (selector.startsWith("ref=")) return selector.slice(4);
  if (/^e\d+$/.test(selector)) return selector;
  return null;
}

export function resolveSelector(selector, ownerId, tabId) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("Selector must be a non-empty string");
  }

  const semantic = parseSemanticSelector(selector);
  if (semantic) {
    return {
      css: null,
      role: semantic,
      name: undefined,
      nth: semantic.nth,
      isRef: true,
      isSemantic: true,
    };
  }

  const ref = parseRef(selector);
  if (ref) {
    const refMap = getRefMap(ownerId, tabId);
    const data = refMap[ref];
    if (!data) {
      throw new Error(
        `Unknown ref: ${ref}. Run 'snapshot' first to generate refs.`,
      );
    }
    return {
      css: null,
      role: data.role,
      name: data.name,
      nth: data.nth,
      isRef: true,
    };
  }

  return { css: selector, isRef: false };
}

export function buildComposedCssMatcherAllScript(selector) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("CSS selector must be a non-empty string");
  }

  return `
    (() => {
      const selector = ${JSON.stringify(selector)};

      document.querySelectorAll(selector);
      const matches = [];
      const seen = new Set();
      const childElements = el => {
        const children = [...(el.children || [])];
        if (el.shadowRoot) children.push(...(el.shadowRoot.children || []));
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            const frameRoot = el.contentDocument && el.contentDocument.documentElement;
            if (frameRoot) children.push(frameRoot);
          } catch (_) {

          }
        }
        return children;
      };
      const visit = el => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        if (el.matches(selector)) matches.push(el);
        for (const child of childElements(el)) visit(child);
      };
      visit(document.documentElement || document.body);
      return matches;
    })()
  `;
}

export function buildComposedCssMatcherScript(selector) {
  const allMatches = buildComposedCssMatcherAllScript(selector);
  return `
    (() => {
      const matches = ${allMatches.trim()};
      return matches[0] || null;
    })()
  `;
}

export function buildResolvedElementMatcherScript(resolved) {
  return resolved.isRef
    ? buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth)
    : buildComposedCssMatcherScript(resolved.css);
}

export function buildTopLevelRectSource(elementName = "el") {
  return `
    const localRect = ${elementName}.getBoundingClientRect();
    let topX = localRect.left;
    let topY = localRect.top;
    let currentWindow = ${elementName}.ownerDocument?.defaultView || window;
    const visitedWindows = new Set();
    while (currentWindow && currentWindow !== currentWindow.top) {
      if (visitedWindows.has(currentWindow)) throw new Error('Cyclic frame ancestry');
      visitedWindows.add(currentWindow);
      let frameElement;
      try { frameElement = currentWindow.frameElement; }
      catch (_) { throw new Error('Cannot resolve coordinates through a cross-origin frame'); }
      if (!frameElement) throw new Error('Cannot resolve the ancestor frame element');
      const frameRect = frameElement.getBoundingClientRect();
      topX += frameRect.left + (frameElement.clientLeft || 0);
      topY += frameRect.top + (frameElement.clientTop || 0);
      currentWindow = frameElement.ownerDocument?.defaultView;
    }
  `;
}

function normalizeRoleMatcher(role, name, nth) {
  return isPlainObject(role) && SEMANTIC_KINDS.has(role.kind)
    ? normalizeSemanticSelector(role)
    : { kind: "role", role, name, nth, exact: true };
}

export function buildRoleMatcherAllScript(role, name) {
  const matcher = normalizeRoleMatcher(role, name, undefined);

  return `
    (() => {
      const ROLE_TAG_MAP = {
        button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]'],
        link: ['a[href]', '[role="link"]'],
        textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
        checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]'],
        combobox: ['select', '[role="combobox"]'],
        listbox: ['select[multiple]', '[role="listbox"]'],
        menuitem: ['[role="menuitem"]'],
        option: ['option', '[role="option"]'],
        searchbox: ['input[type="search"]', '[role="searchbox"]'],
        slider: ['input[type="range"]', '[role="slider"]'],
        spinbutton: ['input[type="number"]', '[role="spinbutton"]'],
        switch: ['[role="switch"]'],
        tab: ['[role="tab"]'],
        treeitem: ['[role="treeitem"]'],
        heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
        img: ['img[alt]', '[role="img"]'],
        cell: ['td', '[role="cell"]', '[role="gridcell"]'],
        row: ['tr', '[role="row"]'],
        navigation: ['nav', '[role="navigation"]'],
        main: ['main', '[role="main"]'],
        region: ['section[aria-label]', '[role="region"]'],
        article: ['article', '[role="article"]'],
        clickable: ['[onclick]', '[tabindex]:not([tabindex="-1"])'],
        focusable: ['[tabindex]:not([tabindex="-1"])'],
      };

      const matcher = ${JSON.stringify(matcher)};
      const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const stringMatches = (actual, expected) => {
        const actualValue = normalize(actual);
        const expectedValue = normalize(expected);
        return matcher.exact
          ? actualValue === expectedValue
          : actualValue.toLocaleLowerCase().includes(expectedValue.toLocaleLowerCase());
      };
      const childElements = el => {
        const children = [...(el.children || [])];
        if (el.shadowRoot) {
          children.push(...(el.shadowRoot.children || []));
        }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            const frameBody = el.contentDocument && el.contentDocument.body;
            if (frameBody) children.push(frameBody);
          } catch (_) {

          }
        }
        return children;
      };
      const composedElements = [];
      const seenElements = new Set();
      const visitElement = el => {
        if (!el || seenElements.has(el)) return;
        seenElements.add(el);
        composedElements.push(el);
        for (const child of childElements(el)) visitElement(child);
      };
      visitElement(document.documentElement || document.body);
      const composedParent = el => {
        if (el.parentElement) return el.parentElement;
        const root = el.getRootNode ? el.getRootNode() : null;
        if (root && root.host) return root.host;
        try { return root && root.defaultView ? root.defaultView.frameElement : null; }
        catch (_) { return null; }
      };
      const isVisible = el => {
        if (!el || !el.isConnected) return false;
        if (el.tagName !== 'BODY' && el.getClientRects().length === 0) return false;
        for (let node = el, depth = 0; node && depth < 64; node = composedParent(node), depth += 1) {
          if (node.hidden || node.inert || node.getAttribute?.('aria-hidden')?.toLowerCase() === 'true') {
            return false;
          }
          const nodeWin = node.ownerDocument && node.ownerDocument.defaultView;
          const style = nodeWin && nodeWin.getComputedStyle(node);
          if (style && (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            parseFloat(style.opacity) === 0
          )) return false;
        }
        return true;
      };
      const uniqueVisible = elements =>
        [...new Set(elements)].filter(isVisible);
      const queryComposedAny = selectors =>
        composedElements.filter(el => {
          for (const selector of selectors) {
            try {
              if (el.matches(selector)) return true;
            } catch (_) {

            }
          }
          return false;
        });
      const queryComposed = selector => queryComposedAny([selector]);
      const elementRoot = el =>
        (el.getRootNode && el.getRootNode()) || el.ownerDocument || document;
      const findIdReference = (el, id) => {
        const root = elementRoot(el);
        const localMatch = root && root.getElementById ? root.getElementById(id) : null;
        return localMatch || el.ownerDocument?.getElementById(id) || null;
      };
      const labelledText = el => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (!labelledBy) return '';
        return labelledBy
          .split(/\\s+/)
          .map(id => findIdReference(el, id)?.textContent || '')
          .join(' ');
      };
      const accessibleName = el => {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const labelled = labelledText(el);
        if (labelled) return labelled;
        if (el.id) {
          const root = elementRoot(el);
          const labels = root && root.querySelectorAll ? root.querySelectorAll('label') : [];
          const label = [...labels].find(candidate => candidate.htmlFor === el.id);
          if (label) return label.textContent || '';
        }
        return el.alt || el.value || el.title || el.placeholder || el.textContent || '';
      };

      let matches = [];
      if (matcher.kind === 'role') {
        const selectors = ROLE_TAG_MAP[matcher.role] || ['[role="' + matcher.role + '"]'];
        const candidates = uniqueVisible(queryComposedAny(selectors));
        matches = matcher.name === undefined
          ? candidates
          : candidates.filter(el => stringMatches(accessibleName(el), matcher.name));
      } else if (matcher.kind === 'text') {
        const candidates = uniqueVisible(
          composedElements.filter(el => el.tagName !== 'HTML' && el.tagName !== 'BODY'),
        );
        matches = candidates.filter(el => {
          if (!stringMatches(el.textContent, matcher.value)) return false;
          return !childElements(el).some(
            child => isVisible(child) && stringMatches(child.textContent, matcher.value),
          );
        });
      } else if (matcher.kind === 'label') {
        const controls = [];
        for (const label of queryComposed('label')) {
          if (!stringMatches(label.textContent, matcher.value)) continue;
          const control = label.control || label.querySelector('input, textarea, select, button');
          if (control) controls.push(control);
        }
        for (const el of queryComposed('[aria-label], [aria-labelledby]')) {
          if (stringMatches(accessibleName(el), matcher.value)) controls.push(el);
        }
        matches = uniqueVisible(controls);
      } else if (matcher.kind === 'placeholder') {
        matches = uniqueVisible(queryComposed('[placeholder]'))
          .filter(el => stringMatches(el.getAttribute('placeholder'), matcher.value));
      } else if (matcher.kind === 'testid') {
        matches = uniqueVisible(queryComposed('[data-testid]'))
          .filter(el => stringMatches(el.getAttribute('data-testid'), matcher.value));
      }

      return matches;
    })()
  `;
}

export function buildRoleMatcherScript(role, name, nth) {
  const matcher = normalizeRoleMatcher(role, name, nth);
  const allMatches = buildRoleMatcherAllScript(matcher);
  const description =
    matcher.kind === "role"
      ? `role=${JSON.stringify(matcher.role)}${
          matcher.name !== undefined
            ? ` name=${JSON.stringify(matcher.name)}`
            : ""
        }`
      : `${matcher.kind}=${JSON.stringify(matcher.value)}`;

  return `
    (() => {
      const matches = ${allMatches.trim()};
      if (matches.length === 0) {
        throw new Error(${JSON.stringify(`No element found with ${description}`)});
      }
      const hasExplicitIndex = ${matcher.nth !== undefined};
      if (!hasExplicitIndex && matches.length > 1) {
        throw new Error(
          'Strict mode violation: ${description} matched ' + matches.length +
          ' visible elements; refine the locator or use nth()/first()/last()',
        );
      }
      const index = ${matcher.nth ?? 0};
      if (index >= matches.length) {
        throw new Error('Element index ' + index + ' out of range, found ' + matches.length + ' matches');
      }
      return matches[index];
    })()
  `;
}
