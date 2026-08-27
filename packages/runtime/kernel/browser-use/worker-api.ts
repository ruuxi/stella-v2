export type BrowserWorkerCall = (
  method: "command" | "chain" | "use",
  args: readonly unknown[],
) => Promise<unknown>;

export type BrowserWorkerBackend = "in-app" | "external";

export type BrowserWorkerChainStep = Readonly<{
  action: string;
  params: Readonly<Record<string, unknown>>;
}>;

export type BrowserWorkerChainOptions = Readonly<{
  timeout?: number;
  delay?: Readonly<{ min?: number; max?: number }>;
  waitForSelector?: boolean;
  waitTimeout?: number;
  abortOnError?: boolean;
  returnSnapshot?: boolean;
  returnScreenshot?: boolean;
}>;

export type BrowserWorkerApiOptions = Readonly<{
  maxExpectNewTabTimeoutMs?: number;
}>;

export type BrowserWorkerScreenshotReceipt = Readonly<{
  attached: true;
  path: string;
  format: "png" | "jpeg";
  mimeType: "image/png" | "image/jpeg";
}>;

export interface BrowserWorkerLocator {
  readonly backend: BrowserWorkerBackend;
  locator(selector: string): BrowserWorkerLocator;
  filter(options: Record<string, unknown>): BrowserWorkerLocator;
  nth(index: number): BrowserWorkerLocator;
  first(): BrowserWorkerLocator;
  last(): BrowserWorkerLocator;
  count(): Promise<number>;
  click(): Promise<unknown>;
  dblclick(): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  type(text: string): Promise<unknown>;
  press(key: string): Promise<unknown>;
  hover(): Promise<unknown>;
  focus(): Promise<unknown>;
  check(): Promise<unknown>;
  uncheck(): Promise<unknown>;
  setChecked(checked: boolean): Promise<unknown>;
  selectOption(value: string | readonly string[]): Promise<unknown>;
  setInputFiles(files: string | readonly string[]): Promise<unknown>;
  scrollIntoViewIfNeeded(): Promise<unknown>;
  innerText(): Promise<string>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  boundingBox(): Promise<unknown>;
  evaluate(
    pageFunction: string | ((element: unknown, arg?: unknown) => unknown),
    arg?: unknown,
  ): Promise<unknown>;
  waitFor(
    options?: Readonly<{ state?: string; timeout?: number }>,
  ): Promise<void>;
  allTextContents(): Promise<string[]>;
}

