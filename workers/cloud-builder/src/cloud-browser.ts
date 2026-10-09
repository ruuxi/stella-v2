/**
 * The cloud browser as a pi agent's `code` sees it.
 *
 * Browser Run lives behind the private Browser Gateway, and every command is
 * a bounded JSON request, so nothing about it needs a container: the
 * conversation's Durable Object forwards each command under the agent run's
 * own authority. The model-facing surface mirrors the desktop agent's:
 * Playwright selectors, page scripts, cookies, the network log, and
 * screenshots.
 *
 * A login handoff is the one command that does not complete. The gateway puts
 * the profile under human control and answers with a secret-free suspension;
 * the `code` call ends as `AgentToolSuspendedError`, and the agent's run holds
 * that call open until the user finishes on their device
 * (`PiConversationRuntime`), then answers it with how the handoff ended.
 */
import {
  isCloudBrowserSuspension,
  type CloudBrowserCommandRequest,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import { readBoundedResponseBytes } from "./bounded-body.js";

/** How long the gateway may take to give a profile back. */
const GATEWAY_CANCEL_TIMEOUT_MS = 30_000;
/** A screenshot or a response body can be large; anything past this is refused. */
const GATEWAY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/** Whose command it is: the gateway binds a handoff to exactly this. */
export type CloudBrowserAuthority = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
}>;

export type ForwardedBrowserGatewayCommand =
  | Readonly<{ kind: "failure"; status: number }>
  | Readonly<{ kind: "forwarded"; status: number; body: Uint8Array }>;

/** Forward one command under the caller's authority. */
export type CloudBrowserTransport = (
  command: CloudBrowserCommandRequest,
  signal: AbortSignal,
) => Promise<ForwardedBrowserGatewayCommand>;

/** Commands to the private Browser Gateway over its service binding. */
export const gatewayBrowserTransport =
  (gateway: Fetcher, authority: CloudBrowserAuthority): CloudBrowserTransport =>
  async (command, signal) => {
    let response: Response;
    try {
      response = await gateway.fetch("https://browser-gateway/internal/turn/command", {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ schemaVersion: 1, authority, command }),
        signal,
        redirect: "manual",
      });
    } catch {
      return { kind: "failure", status: signal.aborted ? 410 : 502 };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failure", status: 502 };
    }
    try {
      return {
        kind: "forwarded",
        status: response.status,
        body: await readBoundedResponseBytes(response, GATEWAY_RESPONSE_MAX_BYTES),
      };
    } catch {
      return { kind: "failure", status: 502 };
    }
  };

/**
 * Give a handed-off profile back to agents at once, through the gateway's own
 * decision route: for a handoff no client can show the user (its interaction
 * could not be recorded), which would otherwise hold the profile until its
 * deadline.
 */
export const cancelGatewayHandoff = async (
  gateway: Fetcher,
  authority: CloudBrowserAuthority,
  suspension: CloudBrowserSuspension,
): Promise<void> => {
  const response = await gateway.fetch("https://browser-gateway/internal/interactions/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      authority,
      profileId: suspension.profileId,
      profileEpoch: suspension.profileEpoch,
      interactionId: suspension.interactionId,
      interactionRevision: suspension.interactionRevision,
      decision: "cancel",
    }),
    signal: AbortSignal.timeout(GATEWAY_CANCEL_TIMEOUT_MS),
    redirect: "manual",
  });
  await response.body?.cancel().catch(() => undefined);
};

export type CloudBrowserMethod =
  | "open"
  | "navigate"
  | "observe"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "wait"
  | "tabs"
  | "focusTab"
  | "back"
  | "forward"
  | "reload"
  | "hover"
  | "scroll"
  | "check"
  | "uncheck"
  | "text"
  | "screenshot"
  | "evaluate"
  | "cookies"
  | "setCookies"
  | "clearCookies"
  | "requests"
  | "responseBody"
  | "close"
  | "requestLoginTakeover"
  | "requestDeviceCodeFixture";

