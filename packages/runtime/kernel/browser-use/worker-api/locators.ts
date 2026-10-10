/**
 * Locator handles: Playwright-style element locators bound to one tab
 * generation. Direct CSS locators run as single commands; filtered, indexed
 * and semantic ones mark their element in the page first (a two-step chain).
 */

import type {
  BrowserWorkerBackend,
  BrowserWorkerLocator,
} from "../worker-api.js";
import {
  requireNonNegativeInteger,
  type BrowserProtocolAction,
} from "../protocol.js";
import {
  booleanField,
  chainStepData,
  delay,
  exposePublicApi,
  fieldOrSelf,
  numberField,
  stringField,
  tabGenerationParams,
  type BrowserWorkerContext,
} from "./context.js";
import {
  parseSemanticSelector,
  queryExpression,
  semanticSelector,
  semanticWithNth,
} from "./selectors.js";
import {
  assertKnownKeys,
  functionSource,
  requireOptions,
  requireSelectorText,
  requireString,
  serializeArgument,
  timeoutParam,
} from "./validation.js";

export type LocatorState = {
  backend: BrowserWorkerBackend;
  tabId: number;
  tabGeneration: string;
  selector: string;
  index?: number | "last";
  textFilters: readonly Readonly<{
    value: string;
    exact: boolean;
    negate: boolean;
  }>[];
  marker: string;
};

const LOCATOR_PUBLIC_API = Object.freeze([
  "backend",
  "locator",
  "filter",
  "nth",
  "first",
  "last",
  "count",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "hover",
  "focus",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "setInputFiles",
  "scrollIntoViewIfNeeded",
  "innerText",
  "textContent",
  "inputValue",
  "getAttribute",
  "isVisible",
  "isEnabled",
  "isChecked",
  "boundingBox",
  "evaluate",
  "waitFor",
  "allTextContents",
] as const);

const locatorKey = (
  backend: BrowserWorkerBackend,
  tabId: number,
  tabGeneration: string,
  selector: string,
  index: number | "last" | undefined,
  textFilters: LocatorState["textFilters"],
): string =>
  JSON.stringify([
    backend,
    tabId,
    tabGeneration,
    selector,
    index ?? null,
    textFilters,
  ]);

