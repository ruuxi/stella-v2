/**
 * Tab handles and `browser.tabs`: every handle is bound to one backend and
 * one tab generation, so a numeric tab id reused by the browser can never be
 * driven through a stale handle.
 */

import type {
  BrowserWorkerAxObservation,
  BrowserWorkerAxSnapshotOptions,
  BrowserWorkerBackend,
  BrowserWorkerKeyboard,
  BrowserWorkerNetwork,
  BrowserWorkerPlaywright,
  BrowserWorkerScreenshotReceipt,
  BrowserWorkerTab,
  BrowserWorkerTabs,
} from "../worker-api.js";
import {
  requirePositiveInteger,
  type BrowserProtocolAction,
} from "../protocol.js";
import {
  delay,
  exposePublicApi,
  field,
  fieldOrSelf,
  isLegacyTabGeneration,
  numberField,
  stringField,
  tabGenerationParams,
  type BrowserWorkerContext,
} from "./context.js";
import type { BrowserWorkerLocators } from "./locators.js";
import { createTabNetwork } from "./network.js";
import {
  assertKnownKeys,
  functionSource,
  isPlainObject,
  pageEvaluateScript,
  requireFiniteNonNegative,
  requireOptions,
  requireSelectorText,
  requireString,
  screenshotParams,
  snapshotParams,
  timeoutParam,
} from "./validation.js";

const DEFAULT_EXPECT_NEW_TAB_TIMEOUT_MS = 10_000;

type TabState = {
  backend: BrowserWorkerBackend;
  id: number;
  generation: string;
  url: string;
  title: string;
  active: boolean;
  playwright?: BrowserWorkerPlaywright;
  keyboard?: BrowserWorkerKeyboard;
  network?: BrowserWorkerNetwork;
  ax?: {
    pending: Promise<void>;
    baseline?: Readonly<{
      snapshotId: string;
      documentKey: string;
      optionsKey: string;
      snapshot: string;
    }>;
  };
};

