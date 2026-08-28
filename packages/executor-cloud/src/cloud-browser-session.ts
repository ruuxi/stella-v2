import {
  isCloudBrowserSuspension,
  type CloudBrowserCommandRequest,
  type CloudBrowserCommandResponse,
} from "@stella/contracts/cloud-browser";
import {
  BrowserSessionCommandError,
  BrowserSessionDisposedError,
  type BrowserBackend,
  type BrowserChainOptions,
  type BrowserChainResult,
  type BrowserChainStep,
  type BrowserCommandOptions,
  type BrowserCommandParams,
  type BrowserCommandReceipt,
  type BrowserSessionAction,
  type BrowserSessionClient,
  type BrowserSessionFactory,
  type BrowserTurnEndBehavior,
} from "@stella/runtime/kernel/browser-use/client.js";
import { AgentToolSuspendedError } from "@stella/runtime/kernel/agent-core/suspension.js";
import type { TurnCredentialBrokerClient } from "./turn-credential-broker.js";

export const CLOUD_BROWSER_COMMAND_PATH = "/api/cloud/browser/command";

const MAX_CLOUD_BROWSER_RESPONSE_BYTES = 64 * 1024;
const SENSITIVE_BROWSER_RESULT_KEYS = new Set([
  "accesstoken",
  "authorization",
  "browsercapability",
  "capability",
  "capabilityurl",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "devicesecret",
  "liveviewcapability",
  "liveviewcapabilityurl",
  "password",
  "polltoken",
  "refreshtoken",
  "secret",
  "setcookie",
  "storagestate",
  "token",
]);

type BrowserBroker = Pick<TurnCredentialBrokerClient, "postJson">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
};

type CloudBrowserGatewayAction =
  | "browser.open"
  | "browser.navigate"
  | "browser.observe"
  | "browser.click"
  | "browser.fill"
  | "browser.press"
  | "browser.select"
  | "browser.wait"
  | "browser.tabs"
  | "browser.focus_tab"
  | "browser.checkpoint"
  | "browser.login_takeover"
  | "browser.close"
  | "device_code.fixture_start";

type CloudBrowserCommandPlan = Readonly<{
  action: CloudBrowserGatewayAction;
  params: Readonly<Record<string, unknown>>;
  project: (data: unknown) => unknown;
}>;

const WORKER_BACKEND_PARAM = "__stellaBrowserBackend";

const localParams = (
  params: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): Record<string, unknown> => {
  const actual = { ...params };
  const backend = actual[WORKER_BACKEND_PARAM];
  delete actual[WORKER_BACKEND_PARAM];
  if (backend !== undefined && backend !== "in-app") {
    throw new Error(
      "External browser sessions are unavailable in cloud execution.",
    );
  }
  if (Object.keys(actual).some((key) => !allowed.includes(key))) {
    throw new Error("Cloud browser command parameters are unsupported.");
  }
  return actual;
};

