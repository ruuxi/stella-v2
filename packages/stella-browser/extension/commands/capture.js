/**
 * Capture command handlers: screenshot, snapshot, content, evaluate, pdf.
 */
import { getActiveTab } from "./tabs.js";
import {
  setRefMap,
  resolveSelector,
  buildResolvedElementMatcherScript,
  buildTopLevelRectSource,
} from "../lib/selector.js";
import { captureFrameSnapshot } from "../lib/frame-snapshot.js";
import { callExactElement, exactElementPoint } from "../lib/frame-elements.js";
import { ensureDebugger, evaluateRuntime } from "../lib/debugger.js";

function buildElementExpression(selector, ownerId, tabId, onFoundSource) {
  const resolved = resolveSelector(selector, ownerId, tabId);
  const finder = buildResolvedElementMatcherScript(resolved);
  return `(() => { const el = ${finder.trim()}; ${onFoundSource} })()`;
}

async function getSelectorClip(tabId, selector, ownerId) {
  const resolved = resolveSelector(selector, ownerId, tabId);
  if (resolved.exactNode) {
    const box = await exactElementPoint(tabId, resolved, {
      boxOnly: true,
      scroll: true,
    });
    const scroll = await evaluateRuntime(tabId, "({x:scrollX,y:scrollY})");
    return {
      x: box.left + scroll.x,
      y: box.top + scroll.y,
      width: box.width,
      height: box.height,
      scale: 1,
    };
  }
  const clip = await evaluateRuntime(
    tabId,
    buildElementExpression(
      selector,
      ownerId,
      tabId,
      `
        if (!el) return null;
        const ancestorFrames = [];
        let ancestorWindow = el.ownerDocument?.defaultView;
        while (ancestorWindow && ancestorWindow !== ancestorWindow.top) {
          let frameElement;
          try { frameElement = ancestorWindow.frameElement; } catch (_) { frameElement = null; }
          if (!frameElement) return null;
          ancestorFrames.push(frameElement);
          ancestorWindow = frameElement.ownerDocument?.defaultView;
        }
        for (const frameElement of ancestorFrames.reverse()) {
          frameElement.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        ${buildTopLevelRectSource("el")}
        if (!localRect.width || !localRect.height) return null;
        const topWindow = currentWindow || window.top;
        return {
          x: topX + topWindow.scrollX,
          y: topY + topWindow.scrollY,
          width: localRect.width,
          height: localRect.height,
          scale: 1,
        };
      `,
    ),
  );

  if (!clip) {
    throw new Error(`Selector not found or not visible: ${selector}`);
  }

  return clip;
}

export async function handleScreenshot(command) {
  const tab = await getActiveTab(command);
  if (command.path) {
    throw new Error(
      "Custom screenshot paths are not supported in extension mode",
    );
  }

  const format = command.format || "jpeg";
  const quality = command.quality ?? (format === "jpeg" ? 60 : undefined);
  /** @type {Record<string, unknown>} */
  const params = {
    format,
    captureBeyondViewport: Boolean(command.fullPage || command.selector),
  };
  if (format === "jpeg") {
    params.quality = quality;
  }

  await ensureDebugger(tab.id);

  if (command.fullPage) {
    const metrics = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Page.getLayoutMetrics",
    );
    const contentSize = metrics.contentSize;
    params.clip = {
      x: 0,
      y: 0,
      width: contentSize.width,
      height: contentSize.height,
      scale: 1,
    };
  } else if (command.selector) {
    params.clip = await getSelectorClip(
      tab.id,
      command.selector,
      command.ownerId,
    );
  }

  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    "Page.captureScreenshot",
    params,
  );
  const base64 = result.data;

  return {
    id: command.id,
    success: true,
    data: {
      base64,
      format,
    },
  };
}

export async function handleSnapshot(command) {
  if (command.format === "ax") return handleAxSnapshot(command);
  const tab = await getActiveTab(command);

  const options = {
    interactive: command.interactive ?? false,
    cursor: command.cursor ?? false,
    maxDepth: command.maxDepth ?? command.depth,
    compact: command.compact ?? false,
    selector: command.selector,
  };

  const snapshot = await captureFrameSnapshot(tab.id, options);

  // Update the ref map for subsequent commands
  setRefMap(command.ownerId, tab.id, snapshot.refs || {});

  return {
    id: command.id,
    success: true,
    data: {
      ...snapshot,
    },
  };
}

export async function handleAxSnapshot(command) {
  const tab = await getActiveTab(command);
  const snapshot = await captureFrameSnapshot(
    tab.id,
    {
      interactive: command.interactive ?? false,
      compact: command.compact ?? false,
      maxDepth: command.maxDepth ?? command.depth,
      selector: command.selector,
    },
    "ax",
  );
  setRefMap(command.ownerId, tab.id, snapshot.refs);
  return { id: command.id, success: true, data: snapshot };
}

async function readElement(tabId, selector, ownerId, body) {
  const resolved = resolveSelector(selector, ownerId, tabId);
  if (resolved.exactNode) return callExactElement(tabId, resolved, body);
  return evaluateRuntime(
    tabId,
    buildElementExpression(selector, ownerId, tabId, body),
  );
}

export async function handleContent(command) {
  const tab = await getActiveTab(command);
  let html = "";

  if (command.selector) {
    html =
      (await readElement(
        tab.id,
        command.selector,
        command.ownerId,
        "return el ? el.innerHTML : null;",
      )) || "";
  } else {
    html =
      (await evaluateRuntime(
        tab.id,
        'document.documentElement ? document.documentElement.outerHTML : ""',
      )) || "";
  }

  return {
    id: command.id,
    success: true,
    data: { html },
  };
}

export async function handleEvaluate(command) {
  const tab = await getActiveTab(command);
  const expression = command.expression || command.script;

  if (!expression) throw new Error("Expression is required for evaluate");

  const value = await evaluateRuntime(tab.id, expression, {
    timeoutMs: Math.min(command.timeout ?? 30_000, 30_000),
  });
  return {
    id: command.id,
    success: true,
    data: { result: value },
  };
}

export async function handleGetText(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  if (!selector) throw new Error("Selector is required for gettext");

  return {
    id: command.id,
    success: true,
    data: {
      text:
        (await readElement(
          tab.id,
          selector,
          command.ownerId,
          "return el ? el.textContent.trim() : null;",
        )) ?? "",
    },
  };
}

export async function handleGetAttribute(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  const attribute = command.attribute || command.name;
  if (!selector) throw new Error("Selector is required");
  if (!attribute) throw new Error("Attribute name is required");

  return {
    id: command.id,
    success: true,
    data: {
      value: await readElement(
        tab.id,
        selector,
        command.ownerId,
        `return el ? el.getAttribute(${JSON.stringify(attribute)}) : null;`,
      ),
    },
  };
}

export async function handlePdf(command) {
  const tab = await getActiveTab(command);
  await ensureDebugger(tab.id);

  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    "Page.printToPDF",
    {
      landscape: command.landscape || false,
      printBackground: command.printBackground ?? true,
      paperWidth: command.paperWidth,
      paperHeight: command.paperHeight,
    },
  );

  return {
    id: command.id,
    success: true,
    data: { base64: result.data, format: "pdf" },
  };
}