export interface BrowserWorkerPlaywright {
  domSnapshot(options?: Record<string, unknown>): Promise<unknown>;
  evaluate(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
  ): Promise<unknown>;
  locator(selector: string): BrowserWorkerLocator;
  getByRole(
    role: string,
    options?: Record<string, unknown>,
  ): BrowserWorkerLocator;
  getByText(
    text: string,
    options?: Record<string, unknown>,
  ): BrowserWorkerLocator;
  getByLabel(
    text: string,
    options?: Record<string, unknown>,
  ): BrowserWorkerLocator;
  getByPlaceholder(
    text: string,
    options?: Record<string, unknown>,
  ): BrowserWorkerLocator;
  getByTestId(
    testId: string,
    options?: Record<string, unknown>,
  ): BrowserWorkerLocator;
  waitForURL(
    url: string,
    options?: Readonly<{ timeout?: number }>,
  ): Promise<string>;
  waitForFunction(
    pageFunction: string | (() => unknown),
    options?: Readonly<{ timeout?: number }>,
  ): Promise<unknown>;
  schedule(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
  ): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  expectNewTab(
    action: () => unknown | Promise<unknown>,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<BrowserWorkerTab>;
}

export interface BrowserWorkerNetwork {
  requests(
    options?: Readonly<{
      filter?: string;
      after?: number;
      limit?: number;
      clear?: boolean;
    }>,
  ): Promise<readonly unknown[]>;
  waitForResponse(
    url: string,
    action?: () => unknown | Promise<unknown>,
    options?: Readonly<{ timeout?: number }>,
  ): Promise<unknown>;
  rewriteRequest(
    url: string,
    options: Readonly<{
      method?: string;
      postData?: string;
      jsonPatch?: Readonly<Record<string, unknown>>;
      headers?: Readonly<Record<string, string>>;
    }>,
  ): Promise<unknown>;
  clearRequestRewrite(url?: string): Promise<unknown>;
  fetch(
    url: string,
    options?: Readonly<{
      method?: string;
      headers?: Readonly<Record<string, string>>;
      body?: string;
      timeout?: number;
      maxBodyBytes?: number;
    }>,
  ): Promise<unknown>;
  fetchAll(
    requests: readonly Readonly<{
      url: string;
      method?: string;
      headers?: Readonly<Record<string, string>>;
      body?: string;
      timeout?: number;
      maxBodyBytes?: number;
    }>[],
    options?: Readonly<{ concurrency?: number; timeout?: number }>,
  ): Promise<readonly unknown[]>;
}

export interface BrowserWorkerKeyboard {
  press(key: string): Promise<unknown>;
  type(text: string): Promise<unknown>;
}

export interface BrowserWorkerTab {
  readonly backend: BrowserWorkerBackend;
  readonly id: number;
  readonly generation: string;
  readonly playwright: BrowserWorkerPlaywright;
  readonly keyboard: BrowserWorkerKeyboard;
  readonly network: BrowserWorkerNetwork;
  press(key: string): Promise<unknown>;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  back(options?: Record<string, unknown>): Promise<unknown>;
  forward(options?: Record<string, unknown>): Promise<unknown>;
  reload(options?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<unknown>;
  markDeliverable(): Promise<unknown>;
  markHandoff(): Promise<unknown>;
  url(): Promise<string>;
  title(): Promise<string>;
  snapshot(options?: Record<string, unknown>): Promise<unknown>;
  screenshot(
    options?: Record<string, unknown>,
  ): Promise<BrowserWorkerScreenshotReceipt>;
  scroll(options?: Record<string, unknown>): Promise<unknown>;
  expectNewTab(
    action: () => unknown | Promise<unknown>,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<BrowserWorkerTab>;
}

export interface BrowserWorkerTabs {
  list(): Promise<readonly BrowserWorkerTab[]>;
  readonly new: (url?: string) => Promise<BrowserWorkerTab>;
  selected(): Promise<BrowserWorkerTab>;
  get(id: number): BrowserWorkerTab;
  finalize(entries?: unknown): Promise<unknown>;
}

export interface BrowserWorkerApi {
  readonly backend: BrowserWorkerBackend;
  use(
    backend: BrowserWorkerBackend,
  ): Promise<Readonly<{ backend: BrowserWorkerBackend }>>;
  readonly capabilities: Readonly<{
    observations: readonly string[];
    actions: readonly string[];
    notes: readonly string[];
  }>;
  chain(
    steps: readonly BrowserWorkerChainStep[],
    options?: BrowserWorkerChainOptions,
  ): Promise<unknown>;
  readonly tabs: BrowserWorkerTabs;
}

export function installBrowserWorkerApi(
  callBrowser: BrowserWorkerCall,
  options: BrowserWorkerApiOptions = {},
): BrowserWorkerApi {
  if (typeof callBrowser !== "function") {
    throw new TypeError("callBrowser must be a function.");
  }
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("browser worker options must be an object.");
  }

  const MAX_CHAIN_STEPS = 100;
  const DEFAULT_EXPECT_NEW_TAB_TIMEOUT_MS = 10_000;
  const ABSOLUTE_EXPECT_NEW_TAB_TIMEOUT_MS = 60_000;
  const expectNewTabLimit =
    options.maxExpectNewTabTimeoutMs === undefined
      ? ABSOLUTE_EXPECT_NEW_TAB_TIMEOUT_MS
      : options.maxExpectNewTabTimeoutMs;
  if (
    !Number.isSafeInteger(expectNewTabLimit) ||
    expectNewTabLimit <= 0 ||
    expectNewTabLimit > ABSOLUTE_EXPECT_NEW_TAB_TIMEOUT_MS
  ) {
    throw new RangeError(
      `maxExpectNewTabTimeoutMs must be an integer from 1 to ${ABSOLUTE_EXPECT_NEW_TAB_TIMEOUT_MS}.`,
    );
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) return true;
    return (
      Object.getPrototypeOf(prototype) === null &&
      typeof prototype.constructor === "function" &&
      prototype.constructor.name === "Object"
    );
  };
  const requireString = (
    value: unknown,
    name: string,
    options: { allowEmpty?: boolean; maxLength?: number } = {},
  ): string => {
    if (
      typeof value !== "string" ||
      (!options.allowEmpty && value.length === 0)
    ) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
    if (value.includes("\0")) {
      throw new TypeError(`${name} must not contain a null byte.`);
    }
    if (value.length > (options.maxLength ?? 100_000)) {
      throw new RangeError(`${name} is too long.`);
    }
    return value;
  };
  const requirePositiveInteger = (value: unknown, name: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
    return value as number;
  };
  const requireNonNegativeInteger = (value: unknown, name: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError(`${name} must be a non-negative integer.`);
    }
    return value as number;
  };
  const requireFiniteNonNegative = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative number.`);
    }
    return value;
  };
  const rejectRegExp = (value: unknown, name: string): void => {
    if (Object.prototype.toString.call(value) === "[object RegExp]") {
      throw new TypeError(`${name} does not support RegExp; pass a string.`);
    }
  };
  const requireSelectorText = (value: unknown, name: string): string => {
    rejectRegExp(value, name);
    return requireString(value, name, { maxLength: 8_192 });
  };
  const requireOptions = (
    value: unknown,
    name: string,
  ): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
      throw new TypeError(`${name} must be an object.`);
    }
    return value;
  };
  const assertKnownKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    name: string,
  ): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new TypeError(`${name} contains unsupported option '${key}'.`);
      }
    }
  };
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeError = (value: unknown): Error => {
    if (value instanceof Error) return value;
    if (isPlainObject(value)) {
      const message =
        typeof value.error === "string"
          ? value.error
          : typeof value.message === "string"
            ? value.message
            : "Browser command failed.";
      return new Error(message);
    }
    return new Error(String(value ?? "Browser command failed."));
  };
  let selectedBackend: BrowserWorkerBackend = "in-app";
  const currentTabGeneration = new Map<string, string>();
  const generationKey = (
    backend: BrowserWorkerBackend,
    tabId: number,
  ): string => `${backend}:${tabId}`;
  const isLegacyTabGeneration = (generation: string): boolean =>
    generation.startsWith("legacy:");
  const tabGenerationParams = (
    generation: string,
  ): Readonly<{ tabGeneration?: string }> =>
    isLegacyTabGeneration(generation) ? {} : { tabGeneration: generation };
  const assertCurrentTabGeneration = (
    tabId: number,
    generation: string,
    backend: BrowserWorkerBackend = selectedBackend,
  ): void => {
    const current = currentTabGeneration.get(generationKey(backend, tabId));
    if (current !== undefined && current !== generation) {
      throw new Error(
        `Stale browser tab handle ${tabId} generation ${generation}; the numeric tab id now refers to generation ${current}. Call browser.tabs.list() and use the current handle.`,
      );
    }
  };
  const stampTabGeneration = (
    params: Record<string, unknown>,
    backend: BrowserWorkerBackend = selectedBackend,
  ): Record<string, unknown> => {
    const tabId = params.tabId;
    if (
      params.tabGeneration !== undefined ||
      !Number.isSafeInteger(tabId) ||
      (tabId as number) <= 0
    ) {
      return params;
    }
    const generation = currentTabGeneration.get(
      generationKey(backend, tabId as number),
    );
    if (generation === undefined || isLegacyTabGeneration(generation)) {
      return params;
    }
    return { ...params, tabGeneration: generation };
  };
  const unwrapResponse = (value: unknown): unknown => {
    let envelope = value;
    if (
      isPlainObject(envelope) &&
      isPlainObject(envelope.result) &&
      typeof envelope.result.success === "boolean"
    ) {
      envelope = envelope.result;
    } else if (
      isPlainObject(envelope) &&
      isPlainObject(envelope.response) &&
      typeof envelope.response.success === "boolean"
    ) {
      envelope = envelope.response;
    }
    if (isPlainObject(envelope) && envelope.success === false) {
      throw normalizeError(envelope);
    }
    if (
      isPlainObject(envelope) &&
      typeof envelope.success === "boolean" &&
      Object.prototype.hasOwnProperty.call(envelope, "data")
    ) {
      return envelope.data;
    }
    return envelope;
  };
  const command = async (
    action: string,
    params: Record<string, unknown>,
    backend?: BrowserWorkerBackend,
  ): Promise<unknown> =>
    unwrapResponse(
      await callBrowser("command", [
        action,
        {
          ...stampTabGeneration(params, backend),
          ...(backend ? { __stellaBrowserBackend: backend } : {}),
        },
      ]),
    );
  const sendChain = async (
    steps: readonly BrowserWorkerChainStep[],
    chainOptions: BrowserWorkerChainOptions,
    backend?: BrowserWorkerBackend,
  ): Promise<unknown> =>
    unwrapResponse(
      await callBrowser("chain", [
        steps,
        {
          ...chainOptions,
          ...(backend ? { __stellaBrowserBackend: backend } : {}),
        },
      ]),
    );
  const field = (value: unknown, key: string): unknown =>
    isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : undefined;
  const fieldOrSelf = (value: unknown, key: string): unknown =>
    isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : value;
  const stringField = (value: unknown, key: string, fallback = ""): string => {
    const candidate = field(value, key);
    return typeof candidate === "string" ? candidate : fallback;
  };
  const booleanField = (
    value: unknown,
    key: string,
    fallback = false,
  ): boolean => {
    const candidate = field(value, key);
    if (typeof candidate === "boolean") return candidate;
    if (candidate === "true") return true;
    if (candidate === "false") return false;
    return fallback;
  };
  const numberField = (value: unknown, key: string, fallback = 0): number => {
    const candidate = field(value, key);
    const number =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim() !== ""
          ? Number(candidate)
          : Number.NaN;
    return Number.isFinite(number) ? number : fallback;
  };

  const snapshotParams = (
    tabId: number,
    rawOptions: unknown,
  ): Record<string, unknown> => {
    const value = requireOptions(rawOptions, "snapshot options");
    assertKnownKeys(
      value,
      ["interactive", "cursor", "maxDepth", "depth", "compact", "selector"],
      "snapshot options",
    );
    const params: Record<string, unknown> = { tabId };
    for (const key of ["interactive", "cursor", "compact"] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== "boolean") {
          throw new TypeError(`${key} must be a boolean.`);
        }
        params[key] = value[key];
      }
    }
    const depth = value.maxDepth ?? value.depth;
    if (depth !== undefined) {
      params.maxDepth = requireNonNegativeInteger(depth, "maxDepth");
    }
    if (value.selector !== undefined) {
      params.selector = requireSelectorText(value.selector, "selector");
    }
    return params;
  };
  const screenshotParams = (
    tabId: number,
    rawOptions: unknown,
  ): Record<string, unknown> => {
    const value = requireOptions(rawOptions, "screenshot options");
    assertKnownKeys(
      value,
      ["fullPage", "selector", "format", "quality", "annotate"],
      "screenshot options",
    );
    const params: Record<string, unknown> = { tabId };
    if (value.fullPage !== undefined) {
      if (typeof value.fullPage !== "boolean") {
        throw new TypeError("fullPage must be a boolean.");
      }
      params.fullPage = value.fullPage;
    }
    if (value.annotate !== undefined) {
      if (typeof value.annotate !== "boolean") {
        throw new TypeError("annotate must be a boolean.");
      }
      params.annotate = value.annotate;
    }
    if (value.selector !== undefined) {
      params.selector = requireSelectorText(value.selector, "selector");
    }
    if (value.format !== undefined) {
      const format = requireString(value.format, "format");
      if (format !== "png" && format !== "jpeg") {
        throw new TypeError("format must be 'png' or 'jpeg'.");
      }
      params.format = format;
    }
    if (value.quality !== undefined) {
      const quality = requireNonNegativeInteger(value.quality, "quality");
      if (quality > 100) throw new RangeError("quality must be at most 100.");
      params.quality = quality;
    }
    return params;
  };
  const timeoutParam = (
    value: unknown,
    name: string,
    maximum = 120_000,
  ): number => {
    const timeout = requireNonNegativeInteger(value, name);
    if (timeout > maximum) {
      throw new RangeError(`${name} must be at most ${maximum}.`);
    }
    return timeout;
  };
  const serializeArgument = (value: unknown): string => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new TypeError("evaluate argument must be JSON-serializable.");
    }
    if (serialized === undefined) {
      throw new TypeError("evaluate argument must be JSON-serializable.");
    }
    return serialized;
  };
  const functionSource = (value: unknown, name: string): string => {
    if (typeof value === "string") {
      return requireString(value, name, { maxLength: 100_000 });
    }
    if (typeof value !== "function") {
      throw new TypeError(
        `${name} must be a function or function source string.`,
      );
    }
    const source = Function.prototype.toString.call(value);
    if (source.includes("[native code]")) {
      throw new TypeError(`${name} must not be a native or bound function.`);
    }
    return source;
  };
  const pageEvaluateScript = (
    pageFunction: unknown,
    arg: unknown,
    hasArgument: boolean,
  ): string => {
    if (typeof pageFunction === "string" && !hasArgument) {
      return functionSource(pageFunction, "pageFunction");
    }
    const source = functionSource(pageFunction, "pageFunction");
    return `(${source})(${hasArgument ? serializeArgument(arg) : ""})`;
  };

  const encodeSemanticSelector = (payload: Record<string, unknown>): string =>
    `aria=${encodeURIComponent(JSON.stringify(payload))}`;
  const parseSemanticSelector = (
    selector: string,
  ): Record<string, unknown> | null => {
    if (!selector.startsWith("aria=")) return null;
    try {
      const parsed: unknown = JSON.parse(
        decodeURIComponent(selector.slice("aria=".length)),
      );
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const semanticSelector = (
    kind: "role" | "text" | "label" | "placeholder" | "testid",
    value: string,
    rawOptions: unknown,
  ): string => {
    const locatorOptions = requireOptions(
      rawOptions,
      `${kind} locator options`,
    );
    assertKnownKeys(
      locatorOptions,
      kind === "role" ? ["name", "exact"] : ["exact"],
      `${kind} locator options`,
    );
    if (
      locatorOptions.exact !== undefined &&
      typeof locatorOptions.exact !== "boolean"
    ) {
      throw new TypeError("exact must be a boolean.");
    }
    const exact = locatorOptions.exact === true;
    if (kind === "role") {
      const role = requireSelectorText(value, "role");
      const payload: Record<string, unknown> = { kind, role };
      if (locatorOptions.name !== undefined) {
        payload.name = requireSelectorText(locatorOptions.name, "name");
      }
      payload.exact = exact;
      return encodeSemanticSelector(payload);
    }
    return encodeSemanticSelector({
      kind,
      value: requireSelectorText(value, kind),
      exact,
    });
  };
  const semanticWithNth = (selector: string, nth: number): string => {
    const payload = parseSemanticSelector(selector);
    if (!payload) throw new TypeError("Expected a semantic selector.");
    return encodeSemanticSelector({ ...payload, nth });
  };

  type LocatorState = {
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
  };
  const currentTabId = (state: TabState): number => {
    assertCurrentTabGeneration(state.id, state.generation, state.backend);
    return state.id;
  };

  const tabState = new WeakMap<object, TabState>();
  const locatorState = new WeakMap<object, LocatorState>();
  const tabCache = new Map<string, WeakRef<BrowserWorkerTab>>();
  const locatorCache = new Map<string, WeakRef<BrowserWorkerLocator>>();
  const tabFinalizer = new FinalizationRegistry<{
    key: string;
    reference: WeakRef<BrowserWorkerTab>;
  }>(({ key, reference }) => {
    if (tabCache.get(key) === reference) tabCache.delete(key);
  });
  const locatorFinalizer = new FinalizationRegistry<{
    key: string;
    reference: WeakRef<BrowserWorkerLocator>;
  }>(({ key, reference }) => {
    if (locatorCache.get(key) === reference) locatorCache.delete(key);
  });
  let nextMarker = 1;

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

  const queryExpression = (state: LocatorState): string => {
    const descriptor = JSON.stringify({
      selector: state.selector,
      index: state.index,
      textFilters: state.textFilters,
    });
    return `(() => {
      const descriptor = ${descriptor};
      const normalize = value => String(value ?? "").replace(/\\s+/g, " ").trim();
      const matchesText = (actual, filter) => {
        const left = normalize(actual);
        const right = normalize(filter.value);
        const matches = filter.exact
          ? left === right
          : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
        return filter.negate ? !matches : matches;
      };
      const semantic = descriptor.selector.startsWith("aria=")
        ? JSON.parse(decodeURIComponent(descriptor.selector.slice(5)))
        : null;

      const roots = [];
      const visitRoot = (root, depth) => {
        if (!root || depth > 8) return;
        roots.push(root);
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
      const queryAll = selector => {
        const out = [];
        for (const root of roots) {
          try { out.push(...root.querySelectorAll(selector)); } catch (e) {}
        }
        return out;
      };
      const visible = element => element.tagName === "BODY" || element.getClientRects().length > 0;
      const uniqueVisible = elements => [...new Set(elements)].filter(visible);
      const labelledText = element => {
        const ids = element.getAttribute("aria-labelledby");
        if (!ids) return "";
        const scope = element.getRootNode();
        const byId = id => (scope.getElementById ? scope.getElementById(id) : null);
        return ids.split(/\\s+/).map(id => byId(id)?.textContent || "").join(" ");
      };
      const accessibleName = element => {
        const aria = element.getAttribute("aria-label");
        if (aria) return aria;
        const labelled = labelledText(element);
        if (labelled) return labelled;
        if (element.id) {
          let label = null;
          try { label = element.getRootNode().querySelector('label[for="' + CSS.escape(element.id) + '"]'); } catch (e) {}
          if (label) return label.textContent || "";
        }
        return element.alt || element.value || element.title || element.placeholder || element.textContent || "";
      };
      const stringMatches = (actual, expected, exact) => {
        const left = normalize(actual);
        const right = normalize(expected);
        return exact ? left === right : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
      };
      let elements;
      if (!semantic) {
        elements = queryAll(descriptor.selector);
      } else if (semantic.kind === "role") {
        const roleMap = {
          button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]'],
          link: ['a[href]', '[role="link"]'],
          textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
          checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
          radio: ['input[type="radio"]', '[role="radio"]'],
          combobox: ['select', '[role="combobox"]'],
          listbox: ['select[multiple]', '[role="listbox"]'],
          option: ['option', '[role="option"]'],
          heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
          img: ['img[alt]', '[role="img"]'],
          row: ['tr', '[role="row"]'],
          cell: ['td', '[role="cell"]', '[role="gridcell"]'],
          navigation: ['nav', '[role="navigation"]'],
          main: ['main', '[role="main"]'],
        };
        const selectors = roleMap[semantic.role] || ['[role="' + CSS.escape(semantic.role) + '"]'];
        elements = uniqueVisible(selectors.flatMap(selector => queryAll(selector)));
        if (semantic.name !== undefined) {
          elements = elements.filter(element => stringMatches(accessibleName(element), semantic.name, semantic.exact));
        }
      } else if (semantic.kind === "text") {
        const content = [];
        for (const root of roots) {
          const scope = root.body || root;
          try { content.push(...scope.querySelectorAll("*")); } catch (e) {}
        }
        elements = uniqueVisible(content).filter(element => {
          if (!stringMatches(element.textContent, semantic.value, semantic.exact)) return false;
          return ![...element.children].some(child => visible(child) && stringMatches(child.textContent, semantic.value, semantic.exact));
        });
      } else if (semantic.kind === "label") {
        const controls = [];
        for (const label of queryAll("label")) {
          if (!stringMatches(label.textContent, semantic.value, semantic.exact)) continue;
          const control = label.control || label.querySelector("input, textarea, select, button");
          if (control) controls.push(control);
        }
        for (const element of queryAll("[aria-label], [aria-labelledby]")) {
          if (stringMatches(accessibleName(element), semantic.value, semantic.exact)) controls.push(element);
        }
        elements = uniqueVisible(controls);
      } else if (semantic.kind === "placeholder") {
        elements = uniqueVisible(queryAll("[placeholder]")).filter(element => stringMatches(element.getAttribute("placeholder"), semantic.value, semantic.exact));
      } else if (semantic.kind === "testid") {
        elements = uniqueVisible(queryAll("[data-testid]")).filter(element => stringMatches(element.getAttribute("data-testid"), semantic.value, semantic.exact));
      } else {
        elements = [];
      }
      for (const filter of descriptor.textFilters) {
        elements = elements.filter(element => matchesText(element.textContent, filter));
      }
      const encodedNth = semantic && Number.isInteger(semantic.nth) ? semantic.nth : undefined;
      const index = descriptor.index === "last"
        ? elements.length - 1
        : descriptor.index ?? encodedNth;
      return index === undefined ? elements : (index >= 0 && index < elements.length ? [elements[index]] : []);
    })()`;
  };

  const chainStepData = (value: unknown, index: number): unknown => {
    const results = field(value, "results");
    if (!Array.isArray(results) || results.length <= index) return value;
    const step = results[index];
    if (isPlainObject(step) && step.success === false)
      throw normalizeError(step);
    if (
      isPlainObject(step) &&
      Object.prototype.hasOwnProperty.call(step, "data")
    ) {
      return step.data;
    }
    return fieldOrSelf(step, "result");
  };

  const makeMarkerChain = async (
    state: LocatorState,
    action: string,
    extra: Record<string, unknown>,
  ): Promise<unknown> => {
    const markerAttribute = "data-stella-worker-locator";
    const markerSelector = `[${markerAttribute}="${state.marker}"]`;

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
    "screenshot",
    "scroll",
    "expectNewTab",
  ] as const);
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
  const exposePublicApi = (
    instance: object,
    names: readonly string[],
  ): void => {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (!prototype) return;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor) continue;
      Object.defineProperty(instance, name, {
        ...descriptor,
        enumerable: true,
      });
    }
  };

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
      action: string,
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

  type NormalizedTabList = {
    tabs: readonly BrowserWorkerTab[];
    activeTabId?: number;
  };

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
  const normalizeTabGeneration = (
    value: unknown,
    tabId: number,
    name: string,
    backend: BrowserWorkerBackend = selectedBackend,
  ): string => {
    if (value === undefined || value === null) {
      return (
        currentTabGeneration.get(generationKey(backend, tabId)) ??
        `legacy:${backend}:${tabId}`
      );
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
    return value.trim();
  };
  const getTab = (
    idValue: unknown,
    metadata: Record<string, unknown> = {},
    backend: BrowserWorkerBackend = selectedBackend,
  ): BrowserWorkerTab => {
    const id = normalizeTabId(idValue, "tab id");
    const generation = normalizeTabGeneration(
      metadata.tabGeneration,
      id,
      "tab generation",
      backend,
    );
    currentTabGeneration.set(generationKey(backend, id), generation);
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
    backend: BrowserWorkerBackend = selectedBackend,
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
    backend: BrowserWorkerBackend = selectedBackend,
  ): Promise<BrowserWorkerTab> => {
    if (typeof action !== "function") {
      throw new TypeError("expectNewTab action must be a function.");
    }
    const value = requireOptions(rawOptions, "expectNewTab options");
    assertKnownKeys(value, ["timeoutMs"], "expectNewTab options");
    const timeoutMs = timeoutParam(
      value.timeoutMs ?? DEFAULT_EXPECT_NEW_TAB_TIMEOUT_MS,
      "timeoutMs",
      expectNewTabLimit as number,
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
      action: string,
      params: Record<string, unknown>,
    ): Promise<unknown> {
      return await command(action, params, this.state().backend);
    }

    get playwright(): BrowserWorkerPlaywright {
      const state = this.state();
      if (state.playwright) return state.playwright;
      const boundCommand = (action: string, params: Record<string, unknown>) =>
        command(action, params, state.backend);
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
      const boundCommand = (action: string, params: Record<string, unknown>) =>
        command(action, params, state.backend);
      const tabParams = () => ({
        tabId: currentTabId(state),
        ...tabGenerationParams(state.generation),
      });
      state.network = Object.freeze({
        requests: async (rawOptions: Record<string, unknown> = {}) => {
          const value = requireOptions(rawOptions, "requests options");
          assertKnownKeys(
            value,
            ["filter", "after", "limit", "clear"],
            "requests options",
          );
          const params: Record<string, unknown> = tabParams();
          if (value.filter !== undefined) {
            params.filter = requireString(value.filter, "filter", {
              maxLength: 8_192,
            });
          }
          if (value.after !== undefined) {
            params.after = requireNonNegativeInteger(value.after, "after");
          }
          if (value.limit !== undefined) {
            const limit = requirePositiveInteger(value.limit, "limit");
            if (limit > 256) throw new RangeError("limit must be at most 256.");
            params.limit = limit;
          }
          if (value.clear !== undefined) {
            if (typeof value.clear !== "boolean") {
              throw new TypeError("clear must be a boolean.");
            }
            params.clear = value.clear;
          }
          const data = await boundCommand("requests", params);
          const requests = field(data, "requests");
          return Object.freeze(Array.isArray(requests) ? [...requests] : []);
        },
        waitForResponse: async (
          url: string,
          action?: () => unknown | Promise<unknown>,
          rawOptions: Readonly<{ timeout?: number }> = {},
        ) => {
          if (action !== undefined && typeof action !== "function") {
            throw new TypeError("waitForResponse action must be a function.");
          }
          const value = requireOptions(rawOptions, "waitForResponse options");
          assertKnownKeys(value, ["timeout"], "waitForResponse options");
          const timeout = timeoutParam(
            value.timeout ?? 30_000,
            "timeout",
            600_000,
          );
          const pattern = requireString(url, "url", { maxLength: 16_384 });
          await boundCommand("requests", { ...tabParams(), limit: 1 });
          const after = Date.now();
          if (action) await action();
          return await boundCommand("responsebody", {
            ...tabParams(),
            url: pattern,
            after,
            timeout,
          });
        },
        rewriteRequest: async (
          url: string,
          rawOptions: Record<string, unknown>,
        ) => {
          const value = requireOptions(rawOptions, "rewriteRequest options");
          assertKnownKeys(
            value,
            ["method", "postData", "jsonPatch", "headers"],
            "rewriteRequest options",
          );
          const params: Record<string, unknown> = {
            ...tabParams(),
            url: requireString(url, "url", { maxLength: 16_384 }),
          };
          if (value.method !== undefined) {
            params.method = requireString(value.method, "method", {
              maxLength: 64,
            });
          }
          if (value.postData !== undefined) {
            params.postData = requireString(value.postData, "postData", {
              allowEmpty: true,
              maxLength: 1024 * 1024,
            });
          }
          if (value.jsonPatch !== undefined) {
            if (!isPlainObject(value.jsonPatch)) {
              throw new TypeError("jsonPatch must be an object.");
            }
            params.jsonPatch = safeJsonValue(value.jsonPatch, "jsonPatch");
          }
          if (value.headers !== undefined) {
            if (!isPlainObject(value.headers)) {
              throw new TypeError("headers must be an object.");
            }
            const headers: Record<string, string> = {};
            for (const [name, headerValue] of Object.entries(value.headers)) {
              headers[requireString(name, "header name", { maxLength: 256 })] =
                requireString(headerValue, `headers.${name}`, {
                  allowEmpty: true,
                  maxLength: 8_192,
                });
            }
            params.headers = headers;
          }
          return await boundCommand("rewrite_request", params);
        },
        clearRequestRewrite: async (url?: string) => {
          const params: Record<string, unknown> = tabParams();
          if (url !== undefined) {
            params.url = requireString(url, "url", { maxLength: 16_384 });
          }
          return await boundCommand("unrewrite_request", params);
        },
        fetch: async (
          url: string,
          rawOptions: Record<string, unknown> = {},
        ) => {
          const value = requireOptions(rawOptions, "fetch options");
          assertKnownKeys(
            value,
            ["method", "headers", "body", "timeout", "maxBodyBytes"],
            "fetch options",
          );
          const params: Record<string, unknown> = {
            ...tabParams(),
            url: requireString(url, "url", { maxLength: 16_384 }),
          };
          if (value.method !== undefined) {
            params.method = requireString(value.method, "method", {
              maxLength: 64,
            });
          }
          if (value.body !== undefined) {
            params.body = requireString(value.body, "body", {
              allowEmpty: true,
              maxLength: 1024 * 1024,
            });
          }
          if (value.timeout !== undefined) {
            params.timeout = timeoutParam(value.timeout, "timeout", 600_000);
          }
          if (value.maxBodyBytes !== undefined) {
            const maximum = requirePositiveInteger(
              value.maxBodyBytes,
              "maxBodyBytes",
            );
            if (maximum > 1024 * 1024) {
              throw new RangeError("maxBodyBytes must be at most 1048576.");
            }
            params.maxBodyBytes = maximum;
          }
          if (value.headers !== undefined) {
            if (!isPlainObject(value.headers)) {
              throw new TypeError("headers must be an object.");
            }
            params.headers = safeJsonValue(value.headers, "headers");
          }
          return await boundCommand("authenticated_request", params);
        },
        fetchAll: async (
          rawRequests: readonly Record<string, unknown>[],
          rawOptions: Record<string, unknown> = {},
        ) => {
          if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
            throw new TypeError("fetchAll requests must be a non-empty array.");
          }
          if (rawRequests.length > 100) {
            throw new RangeError("fetchAll accepts at most 100 requests.");
          }
          const value = requireOptions(rawOptions, "fetchAll options");
          assertKnownKeys(
            value,
            ["concurrency", "timeout"],
            "fetchAll options",
          );
          const concurrency = requirePositiveInteger(
            value.concurrency ?? 4,
            "concurrency",
          );
          if (concurrency > 4) {
            throw new RangeError("concurrency must be from 1 to 4.");
          }
          const timeout = timeoutParam(
            value.timeout ?? 30_000,
            "timeout",
            600_000,
          );
          const requests = rawRequests.map((request, index) => {
            const options = requireOptions(request, `requests[${index}]`);
            assertKnownKeys(
              options,
              ["url", "method", "headers", "body", "timeout", "maxBodyBytes"],
              `requests[${index}]`,
            );
            const clean = safeJsonValue(
              options,
              `requests[${index}]`,
            ) as Record<string, unknown>;
            clean.url = requireString(clean.url, `requests[${index}].url`, {
              maxLength: 16_384,
            });
            return clean;
          });
          const data = await boundCommand("authenticated_request_batch", {
            ...tabParams(),
            requests,
            concurrency,
            timeout,
          });
          const responses = field(data, "responses");
          return Object.freeze(Array.isArray(responses) ? [...responses] : []);
        },
      });
      return state.network;
    }

    get keyboard(): BrowserWorkerKeyboard {
      const state = this.state();
      if (state.keyboard) return state.keyboard;
      const boundCommand = (action: string, params: Record<string, unknown>) =>
        command(action, params, state.backend);
      state.keyboard = Object.freeze({

        press: async (key: string) =>
          await boundCommand("press", {
            tabId: currentTabId(state),
            ...tabGenerationParams(state.generation),
            key: requireString(key, "key", { maxLength: 64 }),
          }),

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

  const SAFE_ACTION_KEYS: Record<string, readonly string[]> = Object.freeze({
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

    requests: ["tabId", "filter", "clear", "after", "limit"],
    responsebody: ["tabId", "url", "timeout", "after"],
    har_start: ["tabId"],
    har_stop: ["tabId", "path"],
  });
  const NON_TAB_ACTIONS = Object.freeze(new Set(["tab_list", "tab_new"]));

  const safeJsonValue = (value: unknown, path: string, depth = 0): unknown => {
    if (depth > 12) throw new TypeError(`${path} is too deeply nested.`);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        safeJsonValue(entry, `${path}[${index}]`, depth + 1),
      );
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`${path} must contain only JSON values.`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(`${path} contains unsafe key '${key}'.`);
      }
      result[key] = safeJsonValue(nested, `${path}.${key}`, depth + 1);
    }
    return result;
  };

  const sanitizeChainStep = (
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
      throw new TypeError(
        `steps[${index}] uses unsupported action '${action}'.`,
      );
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

  const sanitizeChainOptions = (
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
    if (value.timeout !== undefined) {
      result.timeout = timeoutParam(value.timeout, "timeout", 240_000);
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
      result.waitTimeout = timeoutParam(value.waitTimeout, "waitTimeout");
    }
    if (value.delay !== undefined) {
      const delayOptions = requireOptions(value.delay, "chain delay");
      assertKnownKeys(delayOptions, ["min", "max"], "chain delay");
      const min = requireFiniteNonNegative(
        delayOptions.min ?? 300,
        "delay.min",
      );
      const max = requireFiniteNonNegative(
        delayOptions.max ?? 1_200,
        "delay.max",
      );
      if (min > max)
        throw new RangeError("delay.min must not exceed delay.max.");
      result.delay = Object.freeze({ min, max });
    }
    return Object.freeze(result) as BrowserWorkerChainOptions;
  };

  Object.freeze(Locator.prototype);
  Object.freeze(Tab.prototype);

  const tabs: BrowserWorkerTabs = Object.freeze({
    list: async () => (await listTabsInternal()).tabs,
    new: async (url?: string) => {

      const backend = selectedBackend;
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
      const defaultBackend = selectedBackend;
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

  const browser: BrowserWorkerApi = Object.freeze({
    get backend() {
      return selectedBackend;
    },
    use: async (backend: BrowserWorkerBackend) => {
      if (backend !== "in-app" && backend !== "external") {
        throw new TypeError("backend must be 'in-app' or 'external'.");
      }
      const result = await callBrowser("use", [backend]);
      selectedBackend = backend;
      return (isPlainObject(result) ? result : { backend }) as Readonly<{
        backend: BrowserWorkerBackend;
      }>;
    },
    capabilities: Object.freeze({
      observations: Object.freeze([
        "url/title",
        "element state/text",
        "bounded semantic snapshot",
        "screenshot receipt",
      ]),
      actions: Object.freeze([
        "backend-bound tab and locator handles",
        "locator actions",
        "low-level chain",
        "network observation",
      ]),
      notes: Object.freeze([
        "Prefer state reads before snapshots.",
        "Screenshots attach automatically.",
        "Reuse one task-owned tab.",
      ]),
    }),
    chain: async (
      rawSteps: readonly BrowserWorkerChainStep[],
      rawOptions?: BrowserWorkerChainOptions,
    ) => {
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        throw new TypeError("steps must be a non-empty array.");
      }
      if (rawSteps.length > MAX_CHAIN_STEPS) {
        throw new RangeError(
          `steps must contain at most ${MAX_CHAIN_STEPS} actions.`,
        );
      }
      const backend = selectedBackend;
      const steps = Object.freeze(
        rawSteps.map((step, index) => sanitizeChainStep(step, index, backend)),
      );
      const chainOptions = sanitizeChainOptions(rawOptions);
      return await sendChain(steps, chainOptions, backend);
    },
    tabs,
  });

  return browser;
}