export const CLOUD_BROWSER_METHODS: ReadonlySet<string> =
  new Set<CloudBrowserMethod>([
    "open",
    "navigate",
    "observe",
    "click",
    "fill",
    "press",
    "select",
    "wait",
    "tabs",
    "focusTab",
    "back",
    "forward",
    "reload",
    "hover",
    "scroll",
    "check",
    "uncheck",
    "text",
    "screenshot",
    "evaluate",
    "cookies",
    "setCookies",
    "clearCookies",
    "requests",
    "responseBody",
    "close",
    "requestLoginTakeover",
    "requestDeviceCodeFixture",
  ]);

/**
 * Thrown into the sandbox once the profile is under human control. The outer
 * `code` tool reads the recorded suspension, not this error, so a cell that
 * catches it still ends the turn as a handoff.
 */
export class CloudBrowserSuspendedError extends Error {
  constructor() {
    super(
      "The browser is waiting for the user to finish signing in. Stop here; this step resumes once they are done.",
    );
    this.name = "CloudBrowserSuspendedError";
  }
}

/**
 * What `screenshot` resolves to on the host. The code tool lifts the image
 * into the call's result for the model; the sandbox only learns it was taken.
 */
export type CloudBrowserScreenshot = Readonly<{
  image: Readonly<{
    mimeType: "image/jpeg";
    data: string;
    width: number;
    height: number;
  }>;
}>;

export type CloudBrowserClient = Readonly<{
  call(
    method: string,
    args: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
  /** The handoff this run is waiting on, if a takeover suspended it. */
  suspension(): CloudBrowserSuspension | undefined;
  /** The handoff ended (the user finished, canceled, or it expired): commands may run again. */
  resumed(): void;
  /** Whether any command reached the gateway and so may need a checkpoint. */
  used(): boolean;
  /** Persist the profile at the end of a run that is not handing off. */
  checkpoint(signal: AbortSignal): Promise<void>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/**
 * Defense in depth: a Live View URL is the human's control capability for a
 * handoff and is never an agent's to hold, whatever a page script returns.
 */
const assertCapabilityFree = (value: unknown, seen = new Set<object>()): void => {
  if (typeof value === "string") {
    if (!value.includes("live.browser.run")) return;
    let hostname: string | undefined;
    try {
      hostname = new URL(value).hostname.toLowerCase();
    } catch {
      return;
    }
    if (hostname === "live.browser.run") {
      throw new Error("Cloud browser response contained a private capability.");
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertCapabilityFree(nested, seen);
  }
};

type GatewayOutcome =
  | Readonly<{ outcome: "completed"; data?: unknown }>
  | Readonly<{ outcome: "failed"; code: string; detail?: string }>
  | Readonly<{ outcome: "suspended"; suspension: CloudBrowserSuspension }>;

const parseGatewayResponse = (
  body: Uint8Array,
  requestId: string,
): GatewayOutcome => {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    throw new Error("Cloud browser returned an invalid response.");
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Cloud browser returned an invalid response.");
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
    assertCapabilityFree(value.data);
    return value.data === undefined
      ? { outcome: "completed" }
      : { outcome: "completed", data: value.data };
  }
  if (
    value.outcome === "suspended" &&
    hasExactKeys(value, ["schemaVersion", "outcome", "suspension"]) &&
    isCloudBrowserSuspension(value.suspension) &&
    value.suspension.toolCallId === requestId
  ) {
    return { outcome: "suspended", suspension: value.suspension };
  }
  if (
    value.outcome === "failed" &&
    value.requestId === requestId &&
    typeof value.code === "string" &&
    /^[a-z_]{1,64}$/u.test(value.code)
  ) {
    return { outcome: "failed", code: value.code };
  }
  // The gateway's error envelope (`publicErrorResponse`).
  if (
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    /^[a-z_]{1,64}$/u.test(value.error.code)
  ) {
    return {
      outcome: "failed",
      code: value.error.code,
      ...(typeof value.error.detail === "string"
        ? { detail: value.error.detail.slice(0, 2_000) }
        : {}),
    };
  }
  throw new Error("Cloud browser returned an invalid response.");
};

const requireString = (value: unknown, name: string, max = 4_096): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(`browser: ${name} must be a non-empty string.`);
  }
  return value.trim();
};

const optionalObject = (value: unknown, name: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new TypeError(`browser: ${name} must be a plain object.`);
  }
  return value;
};

const httpsOrigin = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("browser: url must be an absolute https:// URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError("browser: url must be an absolute https:// URL.");
  }
  return parsed.origin;
};

