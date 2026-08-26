import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BROWSER_CHAIN_ACTIONS,
  BROWSER_PROTOCOL_ACTIONS,
} from "@stella/runtime/kernel/browser-use/client";
import { installBrowserWorkerApi } from "@stella/runtime/kernel/browser-use/worker-api";

/**
 * Contract tests binding every JS layer of the browser vocabulary to the
 * canonical manifest at packages/stella-browser/protocol/actions.json. The
 * Rust daemon is bound to the same manifest by
 * packages/stella-browser/cli/src/native/contract_tests.rs, so an action
 * added, removed, or renamed in any layer fails a test until the manifest and
 * every layer agree.
 */

const MANIFEST_PATH = fileURLToPath(
  new URL(
    "../../../../../stella-browser/protocol/actions.json",
    import.meta.url,
  ),
);

type ManifestEntry = Readonly<{
  chain: boolean;
  params: readonly string[];
  note?: string;
}>;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  globalParams: { params: readonly string[] };
  actions: Record<string, ManifestEntry>;
};

const manifestActions = new Set(Object.keys(manifest.actions));
const manifestChainActions = new Set(
  Object.entries(manifest.actions)
    .filter(([, entry]) => entry.chain === true)
    .map(([name]) => name),
);
const globalParams = new Set(manifest.globalParams.params);

const paramsOf = (action: string): Set<string> =>
  new Set(manifest.actions[action]?.params ?? []);

/**
 * SAFE_ACTION_KEYS lives inside installBrowserWorkerApi so the function stays
 * self-contained for data-URL embedding; recover the literal from its source.
 */
const extractSafeActionKeys = (): Record<string, readonly string[]> => {
  const source = installBrowserWorkerApi.toString();
  const marker = source.indexOf("SAFE_ACTION_KEYS");
  expect(marker).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf("Object.freeze(", marker));
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  const literal = source.slice(open, end + 1);
  const parsed = new Function(`return (${literal});`)() as Record<
    string,
    readonly string[]
  >;
  // Sanity: the extraction must have found the real table.
  expect(Object.keys(parsed)).toContain("navigate");
  return parsed;
};

/**
 * Every daemon action the worker API's method surface emits, mapped to the
 * param keys those methods send (tabId excluded; it is a global param). Keep
 * in sync with worker-api.ts — this is the JS-offered vocabulary outside of
 * browser.chain().
 */
const WORKER_EMITTED_COMMANDS: Record<string, readonly string[]> = {
  navigate: ["url", "waitUntil", "timeout"], // tab.goto
  back: ["timeout"],
  forward: ["timeout"],
  reload: ["timeout"],
  url: [],
  title: [],
  tab_list: [],
  tab_new: ["url"],
  tab_close: [],
  mark_tab: ["status"], // tab.markDeliverable / tab.markHandoff
  finalize_tabs: ["keep"], // browser.tabs.finalize (top-level only)
  snapshot: ["interactive", "cursor", "compact", "maxDepth", "selector"],
  screenshot: ["fullPage", "annotate", "selector", "format", "quality"],
  scroll: ["x", "y", "direction", "amount", "selector"], // tab.scroll
  evaluate: ["script"],
  evaluate_detached: ["script"],
  wait: ["selector", "timeout"], // waitFor / waitForTimeout
  waitforurl: ["url", "timeout"],
  waitforfunction: ["expression", "timeout"],
  press: ["key", "selector"], // tab.press / locator.press
  inserttext: ["text"], // tab.keyboard.type
  click: ["selector"],
  dblclick: ["selector"],
  fill: ["selector", "value"],
  type: ["selector", "text"],
  hover: ["selector"],
  focus: ["selector"],
  check: ["selector"],
  uncheck: ["selector"],
  select: ["selector", "values"], // locator.selectOption
  upload: ["selector", "files"], // locator.setInputFiles
  scrollintoview: ["selector"],
  innertext: ["selector"],
  gettext: ["selector"],
  inputvalue: ["selector"],
  getattribute: ["selector", "attribute"],
  isvisible: ["selector"],
  isenabled: ["selector"],
  ischecked: ["selector"],
  boundingbox: ["selector"],
  count: ["selector"],
  requests: ["filter", "after", "limit", "clear"],
  responsebody: ["url", "after", "timeout"],
  rewrite_request: ["url", "method", "postData", "jsonPatch", "headers"],
  unrewrite_request: ["url"],
  authenticated_request: [
    "url",
    "method",
    "headers",
    "body",
    "timeout",
    "maxBodyBytes",
  ],
  authenticated_request_batch: ["requests", "concurrency", "timeout"],
};

/**
 * Manifest actions with "chain": true that the agent-facing chain vocabulary
 * (SAFE_ACTION_KEYS) deliberately does not offer. Every omission must be
 * conscious: a new chain-capable daemon action either gets a SAFE_ACTION_KEYS
 * entry or an entry here with a reason.
 */
const CHAIN_ACTIONS_NOT_OFFERED_TO_AGENTS: Record<string, string> = {
  healthcheck: "transport-level liveness probe, not an automation step",
  content: "full-page HTML dump; snapshot/evaluate are the supported reads",
  styles: "low-level style probe superseded by evaluate",
  bringtofront: "daemon-internal focus management",
  clear: "locator.fill('') covers it; no locator method emits clear",
  route: "rewrites responses; deliberately kept away from agents",
  unroute: "rewrites responses; deliberately kept away from agents",
  clipboard: "raw clipboard access is not agent vocabulary",
  cookies_get: "raw session secrets stay out of the worker",
  cookies_set: "raw session secrets stay out of the worker",
  cookies_clear: "raw session secrets stay out of the worker",
  drag: "mouse/HTML5 drag still needs a curated API before agent exposure",
  keydown: "half-press primitives; tab.press covers the supported use",
  keyup: "half-press primitives; tab.press covers the supported use",
  mousemove: "raw pointer primitives; locator actions cover the use cases",
  mousedown: "raw pointer primitives; locator actions cover the use cases",
  mouseup: "raw pointer primitives; locator actions cover the use cases",
  inserttext:
    "exposed as tab.keyboard.type (direct command), not as a chain step",
};

