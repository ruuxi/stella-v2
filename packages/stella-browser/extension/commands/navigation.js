import { getActiveTab } from "./tabs.js";
import { ensureDebugger } from "../lib/debugger.js";
import {
  abortableCommandDelay,
  markCommandMutationDispatched,
  markCommandMutationOutcomeKnown,
  throwIfCommandAborted,
} from "./cancellation.js";

function waitForLoad(tabId, timeout = 30000, signal) {
  return new Promise((resolve, reject) => {
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
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
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

    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function handleNavigate(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  const url = command.url;

  if (!url) throw new Error("URL is required for navigate");

  markCommandMutationDispatched(command);
  await chrome.tabs.update(tab.id, { url });

  if (command.waitUntil !== "none") {
    await waitForLoad(tab.id, command.timeout || 30000, command.signal);
  }

  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);

  try {
    await ensureDebugger(updated.id);
  } catch {}

  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleBack(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  markCommandMutationDispatched(command);
  await chrome.tabs.goBack(tab.id);

  await abortableCommandDelay(command, 500);
  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleForward(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  markCommandMutationDispatched(command);
  await chrome.tabs.goForward(tab.id);
  await abortableCommandDelay(command, 500);
  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleReload(command) {
  throwIfCommandAborted(command);
  const tab = await getActiveTab(command);
  markCommandMutationDispatched(command);
  await chrome.tabs.reload(tab.id);
  await waitForLoad(tab.id, command.timeout || 30000, command.signal);
  throwIfCommandAborted(command);
  const updated = await chrome.tabs.get(tab.id);
  markCommandMutationOutcomeKnown(command);

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
