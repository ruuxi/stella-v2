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
import { executeSnapshot } from "../lib/snapshot.js";
import { ensureDebugger, evaluateRuntime } from "../lib/debugger.js";

function buildElementExpression(selector, ownerId, tabId, onFoundSource) {
  const resolved = resolveSelector(selector, ownerId, tabId);
  const finder = buildResolvedElementMatcherScript(resolved);
  return `(() => { const el = ${finder.trim()}; ${onFoundSource} })()`;
}

async function getSelectorClip(tabId, selector, ownerId) {
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
  const tab = await getActiveTab(command);

  const options = {
    interactive: command.interactive ?? false,
    cursor: command.cursor ?? false,
    maxDepth: command.maxDepth ?? command.depth,
    compact: command.compact ?? false,
    selector: command.selector,
  };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: executeSnapshot,
    args: [options],
    world: "MAIN",
  });

  if (result?.error)
    throw new Error(result.error.message || String(result.error));

  const snapshot = result?.result;
  if (!snapshot) throw new Error("Snapshot generation failed");

  // Update the ref map for subsequent commands
  setRefMap(command.ownerId, tab.id, snapshot.refs || {});

  return {
    id: command.id,
    success: true,
    data: {
      snapshot: snapshot.tree,
      refs: snapshot.refs,
    },
  };
}

export async function handleContent(command) {
  const tab = await getActiveTab(command);
  let html = "";

  if (command.selector) {
    html =
      (await evaluateRuntime(
        tab.id,
        buildElementExpression(
          command.selector,
          command.ownerId,
          tab.id,
          "return el ? el.innerHTML : null;",
        ),
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

  const script = buildElementExpression(
    selector,
    command.ownerId,
    tab.id,
    "return el ? el.textContent.trim() : null;",
  );

  return {
    id: command.id,
    success: true,
    data: { text: (await evaluateRuntime(tab.id, script)) ?? "" },
  };
}

export async function handleGetAttribute(command) {
  const tab = await getActiveTab(command);
  const selector = command.selector || command.ref;
  const attribute = command.attribute || command.name;
  if (!selector) throw new Error("Selector is required");
  if (!attribute) throw new Error("Attribute name is required");

  const script = buildElementExpression(
    selector,
    command.ownerId,
    tab.id,
    `return el ? el.getAttribute(${JSON.stringify(attribute)}) : null;`,
  );

  return {
    id: command.id,
    success: true,
    data: { value: await evaluateRuntime(tab.id, script) },
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
