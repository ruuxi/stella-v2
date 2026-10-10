/**
 * `browser.chain()` input: the step vocabulary agents may use and the
 * options the session accepts, checked before the chain leaves the worker.
 */

import type {
  BrowserWorkerBackend,
  BrowserWorkerChainOptions,
  BrowserWorkerChainStep,
} from "../worker-api.js";
import {
  DEFAULT_BROWSER_CHAIN_DELAY_MAX_MS,
  DEFAULT_BROWSER_CHAIN_DELAY_MIN_MS,
  MAX_BROWSER_CHAIN_TIMEOUT_MS,
  MAX_BROWSER_CHAIN_WAIT_TIMEOUT_MS,
  requireNonNegativeInteger,
  requirePositiveInteger,
  type BrowserChainAction,
} from "../protocol.js";
import { isLegacyTabGeneration, type BrowserWorkerContext } from "./context.js";
import {
  assertKnownKeys,
  isPlainObject,
  requireOptions,
  requireString,
  safeJsonValue,
} from "./validation.js";

// Chain-step vocabulary offered to agents: a deliberate subset of the
// session's BROWSER_CHAIN_ACTIONS, which the `satisfies` below enforces at
// compile time. Contract-checked against
// packages/stella-browser/protocol/actions.json by
// tests/runtime/kernel/browser-use/action-contract.test.ts: every action
// here must be a manifest action with "chain": true, and every key must be
// a manifest param (or the global tabId). finalize_tabs is deliberately
// absent: it is top-level-only on the daemon and exposed as
// browser.tabs.finalize() instead.
const SAFE_ACTION_KEYS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    navigate: ["tabId", "url", "waitUntil", "timeout"],
    back: ["tabId", "timeout"],
    forward: ["tabId", "timeout"],
    reload: ["tabId", "timeout"],
    tab_list: [],
    tab_new: ["url"],
    tab_switch: ["tabId"],
    tab_close: ["tabId"],
    url: ["tabId"],
    title: ["tabId"],
    snapshot: [
      "tabId",
      "interactive",
      "cursor",
      "maxDepth",
      "compact",
      "selector",
    ],
    screenshot: [
      "tabId",
      "fullPage",
      "selector",
      "format",
      "quality",
      "annotate",
    ],
    evaluate: ["tabId", "script"],
    click: ["tabId", "selector"],
    dblclick: ["tabId", "selector"],
    fill: ["tabId", "selector", "value"],
    type: ["tabId", "selector", "text"],
    press: ["tabId", "selector", "key"],
    hover: ["tabId", "selector"],
    focus: ["tabId", "selector"],
    check: ["tabId", "selector"],
    uncheck: ["tabId", "selector"],
    select: ["tabId", "selector", "values"],
    upload: ["tabId", "selector", "files"],
    scroll: ["tabId", "selector", "x", "y", "direction", "amount"],
    scrollintoview: ["tabId", "selector"],
    wait: ["tabId", "selector", "timeout"],
    waitforurl: ["tabId", "url", "timeout"],
    waitforfunction: ["tabId", "expression", "timeout"],
    gettext: ["tabId", "selector"],
    innertext: ["tabId", "selector"],
    innerhtml: ["tabId", "selector"],
    inputvalue: ["tabId", "selector"],
    getattribute: ["tabId", "selector", "attribute"],
    count: ["tabId", "selector"],
    boundingbox: ["tabId", "selector"],
    isvisible: ["tabId", "selector"],
    isenabled: ["tabId", "selector"],
    ischecked: ["tabId", "selector"],
    // Network observation. These read traffic the tab was already going to
    // make, which is what lets a caller derive a direct API client for a site
    // instead of re-driving the UI on every run. Deliberately excluded:
    // `route`/`unroute` (they rewrite responses) and `cookies_*` (raw session
    // secrets). Authenticated calls are made from the page's own origin with
    // `evaluate`, so no credential ever has to cross into the worker.
    requests: ["tabId", "filter", "clear", "after", "limit"],
    responsebody: ["tabId", "url", "timeout", "after"],
    har_start: ["tabId"],
    har_stop: ["tabId", "path"],
  } satisfies Partial<Record<BrowserChainAction, readonly string[]>>);