type Plan = Readonly<{
  action: string;
  params: Record<string, unknown>;
}>;

const planFor = (method: CloudBrowserMethod, args: readonly unknown[]): Plan => {
  switch (method) {
    case "open": {
      const url = requireString(args[0], "url");
      const options = optionalObject(args[1], "options");
      const origin = httpsOrigin(url);
      const extra = options.allowedOrigins;
      if (
        extra !== undefined &&
        (!Array.isArray(extra) || extra.some((entry) => typeof entry !== "string"))
      ) {
        throw new TypeError("browser: allowedOrigins must be an array of origins.");
      }
      const allowedOrigins = [
        ...new Set([origin, ...((extra as string[] | undefined) ?? [])]),
      ];
      return {
        action: "browser.open",
        params: { allowedOrigins, startUrl: url },
      };
    }
    case "navigate":
      return {
        action: "browser.navigate",
        params: { url: requireString(args[0], "url") },
      };
    case "observe":
      return { action: "browser.observe", params: {} };
    case "click":
      return {
        action: "browser.click",
        params: { selector: requireString(args[0], "selector", 4_096) },
      };
    case "fill": {
      if (typeof args[1] !== "string") {
        throw new TypeError("browser: value must be a string.");
      }
      return {
        action: "browser.fill",
        params: {
          selector: requireString(args[0], "selector", 4_096),
          value: args[1],
        },
      };
    }
    case "press":
      return {
        action: "browser.press",
        params: {
          selector: requireString(args[0], "selector", 4_096),
          key: requireString(args[1], "key", 64),
        },
      };
    case "select":
      return {
        action: "browser.select",
        params: {
          selector: requireString(args[0], "selector", 4_096),
          value: requireString(args[1], "value", 1_024),
        },
      };
    case "wait": {
      const timeoutMs = args[1];
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)
      ) {
        throw new TypeError("browser: timeoutMs must be a positive integer.");
      }
      return {
        action: "browser.wait",
        params: {
          selector: requireString(args[0], "selector", 4_096),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      };
    }
    case "tabs":
      return { action: "browser.tabs", params: {} };
    case "focusTab":
      return {
        action: "browser.focus_tab",
        params: { tabId: requireString(args[0], "tabId", 32) },
      };
    case "back":
    case "forward":
    case "reload":
      return { action: `browser.${method}`, params: {} };
    case "hover":
    case "check":
    case "uncheck":
    case "text":
      return {
        action: `browser.${method}`,
        params: { selector: requireString(args[0], "selector", 4_096) },
      };
    case "scroll": {
      const options = optionalObject(args[0], "options");
      const allowed = new Set(["direction", "amount", "selector"]);
      if (Object.keys(options).some((key) => !allowed.has(key))) {
        throw new TypeError(
          "browser.scroll: options are { direction?, amount?, selector? }.",
        );
      }
      return {
        action: "browser.scroll",
        params: {
          direction: options.direction ?? "down",
          ...(options.amount === undefined ? {} : { amount: options.amount }),
          ...(options.selector === undefined
            ? {}
            : { selector: requireString(options.selector, "selector", 4_096) }),
        },
      };
    }
    case "screenshot": {
      const options = optionalObject(args[0], "options");
      return {
        action: "browser.screenshot",
        params: options.fullPage === true ? { fullPage: true } : {},
      };
    }
    case "evaluate":
      return {
        action: "browser.evaluate",
        params: {
          script: requireString(args[0], "script", 512 * 1024),
          ...(args.length > 1 ? { arg: args[1] } : {}),
        },
      };
    case "cookies": {
      const urls = args[0];
      if (urls !== undefined && !Array.isArray(urls)) {
        throw new TypeError("browser.cookies: urls must be an array.");
      }
      return { action: "browser.cookies", params: urls ? { urls } : {} };
    }
    case "setCookies":
      if (!Array.isArray(args[0])) {
        throw new TypeError("browser.setCookies: cookies must be an array.");
      }
      return { action: "browser.set_cookies", params: { cookies: args[0] } };
    case "clearCookies":
      return { action: "browser.clear_cookies", params: {} };
    case "requests": {
      const options = optionalObject(args[0], "options");
      return {
        action: "browser.requests",
        params: options.limit === undefined ? {} : { limit: options.limit },
      };
    }
    case "responseBody":
      return {
        action: "browser.response_body",
        params: { url: requireString(args[0], "url", 8_192) },
      };
    case "close":
      return { action: "browser.close", params: {} };
    case "requestLoginTakeover": {
      const options = optionalObject(args[0], "options");
      const allowed = new Set([
        "allowedOrigins",
        "displayOrigin",
        "displayTitle",
        "startUrl",
        "expiresInMs",
        "verification",
      ]);
      if (Object.keys(options).some((key) => !allowed.has(key))) {
        throw new TypeError(
          "browser.requestLoginTakeover: unsupported option. Allowed: allowedOrigins, displayOrigin, startUrl, displayTitle, expiresInMs, verification.",
        );
      }
      return { action: "browser.login_takeover", params: options };
    }
    case "requestDeviceCodeFixture":
      return {
        action: "device_code.fixture_start",
        params: optionalObject(args[0], "options"),
      };
  }
};