// Runs inside the persistent Node worker, never the Electron renderer. The
// matrix budget bounds work even if a backend returns an unusually deep tree.
const axLineDiff = (before: string, after: string): string | null => {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) return null;
  const width = b.length + 1;
  const lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const edits: {
    prefix: " " | "-" | "+";
    text: string;
    oldLine: number;
    newLine: number;
  }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const oldLine = i + 1;
    const newLine = j + 1;
    if (i < a.length && j < b.length && a[i] === b[j]) {
      edits.push({ prefix: " ", text: a[i], oldLine, newLine });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j === b.length ||
        lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    ) {
      edits.push({ prefix: "-", text: a[i], oldLine, newLine });
      i += 1;
    } else {
      edits.push({ prefix: "+", text: b[j], oldLine, newLine });
      j += 1;
    }
  }
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < edits.length; index += 1) {
    if (edits[index].prefix === " ") continue;
    const start = Math.max(0, index - 2);
    const end = Math.min(edits.length, index + 3);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges
    .map(({ start, end }) => {
      const lines = edits.slice(start, end);
      const oldCount = lines.filter((line) => line.prefix !== "+").length;
      const newCount = lines.filter((line) => line.prefix !== "-").length;
      const first = edits[start];
      const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
      const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
      return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.map((line) => line.prefix + line.text).join("\n")}`;
    })
    .join("\n");
};

const TAB_PUBLIC_API = Object.freeze([
  "backend",
  "id",
  "generation",
  "playwright",
  "keyboard",
  "network",
  "press",
  "goto",
  "back",
  "forward",
  "reload",
  "close",
  "markDeliverable",
  "markHandoff",
  "url",
  "title",
  "snapshot",
  "axSnapshot",
  "screenshot",
  "scroll",
  "expectNewTab",
] as const);

type NormalizedTabList = {
  tabs: readonly BrowserWorkerTab[];
  activeTabId?: number;
};

// The worker only sees payloads, so backend problems surface here as shape
// mismatches. Two distinct failure modes get distinct messages: a payload
// that identifies tabs only by position comes from a backend that predates
// stable tab ids (fix: update the Stella Browser daemon/extension), while
// any other malformed payload is a protocol drift between backend and
// runtime (fix: update Stella so both sides match). Neither is fixed by
// "update the extension" alone — the in-app CDP daemon speaks the same
// protocol.
const browserProtocolMismatch = (detail: string): Error =>
  new Error(
    `Stella Browser protocol mismatch: ${detail}. The connected browser backend (in-app browser daemon or extension) returned a payload shape this runtime cannot drive. Update Stella so the browser backend and runtime versions match.`,
  );

const browserLegacyIndexOnlyTabs = (detail: string): Error =>
  new Error(
    `Stella Browser protocol mismatch: ${detail}. The backend identified tabs only by position ('index'), which is not stable across tab changes; this browser backend predates stable tab ids. Update the Stella Browser backend to a version that reports 'tabId'.`,
  );

const normalizeTabId = (value: unknown, name: string): number => {
  const numeric =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return requirePositiveInteger(numeric, name);
};

export const createTabs = (
  context: BrowserWorkerContext,
  { locatorBuilders }: BrowserWorkerLocators,
  expectNewTabLimit: number,
): BrowserWorkerTabs => {
  const {
    assertCurrentTabGeneration,
    command,
    normalizeTabGeneration,
    rememberTabGeneration,
  } = context;
  let nextAxSnapshot = 1;
  const currentTabId = (state: TabState): number => {
    assertCurrentTabGeneration(state.id, state.generation, state.backend);
    return state.id;
  };

  const tabState = new WeakMap<object, TabState>();
  const tabCache = new Map<string, WeakRef<BrowserWorkerTab>>();
  const tabFinalizer = new FinalizationRegistry<{
    key: string;
    reference: WeakRef<BrowserWorkerTab>;
  }>(({ key, reference }) => {
    if (tabCache.get(key) === reference) tabCache.delete(key);
  });

  const updateTabMetadata = (
    tab: BrowserWorkerTab,
    metadata: Record<string, unknown>,
  ): void => {
    const state = tabState.get(tab as object);
    if (!state) return;
    if (typeof metadata.url === "string") state.url = metadata.url;
    if (typeof metadata.title === "string") state.title = metadata.title;
    if (typeof metadata.active === "boolean") state.active = metadata.active;
  };

  const getTab = (
    idValue: unknown,
    metadata: Record<string, unknown> = {},
    backend: BrowserWorkerBackend = context.selectedBackend,
  ): BrowserWorkerTab => {
    const id = normalizeTabId(idValue, "tab id");
    const generation = normalizeTabGeneration(
      metadata.tabGeneration,
      id,
      "tab generation",
      backend,
    );
    rememberTabGeneration(backend, id, generation);
    const key = `${backend}:${id}:${generation}`;
    const existing = tabCache.get(key)?.deref();
    if (existing) {
      updateTabMetadata(existing, metadata);
      return existing;
    }
    const tab = new Tab({
      backend,
      id,
      generation,
      url: typeof metadata.url === "string" ? metadata.url : "",
      title: typeof metadata.title === "string" ? metadata.title : "",
      active: metadata.active === true,
    });
    const reference = new WeakRef(tab);
    tabCache.set(key, reference);
    tabFinalizer.register(tab, { key, reference });
    return tab;
  };

  const listTabsInternal = async (
    backend: BrowserWorkerBackend = context.selectedBackend,
  ): Promise<NormalizedTabList> => {
    const data = await command("tab_list", {}, backend);
    const rawTabs = Array.isArray(data)
      ? data
      : Array.isArray(field(data, "tabs"))
        ? (field(data, "tabs") as unknown[])
        : null;
    if (!rawTabs) {
      throw browserProtocolMismatch("tab_list returned no tabs array");
    }
    const activeRaw = field(data, "activeTabId");
    const activeIndex = numberField(data, "active", -1);
    const tabs: BrowserWorkerTab[] = [];
    let activeTabId: number | undefined;
    for (let index = 0; index < rawTabs.length; index += 1) {
      const item = rawTabs[index];
      if (!isPlainObject(item)) {
        throw browserProtocolMismatch(
          `tab_list tabs[${index}] is not an object`,
        );
      }
      const rawId = item.tabId ?? item.id;
      try {
        const id = normalizeTabId(rawId, `tabs[${index}].tabId`);
        const active =
          item.active === true ||
          item.selected === true ||
          index === activeIndex ||
          Number(activeRaw) === id;
        const tab = getTab(id, { ...item, active }, backend);
        tabs.push(tab);
        if (active) activeTabId = id;
      } catch (error) {
        const detail = `tab_list tabs[${index}] has no stable positive tabId (${error instanceof Error ? error.message : String(error)})`;
        if (rawId === undefined && typeof item.index === "number") {
          throw browserLegacyIndexOnlyTabs(detail);
        }
        throw browserProtocolMismatch(detail);
      }
    }
    return Object.freeze({
      tabs: Object.freeze(tabs),
      ...(activeTabId === undefined ? {} : { activeTabId }),
    });
  };

  const expectNewTab = async (
    action: () => unknown | Promise<unknown>,
    rawOptions: Readonly<{ timeoutMs?: number }> = {},
    backend: BrowserWorkerBackend = context.selectedBackend,
  ): Promise<BrowserWorkerTab> => {
    if (typeof action !== "function") {
      throw new TypeError("expectNewTab action must be a function.");
    }
    const value = requireOptions(rawOptions, "expectNewTab options");
    assertKnownKeys(value, ["timeoutMs"], "expectNewTab options");
    const timeoutMs = timeoutParam(
      value.timeoutMs ?? DEFAULT_EXPECT_NEW_TAB_TIMEOUT_MS,
      "timeoutMs",
      expectNewTabLimit,
    );
    const before = await listTabsInternal(backend);
    const previousHandles = new Set(
      before.tabs.map((tab) => `${tab.id}:${tab.generation}`),
    );
    await action();
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const current = await listTabsInternal(backend);
      const added = current.tabs.filter(
        (tab) => !previousHandles.has(`${tab.id}:${tab.generation}`),
      );
      if (added.length === 1) return added[0]!;
      if (added.length > 1) {
        throw new Error(
          `expectNewTab observed ${added.length} new owned tabs; expected exactly one.`,
        );
      }
      await delay(
        Math.min(50, Math.max(1, timeoutMs - (Date.now() - startedAt))),
      );
    }
    throw new Error(`Timeout waiting ${timeoutMs}ms for a newly adopted tab.`);
  };

  class Tab implements BrowserWorkerTab {
    constructor(state: TabState) {
      tabState.set(this, state);
      exposePublicApi(this, TAB_PUBLIC_API);
      Object.freeze(this);
    }

    private state(): TabState {
      const state = tabState.get(this);
      if (!state) throw new Error("Invalid Tab object.");
      assertCurrentTabGeneration(state.id, state.generation, state.backend);
      return state;
    }

    get id(): number {
      return this.state().id;
    }

    get backend(): BrowserWorkerBackend {
      return this.state().backend;
    }

    get generation(): string {
      return this.state().generation;
    }

    private async run(
      action: BrowserProtocolAction,
      params: Record<string, unknown>,
    ): Promise<unknown> {
      return await command(action, params, this.state().backend);
    }

    get playwright(): BrowserWorkerPlaywright {
      const state = this.state();
      if (state.playwright) return state.playwright;
      const boundCommand = (
        action: BrowserProtocolAction,
        params: Record<string, unknown>,
      ) => command(action, params, state.backend);
      const builders = locatorBuilders(
        state.backend,
        currentTabId(state),
        state.generation,
      );
      state.playwright = Object.freeze({
        domSnapshot: async (rawOptions?: Record<string, unknown>) => {
          const data = await boundCommand(
            "snapshot",
            snapshotParams(currentTabId(state), rawOptions),
          );
          return fieldOrSelf(data, "snapshot");
        },
        evaluate: async function (
          pageFunction: string | ((arg?: unknown) => unknown),
          arg?: unknown,
        ) {
          const script = pageEvaluateScript(
            pageFunction,
            arg,
            arguments.length >= 2,
          );
          const data = await boundCommand("evaluate", {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            script,
          });
          return fieldOrSelf(data, "result");
        },
        ...builders,
        waitForURL: async (
          url: string,
          rawOptions: Readonly<{ timeout?: number }> = {},
        ) => {
          const value = requireOptions(rawOptions, "waitForURL options");
          assertKnownKeys(value, ["timeout"], "waitForURL options");
          const params: Record<string, unknown> = {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            url: requireSelectorText(url, "url"),
          };
          if (value.timeout !== undefined) {
            params.timeout = timeoutParam(value.timeout, "timeout");
          }
          const data = await boundCommand("waitforurl", params);
          return stringField(data, "url", typeof data === "string" ? data : "");
        },
        waitForFunction: async (
          pageFunction: string | (() => unknown),
          rawOptions: Readonly<{ timeout?: number }> = {},
        ) => {
          const value = requireOptions(rawOptions, "waitForFunction options");
          assertKnownKeys(value, ["timeout"], "waitForFunction options");
          const expression =
            typeof pageFunction === "function"
              ? `(${functionSource(pageFunction, "pageFunction")})()`
              : functionSource(pageFunction, "pageFunction");
          const timeout = timeoutParam(
            value.timeout ?? 30_000,
            "timeout",
            600_000,
          );
          const params: Record<string, unknown> = {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            expression,
            timeout,
          };
          if (state.backend === "external") {
            const startedAt = Date.now();
            while (Date.now() - startedAt <= timeout) {
              const data = await boundCommand("evaluate", {
                tabId: currentTabId(state),
                ...tabGenerationParams(state.generation),
                script: `Boolean(${expression})`,
              });
              if (fieldOrSelf(data, "result")) return true;
              await delay(
                Math.min(100, Math.max(1, timeout - (Date.now() - startedAt))),
              );
            }
            throw new Error(`Timeout waiting ${timeout}ms for page function.`);
          }
          const data = await boundCommand("waitforfunction", params);
          return fieldOrSelf(data, "result");
        },
        schedule: async function (
          pageFunction: string | ((arg?: unknown) => unknown),
          arg?: unknown,
        ) {
          const script = pageEvaluateScript(
            pageFunction,
            arg,
            arguments.length >= 2,
          );
          await boundCommand(
            state.backend === "external" ? "evaluate" : "evaluate_detached",
            {
              tabId: currentTabId(state),
              ...tabGenerationParams(state.generation),
              script:
                state.backend === "external"
                  ? `(() => { void Promise.resolve().then(() => (${script})); return true; })()`
                  : script,
            },
          );
        },
        waitForTimeout: async (ms: number) => {
          await boundCommand("wait", {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            timeout: timeoutParam(ms, "ms"),
          });
        },
        expectNewTab: async (
          action: () => unknown | Promise<unknown>,
          rawOptions?: Readonly<{ timeoutMs?: number }>,
        ) => await expectNewTab(action, rawOptions, state.backend),
      });
      return state.playwright;
    }

    get network(): BrowserWorkerNetwork {
      const state = this.state();
      if (state.network) return state.network;
      state.network = createTabNetwork(
        (action, params) => command(action, params, state.backend),
        () => ({
          tabId: currentTabId(state),
          ...tabGenerationParams(state.generation),
        }),
      );
      return state.network;
    }

    get keyboard(): BrowserWorkerKeyboard {
      const state = this.state();
      if (state.keyboard) return state.keyboard;
      const boundCommand = (
        action: BrowserProtocolAction,
        params: Record<string, unknown>,
      ) => command(action, params, state.backend);
      state.keyboard = Object.freeze({
        // Page-level key press (no selector): the key goes to whatever holds
        // focus, or the document. Supports combos like "Control+a".
        press: async (key: string) =>
          await boundCommand("press", {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            key: requireString(key, "key", { maxLength: 64 }),
          }),
        // Raw text insertion at the current focus (Input.insertText): no
        // per-character key events, works for emoji/CJK.
        type: async (text: string) =>
          await boundCommand("inserttext", {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            text: requireString(text, "text", { allowEmpty: true }),
          }),
      });
      return state.keyboard;
    }

    async press(key: string): Promise<unknown> {
      return await this.keyboard.press(key);
    }

    async goto(
      url: string,
      rawOptions: Record<string, unknown> = {},
    ): Promise<unknown> {
      const value = requireOptions(rawOptions, "goto options");
      assertKnownKeys(value, ["waitUntil", "timeout"], "goto options");
      const params: Record<string, unknown> = {
        tabId: this.id,
        url: requireString(url, "url", { maxLength: 16_384 }),
      };
      if (value.waitUntil !== undefined) {
        params.waitUntil = requireString(value.waitUntil, "waitUntil");
      }
      if (value.timeout !== undefined) {
        params.timeout = timeoutParam(value.timeout, "timeout");
      }
      const data = await this.run("navigate", params);
      if (isPlainObject(data)) updateTabMetadata(this, data);
      return data;
    }

    private async navigateHistory(
      action: "back" | "forward" | "reload",
      rawOptions: Record<string, unknown> = {},
    ): Promise<unknown> {
      const value = requireOptions(rawOptions, `${action} options`);
      assertKnownKeys(value, ["timeout"], `${action} options`);
      const params: Record<string, unknown> = { tabId: this.id };
      if (value.timeout !== undefined) {
        params.timeout = timeoutParam(value.timeout, "timeout");
      }
      const data = await this.run(action, params);
      if (isPlainObject(data)) updateTabMetadata(this, data);
      return data;
    }

    async back(options?: Record<string, unknown>): Promise<unknown> {
      return await this.navigateHistory("back", options);
    }

    async forward(options?: Record<string, unknown>): Promise<unknown> {
      return await this.navigateHistory("forward", options);
    }

    async reload(options?: Record<string, unknown>): Promise<unknown> {
      return await this.navigateHistory("reload", options);
    }

    async close(): Promise<unknown> {
      return await this.run("tab_close", { tabId: this.id });
    }

    async markDeliverable(): Promise<unknown> {
      return await this.run("mark_tab", {
        tabId: this.id,
        status: "deliverable",
      });
    }

    async markHandoff(): Promise<unknown> {
      return await this.run("mark_tab", {
        tabId: this.id,
        status: "handoff",
      });
    }

    async url(): Promise<string> {
      const data = await this.run("url", { tabId: this.id });
      const url = stringField(
        data,
        "url",
        typeof data === "string" ? data : "",
      );
      this.state().url = url;
      return url;
    }

    async title(): Promise<string> {
      const data = await this.run("title", { tabId: this.id });
      const title = stringField(
        data,
        "title",
        typeof data === "string" ? data : "",
      );
      this.state().title = title;
      return title;
    }

    async snapshot(rawOptions?: Record<string, unknown>): Promise<unknown> {
      const data = await this.run(
        "snapshot",
        snapshotParams(this.id, rawOptions),
      );
      return fieldOrSelf(data, "snapshot");
    }

    async axSnapshot(
      rawOptions: BrowserWorkerAxSnapshotOptions = {},
    ): Promise<BrowserWorkerAxObservation> {
      const value = requireOptions(rawOptions, "AX snapshot options");
      assertKnownKeys(
        value,
        ["mode", "interactive", "compact", "maxDepth", "selector"],
        "AX snapshot options",
      );
      const mode = value.mode ?? "auto";
      if (mode !== "auto" && mode !== "full" && mode !== "diff") {
        throw new TypeError(
          "AX snapshot mode must be 'auto', 'full', or 'diff'.",
        );
      }
      const state = this.state();
      const { mode: _mode, ...captureOptions } = value;
      const params = snapshotParams(currentTabId(state), {
        interactive: false,
        compact: false,
        ...captureOptions,
      });
      const optionsKey = JSON.stringify(params);
      const cache = (state.ax ??= { pending: Promise.resolve() });
      // Concurrent callers consume a single ordered baseline, never both a
      // predecessor that has already been replaced by a later observation.
      const capture = cache.pending.then(
        async (): Promise<BrowserWorkerAxObservation> => {
          try {
            currentTabId(state);
            const data = await command(
              "snapshot",
              {
                ...params,
                format: "ax",
                ...tabGenerationParams(state.generation),
              },
              state.backend,
            );
            currentTabId(state);
            if (
              !isPlainObject(data) ||
              typeof data.snapshot !== "string" ||
              typeof data.documentKey !== "string" ||
              !data.documentKey
            ) {
              throw new Error(
                "AX snapshot backend did not return a tree and document identity. Update the browser backend.",
              );
            }
            if (
              data.snapshot.length > 100_000 ||
              data.documentKey.length > 100_000
            ) {
              throw new Error(
                "AX snapshot backend exceeded its bounded observation budget.",
              );
            }
            const { snapshot, documentKey } = data;
            const previous = cache.baseline;
            const reason =
              mode === "full"
                ? "requested"
                : !previous
                  ? "initial"
                  : previous.documentKey !== documentKey
                    ? "document-changed"
                    : previous.optionsKey !== optionsKey
                      ? "options-changed"
                      : undefined;
            if (!reason && previous?.snapshot === snapshot) {
              return Object.freeze({
                kind: "unchanged",
                snapshotId: previous.snapshotId,
              });
            }
            const snapshotId = `ax-${nextAxSnapshot++}`;
            const diff =
              !reason && previous
                ? axLineDiff(previous.snapshot, snapshot)
                : null;
            cache.baseline = { snapshotId, documentKey, optionsKey, snapshot };
            if (
              diff !== null &&
              previous &&
              (mode === "diff" || diff.length < snapshot.length)
            ) {
              return Object.freeze({
                kind: "diff",
                snapshotId,
                baseSnapshotId: previous.snapshotId,
                diff,
              });
            }
            return Object.freeze({
              kind: "full",
              snapshotId,
              snapshot,
              reason:
                reason ?? (diff === null ? "diff-budget" : "diff-not-smaller"),
            });
          } catch (error) {
            cache.baseline = undefined;
            throw error;
          }
        },
      );
      cache.pending = capture.then(
        () => undefined,
        () => undefined,
      );
      return await capture;
    }

    async screenshot(
      rawOptions?: Record<string, unknown>,
    ): Promise<BrowserWorkerScreenshotReceipt> {
      const data = await this.run(
        "screenshot",
        screenshotParams(this.id, rawOptions),
      );
      const path = stringField(data, "path");
      if (!path) {
        throw new Error(
          "Browser screenshot completed without an attached artifact path.",
        );
      }
      const format =
        stringField(data, "format", "jpeg") === "png" ? "png" : "jpeg";
      return Object.freeze({
        attached: true,
        path,
        format,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      });
    }

    async scroll(rawOptions: Record<string, unknown> = {}): Promise<unknown> {
      const value = requireOptions(rawOptions, "scroll options");
      assertKnownKeys(
        value,
        ["x", "y", "direction", "amount", "selector"],
        "scroll options",
      );
      const params: Record<string, unknown> = { tabId: this.id };
      // x/y are pixel deltas (negative scrolls up/left); direction+amount is
      // the ergonomic alternative the daemon converts to deltas.
      for (const key of ["x", "y"] as const) {
        if (value[key] !== undefined) {
          if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
            throw new TypeError(`${key} must be a finite number.`);
          }
          params[key] = value[key];
        }
      }
      if (value.direction !== undefined) {
        const direction = requireString(value.direction, "direction");
        if (!["up", "down", "left", "right"].includes(direction)) {
          throw new TypeError("direction must be up, down, left, or right.");
        }
        params.direction = direction;
      }
      if (value.amount !== undefined) {
        params.amount = requireFiniteNonNegative(value.amount, "amount");
      }
      if (value.selector !== undefined) {
        params.selector = requireSelectorText(value.selector, "selector");
      }
      return await this.run("scroll", params);
    }

    async expectNewTab(
      action: () => unknown | Promise<unknown>,
      rawOptions?: Readonly<{ timeoutMs?: number }>,
    ): Promise<BrowserWorkerTab> {
      const state = this.state();
      return await expectNewTab(action, rawOptions, state.backend);
    }
  }

  Object.freeze(Tab.prototype);

  const tabs: BrowserWorkerTabs = Object.freeze({
    list: async () => (await listTabsInternal()).tabs,
    new: async (url?: string) => {
      // Capture before transport: browser.use() may complete while tab_new is
      // in flight, but the returned handle belongs to the backend that
      // actually received this dispatch.
      const backend = context.selectedBackend;
      const params: Record<string, unknown> = {};
      if (url !== undefined) {
        params.url = requireString(url, "url", { maxLength: 16_384 });
      }
      const data = await command("tab_new", params, backend);
      const rawId =
        field(data, "tabId") ??
        field(data, "id") ??
        field(field(data, "tab"), "id");
      if (rawId === undefined || rawId === null) {
        const detail = "tab_new returned no stable tabId";
        if (typeof field(data, "index") === "number") {
          throw browserLegacyIndexOnlyTabs(detail);
        }
        throw browserProtocolMismatch(detail);
      }
      return getTab(
        rawId,
        {
          tabGeneration: field(data, "tabGeneration"),
          url: typeof url === "string" ? url : "about:blank",
          active: true,
        },
        backend,
      );
    },
    selected: async () => {
      const listed = await listTabsInternal();
      const selected =
        listed.tabs.find((tab) => tab.id === listed.activeTabId) ??
        listed.tabs.find((tab) => tabState.get(tab as object)?.active);
      if (!selected) throw new Error("No selected browser tab is available.");
      return selected;
    },
    get: (id: number) => getTab(id),
    finalize: async (entries: unknown = []) => {
      const defaultBackend = context.selectedBackend;
      const input = Array.isArray(entries) ? entries : [entries];
      const normalized = input.map((entry, index) => {
        let tabId: unknown;
        let status: unknown = "deliverable";
        const directState =
          entry && typeof entry === "object"
            ? tabState.get(entry as object)
            : undefined;
        if (directState) {
          tabId = directState.id;
        } else if (typeof entry === "number" || typeof entry === "string") {
          tabId = entry;
        } else if (isPlainObject(entry)) {
          const nestedTabState =
            entry.tab && typeof entry.tab === "object"
              ? tabState.get(entry.tab as object)
              : undefined;
          tabId = nestedTabState?.id ?? entry.tabId ?? entry.id;
          status = entry.status ?? status;
        } else {
          throw new TypeError(`finalize entry ${index} is invalid.`);
        }
        const nestedState =
          isPlainObject(entry) && entry.tab && typeof entry.tab === "object"
            ? tabState.get(entry.tab as object)
            : undefined;
        const entryBackend =
          directState?.backend ?? nestedState?.backend ?? defaultBackend;
        if (status !== "handoff" && status !== "deliverable") {
          throw new TypeError(
            `finalize entry ${index} status must be 'handoff' or 'deliverable'.`,
          );
        }
        const keep = Object.freeze({
          tabId: normalizeTabId(tabId, `finalize entry ${index} tabId`),
          ...(() => {
            const stateGeneration = directState ?? nestedState;
            const rawGeneration =
              stateGeneration?.generation ??
              (isPlainObject(entry) ? entry.tabGeneration : undefined);
            const normalizedTabId = normalizeTabId(
              tabId,
              `finalize entry ${index} tabId`,
            );
            const generation = normalizeTabGeneration(
              rawGeneration,
              normalizedTabId,
              `finalize entry ${index} tabGeneration`,
              entryBackend,
            );
            assertCurrentTabGeneration(
              normalizedTabId,
              generation,
              entryBackend,
            );
            return isLegacyTabGeneration(generation)
              ? {}
              : { tabGeneration: generation };
          })(),
          status,
        });
        return Object.freeze({ backend: entryBackend, keep });
      });
      const groups = new Map<
        BrowserWorkerBackend,
        Array<(typeof normalized)[number]["keep"]>
      >();
      if (normalized.length === 0) groups.set(defaultBackend, []);
      for (const entry of normalized) {
        const group = groups.get(entry.backend) ?? [];
        group.push(entry.keep);
        groups.set(entry.backend, group);
      }
      const outcomes: Array<{
        backend: BrowserWorkerBackend;
        result: unknown;
      }> = [];
      for (const [backend, keep] of groups) {
        outcomes.push({
          backend,
          result: await command(
            "finalize_tabs",
            { keep: Object.freeze(keep) },
            backend,
          ),
        });
      }
      if (outcomes.length === 1) return outcomes[0]!.result;
      return Object.freeze({
        backendResults: Object.freeze(
          outcomes.map(({ backend, result }) =>
            Object.freeze({ backend, result }),
          ),
        ),
      });
    },
  });

  return tabs;
};
