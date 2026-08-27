import {
  connect,
  disconnect,
  isConnected,
  onCommand,
  onStatus,
  send,
} from "./lib/connection.js";
import {
  authorizeOwnerLease,
  releaseOwnerLease,
  handleTabNew,
  handleTabList,
  handleTabSwitch,
  handleTabClose,
  handleMarkTab,
  closeAgentWindow,
  finalizeOwnerTabs,
  cleanupStaleGroups,
  cleanupStaleTabs,
} from "./commands/tabs.js";
import {
  handleNavigate,
  handleBack,
  handleForward,
  handleReload,
  handleUrl,
  handleTitle,
} from "./commands/navigation.js";
import {
  handleClick,
  handleFill,
  handleType,
  handleHover,
  handleSelect,
  handlePress,
  handleScroll,
  handleClear,
  handleCheck,
  handleUncheck,
  handleFocus,
  handleDblclick,
  handleWait,
  handleClipboard,
  handleMouseMove,
  handleMouseDown,
  handleMouseUp,
  handleDrag,
  handleKeyDown,
  handleKeyUp,
  handleInsertText,
} from "./commands/interaction.js";
import {
  handleScreenshot,
  handleSnapshot,
  handleContent,
  handleEvaluate,
  handleGetText,
  handleGetAttribute,
  handlePdf,
} from "./commands/capture.js";
import {
  handleCookiesGet,
  handleCookiesExportAll,
  handleCookiesSet,
  handleCookiesClear,
} from "./commands/cookies.js";
import {
  handleInnerText,
  handleInnerHtml,
  handleInputValue,
  handleBoundingBox,
  handleWaitForUrl,
  handleScrollIntoView,
  handleIsVisible,
  handleIsEnabled,
  handleIsChecked,
  handleCount,
  handleStyles,
  handleBringToFront,
} from "./commands/queries.js";
import {
  handleRequests,
  handleResponseBody,
  handleRoute,
  handleUnroute,
  handleHarStart,
  handleHarStop,
} from "./commands/network.js";
import { handleDownload } from "./commands/downloads.js";
import { handleChain } from "./commands/chain.js";
import {
  handleSiteModSet,
  handleSiteModList,
  handleSiteModRemove,
  handleSiteModToggle,
  syncContentScriptRegistration,
} from "./commands/site-mods.js";

const HANDLERS = {

  healthcheck: async (cmd) => ({ id: cmd.id, success: true, data: {} }),

  navigate: handleNavigate,
  open: handleNavigate,
  back: handleBack,
  forward: handleForward,
  reload: handleReload,
  url: handleUrl,
  title: handleTitle,

  click: handleClick,
  fill: handleFill,
  type: handleType,
  hover: handleHover,
  select: handleSelect,
  press: handlePress,
  scroll: handleScroll,
  clear: handleClear,
  check: handleCheck,
  uncheck: handleUncheck,
  focus: handleFocus,
  dblclick: handleDblclick,
  wait: handleWait,

  screenshot: handleScreenshot,
  snapshot: handleSnapshot,
  content: handleContent,
  evaluate: handleEvaluate,
  gettext: handleGetText,
  getattribute: handleGetAttribute,
  pdf: handlePdf,

  innertext: handleInnerText,
  innerhtml: handleInnerHtml,
  inputvalue: handleInputValue,
  boundingbox: handleBoundingBox,
  scrollintoview: handleScrollIntoView,
  isvisible: handleIsVisible,
  isenabled: handleIsEnabled,
  ischecked: handleIsChecked,
  count: handleCount,
  styles: handleStyles,
  waitforurl: handleWaitForUrl,
  bringtofront: handleBringToFront,

  requests: handleRequests,
  responsebody: handleResponseBody,
  route: handleRoute,
  unroute: handleUnroute,
  har_start: handleHarStart,
  har_stop: handleHarStop,

  download: handleDownload,

  clipboard: handleClipboard,

  mousemove: handleMouseMove,
  mousedown: handleMouseDown,
  mouseup: handleMouseUp,
  drag: handleDrag,
  keydown: handleKeyDown,
  keyup: handleKeyUp,
  inserttext: handleInsertText,

  tab_new: handleTabNew,
  tab_list: handleTabList,
  tab_switch: handleTabSwitch,
  tab_close: handleTabClose,
  mark_tab: handleMarkTab,
  finalize_tabs: async (cmd) => {
    const data = await finalizeOwnerTabs(cmd);
    await releaseOwnerLease(cmd);
    return { id: cmd.id, success: true, data };
  },
  close_owner: async (cmd) => {
    const data = await finalizeOwnerTabs(cmd, []);
    await releaseOwnerLease(cmd);
    return { id: cmd.id, success: true, data };
  },
  release_owner_lease: async (cmd) => {
    await releaseOwnerLease(cmd);
    return { id: cmd.id, success: true, data: { released: true } };
  },

  cookies_get: handleCookiesGet,
  cookies_export_all: handleCookiesExportAll,
  cookies_set: handleCookiesSet,
  cookies_clear: handleCookiesClear,

  chain: (cmd) => handleChain(cmd, HANDLERS),

  site_mod_set: handleSiteModSet,
  site_mod_list: handleSiteModList,
  site_mod_remove: handleSiteModRemove,
  site_mod_toggle: handleSiteModToggle,
};

