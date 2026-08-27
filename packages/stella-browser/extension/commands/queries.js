import { getActiveTab } from "./tabs.js";
import {
  resolveSelector,
  buildComposedCssMatcherAllScript,
  buildRoleMatcherAllScript,
  buildResolvedElementMatcherScript,
  buildTopLevelRectSource,
} from "../lib/selector.js";
import { evaluateRuntime } from "../lib/debugger.js";

async function queryElement(tabId, ownerId, selector, scriptBody) {
  const resolved = resolveSelector(selector, ownerId, tabId);
  const finder = buildResolvedElementMatcherScript(resolved);
  const missingMessage = resolved.isRef
    ? "Element not found"
    : `Element not found: ${resolved.css}`;
  const script = `(() => {
    const el = ${finder.trim()};
    if (!el) throw new Error(${JSON.stringify(missingMessage)});
    ${scriptBody}
  })()`;

  return evaluateRuntime(tabId, script);
}

export async function handleInnerText(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for innertext");

  const text = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    "return el.innerText;",
  );
  return { id: command.id, success: true, data: { text } };
}

export async function handleInnerHtml(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for innerhtml");

  const html = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    "return el.innerHTML;",
  );
  return { id: command.id, success: true, data: { html } };
}

export async function handleInputValue(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for inputvalue");

  const value = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    'return el.value ?? "";',
  );
  return { id: command.id, success: true, data: { value } };
}

export async function handleBoundingBox(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for boundingbox");

  const box = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    `
    ${buildTopLevelRectSource("el")}
    return {
      x: Math.round(topX),
      y: Math.round(topY),
      width: Math.round(localRect.width),
      height: Math.round(localRect.height),
    };
  `,
  );
  return { id: command.id, success: true, data: { box } };
}

export async function handleScrollIntoView(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for scrollintoview");

  await queryElement(
    tab.id,
    command.ownerId,
    selector,
    `
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  `,
  );
  return { id: command.id, success: true, data: { scrolled: true } };
}

export async function handleIsVisible(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for isvisible");

  const resolved = resolveSelector(selector, command.ownerId, tab.id);
  const visibilityCheck = `
    const composedParent = node => {
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode ? node.getRootNode() : null;
      if (root && root.host) return root.host;
      try { return root && root.defaultView ? root.defaultView.frameElement : null; }
      catch (_) { return null; }
    };
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    for (let node = el, depth = 0; node && depth < 64; node = composedParent(node), depth += 1) {
      if (node.hidden || node.inert || node.getAttribute?.('aria-hidden')?.toLowerCase() === 'true') return false;
      const nodeWindow = node.ownerDocument?.defaultView;
      const style = nodeWindow?.getComputedStyle(node);
      if (style && (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        parseFloat(style.opacity) === 0
      )) return false;
    }
    return true;
  `;
  const finder = buildResolvedElementMatcherScript(resolved);
  const script = `(() => { const el = ${finder.trim()}; if (!el) return false; ${visibilityCheck} })()`;

  const visible = await evaluateRuntime(tab.id, script);

  return { id: command.id, success: true, data: { visible: !!visible } };
}

export async function handleIsEnabled(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for isenabled");

  const enabled = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    "return !el.disabled;",
  );
  return { id: command.id, success: true, data: { enabled } };
}

export async function handleIsChecked(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for ischecked");

  const checked = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    "return !!el.checked;",
  );
  return { id: command.id, success: true, data: { checked } };
}

export async function handleCount(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector;
  if (!selector) throw new Error("Selector is required for count");

  const resolved = resolveSelector(selector, command.ownerId, tab.id);
  if (resolved.isSemantic) {
    const allMatches = buildRoleMatcherAllScript(resolved.role, resolved.name);
    const count = await evaluateRuntime(
      tab.id,
      `(${allMatches.trim()}).length`,
    );
    return { id: command.id, success: true, data: { count: count ?? 0 } };
  }

  const allMatches = buildComposedCssMatcherAllScript(resolved.css);
  const count = await evaluateRuntime(tab.id, `(${allMatches.trim()}).length`);
  return { id: command.id, success: true, data: { count: count ?? 0 } };
}

export async function handleStyles(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for styles");

  const resolved = resolveSelector(selector, command.ownerId, tab.id);
  const extractScript = `
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    ${buildTopLevelRectSource("el")}
    return {
      tag: el.tagName.toLowerCase(),
      text: el.innerText?.trim().slice(0, 80) || null,
      box: {
        x: Math.round(topX),
        y: Math.round(topY),
        width: Math.round(localRect.width),
        height: Math.round(localRect.height),
      },
      styles: {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        fontFamily: s.fontFamily.split(',')[0].trim().replace(/"/g, ''),
        color: s.color,
        backgroundColor: s.backgroundColor,
        borderRadius: s.borderRadius,
        border: s.border !== 'none' && s.borderWidth !== '0px' ? s.border : null,
        boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
        padding: s.padding,
      },
    };
  `;

  if (!resolved.isRef) {
    const allMatches = buildComposedCssMatcherAllScript(resolved.css);
    const script = `(() => {
      const els = ${allMatches.trim()};
      return els.map(el => {
        ${extractScript}
      });
    })()`;

    const elements = await evaluateRuntime(tab.id, script);

    return {
      id: command.id,
      success: true,
      data: { elements: elements || [] },
    };
  }

  const element = await queryElement(
    tab.id,
    command.ownerId,
    selector,
    extractScript,
  );
  return { id: command.id, success: true, data: { elements: [element] } };
}

function urlMatches(url, pattern) {
  if (!pattern) return true;

  if (url === pattern) return true;

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
  return regex.test(url);
}

export async function handleWaitForUrl(command) {
  const tab = await getActiveTab(command);
  const pattern = command.url;
  const timeout = command.timeout || 30000;

  if (!pattern) throw new Error("URL pattern is required for waitforurl");

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await chrome.tabs.get(tab.id);
    if (urlMatches(current.url, pattern)) {
      return { id: command.id, success: true, data: { url: current.url } };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for URL matching: ${pattern}`);
}

export async function handleBringToFront(command) {
  const tab = await getActiveTab(command);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { id: command.id, success: true, data: { focused: true } };
}