const requiredString = (
  value: unknown,
  name: string,
  maxLength = 4_096,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} must be a bounded non-empty string.`);
  }
  return value;
};

const requiredPositiveInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return Number(value);
};

type SafeObservation = Readonly<{
  url: string;
  title: string;
  text: string;
}>;

const safeObservation = (value: unknown): SafeObservation => {
  if (!isRecord(value) || !hasExactKeys(value, ["url", "title", "text"])) {
    throw new Error("Cloud browser returned an invalid observation.");
  }
  return Object.freeze({
    url: requiredString(value.url, "observation.url", 4_096),
    title:
      typeof value.title === "string" && value.title.length <= 1_024
        ? value.title
        : (() => {
            throw new Error("Cloud browser returned an invalid observation.");
          })(),
    text:
      typeof value.text === "string" && value.text.length <= 32_768
        ? value.text
        : (() => {
            throw new Error("Cloud browser returned an invalid observation.");
          })(),
  });
};

const observationFromData = (value: unknown): SafeObservation => {
  if (!isRecord(value)) {
    throw new Error("Cloud browser returned an invalid observation.");
  }
  return safeObservation(value.observation);
};

/** Defense in depth against a gateway accidentally returning private state. */
const assertCapabilityFreeBrowserData = (
  value: unknown,
  seen = new Set<object>(),
): void => {
  if (typeof value === "string") {
    try {
      if (new URL(value).hostname.toLowerCase() === "live.browser.run") {
        throw new Error(
          "Cloud browser response contained a private capability.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Cloud browser response contained a private capability."
      ) {
        throw error;
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertCapabilityFreeBrowserData(item, seen);
    return;
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      SENSITIVE_BROWSER_RESULT_KEYS.has(
        key.toLowerCase().replace(/[^a-z0-9]/gu, ""),
      )
    ) {
      throw new Error(
        "Cloud browser response contained private browser state.",
      );
    }
    assertCapabilityFreeBrowserData(nested, seen);
  }
};

const readBoundedBrowserResponse = async (
  response: Response,
): Promise<unknown> => {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/u.test(declared) ||
      Number(declared) > MAX_CLOUD_BROWSER_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Cloud browser response exceeded its bounded size.");
  }
  if (!response.body) throw new Error("Cloud browser response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CLOUD_BROWSER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Cloud browser response exceeded its bounded size.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Cloud browser response was invalid.");
  } finally {
    bytes.fill(0);
  }
};

const parseBrowserCommandResponse = (
  value: unknown,
  requestId: string,
): CloudBrowserCommandResponse => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Cloud browser response was invalid.");
  }
  if (
    value.outcome === "completed" &&
    value.requestId === requestId &&
    hasExactKeys(
      value,
      value.data === undefined
        ? ["schemaVersion", "outcome", "requestId"]
        : ["schemaVersion", "outcome", "requestId", "data"],
    )
  ) {
    assertCapabilityFreeBrowserData(value.data);
    return value as CloudBrowserCommandResponse;
  }
  if (
    value.outcome === "suspended" &&
    hasExactKeys(value, ["schemaVersion", "outcome", "suspension"]) &&
    isCloudBrowserSuspension(value.suspension)
  ) {
    return value as CloudBrowserCommandResponse;
  }
  if (
    value.outcome === "failed" &&
    value.requestId === requestId &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.outcomeUnknown === undefined ||
      typeof value.outcomeUnknown === "boolean") &&
    hasExactKeys(
      value,
      value.outcomeUnknown === undefined
        ? ["schemaVersion", "outcome", "requestId", "code", "message"]
        : [
            "schemaVersion",
            "outcome",
            "requestId",
            "code",
            "message",
            "outcomeUnknown",
          ],
    )
  ) {
    return value as CloudBrowserCommandResponse;
  }
  throw new Error("Cloud browser response was invalid.");
};

class TurnBrokerBrowserSession implements BrowserSessionClient {
  private disposed = false;
  private activeTurnId?: string;
  private humanControlActive = false;
  private endingTurn?: Readonly<{ turnId: string; promise: Promise<void> }>;
  private nextLocalTabId = 1;
  private syntheticActiveTabId?: number;
  private readonly localTabIdByGatewayId = new Map<string, number>();
  private readonly gatewayTabIdByLocalId = new Map<number, string>();

  constructor(
    private readonly broker: BrowserBroker,
    private readonly sessionId: string,
  ) {}

  command<TData = unknown>(
    action: BrowserSessionAction,
    params: BrowserCommandParams = {},
    options: BrowserCommandOptions = {},
  ): Promise<BrowserCommandReceipt<TData>> {
    return this.dispatch<TData>(action, params, options.signal);
  }

  chain<TData = unknown>(
    _steps: readonly BrowserChainStep[],
    _options: BrowserChainOptions = {},
  ): Promise<BrowserCommandReceipt<BrowserChainResult<TData>>> {
    return Promise.reject(
      new Error(
        "Cloud browser batching is unavailable; issue supported browser calls sequentially.",
      ),
    );
  }

  async selectBackend(
    backend: BrowserBackend,
  ): Promise<Readonly<{ backend: BrowserBackend }>> {
    this.assertOpen();
    if (backend !== "in-app") {
      throw new Error(
        "External browser sessions are unavailable in cloud execution.",
      );
    }
    return Object.freeze({ backend });
  }

  beginTurn(turnId: string): void {
    this.assertOpen();
    if (!turnId.trim()) throw new TypeError("Browser turn id is required.");
    // One persistent code kernel can execute several Code calls in a physical
    // agent turn. Only the latest call can still own browser work at teardown.
    this.activeTurnId = turnId;
  }

  async endTurn(
    turnId: string,
    behavior: BrowserTurnEndBehavior,
  ): Promise<void> {
    if (this.disposed || this.activeTurnId !== turnId) return;
    // Browser Run is fenced while the human owns it. A suspended physical turn
    // persists its transcript then releases the sandbox without issuing any
    // automation command against that profile.
    if (this.humanControlActive) return;
    if (this.endingTurn?.turnId === turnId) {
      await this.endingTurn.promise;
      return;
    }
    const promise = (async () => {
      await this.dispatch("finalize_tabs", {});
      if (behavior === "close-tabs") {
        await this.dispatch("tab_close", {});
      }
    })();
    this.endingTurn = Object.freeze({ turnId, promise });
    try {
      await promise;
    } finally {
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
      if (this.endingTurn?.promise === promise) this.endingTurn = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeTurnId = undefined;
    this.endingTurn = undefined;
  }

  private assertOpen(): void {
    if (this.disposed) throw new BrowserSessionDisposedError();
  }

  private localTabId(gatewayTabId?: string): number {
    if (gatewayTabId) {
      const existing = this.localTabIdByGatewayId.get(gatewayTabId);
      if (existing) return existing;
      if (this.syntheticActiveTabId !== undefined) {
        const id = this.syntheticActiveTabId;
        this.syntheticActiveTabId = undefined;
        this.localTabIdByGatewayId.set(gatewayTabId, id);
        this.gatewayTabIdByLocalId.set(id, gatewayTabId);
        return id;
      }
    }
    const id = this.nextLocalTabId++;
    if (gatewayTabId) {
      this.localTabIdByGatewayId.set(gatewayTabId, id);
      this.gatewayTabIdByLocalId.set(id, gatewayTabId);
    }
    return id;
  }

  private projectTabs(data: unknown): unknown {
    if (!isRecord(data) || !Array.isArray(data.tabs)) {
      throw new Error("Cloud browser returned an invalid tab list.");
    }
    const tabs = data.tabs.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ["tabId", "url", "title", "active"])
      ) {
        throw new Error("Cloud browser returned an invalid tab list.");
      }
      const gatewayTabId = requiredString(candidate.tabId, "tabId", 32);
      const tabId = this.localTabId(gatewayTabId);
      if (
        typeof candidate.url !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.active !== "boolean"
      ) {
        throw new Error("Cloud browser returned an invalid tab list.");
      }
      return Object.freeze({
        tabId,
        tabGeneration: `cloud:${tabId}`,
        url: candidate.url,
        title: candidate.title,
        active: candidate.active,
      });
    });
    return Object.freeze({
      tabs: Object.freeze(tabs),
      ...(tabs.find((tab) => tab.active)
        ? { activeTabId: tabs.find((tab) => tab.active)!.tabId }
        : {}),
    });
  }

  private planCommand(
    action: BrowserSessionAction,
    rawParams: Readonly<Record<string, unknown>>,
  ): CloudBrowserCommandPlan {
    const tabMetadata = ["tabId", "tabGeneration"] as const;
    const identity = (data: unknown) => data;
    switch (action) {
      case "tab_new": {
        const params = localParams(rawParams, ["url"]);
        const url = requiredString(params.url, "url");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new TypeError("url must be an absolute HTTPS URL.");
        }
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password
        ) {
          throw new TypeError("url must be an absolute HTTPS URL.");
        }
        return {
          action: "browser.open",
          params: {
            allowedOrigins: [parsed.origin],
            startUrl: parsed.toString(),
          },
          project: (data) => {
            const observation = observationFromData(data);
            const tabId = this.localTabId();
            this.syntheticActiveTabId = tabId;
            return Object.freeze({
              tabId,
              tabGeneration: `cloud:${tabId}`,
              url: observation.url,
              title: observation.title,
              active: true,
            });
          },
        };
      }
      case "navigate": {
        const params = localParams(rawParams, [
          ...tabMetadata,
          "url",
          "waitUntil",
          "timeout",
        ]);
        return {
          action: "browser.navigate",
          params: { url: requiredString(params.url, "url") },
          project: (data) => {
            const observation = observationFromData(data);
            return Object.freeze({
              url: observation.url,
              title: observation.title,
              snapshot: observation.text,
            });
          },
        };
      }
      case "snapshot": {
        localParams(rawParams, [
          ...tabMetadata,
          "interactive",
          "cursor",
          "maxDepth",
          "compact",
          "selector",
        ]);
        return {
          action: "browser.observe",
          params: {},
          project: (data) => {
            const observation = observationFromData(data);
            return Object.freeze({
              snapshot: observation.text,
              url: observation.url,
              title: observation.title,
            });
          },
        };
      }
      case "url": {
        localParams(rawParams, tabMetadata);
        return {
          action: "browser.observe",
          params: {},
          project: (data) => ({ url: observationFromData(data).url }),
        };
      }
      case "title": {
        localParams(rawParams, tabMetadata);
        return {
          action: "browser.observe",
          params: {},
          project: (data) => ({ title: observationFromData(data).title }),
        };
      }
      case "click": {
        const params = localParams(rawParams, [...tabMetadata, "selector"]);
        return {
          action: "browser.click",
          params: {
            selector: requiredString(params.selector, "selector", 512),
          },
          project: identity,
        };
      }
      case "fill": {
        const params = localParams(rawParams, [
          ...tabMetadata,
          "selector",
          "value",
        ]);
        return {
          action: "browser.fill",
          params: {
            selector: requiredString(params.selector, "selector", 512),
            value: requiredString(params.value, "value"),
            sensitivity: "non_secret",
          },
          project: identity,
        };
      }
      case "press": {
        const params = localParams(rawParams, [
          ...tabMetadata,
          "selector",
          "key",
        ]);
        return {
          action: "browser.press",
          params: {
            selector:
              params.selector === undefined
                ? "body"
                : requiredString(params.selector, "selector", 512),
            key: requiredString(params.key, "key", 64),
          },
          project: identity,
        };
      }
      case "select": {
        const params = localParams(rawParams, [
          ...tabMetadata,
          "selector",
          "values",
        ]);
        if (!Array.isArray(params.values) || params.values.length !== 1) {
          throw new Error("Cloud browser select requires exactly one value.");
        }
        return {
          action: "browser.select",
          params: {
            selector: requiredString(params.selector, "selector", 512),
            value: requiredString(params.values[0], "value", 1_024),
          },
          project: identity,
        };
      }
      case "wait": {
        const params = localParams(rawParams, [
          ...tabMetadata,
          "selector",
          "timeout",
          "timeoutMs",
        ]);
        const timeoutValue = params.timeoutMs ?? params.timeout;
        return {
          action: "browser.wait",
          params: {
            selector: requiredString(params.selector, "selector", 512),
            ...(timeoutValue === undefined
              ? {}
              : {
                  timeoutMs: requiredPositiveInteger(timeoutValue, "timeout"),
                }),
          },
          project: identity,
        };
      }
      case "tab_list": {
        localParams(rawParams, []);
        return {
          action: "browser.tabs",
          params: {},
          project: (data) => this.projectTabs(data),
        };
      }
      case "tab_switch": {
        const params = localParams(rawParams, ["tabId", "tabGeneration"]);
        const localId = requiredPositiveInteger(params.tabId, "tabId");
        const gatewayId = this.gatewayTabIdByLocalId.get(localId);
        if (!gatewayId) throw new Error("Unknown cloud browser tab.");
        return {
          action: "browser.focus_tab",
          params: { tabId: gatewayId },
          project: identity,
        };
      }
      case "finalize_tabs": {
        localParams(rawParams, ["keep"]);
        return {
          action: "browser.checkpoint",
          params: {},
          project: identity,
        };
      }
      case "tab_close": {
        localParams(rawParams, tabMetadata);
        return {
          action: "browser.close",
          params: {},
          project: (data) => {
            this.localTabIdByGatewayId.clear();
            this.gatewayTabIdByLocalId.clear();
            this.nextLocalTabId = 1;
            this.syntheticActiveTabId = undefined;
            return data;
          },
        };
      }
      case "cloud_login_takeover": {
        const params = localParams(rawParams, [
          "allowedOrigins",
          "displayOrigin",
          "displayTitle",
          "startUrl",
          "expiresInMs",
          "verification",
        ]);
        return {
          action: "browser.login_takeover",
          params,
          project: identity,
        };
      }
      case "cloud_device_code_fixture": {
        const params = localParams(rawParams, ["expiresInMs"]);
        return {
          action: "device_code.fixture_start",
          params,
          project: identity,
        };
      }
      default:
        throw new Error(`Cloud browser action '${action}' is unavailable.`);
    }
  }

  private async dispatch<TData>(
    action: BrowserSessionAction,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<BrowserCommandReceipt<TData>> {
    this.assertOpen();
    const plan = this.planCommand(action, params);
    const requestId = crypto.randomUUID();
    const request: CloudBrowserCommandRequest = {
      schemaVersion: 1,
      requestId,
      action: plan.action,
      params: plan.params,
    };
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.broker.postJson(
        CLOUD_BROWSER_COMMAND_PATH,
        request,
        signal,
      );
    } catch (cause) {
      throw new BrowserSessionCommandError(
        "execution_failed",
        "Cloud browser execution failed.",
        {
          requestId,
          action: plan.action,
          requestDispatched: true,
          outcomeUnknown: true,
          cause,
        },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrowserSessionCommandError(
        "execution_failed",
        "Cloud browser execution failed.",
        {
          requestId,
          action: plan.action,
          requestDispatched: true,
          outcomeUnknown: response.status >= 500,
        },
      );
    }

    let parsed: CloudBrowserCommandResponse;
    try {
      parsed = parseBrowserCommandResponse(
        await readBoundedBrowserResponse(response),
        requestId,
      );
    } catch (cause) {
      throw new BrowserSessionCommandError(
        "execution_failed",
        "Cloud browser returned an invalid response.",
        {
          requestId,
          action: plan.action,
          requestDispatched: true,
          outcomeUnknown: true,
          cause,
        },
      );
    }
    if (parsed.outcome === "suspended") {
      this.humanControlActive = true;
      throw new AgentToolSuspendedError(parsed.suspension);
    }
    if (parsed.outcome === "failed") {
      throw new BrowserSessionCommandError(
        "command_failed",
        "Cloud browser command failed.",
        {
          requestId,
          action: plan.action,
          requestDispatched: true,
          outcomeUnknown: parsed.outcomeUnknown === true,
        },
      );
    }
    return Object.freeze({
      sessionId: this.sessionId,
      bridgeSessionId: "cloud-browser-run",
      requestId,
      action,
      params: params as BrowserCommandParams,
      result: Object.freeze({
        id: requestId,
        success: true as const,
        ...(parsed.data === undefined
          ? {}
          : { data: plan.project(parsed.data) as TData }),
      }),
      attempts: 1,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  }
}

export const createTurnBrokerBrowserSessionFactory =
  (broker: BrowserBroker): BrowserSessionFactory =>
  (options) =>
    new TurnBrokerBrowserSession(broker, options.sessionId);