export const createLocators = (context: BrowserWorkerContext) => {
  const { assertCurrentTabGeneration, command, sendChain } = context;
  const locatorState = new WeakMap<object, LocatorState>();
  const locatorCache = new Map<string, WeakRef<BrowserWorkerLocator>>();
  const locatorFinalizer = new FinalizationRegistry<{
    key: string;
    reference: WeakRef<BrowserWorkerLocator>;
  }>(({ key, reference }) => {
    if (locatorCache.get(key) === reference) locatorCache.delete(key);
  });
  let nextMarker = 1;

  const makeMarkerChain = async (
    state: LocatorState,
    action: BrowserProtocolAction,
    extra: Record<string, unknown>,
  ): Promise<unknown> => {
    const markerAttribute = "data-stella-worker-locator";
    const markerSelector = `[${markerAttribute}="${state.marker}"]`;
    // Markers can land on elements inside same-origin iframes/shadow roots,
    // so marker discovery must walk the same roots the resolver searches.
    const markedElementsJs = `(() => {
      const marked = [];
      const visitRoot = (root, depth) => {
        if (!root || depth > 8) return;
        try { marked.push(...root.querySelectorAll(${JSON.stringify(markerSelector)})); } catch (e) {}
        let all;
        try { all = root.querySelectorAll("*"); } catch (e) { return; }
        for (const node of all) {
          if (node.shadowRoot) visitRoot(node.shadowRoot, depth + 1);
          const tag = node.tagName;
          if (tag === "IFRAME" || tag === "FRAME") {
            let doc = null;
            try { doc = node.contentDocument; } catch (e) { doc = null; }
            if (doc) visitRoot(doc, depth + 1);
          }
        }
      };
      visitRoot(document, 0);
      return marked;
    })()`;
    const script = `(() => {
      const elements = ${queryExpression(state)};
      const element = elements[0];
      if (!element) throw new Error("Locator did not match an element");
      for (const previous of ${markedElementsJs}) {
        previous.removeAttribute(${JSON.stringify(markerAttribute)});
      }
      element.setAttribute(${JSON.stringify(markerAttribute)}, ${JSON.stringify(state.marker)});
      return true;
    })()`;
    const cleanupScript = `(() => {
      for (const element of ${markedElementsJs}) {
        element.removeAttribute(${JSON.stringify(markerAttribute)});
      }
      return true;
    })()`;
    let actionError: unknown;
    try {
      const result = await sendChain(
        [
          Object.freeze({
            action: "evaluate",
            params: Object.freeze({
              tabId: state.tabId,
              ...tabGenerationParams(state.tabGeneration),
              script,
            }),
          }),
          Object.freeze({
            action,
            params: Object.freeze({
              tabId: state.tabId,
              ...tabGenerationParams(state.tabGeneration),
              selector: markerSelector,
              ...extra,
            }),
          }),
        ],
        Object.freeze({ abortOnError: false, waitForSelector: false }),
        state.backend,
      );
      chainStepData(result, 0);
      return chainStepData(result, 1);
    } catch (error) {
      actionError = error;
      throw error;
    } finally {
      try {
        await command(
          "evaluate",
          {
            tabId: state.tabId,
            ...tabGenerationParams(state.tabGeneration),
            script: cleanupScript,
          },
          state.backend,
        );
      } catch (cleanupError) {
        if (actionError === undefined) throw cleanupError;
      }
    }
  };

  class Locator implements BrowserWorkerLocator {
    constructor(state: LocatorState) {
      locatorState.set(this, state);
      exposePublicApi(this, LOCATOR_PUBLIC_API);
      Object.freeze(this);
    }

    private state(): LocatorState {
      const state = locatorState.get(this);
      if (!state) throw new Error("Invalid Locator object.");
      assertCurrentTabGeneration(
        state.tabId,
        state.tabGeneration,
        state.backend,
      );
      return state;
    }

    get backend(): BrowserWorkerBackend {
      return this.state().backend;
    }

    locator(selector: string): BrowserWorkerLocator {
      const state = this.state();
      const child = requireSelectorText(selector, "selector");
      if (
        parseSemanticSelector(state.selector) ||
        state.index !== undefined ||
        state.textFilters.length > 0
      ) {
        throw new TypeError(
          "locator() chaining is only supported from an unfiltered CSS locator.",
        );
      }
      return getLocator({
        backend: state.backend,
        tabId: state.tabId,
        tabGeneration: state.tabGeneration,
        selector: `${state.selector} ${child}`,
        textFilters: Object.freeze([]),
      });
    }

    filter(rawOptions: Record<string, unknown>): BrowserWorkerLocator {
      const state = this.state();
      const filterOptions = requireOptions(rawOptions, "filter options");
      assertKnownKeys(
        filterOptions,
        ["hasText", "hasNotText", "has", "hasNot"],
        "filter options",
      );
      let selector = state.selector;
      const textFilters = [...state.textFilters];
      for (const [key, negate] of [
        ["hasText", false],
        ["hasNotText", true],
      ] as const) {
        if (filterOptions[key] !== undefined) {
          textFilters.push(
            Object.freeze({
              value: requireSelectorText(filterOptions[key], key),
              exact: false,
              negate,
            }),
          );
        }
      }
      for (const [key, negate] of [
        ["has", false],
        ["hasNot", true],
      ] as const) {
        if (filterOptions[key] === undefined) continue;
        const nested = locatorState.get(filterOptions[key] as object);
        if (
          !nested ||
          nested.tabId !== state.tabId ||
          nested.tabGeneration !== state.tabGeneration
        ) {
          throw new TypeError(`${key} must be a Locator from the same tab.`);
        }
        if (
          parseSemanticSelector(selector) ||
          parseSemanticSelector(nested.selector) ||
          nested.index !== undefined ||
          nested.textFilters.length > 0
        ) {
          throw new TypeError(`${key} currently requires CSS locators.`);
        }
        selector += negate
          ? `:not(:has(${nested.selector}))`
          : `:has(${nested.selector})`;
      }
      return getLocator({
        backend: state.backend,
        tabId: state.tabId,
        tabGeneration: state.tabGeneration,
        selector,
        index: state.index,
        textFilters: Object.freeze(textFilters),
      });
    }

    nth(index: number): BrowserWorkerLocator {
      const state = this.state();
      const nth = requireNonNegativeInteger(index, "index");
      const semantic = parseSemanticSelector(state.selector);
      return getLocator({
        backend: state.backend,
        tabId: state.tabId,
        tabGeneration: state.tabGeneration,
        selector: semantic
          ? semanticWithNth(state.selector, nth)
          : state.selector,
        index: semantic ? undefined : nth,
        textFilters: state.textFilters,
      });
    }

    first(): BrowserWorkerLocator {
      return this.nth(0);
    }

    last(): BrowserWorkerLocator {
      const state = this.state();
      return getLocator({
        backend: state.backend,
        tabId: state.tabId,
        tabGeneration: state.tabGeneration,
        selector: state.selector,
        index: "last",
        textFilters: state.textFilters,
      });
    }

    private isDirect(state: LocatorState): boolean {
      return state.index === undefined && state.textFilters.length === 0;
    }

    private async resolveSemanticLast(
      state: LocatorState,
    ): Promise<LocatorState> {
      if (
        state.index !== "last" ||
        state.textFilters.length > 0 ||
        !parseSemanticSelector(state.selector)
      ) {
        return state;
      }
      const data = await command(
        "count",
        {
          tabId: state.tabId,
          selector: state.selector,
        },
        state.backend,
      );
      const count = Math.max(0, Math.trunc(numberField(data, "count")));
      if (count === 0) {
        throw new Error("Locator did not match an element.");
      }
      return {
        ...state,
        selector: semanticWithNth(state.selector, count - 1),
        index: undefined,
      };
    }

    private async action(
      action: BrowserProtocolAction,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> {
      const state = await this.resolveSemanticLast(this.state());
      const deadline = Date.now() + 3_000;
      let lastError: unknown;
      for (;;) {
        try {
          if (this.isDirect(state)) {
            return await command(
              action,
              {
                tabId: state.tabId,
                selector: state.selector,
                ...extra,
              },
              state.backend,
            );
          }
          return await makeMarkerChain(state, action, extra);
        } catch (error) {
          lastError = error;
          const message =
            error instanceof Error ? error.message : String(error);
          const retryable =
            !/outcome=unknown|strict|matched multiple|protocol mismatch/i.test(
              message,
            ) &&
            /not match|not found|no clickable|not clickable|detached|not visible|no clickable area/i.test(
              message,
            );
          const remaining = deadline - Date.now();
          if (!retryable || remaining <= 0) break;
          await delay(Math.min(100, remaining));
        }
      }
      let diagnostic = "";
      try {
        const data = await command(
          "evaluate",
          {
            tabId: state.tabId,
            script: `(() => {
              const all = ${queryExpression(state)};
              const matches = all.slice(0, 5).map(el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return {
                  tag: String(el.tagName || "").toLowerCase(),
                  role: el.getAttribute("role"),
                  type: el.getAttribute("type"),
                  ariaLabel: el.getAttribute("aria-label"),
                  text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
                  visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
                  disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
                };
              });
              return { action: ${JSON.stringify(action)}, locator: ${JSON.stringify(state.selector)}, matchCount: all.length, matches, truncated: all.length > matches.length };
            })()`,
          },
          state.backend,
        );
        diagnostic = ` Diagnostics: ${JSON.stringify(fieldOrSelf(data, "result"))}`;
      } catch {
        // Keep the original action failure if diagnostics cannot be collected.
      }
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`${message}${diagnostic}`);
    }

    async count(): Promise<number> {
      const state = this.state();
      if (this.isDirect(state)) {
        const data = await command(
          "count",
          {
            tabId: state.tabId,
            selector: state.selector,
          },
          state.backend,
        );
        return Math.max(0, Math.trunc(numberField(data, "count")));
      }
      const data = await command(
        "evaluate",
        {
          tabId: state.tabId,
          script: `${queryExpression(state)}.length`,
        },
        state.backend,
      );
      const result = fieldOrSelf(data, "result");
      const number = typeof result === "number" ? result : Number(result);
      return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
    }

    async click(): Promise<unknown> {
      return await this.action("click");
    }

    async dblclick(): Promise<unknown> {
      return await this.action("dblclick");
    }

    async fill(value: string): Promise<unknown> {
      return await this.action("fill", {
        value: requireString(value, "value", { allowEmpty: true }),
      });
    }

    async type(text: string): Promise<unknown> {
      return await this.action("type", {
        text: requireString(text, "text", { allowEmpty: true }),
      });
    }

    async press(key: string): Promise<unknown> {
      return await this.action("press", { key: requireString(key, "key") });
    }

    async hover(): Promise<unknown> {
      return await this.action("hover");
    }

    async focus(): Promise<unknown> {
      return await this.action("focus");
    }

    async check(): Promise<unknown> {
      return await this.action("check");
    }

    async uncheck(): Promise<unknown> {
      return await this.action("uncheck");
    }

    async setChecked(checked: boolean): Promise<unknown> {
      if (typeof checked !== "boolean") {
        throw new TypeError("checked must be a boolean.");
      }
      return checked ? await this.check() : await this.uncheck();
    }

    async selectOption(value: string | readonly string[]): Promise<unknown> {
      const values = (Array.isArray(value) ? value : [value]).map(
        (entry, index) =>
          requireString(entry, `value[${index}]`, { allowEmpty: true }),
      );
      if (values.length === 0) {
        throw new TypeError("value must contain at least one option.");
      }
      return await this.action("select", { values });
    }

    async setInputFiles(files: string | readonly string[]): Promise<unknown> {
      const list = (Array.isArray(files) ? files : [files]).map(
        (entry, index) => {
          const file = requireString(entry, `files[${index}]`, {
            maxLength: 4_096,
          });
          // The daemon hands these to CDP DOM.setFileInputFiles, which
          // resolves them in the browser process: absolute paths only.
          if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(file)) {
            throw new TypeError(`files[${index}] must be an absolute path.`);
          }
          return file;
        },
      );
      return await this.action("upload", { files: list });
    }

    async scrollIntoViewIfNeeded(): Promise<unknown> {
      return await this.action("scrollintoview");
    }

    private async text(action: "innertext" | "gettext"): Promise<unknown> {
      const state = this.state();
      return await this.action(action);
    }

    async innerText(): Promise<string> {
      const data = await this.text("innertext");
      return stringField(data, "text", typeof data === "string" ? data : "");
    }

    async textContent(): Promise<string | null> {
      const data = await this.text("gettext");
      const value = fieldOrSelf(data, "text");
      return value === null ? null : typeof value === "string" ? value : "";
    }

    async inputValue(): Promise<string> {
      const data = await this.action("inputvalue");
      return stringField(data, "value", typeof data === "string" ? data : "");
    }

    async getAttribute(name: string): Promise<string | null> {
      const data = await this.action("getattribute", {
        attribute: requireString(name, "name"),
      });
      const value = fieldOrSelf(data, "value");
      return value === null ? null : typeof value === "string" ? value : null;
    }

    async isVisible(): Promise<boolean> {
      const data = await this.action("isvisible");
      return booleanField(data, "visible", Boolean(data));
    }

    async isEnabled(): Promise<boolean> {
      const data = await this.action("isenabled");
      return booleanField(data, "enabled", Boolean(data));
    }

    async isChecked(): Promise<boolean> {
      const data = await this.action("ischecked");
      return booleanField(data, "checked", Boolean(data));
    }

    async boundingBox(): Promise<unknown> {
      const data = await this.action("boundingbox");
      return fieldOrSelf(data, "box") ?? null;
    }

    async evaluate(
      pageFunction: string | ((element: unknown, arg?: unknown) => unknown),
      arg?: unknown,
    ): Promise<unknown> {
      const state = this.state();
      const source = functionSource(pageFunction, "pageFunction");
      const hasArgument = arguments.length >= 2;
      const script = `(() => {
        const elements = ${queryExpression(state)};
        const element = elements[0];
        if (!element) throw new Error("Locator did not match an element");
        return (${source})(element${hasArgument ? `, ${serializeArgument(arg)}` : ""});
      })()`;
      const data = await command(
        "evaluate",
        { tabId: state.tabId, script },
        state.backend,
      );
      return fieldOrSelf(data, "result");
    }

    async waitFor(
      rawOptions: Readonly<{ state?: string; timeout?: number }> = {},
    ): Promise<void> {
      const value = requireOptions(rawOptions, "waitFor options");
      assertKnownKeys(value, ["state", "timeout"], "waitFor options");
      const desired = value.state ?? "visible";
      if (
        !["attached", "detached", "visible", "hidden"].includes(String(desired))
      ) {
        throw new TypeError(
          "waitFor state must be attached, detached, visible, or hidden.",
        );
      }
      const timeout = timeoutParam(value.timeout ?? 30_000, "timeout");
      const state = this.state();
      if (desired === "attached" && this.isDirect(state)) {
        await command(
          "wait",
          {
            tabId: state.tabId,
            selector: state.selector,
            timeout,
          },
          state.backend,
        );
        return;
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeout) {
        const count = await this.count();
        const visible = count > 0 ? await this.isVisible() : false;
        if (
          (desired === "attached" && count > 0) ||
          (desired === "detached" && count === 0) ||
          (desired === "visible" && visible) ||
          (desired === "hidden" && !visible)
        ) {
          return;
        }
        await delay(
          Math.min(100, Math.max(1, timeout - (Date.now() - startedAt))),
        );
      }
      throw new Error(
        `Timeout waiting for locator to become ${String(desired)}.`,
      );
    }

    async allTextContents(): Promise<string[]> {
      const state = this.state();
      const data = await command(
        "evaluate",
        {
          tabId: state.tabId,
          script: `${queryExpression(state)}.map(element => element.textContent ?? "")`,
        },
        state.backend,
      );
      const result = fieldOrSelf(data, "result");
      return Array.isArray(result)
        ? result.map((entry) =>
            typeof entry === "string" ? entry : String(entry ?? ""),
          )
        : [];
    }
  }

  Object.freeze(Locator.prototype);

  const getLocator = (
    state: Omit<LocatorState, "marker">,
  ): BrowserWorkerLocator => {
    const key = locatorKey(
      state.backend,
      state.tabId,
      state.tabGeneration,
      state.selector,
      state.index,
      state.textFilters,
    );
    const existing = locatorCache.get(key)?.deref();
    if (existing) return existing;
    const locator = new Locator({
      ...state,
      marker: `l${nextMarker++}`,
    });
    const reference = new WeakRef(locator);
    locatorCache.set(key, reference);
    locatorFinalizer.register(locator, { key, reference });
    return locator;
  };

  const locatorFor = (
    backend: BrowserWorkerBackend,
    tabId: number,
    tabGeneration: string,
    selector: string,
  ): BrowserWorkerLocator =>
    getLocator({
      backend,
      tabId,
      tabGeneration,
      selector: requireSelectorText(selector, "selector"),
      textFilters: Object.freeze([]),
    });

  const locatorBuilders = (
    backend: BrowserWorkerBackend,
    tabId: number,
    tabGeneration: string,
  ) => ({
    locator: (selector: string) =>
      locatorFor(backend, tabId, tabGeneration, selector),
    getByRole: (role: string, locatorOptions?: Record<string, unknown>) =>
      locatorFor(
        backend,
        tabId,
        tabGeneration,
        semanticSelector("role", role, locatorOptions),
      ),
    getByText: (text: string, locatorOptions?: Record<string, unknown>) =>
      locatorFor(
        backend,
        tabId,
        tabGeneration,
        semanticSelector("text", text, locatorOptions),
      ),
    getByLabel: (text: string, locatorOptions?: Record<string, unknown>) =>
      locatorFor(
        backend,
        tabId,
        tabGeneration,
        semanticSelector("label", text, locatorOptions),
      ),
    getByPlaceholder: (
      text: string,
      locatorOptions?: Record<string, unknown>,
    ) =>
      locatorFor(
        backend,
        tabId,
        tabGeneration,
        semanticSelector("placeholder", text, locatorOptions),
      ),
    getByTestId: (testId: string, locatorOptions?: Record<string, unknown>) =>
      locatorFor(
        backend,
        tabId,
        tabGeneration,
        semanticSelector("testid", testId, locatorOptions),
      ),
  });

  return { locatorState, locatorBuilders };
};

export type BrowserWorkerLocators = ReturnType<typeof createLocators>;
