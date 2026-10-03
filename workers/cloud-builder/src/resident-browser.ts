/**
 * The cloud browser as a resident turn's `code` sees it.
 *
 * Browser Run lives behind the private Browser Gateway, and every command is
 * a bounded JSON request, so nothing about it needs a container: the Durable
 * Object forwards each command under the turn's own authority, exactly as the
 * turn broker does for the container executor. The model-facing surface is
 * the gateway's allowlist and nothing more — no evaluate, no CDP, no cookies.
 *
 * A login handoff is the one command that does not complete. The gateway puts
 * the profile under human control and answers with a secret-free suspension;
 * the caller records it, the `code` call ends as `AgentToolSuspendedError`,
 * and the turn parks until the user finishes on their device.
 */
import {
  isCloudBrowserSuspension,
  type CloudBrowserCommandRequest,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import type { ForwardedBrowserGatewayCommand } from "./build-session/turn-broker.js";
import { sha256Hex } from "./hash.js";

/** Forward one command; the caller owns authority and suspension observation. */
export type ResidentBrowserTransport = (
  command: CloudBrowserCommandRequest,
  input: Readonly<{ requestFingerprint: string; signal: AbortSignal }>,
) => Promise<ForwardedBrowserGatewayCommand>;

export type ResidentBrowserMethod =
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
  | "close"
  | "requestLoginTakeover"
  | "requestDeviceCodeFixture";

export const RESIDENT_BROWSER_METHODS: ReadonlySet<string> =
  new Set<ResidentBrowserMethod>([
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
    "close",
    "requestLoginTakeover",
    "requestDeviceCodeFixture",
  ]);

/**
 * Thrown into the sandbox once the profile is under human control. The outer
 * `code` tool reads the recorded suspension, not this error, so a cell that
 * catches it still ends the turn as a handoff.
 */
export class ResidentBrowserSuspendedError extends Error {
  constructor() {
    super(
      "The browser is waiting for the user to finish signing in. Stop here; this step resumes once they are done.",
    );
    this.name = "ResidentBrowserSuspendedError";
  }
}

/**
 * What `screenshot` resolves to on the host. The code tool lifts the image
 * into the call's result for the model; the sandbox only learns it was taken.
 */
export type ResidentBrowserScreenshot = Readonly<{
  image: Readonly<{
    mimeType: "image/jpeg";
    data: string;
    width: number;
    height: number;
  }>;
}>;

export type ResidentBrowserClient = Readonly<{
  call(
    method: string,
    args: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
  /** The handoff this turn is waiting on, if a takeover suspended it. */
  suspension(): CloudBrowserSuspension | undefined;
  /** Whether any command reached the gateway and so may need a checkpoint. */
  used(): boolean;
  /**
   * Persist the profile at the end of a turn that is not handing off, the
   * way the container path's `finalize_tabs` does before teardown.
   */
  checkpoint(signal: AbortSignal): Promise<void>;
}>;

const SENSITIVE_RESULT_KEYS = new Set([
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Defense in depth against a gateway accidentally returning private state. */
const assertCapabilityFree = (value: unknown, seen = new Set<object>()): void => {
  if (typeof value === "string") {
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
  if (Array.isArray(value)) {
    for (const item of value) assertCapabilityFree(item, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_RESULT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ""))) {
      throw new Error("Cloud browser response contained private browser state.");
    }
    assertCapabilityFree(nested, seen);
  }
};

type GatewayOutcome =
  | Readonly<{ outcome: "completed"; data?: unknown }>
  | Readonly<{ outcome: "failed"; code: string }>
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

const planFor = (method: ResidentBrowserMethod, args: readonly unknown[]): Plan => {
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
        params: { selector: requireString(args[0], "selector", 512) },
      };
    case "fill":
      return {
        action: "browser.fill",
        params: {
          selector: requireString(args[0], "selector", 512),
          value: requireString(args[1], "value"),
          sensitivity: "non_secret",
        },
      };
    case "press":
      return {
        action: "browser.press",
        params: {
          selector: requireString(args[0], "selector", 512),
          key: requireString(args[1], "key", 64),
        },
      };
    case "select":
      return {
        action: "browser.select",
        params: {
          selector: requireString(args[0], "selector", 512),
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
          selector: requireString(args[0], "selector", 512),
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
        params: { selector: requireString(args[0], "selector", 512) },
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
            : { selector: requireString(options.selector, "selector", 512) }),
        },
      };
    }
    case "screenshot":
      return { action: "browser.screenshot", params: {} };
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

export const createResidentBrowserClient = (
  transport: ResidentBrowserTransport,
): ResidentBrowserClient => {
  let suspension: CloudBrowserSuspension | undefined;
  let used = false;

  const send = async (plan: Plan, signal: AbortSignal): Promise<unknown> => {
    const command: CloudBrowserCommandRequest = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      action: plan.action,
      params: plan.params,
    };
    const requestFingerprint = await sha256Hex(JSON.stringify(command));
    used = true;
    const forwarded = await transport(command, { requestFingerprint, signal });
    if (forwarded.kind === "failure") {
      throw new Error(
        forwarded.status === 503
          ? "The cloud browser is not available in this deployment."
          : `The cloud browser could not run ${plan.action} (${forwarded.status}).`,
      );
    }
    const outcome = parseGatewayResponse(forwarded.body, command.requestId);
    if (outcome.outcome === "failed") {
      throw new Error(`Cloud browser ${plan.action} failed: ${outcome.code}.`);
    }
    if (outcome.outcome === "suspended") {
      suspension = outcome.suspension;
      throw new ResidentBrowserSuspendedError();
    }
    return outcome.data;
  };

  return {
    call: async (method, args, signal) => {
      if (!RESIDENT_BROWSER_METHODS.has(method)) {
        throw new Error(`browser.${method || "?"} is not a browser method.`);
      }
      // Browser Run is fenced while the human owns it; nothing else may touch
      // the profile until the turn that resumes it.
      if (suspension) throw new ResidentBrowserSuspendedError();
      const data = await send(
        planFor(method as ResidentBrowserMethod, args),
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
          } satisfies ResidentBrowserScreenshot;
        }
        default:
          return data;
      }
    },
    suspension: () => suspension,
    used: () => used,
    checkpoint: async (signal) => {
      if (!used || suspension) return;
      await send({ action: "browser.checkpoint", params: {} }, signal);
    },
  };
};