const UNSUPPORTED = new Set([
  "launch",
  "trace_start",
  "trace_stop",
  "state_save",
  "state_load",
  "video_start",
  "video_stop",
  "recording_start",
  "recording_stop",
  "recording_restart",
  "screencast_start",
  "screencast_stop",
  "input_mouse",
  "input_keyboard",
  "input_touch",
  "frame",
  "mainframe",
  "expose",
  "highlight",
  "dialog",
  "geolocation",
  "permissions",
  "viewport",
  "device",
  "useragent",
  "emulatemedia",
  "offline",
  "headers",
  "credentials",
  "timezone",
  "locale",
  "addscript",
  "addstyle",
  "addinitscript",
  "console",
  "errors",
  "keyboard",
  "window_new",
  "upload",
  "getbyrole",
  "getbytext",
  "getbylabel",
  "getbyplaceholder",
  "getbyalttext",
  "getbytitle",
  "getbytestid",
  "nth",
  "tap",
  "wheel",
  "multiselect",
  "selectall",
  "dispatch",
  "evalhandle",
  "pause",
  "waitforloadstate",
  "waitforfunction",
  "waitfordownload",
  "getboundingbox",
]);

async function handleCommand(message) {
  const { action, id } = message;

  if (action === "close") {
    if (typeof message.ownerId === "string" && message.ownerId.trim()) {
      await authorizeOwnerLease(message);
      const result = await finalizeOwnerTabs(message, []);
      await releaseOwnerLease(message);
      return { type: "response", id, success: true, data: result };
    }

    await closeAgentWindow();
    return { type: "response", id, success: true, data: { closed: true } };
  }

  if (action === "launch") {
    return {
      type: "response",
      id,
      success: true,
      data: { launched: true, provider: "extension" },
    };
  }

  const handler = HANDLERS[action];
  if (handler) {
    try {
      if (
        action !== "healthcheck" &&
        (message.ownerId || message.ownerLeaseId)
      ) {
        await authorizeOwnerLease(message);
      }
      const result = await handler(message);
      return { type: "response", ...result };
    } catch (err) {
      return {
        type: "response",
        id,
        success: false,
        error: err.message || String(err),
      };
    }
  }

  if (UNSUPPORTED.has(action)) {
    return {
      type: "response",
      id,
      success: false,
      error: `Command '${action}' is not supported in extension mode`,
    };
  }

  return {
    type: "response",
    id,
    success: false,
    error: `Unknown command: ${action}`,
  };
}

onCommand(handleCommand);

onStatus((connected) => {
  console.log(
    "[background] Connection status:",
    connected ? "connected" : "disconnected",
  );
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {

  }
});

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Keep service worker alive for the browser bridge",
      });
      console.log("[background] Offscreen keepalive document created");
    }
  } catch (err) {
    console.error("[background] Failed to create offscreen document:", err);
  }
}

ensureOffscreen();

cleanupStaleGroups();
cleanupStaleTabs();

chrome.alarms.create("stale-tabs", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "stale-tabs") {
    void cleanupStaleTabs();
  }
});

syncContentScriptRegistration();

const COOKIE_EVENT_DEBOUNCE_MS = 120;
const COOKIE_EVENT_MAX_BATCH = 200;
let pendingCookieChanges = [];
let cookieFlushTimer = null;

let incognitoStoreIds = new Set();
function refreshCookieStores() {
  try {
    const result = chrome.cookies.getAllCookieStores();
    if (result && typeof result.then === "function") {
      result
        .then((stores) => {
          incognitoStoreIds = new Set(
            stores.filter((s) => s.incognito === true).map((s) => s.id),
          );
        })
        .catch(() => {});
    }
  } catch {

  }
}
refreshCookieStores();

function flushCookieChanges() {
  cookieFlushTimer = null;
  if (pendingCookieChanges.length === 0) return;
  if (!isConnected()) {
    pendingCookieChanges = [];
    return;
  }
  const changes = pendingCookieChanges;
  pendingCookieChanges = [];
  send({ type: "event", event: "cookies_changed", changes });
}

function queueCookieChange(changeInfo) {

  const cookie = changeInfo?.cookie;
  if (!cookie || !cookie.name) return;

  if (cookie.storeId && incognitoStoreIds.has(cookie.storeId)) return;
  pendingCookieChanges.push({
    removed: changeInfo.removed === true,
    cause: changeInfo.cause,
    cookie,
  });
  if (pendingCookieChanges.length >= COOKIE_EVENT_MAX_BATCH) {
    if (cookieFlushTimer) {
      clearTimeout(cookieFlushTimer);
      cookieFlushTimer = null;
    }
    flushCookieChanges();
    return;
  }
  if (!cookieFlushTimer) {
    cookieFlushTimer = setTimeout(flushCookieChanges, COOKIE_EVENT_DEBOUNCE_MS);
  }
}

chrome.cookies.onChanged.addListener(queueCookieChange);

async function autoConnect() {
  console.log("[background] Auto-connecting via native messaging");
  connect();
}

autoConnect();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "connect") {
    connect();
    sendResponse({ ok: true });
  } else if (message.type === "disconnect") {
    disconnect();
    sendResponse({ ok: true });
  } else if (message.type === "getStatus") {
    sendResponse({ connected: isConnected() });
  } else if (message.type === "hookHistory" && sender.tab) {

    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: () => {
          if (window.__stellaHistoryHooked) return;
          window.__stellaHistoryHooked = true;
          const origPush = history.pushState;
          const origReplace = history.replaceState;
          history.pushState = function () {
            origPush.apply(this, arguments);
            window.dispatchEvent(new Event("stella:urlchange"));
          };
          history.replaceState = function () {
            origReplace.apply(this, arguments);
            window.dispatchEvent(new Event("stella:urlchange"));
          };
        },
      })
      .catch(() => {});
    sendResponse({ ok: true });
  }
});