export const createCloudBrowserClient = (
  transport: CloudBrowserTransport,
): CloudBrowserClient => {
  let suspension: CloudBrowserSuspension | undefined;
  let used = false;

  const send = async (plan: Plan, signal: AbortSignal): Promise<unknown> => {
    const command: CloudBrowserCommandRequest = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      action: plan.action,
      params: plan.params,
    };
    used = true;
    const forwarded = await transport(command, signal);
    if (forwarded.kind === "failure") {
      throw new Error(
        forwarded.status === 503
          ? "The cloud browser is not available in this deployment."
          : `The cloud browser could not run ${plan.action} (${forwarded.status}).`,
      );
    }
    const outcome = parseGatewayResponse(forwarded.body, command.requestId);
    if (outcome.outcome === "failed") {
      throw new Error(
        `Cloud browser ${plan.action} failed: ${outcome.code}${outcome.detail ? ` — ${outcome.detail}` : ""}.`,
      );
    }
    if (outcome.outcome === "suspended") {
      suspension = outcome.suspension;
      throw new CloudBrowserSuspendedError();
    }
    return outcome.data;
  };

  return {
    call: async (method, args, signal) => {
      if (!CLOUD_BROWSER_METHODS.has(method)) {
        throw new Error(`browser.${method || "?"} is not a browser method.`);
      }
      // Browser Run is fenced while the human owns it; nothing else may touch
      // the profile until the handoff ends.
      if (suspension) throw new CloudBrowserSuspendedError();
      const data = await send(
        planFor(method as CloudBrowserMethod, args),
        signal,
      );
      const observation =
        isRecord(data) && isRecord(data.observation)
          ? data.observation
          : undefined;
      switch (method) {
        case "open":
          return {
            ...(observation ?? {}),
            restored: isRecord(data) && data.restored === true,
          };
        case "navigate":
        case "observe":
        case "back":
        case "forward":
        case "reload":
          return observation ?? data;
        case "text":
          return isRecord(data) && typeof data.text === "string"
            ? data.text
            : "";
        case "evaluate":
          return isRecord(data) ? data.result : undefined;
        case "cookies":
          return isRecord(data) && Array.isArray(data.cookies) ? data.cookies : [];
        case "requests":
          return isRecord(data) && Array.isArray(data.requests)
            ? data.requests
            : [];
        case "screenshot": {
          const shot = isRecord(data) ? data.screenshot : undefined;
          if (
            !isRecord(shot) ||
            shot.mimeType !== "image/jpeg" ||
            typeof shot.data !== "string" ||
            !/^[A-Za-z0-9+/]+={0,2}$/u.test(shot.data)
          ) {
            throw new Error("Cloud browser returned an invalid screenshot.");
          }
          return {
            image: {
              mimeType: shot.mimeType,
              data: shot.data,
              width: Number(shot.width) || 0,
              height: Number(shot.height) || 0,
            },
          } satisfies CloudBrowserScreenshot;
        }
        default:
          return data;
      }
    },
    suspension: () => suspension,
    resumed: () => {
      suspension = undefined;
    },
    used: () => used,
    checkpoint: async (signal) => {
      if (!used || suspension) return;
      await send({ action: "browser.checkpoint", params: {} }, signal);
    },
  };
};
