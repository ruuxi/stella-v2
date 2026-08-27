const debuggerAttachments = new Map();

const detachHolds = new Set();
let detachTimer = null;
const DETACH_TIMEOUT = 300000;

function scheduleIdleDetach() {

  clearTimeout(detachTimer);
  detachTimer = setTimeout(() => detachIdleDebuggers(), DETACH_TIMEOUT);
  detachTimer.unref?.();
}

export function holdDebugger(tabId) {
  detachHolds.add(tabId);
}

export function releaseDebugger(tabId) {
  detachHolds.delete(tabId);
}

async function detachIdleDebuggers() {
  detachTimer = null;
  for (const [tabId] of [...debuggerAttachments]) {
    if (detachHolds.has(tabId)) continue;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {

    }
    debuggerAttachments.delete(tabId);
  }
  if (detachHolds.size > 0) scheduleIdleDetach();
}

export async function ensureDebugger(tabId) {
  if (!debuggerAttachments.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttachments.set(tabId, true);
  }
  scheduleIdleDetach();
}

export async function evaluateRuntime(tabId, expression, options = {}) {
  await ensureDebugger(tabId);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError('Runtime evaluation timeout must be between 1 and 30000ms');
  }
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  };
  if (options.userGesture === true) params.userGesture = true;
  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    params,
  );

  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Runtime evaluation failed';
    throw new Error(message);
  }

  return result.result?.value;
}

export async function detachAllDebuggers() {
  clearTimeout(detachTimer);
  detachTimer = null;
  for (const [tabId] of debuggerAttachments) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {

    }
  }
  debuggerAttachments.clear();

  detachHolds.clear();
}

export function isDebuggerAttached(tabId) {
  return debuggerAttachments.has(tabId);
}

const eventListeners = new Map();

export function onCdpEvent(tabId, method, callback) {
  const key = `${tabId}:${method}`;
  if (!eventListeners.has(key)) {
    eventListeners.set(key, new Set());
  }
  eventListeners.get(key).add(callback);
}

export function offCdpEvent(tabId, method, callback) {
  const key = `${tabId}:${method}`;
  const listeners = eventListeners.get(key);
  if (listeners) {
    listeners.delete(callback);
    if (listeners.size === 0) eventListeners.delete(key);
  }
}

export function clearCdpEvents(tabId) {
  for (const key of eventListeners.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      eventListeners.delete(key);
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const key = `${source.tabId}:${method}`;
  const listeners = eventListeners.get(key);
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(params, source);
      } catch (err) {
        console.error(`[debugger] Event listener error for ${method}:`, err);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachments.delete(tabId);
  releaseDebugger(tabId);
  clearCdpEvents(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttachments.delete(source.tabId);
    releaseDebugger(source.tabId);
  }
});
