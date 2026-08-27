export function executeSnapshot(options) {
  const MAX_CHARS = 20_000;
  const MAX_ELEMENTS = 200;
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  const CONTENT_ROLES = new Set([
    "heading",
    "cell",
    "gridcell",
    "columnheader",
    "rowheader",
    "listitem",
    "article",
    "region",
    "main",
    "navigation",
  ]);

  const STRUCTURAL_ROLES = new Set([
    "generic",
    "group",
    "list",
    "table",
    "row",
    "rowgroup",
    "grid",
    "treegrid",
    "menu",
    "menubar",
    "toolbar",
    "tablist",
    "tree",
    "directory",
    "document",
    "application",
    "presentation",
    "none",
  ]);

  const TAG_ROLE_MAP = {
    A: (el) => (el.hasAttribute("href") ? "link" : null),
    BUTTON: () => "button",
    INPUT: (el) => {
      const type = (el.type || "text").toLowerCase();
      const map = {
        text: "textbox",
        email: "textbox",
        password: "textbox",
        search: "searchbox",
        tel: "textbox",
        url: "textbox",
        number: "spinbutton",
        range: "slider",
        checkbox: "checkbox",
        radio: "radio",
        button: "button",
        submit: "button",
        reset: "button",
      };
      return map[type] || "textbox";
    },
    TEXTAREA: () => "textbox",
    SELECT: (el) => (el.multiple ? "listbox" : "combobox"),
    OPTION: () => "option",
    H1: () => "heading",
    H2: () => "heading",
    H3: () => "heading",
    H4: () => "heading",
    H5: () => "heading",
    H6: () => "heading",
    NAV: () => "navigation",
    MAIN: () => "main",
    ARTICLE: () => "article",
    SECTION: (el) => (el.hasAttribute("aria-label") ? "region" : null),
    FORM: () => "form",
    TABLE: () => "table",
    TR: () => "row",
    TD: () => "cell",
    TH: () => "columnheader",
    THEAD: () => "rowgroup",
    TBODY: () => "rowgroup",
    TFOOT: () => "rowgroup",
    UL: () => "list",
    OL: () => "list",
    LI: () => "listitem",
    IMG: (el) => (el.hasAttribute("alt") ? "img" : "presentation"),
    DETAILS: () => "group",
    SUMMARY: () => "button",
    DIALOG: () => "dialog",
  };

  let refCounter = 0;
  const refs = {};
  const roleCounts = new Map();
  let emittedChars = 0;
  let emittedElements = 0;
  let truncated = false;
  let skippedCrossOriginFrames = 0;

  function addLine(lines, line) {
    if (truncated) return false;
    if (
      emittedElements >= MAX_ELEMENTS ||
      emittedChars + line.length + 1 > MAX_CHARS
    ) {
      truncated = true;
      return false;
    }
    lines.push(line);
    emittedElements += 1;
    emittedChars += line.length + 1;
    return true;
  }

  function childElements(el) {
    const children = Array.from(el.children || []);
    if (el.shadowRoot)
      children.push(...Array.from(el.shadowRoot.children || []));
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      try {
        const body = el.contentDocument?.body;
        if (body) children.push(body);
        else skippedCrossOriginFrames += 1;
      } catch (_) {
        skippedCrossOriginFrames += 1;
      }
    }
    return children;
  }

  function findComposedFirst(selector) {

    document.querySelectorAll(selector);
    const seen = new Set();
    let match = null;
    const visit = (el) => {
      if (!el || match || seen.has(el)) return;
      seen.add(el);
      if (el.matches(selector)) {
        match = el;
        return;
      }
      for (const child of childElements(el)) visit(child);
    };
    visit(document.documentElement || document.body);
    return match;
  }

  function composedDescendants(root) {
    const results = [];
    const seen = new Set();
    const visit = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      for (const child of childElements(el)) {
        results.push(child);
        visit(child);
      }
    };
    visit(root);
    return results;
  }

  function nextRef() {
    return "e" + ++refCounter;
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const mapper = TAG_ROLE_MAP[el.tagName];
    if (mapper) return mapper(el);
    return null;
  }

  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
      const labelledText = labelledBy
        .split(/\s+/)
        .map((id) => {
          const localMatch =
            root && root.getElementById ? root.getElementById(id) : null;
          return (
            (localMatch || el.ownerDocument.getElementById(id))?.textContent ||
            ""
          );
        })
        .join(" ")
        .trim();
      if (labelledText) return labelledText;
    }

    if (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT"
    ) {
      if (el.id) {
        const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
        const labels =
          root && root.querySelectorAll ? root.querySelectorAll("label") : [];
        const label = Array.from(labels).find(
          (candidate) => candidate.htmlFor === el.id,
        );
        if (label) return label.textContent.trim();
      }
      if (el.placeholder) return el.placeholder;
      if (el.title) return el.title;
    }

    if (el.tagName === "IMG") return el.alt || null;

    const role = getRole(el);
    if (
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "option" ||
      role === "treeitem"
    ) {
      const text = getDirectText(el);
      if (text) return text;
    }

    if (role === "heading") {
      const text = el.textContent.trim();
      return text || null;
    }

    return null;
  }

  function getDirectText(el) {
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childRole = getRole(child);
        if (!childRole || !INTERACTIVE_ROLES.has(childRole)) {
          text += getDirectText(child);
        }
      }
    }
    return text.trim();
  }

  function getHeadingLevel(el) {
    const match = el.tagName.match(/^H(\d)$/);
    if (match) return parseInt(match[1]);
    const level = el.getAttribute("aria-level");
    if (level) return parseInt(level);
    return null;
  }

  function isVisible(el) {
    if (
      el.offsetParent === null &&
      el.tagName !== "BODY" &&
      el.tagName !== "HTML"
    ) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      if (style.position !== "fixed" && style.position !== "sticky")
        return false;
    }
    return true;
  }

  function buildCssSelector(el) {
    const testId = el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId + '"]';
    if (el.id) return "#" + CSS.escape(el.id);

    const path = [];
    let current = el;
    while (current && current !== el.ownerDocument.body) {
      let sel = current.tagName.toLowerCase();
      const cls = Array.from(current.classList).filter((c) => c.trim());
      if (cls.length > 0) sel += "." + CSS.escape(cls[0]);

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const matching = siblings.filter((s) => {
          if (s.tagName !== current.tagName) return false;
          if (cls.length > 0 && !s.classList.contains(cls[0])) return false;
          return true;
        });
        if (matching.length > 1) {
          const idx = matching.indexOf(current) + 1;
          sel += ":nth-of-type(" + idx + ")";
        }
      }
      path.unshift(sel);
      current = current.parentElement;
      if (path.length >= 3) break;
    }
    return path.join(" > ");
  }

  function getRoleKey(role, name) {
    return role + ":" + (name || "");
  }

  function processNode(el, depth, lines) {
    if (truncated) return;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (!isVisible(el)) return;

    if (options.maxDepth !== undefined && depth > options.maxDepth) return;

    const role = getRole(el);
    const indent = "  ".repeat(depth);

    if (role) {
      const name = getAccessibleName(el);
      const isInteractive = INTERACTIVE_ROLES.has(role);
      const isContent = CONTENT_ROLES.has(role);
      const isStructural = STRUCTURAL_ROLES.has(role);

      if (options.interactive && !isInteractive) {
        for (const child of childElements(el)) {
          processNode(child, depth, lines);
        }
        return;
      }

      if (options.compact && isStructural && !name) {
        for (const child of childElements(el)) {
          processNode(child, depth, lines);
        }
        return;
      }

      let line = indent + "- " + role;
      let emittedRef = null;
      if (name) line += ' "' + name.replace(/"/g, '\\"') + '"';

      const shouldRef = isInteractive || (isContent && name);
      if (shouldRef) {
        const ref = nextRef();
        emittedRef = ref;
        const key = getRoleKey(role, name);
        const count = roleCounts.get(key) || 0;
        roleCounts.set(key, count + 1);

        refs[ref] = {
          selector: buildCssSelector(el),
          role: role,
          name: name || undefined,
          nth: count,
        };
        line += " [ref=" + ref + "]";
        if (count > 0) line += " [nth=" + count + "]";
      }

      const level = getHeadingLevel(el);
      if (level) line += " [level=" + level + "]";

      if (el.getAttribute("aria-expanded") !== null) {
        line += " [expanded=" + el.getAttribute("aria-expanded") + "]";
      }
      if (el.getAttribute("aria-checked") !== null) {
        line += " [checked=" + el.getAttribute("aria-checked") + "]";
      }
      if (el.getAttribute("aria-selected") !== null) {
        line += " [selected=" + el.getAttribute("aria-selected") + "]";
      }
      if (el.getAttribute("aria-disabled") === "true" || el.disabled) {
        line += " [disabled]";
      }
      if (el.getAttribute("aria-required") === "true" || el.required) {
        line += " [required]";
      }

      if (!addLine(lines, line)) {
        if (emittedRef) delete refs[emittedRef];
        return;
      }
    }

    for (const child of childElements(el)) {
      processNode(child, role ? depth + 1 : depth, lines);
    }

    if (role && !INTERACTIVE_ROLES.has(role) && !STRUCTURAL_ROLES.has(role)) {
      const text = getDirectText(el);
      if (text && !getAccessibleName(el)) {
        addLine(lines, indent + "  " + "- text: " + text.slice(0, 200));
      }
    }
  }

  function findCursorInteractive() {
    const interactiveTags = new Set([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "details",
      "summary",
    ]);
    const results = [];
    const root = options.selector
      ? findComposedFirst(options.selector) || document.body
      : document.body;
    const allElements = composedDescendants(root);

    for (const el of allElements) {
      const tagName = el.tagName.toLowerCase();
      if (interactiveTags.has(tagName)) continue;

      const role = el.getAttribute("role");
      if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) continue;

      const style = getComputedStyle(el);
      const hasCursor = style.cursor === "pointer";
      const hasOnClick = el.hasAttribute("onclick") || el.onclick !== null;
      const tabIndex = el.getAttribute("tabindex");
      const hasTabIndex = tabIndex !== null && tabIndex !== "-1";

      if (!hasCursor && !hasOnClick && !hasTabIndex) continue;

      const text = (el.textContent || "").trim().slice(0, 100);
      if (!text) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      results.push({
        selector: buildCssSelector(el),
        text: text,
        hasCursor: hasCursor,
        hasOnClick: hasOnClick,
        hasTabIndex: hasTabIndex,
      });
    }
    return results;
  }

  const root = options.selector
    ? findComposedFirst(options.selector) || document.body
    : document.body;

  const lines = [];
  processNode(root, 0, lines);

  const keyCounts = new Map();
  for (const data of Object.values(refs)) {
    const key = getRoleKey(data.role, data.name);
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  for (const data of Object.values(refs)) {
    const key = getRoleKey(data.role, data.name);
    if ((keyCounts.get(key) || 0) <= 1) {
      delete data.nth;
    }
  }

  let tree = lines.join("\n") || "(empty)";

  if (options.cursor) {
    const cursorEls = findCursorInteractive();
    const existingNames = new Set(
      Object.values(refs).map((r) => (r.name || "").toLowerCase()),
    );
    const extra = [];

    for (const el of cursorEls) {
      if (existingNames.has(el.text.toLowerCase())) continue;
      const ref = nextRef();
      const role = el.hasCursor || el.hasOnClick ? "clickable" : "focusable";
      refs[ref] = { selector: el.selector, role: role, name: el.text };

      const hints = [];
      if (el.hasCursor) hints.push("cursor:pointer");
      if (el.hasOnClick) hints.push("onclick");
      if (el.hasTabIndex) hints.push("tabindex");
      const line =
        "- " +
        role +
        ' "' +
        el.text +
        '" [ref=' +
        ref +
        "] [" +
        hints.join(", ") +
        "]";
      if (!addLine(extra, line)) {
        delete refs[ref];
        break;
      }
    }

    if (extra.length > 0) {
      tree += "\n# Cursor-interactive elements:\n" + extra.join("\n");
    }
  }

  if (truncated || skippedCrossOriginFrames > 0) {
    tree +=
      "\n[snapshot metadata: truncated=" +
      truncated +
      "; emittedElements=" +
      emittedElements +
      "; emittedChars=" +
      Math.min(emittedChars, MAX_CHARS) +
      "; maxElements=" +
      MAX_ELEMENTS +
      "; maxChars=" +
      MAX_CHARS +
      "; skippedCrossOriginFrames=" +
      skippedCrossOriginFrames +
      "]";
  }

  return {
    tree,
    refs,
    truncated,
    stats: {
      emittedElements,
      emittedChars: Math.min(emittedChars, MAX_CHARS),
      maxElements: MAX_ELEMENTS,
      maxChars: MAX_CHARS,
      skippedCrossOriginFrames,
    },
  };
}
