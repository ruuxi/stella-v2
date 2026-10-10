/**
 * The browser protocol vocabulary and the argument rules both sides of the
 * code browser API enforce: `BrowserSession` (client.ts), which talks to the
 * daemon, and the Node REPL worker's `browser` object (worker-api.ts), which
 * agents call. The worker side is bundled into an eval worker
 * (worker-api-source.ts), so this module must stay import-free.
 */

export const MAX_BROWSER_CHAIN_STEPS = 100;
export const MAX_BROWSER_CHAIN_TIMEOUT_MS = 4 * 60_000;
/** Ceiling for a chain's per-selector wait (`waitTimeout`). */
export const MAX_BROWSER_CHAIN_WAIT_TIMEOUT_MS = 120_000;
/** Delay between chain steps when a caller asks for one without bounds. */
export const DEFAULT_BROWSER_CHAIN_DELAY_MIN_MS = 300;
export const DEFAULT_BROWSER_CHAIN_DELAY_MAX_MS = 1_200;

/** Backend a worker-issued command is bound to; stripped before the daemon. */
export const WORKER_BOUND_BACKEND_PARAM = "__stellaBrowserBackend";

// Contract-checked against packages/stella-browser/protocol/actions.json
// ("chain": true) by tests/runtime/kernel/browser-use/action-contract.test.ts:
// adding, removing, or renaming an entry fails that test until the manifest
// and the Rust daemon (is_chain_allowed_action) agree.
export const BROWSER_CHAIN_ACTIONS = [
  "healthcheck",
  "navigate",
  "back",
  "forward",
  "reload",
  "url",
  "title",
  "click",
  "fill",
  "type",
  "hover",
  "select",
  "press",
  "scroll",
  "clear",
  "check",
  "uncheck",
  "focus",
  "dblclick",
  "wait",
  "screenshot",
  "snapshot",
  "content",
  "evaluate",
  "gettext",
  "getattribute",
  "innertext",
  "innerhtml",
  "inputvalue",
  "boundingbox",
  "scrollintoview",
  "isvisible",
  "isenabled",
  "ischecked",
  "count",
  "styles",
  "waitforurl",
  "waitforfunction",
  "bringtofront",
  "requests",
  "responsebody",
  "route",
  "unroute",
  "har_start",
  "har_stop",
  "clipboard",
  "mousemove",
  "mousedown",
  "mouseup",
  "drag",
  "keydown",
  "keyup",
  "inserttext",
  "tab_new",
  "tab_list",
  "tab_switch",
  "tab_close",
  "cookies_get",
  "cookies_set",
  "cookies_clear",
  "upload",
] as const;

export const BROWSER_PROTOCOL_ACTIONS = [
  ...BROWSER_CHAIN_ACTIONS,
  "authenticated_request",
  "authenticated_request_batch",
  "evaluate_detached",
  "rewrite_request",
  "unrewrite_request",
  "mark_tab",
  "finalize_tabs",
  "close_owner",
  "release_owner_lease",
] as const;

export type BrowserChainAction = (typeof BROWSER_CHAIN_ACTIONS)[number];
export type BrowserProtocolAction = (typeof BROWSER_PROTOCOL_ACTIONS)[number];
/**
 * Host-adapted interaction requests exposed by the code browser API. They are
 * deliberately outside the local daemon protocol manifest: a desktop browser
 * session rejects them, while a trusted cloud adapter maps them to its private
 * gateway contract. The agent loop binds a returned neutral suspension to the
 * active outer Code tool call; the gateway never receives that outer id.
 */
export const CLOUD_BROWSER_SESSION_ACTIONS = [
  "cloud_login_takeover",
  "cloud_device_code_fixture",
] as const;
export type CloudBrowserSessionAction =
  (typeof CLOUD_BROWSER_SESSION_ACTIONS)[number];
export type BrowserSessionAction =
  | BrowserProtocolAction
  | CloudBrowserSessionAction;

export const requirePositiveInteger = (
  value: unknown,
  name: string,
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
};

export const requireNonNegativeInteger = (
  value: unknown,
  name: string,
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
};