describe("browser action contract (manifest <-> JS layers)", () => {
  it("client BROWSER_CHAIN_ACTIONS matches the manifest chain vocabulary exactly", () => {
    const client = new Set<string>(BROWSER_CHAIN_ACTIONS);
    expect(
      [...client].filter((action) => !manifestChainActions.has(action)),
    ).toEqual([]);
    expect(
      [...manifestChainActions].filter((action) => !client.has(action)),
    ).toEqual([]);
  });

  it("client protocol-only actions are top-level manifest actions", () => {
    const chainSet = new Set<string>(BROWSER_CHAIN_ACTIONS);
    const protocolOnly = BROWSER_PROTOCOL_ACTIONS.filter(
      (action) => !chainSet.has(action),
    );
    expect(protocolOnly.sort()).toEqual([
      "authenticated_request",
      "authenticated_request_batch",
      "close_owner",
      "evaluate_detached",
      "finalize_tabs",
      "mark_tab",
      "release_owner_lease",
      "rewrite_request",
      "unrewrite_request",
    ]);
    for (const action of protocolOnly) {
      expect(
        manifestActions.has(action),
        `${action} missing from manifest`,
      ).toBe(true);
      expect(
        manifest.actions[action]!.chain,
        `${action} must be top-level only`,
      ).toBe(false);
    }
  });

  it("SAFE_ACTION_KEYS offers only manifest chain actions with manifest-compatible params", () => {
    const safeActionKeys = extractSafeActionKeys();
    for (const [action, keys] of Object.entries(safeActionKeys)) {
      expect(
        manifestChainActions.has(action),
        `SAFE_ACTION_KEYS offers '${action}', which is not a chain-capable manifest action`,
      ).toBe(true);
      const allowed = paramsOf(action);
      for (const key of keys) {
        expect(
          allowed.has(key) || globalParams.has(key),
          `SAFE_ACTION_KEYS['${action}'] allows param '${key}' the manifest does not list`,
        ).toBe(true);
      }
    }
    // Chains built by the worker are validated again by the client; every
    // agent-offered chain action must survive that validation.
    const clientChain = new Set<string>(BROWSER_CHAIN_ACTIONS);
    for (const action of Object.keys(safeActionKeys)) {
      expect(
        clientChain.has(action),
        `SAFE_ACTION_KEYS offers '${action}' but BROWSER_CHAIN_ACTIONS would reject it`,
      ).toBe(true);
    }
  });

  it("every manifest chain action is either agent-offered or consciously excluded", () => {
    const safeActionKeys = extractSafeActionKeys();
    const offered = new Set(Object.keys(safeActionKeys));
    const excluded = new Set(Object.keys(CHAIN_ACTIONS_NOT_OFFERED_TO_AGENTS));
    for (const action of manifestChainActions) {
      expect(
        offered.has(action) || excluded.has(action),
        `manifest chain action '${action}' is neither in SAFE_ACTION_KEYS nor in the explicit not-offered list`,
      ).toBe(true);
      expect(
        !(offered.has(action) && excluded.has(action)),
        `'${action}' is both offered and marked not-offered`,
      ).toBe(true);
    }
    // The exclusion list must not drift either: no stale entries.
    for (const action of excluded) {
      expect(
        manifestChainActions.has(action),
        `not-offered entry '${action}' is no longer a manifest chain action`,
      ).toBe(true);
    }
  });

  it("every action the worker API emits exists in the manifest with compatible params", () => {
    for (const [action, keys] of Object.entries(WORKER_EMITTED_COMMANDS)) {
      expect(
        manifestActions.has(action),
        `worker API emits '${action}', which is not in the manifest`,
      ).toBe(true);
      const allowed = paramsOf(action);
      for (const key of keys) {
        expect(
          allowed.has(key) || globalParams.has(key),
          `worker API sends param '${key}' for '${action}' that the manifest does not list`,
        ).toBe(true);
      }
      // Everything the worker can emit must pass the client allowlist.
      expect(
        (BROWSER_PROTOCOL_ACTIONS as readonly string[]).includes(action),
        `worker API emits '${action}' but the client transport would reject it`,
      ).toBe(true);
    }
  });

  it("retired vocabulary stays retired", () => {
    // 'open' was an extension-era alias for navigate that the CDP daemon
    // never implemented; site_mod_* are extension-only credential-seeding
    // helpers. None of them belong to the CDP contract.
    for (const action of [
      "open",
      "site_mod_set",
      "site_mod_list",
      "site_mod_remove",
      "site_mod_toggle",
    ]) {
      expect(manifestActions.has(action)).toBe(false);
      expect(
        (BROWSER_PROTOCOL_ACTIONS as readonly string[]).includes(action),
      ).toBe(false);
    }
    // finalize_tabs is top-level-only: offering it as a chain step would be
    // rejected by both the client and the daemon.
    expect(extractSafeActionKeys()).not.toHaveProperty("finalize_tabs");
  });
});