const NON_TAB_ACTIONS = Object.freeze(new Set(["tab_list", "tab_new"]));

const boundedPositiveInteger = (
  value: unknown,
  name: string,
  maximum: number,
): number => {
  const integer = requirePositiveInteger(value, name);
  if (integer > maximum) {
    throw new RangeError(`${name} must be at most ${maximum}.`);
  }
  return integer;
};

export const sanitizeChainStep = (
  {
    assertCurrentTabGeneration,
    normalizeTabGeneration,
  }: Pick<
    BrowserWorkerContext,
    "assertCurrentTabGeneration" | "normalizeTabGeneration"
  >,
  value: unknown,
  index: number,
  backend: BrowserWorkerBackend,
): BrowserWorkerChainStep => {
  if (!isPlainObject(value)) {
    throw new TypeError(`steps[${index}] must be an action object.`);
  }
  assertKnownKeys(value, ["action", "params"], `steps[${index}]`);
  const action = requireString(value.action, `steps[${index}].action`);
  if (action === "chain") {
    throw new TypeError(`steps[${index}] must not contain a nested chain.`);
  }
  const allowed = SAFE_ACTION_KEYS[action];
  if (!allowed) {
    throw new TypeError(`steps[${index}] uses unsupported action '${action}'.`);
  }
  const params = requireOptions(value.params, `steps[${index}].params`);
  assertKnownKeys(
    params,
    [...allowed, "tabGeneration"],
    `steps[${index}].params`,
  );
  const clean = safeJsonValue(params, `steps[${index}].params`) as Record<
    string,
    unknown
  >;
  if (!NON_TAB_ACTIONS.has(action)) {
    const tabId = requirePositiveInteger(
      clean.tabId,
      `steps[${index}].params.tabId`,
    );
    clean.tabId = tabId;
    const generation = normalizeTabGeneration(
      clean.tabGeneration,
      tabId,
      `steps[${index}].params.tabGeneration`,
      backend,
    );
    assertCurrentTabGeneration(tabId, generation, backend);
    if (!isLegacyTabGeneration(generation)) {
      clean.tabGeneration = generation;
    } else {
      delete clean.tabGeneration;
    }
  }
  return Object.freeze({ action, params: Object.freeze(clean) });
};

export const sanitizeChainOptions = (
  rawOptions: unknown,
): BrowserWorkerChainOptions => {
  const value = requireOptions(rawOptions, "chain options");
  assertKnownKeys(
    value,
    [
      "timeout",
      "delay",
      "waitForSelector",
      "waitTimeout",
      "abortOnError",
      "returnSnapshot",
      "returnScreenshot",
    ],
    "chain options",
  );
  const result: Record<string, unknown> = {};
  // Numeric rules match BrowserSession's validateChainOptions, which
  // re-checks these after the kernel maps them to timeoutMs/waitTimeoutMs.
  if (value.timeout !== undefined) {
    result.timeout = boundedPositiveInteger(
      value.timeout,
      "timeout",
      MAX_BROWSER_CHAIN_TIMEOUT_MS,
    );
  }
  for (const key of [
    "waitForSelector",
    "abortOnError",
    "returnSnapshot",
    "returnScreenshot",
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") {
      throw new TypeError(`${key} must be a boolean.`);
    }
    result[key] = value[key];
  }
  if (value.waitTimeout !== undefined) {
    result.waitTimeout = boundedPositiveInteger(
      value.waitTimeout,
      "waitTimeout",
      MAX_BROWSER_CHAIN_WAIT_TIMEOUT_MS,
    );
  }
  if (value.delay !== undefined) {
    const delayOptions = requireOptions(value.delay, "chain delay");
    assertKnownKeys(delayOptions, ["min", "max"], "chain delay");
    const min = requireNonNegativeInteger(
      delayOptions.min ?? DEFAULT_BROWSER_CHAIN_DELAY_MIN_MS,
      "delay.min",
    );
    const max = requireNonNegativeInteger(
      delayOptions.max ?? DEFAULT_BROWSER_CHAIN_DELAY_MAX_MS,
      "delay.max",
    );
    if (min > max) throw new RangeError("delay.min must not exceed delay.max.");
    result.delay = Object.freeze({ min, max });
  }
  return Object.freeze(result) as BrowserWorkerChainOptions;
};
