/**
 * Navigation command handlers.
 */
import { getActiveTab } from "./tabs.js";
import { ensureDebugger } from "../lib/debugger.js";
import {
  markCommandMutationDispatched,
  markCommandMutationOutcomeKnown,
  throwIfCommandAborted,
} from "./cancellation.js";

/**
 * Subscribe before dispatching navigation, including cached loads that can
 * finish before chrome.tabs.update/reload resolves.
 */
async function navigateAndWaitForLoad(command, tabId, navigate, waitUntil = "load") {
  throwIfCommandAborted(command);
  if (waitUntil === "none") {
    markCommandMutationDispatched(command);
    await navigate();
    return;
  }
  const timeout = command.timeout || 30000;
  const signal = command.signal;
  const waitForDomContentLoaded = waitUntil === "domcontentloaded";
  let dispose = () => {};
  const loaded = new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Navigation aborted"));
      return;
    }
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (waitForDomContentLoaded) {
        chrome.webNavigation.onDOMContentLoaded.removeListener(
          onDOMContentLoaded,
        );
      }
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    dispose = () => finish(resolve);
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error("Navigation timeout after " + timeout + "ms")),
      );
    }, timeout);

    const onAbort = () =>
      finish(() => {
        reject(signal.reason || new Error("Navigation aborted"));
      });

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve);
      }
    }

    function onDOMContentLoaded(details) {
      if (details.tabId === tabId && details.frameId === 0) finish(resolve);
    }

    chrome.tabs.onUpdated.addListener(listener);
    if (waitForDomContentLoaded) {
      chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.all([
      loaded,
      Promise.resolve().then(() => {
        markCommandMutationDispatched(command);
        return navigate();
      }),
    ]);
  } finally {
    dispose();
  }
}

export async function handleNavigate(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  const url = command.url;

  if (!url) throw new Error("URL is required for navigate");

  await navigateAndWaitForLoad(
    command,
    tab.id,
    () => chrome.tabs.update(tab.id, { url }),
    command.waitUntil,
  );

  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);

  // Pre-warm debugger for subsequent commands (click, fill, eval, etc.)
  try {
    await ensureDebugger(updated.id);
  } catch {}

  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

async function navigateHistory(command, navigate) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  // Listen before dispatch so cached and same-document navigations cannot
  // finish before we subscribe. Keep the old grace period for pages that emit
  // no navigation event, but return as soon as the browser confirms a commit.
  const events = [
    chrome.webNavigation.onCommitted,
    chrome.webNavigation.onHistoryStateUpdated,
    chrome.webNavigation.onReferenceFragmentUpdated,
  ];
  let finish;
  const committed = new Promise((resolve) => { finish = resolve; });
  const listener = (details) => {
    if (details.tabId === tab.id && details.frameId === 0) finish();
  };
  for (const event of events) event.addListener(listener);
  const timer = setTimeout(finish, 500);
  command.signal?.addEventListener("abort", finish, { once: true });
  try {
    throwIfCommandAborted(command);
    markCommandMutationDispatched(command);
    await navigate(tab.id);
    await committed;
    throwIfCommandAborted(command);
    const updated = await chrome.tabs.get(tab.id);
    markCommandMutationOutcomeKnown(command);
    return {
      id: command.id,
      success: true,
      data: { url: updated.url, title: updated.title },
    };
  } finally {
    clearTimeout(timer);
    for (const event of events) event.removeListener(listener);
    command.signal?.removeEventListener("abort", finish);
  }
}

export async function handleBack(command) {
  return navigateHistory(command, (tabId) => chrome.tabs.goBack(tabId));
}

export async function handleForward(command) {
  return navigateHistory(command, (tabId) => chrome.tabs.goForward(tabId));
}

export async function handleReload(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  await navigateAndWaitForLoad(command, tab.id, () => chrome.tabs.reload(tab.id));
  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);

  // Pre-warm debugger for subsequent commands
  try {
    await ensureDebugger(updated.id);
  } catch {}

  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleUrl(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  return {
    id: command.id,
    success: true,
    data: { url: tab.url || "" },
  };
}

export async function handleTitle(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  return {
    id: command.id,
    success: true,
    data: { title: tab.title || "" },
  };
}
