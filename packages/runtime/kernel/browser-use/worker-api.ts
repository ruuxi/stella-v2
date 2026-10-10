import { MAX_BROWSER_CHAIN_STEPS } from "./protocol.js";
import { sanitizeChainOptions, sanitizeChainStep } from "./worker-api/chain.js";
import { createBrowserWorkerContext } from "./worker-api/context.js";
import { createLocators } from "./worker-api/locators.js";
import { createTabs } from "./worker-api/tabs.js";
import { isPlainObject } from "./worker-api/validation.js";

export type BrowserWorkerCall = (
  method: "command" | "chain" | "use",
  args: readonly unknown[],
) => Promise<unknown>;

export type BrowserWorkerBackend = "in-app" | "external";

export type BrowserWorkerAxSnapshotOptions = Readonly<{
  mode?: "auto" | "full" | "diff";
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  selector?: string;
}>;

export type BrowserWorkerAxObservation =
  | Readonly<{
      kind: "full";
      snapshotId: string;
      snapshot: string;
      reason:
        | "initial"
        | "requested"
        | "document-changed"
        | "options-changed"
        | "diff-budget"
        | "diff-not-smaller";
    }>
  | Readonly<{
      kind: "diff";
      snapshotId: string;
      baseSnapshotId: string;
      diff: string;
    }>
  | Readonly<{
      kind: "unchanged";
      snapshotId: string;
    }>;

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
  axSnapshot(
    options?: BrowserWorkerAxSnapshotOptions,
  ): Promise<BrowserWorkerAxObservation>;
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

/**
 * Installs the browser object graph inside the Node REPL worker. The worker
 * runs this module bundled into one expression (worker-api-source.ts), so it
 * and everything under worker-api/ must import nothing but each other and
 * ./protocol.js: no packages, no Node built-ins.
 */
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

  const context = createBrowserWorkerContext(callBrowser);
  const tabs = createTabs(
    context,
    createLocators(context),
    expectNewTabLimit as number,
  );

  const browser: BrowserWorkerApi = Object.freeze({
    get backend() {
      return context.selectedBackend;
    },
    use: async (backend: BrowserWorkerBackend) => {
      if (backend !== "in-app" && backend !== "external") {
        throw new TypeError("backend must be 'in-app' or 'external'.");
      }
      const result = await callBrowser("use", [backend]);
      context.selectedBackend = backend;
      return (isPlainObject(result) ? result : { backend }) as Readonly<{
        backend: BrowserWorkerBackend;
      }>;
    },
    capabilities: Object.freeze({
      observations: Object.freeze([
        "url/title",
        "element state/text",
        "bounded semantic snapshot",
        "desktop AX snapshot with automatic diffs and document-scoped refs",
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
        "On desktop, use tab.axSnapshot() for repeated structural observations; mode:'full' restores context after compaction.",
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
      if (rawSteps.length > MAX_BROWSER_CHAIN_STEPS) {
        throw new RangeError(
          `steps must contain at most ${MAX_BROWSER_CHAIN_STEPS} actions.`,
        );
      }
      const backend = context.selectedBackend;
      const steps = Object.freeze(
        rawSteps.map((step, index) =>
          sanitizeChainStep(context, step, index, backend),
        ),
      );
      const chainOptions = sanitizeChainOptions(rawOptions);
      return await context.sendChain(steps, chainOptions, backend);
    },
    tabs,
  });

  return browser;
}
