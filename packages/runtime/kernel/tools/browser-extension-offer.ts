import type { ToolResult } from "./types.js";

export type BrowserExtensionConnectOutcome =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

export type BrowserExtensionConnectRequester = (
  payload: {
    conversationId?: string;
    agentId?: string;

    command?: string;
  },

  signal?: AbortSignal,
) => Promise<BrowserExtensionConnectOutcome>;

const EXTENSION_FAILURE_PATTERN =
  /Extension not connected|Install the Stella Browser Bridge extension/i;

const TRANSIENT_EXTENSION_PATTERN =
  /Extension connection is dead|will auto-reconnect/i;

const STELLA_BROWSER_COMMAND_PATTERN = /(^|[\s;|&("'`])stella-browser(\s|$)/;

const OFFER_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

const DECLINE_COOLDOWN_MS = 15 * 60 * 1000;

type OfferGateState = {

  lastRefusedAt: number | null;

  inFlight: boolean;
};

const gate: OfferGateState = { lastRefusedAt: null, inFlight: false };

export const resetBrowserExtensionOfferGate = () => {
  gate.lastRefusedAt = null;
  gate.inFlight = false;
};

export const isBrowserExtensionFailure = (
  command: string,
  payload: { running?: unknown; output?: unknown } | undefined,
): boolean => {
  if (!payload || payload.running === true) return false;
  if (!STELLA_BROWSER_COMMAND_PATTERN.test(command)) return false;
  const output = typeof payload.output === "string" ? payload.output : "";
  if (!EXTENSION_FAILURE_PATTERN.test(output)) return false;
  if (TRANSIENT_EXTENSION_PATTERN.test(output)) return false;
  return true;
};

const execPayloadOf = (
  result: ToolResult,
):
  | (Record<string, unknown> & { running?: unknown; output?: unknown })
  | null => {
  const payload = result.result;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (typeof payload !== "string") return null;
  const details =
    result.details &&
    typeof result.details === "object" &&
    !Array.isArray(result.details)
      ? (result.details as Record<string, unknown>)
      : {};
  return { ...details, output: payload };
};

const annotate = (result: ToolResult, note: string): ToolResult => {
  const payload = execPayloadOf(result);
  if (!payload) return result;
  const details =
    result.details &&
    typeof result.details === "object" &&
    !Array.isArray(result.details)
      ? { ...(result.details as Record<string, unknown>) }
      : {};
  delete details.output;
  if (typeof result.result === "string") {
    return {
      ...result,
      result: `${result.result}\nNote: ${note}`,
      details: { ...details, note },
    };
  }
  return {
    ...result,
    result: { ...payload, note },
    details: { ...details, note },
  };
};

const withTimeout = async (
  promise: Promise<BrowserExtensionConnectOutcome>,
  timeoutMs: number,
): Promise<BrowserExtensionConnectOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<BrowserExtensionConnectOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const maybeRequestBrowserExtensionConnect = async (options: {
  output: string;
  command?: string;
  requestConnect?: BrowserExtensionConnectRequester;
  conversationId?: string;
  agentId?: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<BrowserExtensionConnectOutcome | null> => {
  const command = options.command ?? "stella-browser";
  const now = options.now ?? Date.now;
  if (!options.requestConnect || options.signal?.aborted) return null;
  if (
    !isBrowserExtensionFailure(command, {
      running: false,
      output: options.output,
    })
  ) {
    return null;
  }
  if (gate.inFlight) return { ok: false, reason: "already_in_flight" };
  if (
    gate.lastRefusedAt !== null &&
    now() - gate.lastRefusedAt < DECLINE_COOLDOWN_MS
  ) {
    return { ok: false, reason: "cooldown" };
  }

  gate.inFlight = true;
  let outcome: BrowserExtensionConnectOutcome;
  try {
    outcome = await withTimeout(
      options.requestConnect(
        {
          ...(options.conversationId
            ? { conversationId: options.conversationId }
            : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
          command,
        },
        options.signal,
      ),
      OFFER_WAIT_TIMEOUT_MS,
    );
  } catch (error) {
    outcome = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    gate.inFlight = false;
  }
  if (
    !outcome.ok &&
    (outcome.reason === "declined" || outcome.reason === "timeout")
  ) {
    gate.lastRefusedAt = now();
  }
  return outcome;
};

export const maybeOfferBrowserExtensionConnect = async (options: {
  result: ToolResult;
  command: string;
  requestConnect?: BrowserExtensionConnectRequester;
  rerun: () => Promise<ToolResult>;
  conversationId?: string;
  agentId?: string;
  signal?: AbortSignal;

  now?: () => number;
}): Promise<ToolResult> => {
  const {
    result,
    command,
    requestConnect,
    rerun,
    conversationId,
    agentId,
    signal,
  } = options;
  const now = options.now ?? Date.now;
  if (!requestConnect) return result;
  if (signal?.aborted) return result;
  const payload = execPayloadOf(result);
  if (!payload || !isBrowserExtensionFailure(command, payload)) return result;

  if (gate.inFlight) {
    return annotate(
      result,
      "The Stella browser extension is not connected and a connect card is already open in the chat. Wait for the user's response before retrying the browser operation. If the browser service remains unavailable, report the exact browser error and park the browser-dependent step.",
    );
  }
  if (
    gate.lastRefusedAt !== null &&
    now() - gate.lastRefusedAt < DECLINE_COOLDOWN_MS
  ) {
    return annotate(
      result,
      "The Stella browser extension is not connected and the user recently declined (or ignored) the connect offer. Do not re-offer or switch to a visible Chrome/Brave browser. Report the exact browser error and park the browser-dependent step; continue only work that does not require browser access.",
    );
  }

  gate.inFlight = true;
  let outcome: BrowserExtensionConnectOutcome;
  try {
    outcome = await withTimeout(
      requestConnect(
        {
          ...(conversationId ? { conversationId } : {}),
          ...(agentId ? { agentId } : {}),
          command,
        },
        signal,
      ),
      OFFER_WAIT_TIMEOUT_MS,
    );
  } catch (error) {
    outcome = { ok: false, reason: (error as Error).message || "bridge_error" };
  } finally {
    gate.inFlight = false;
  }

  if (signal?.aborted) return result;

  if (!outcome.ok) {
    if (outcome.reason === "declined" || outcome.reason === "timeout") {
      gate.lastRefusedAt = now();
      return annotate(
        result,
        outcome.reason === "declined"
          ? "A connect card for the Stella browser extension was shown in the chat and the user declined. Acknowledge once at most (it stays available in settings), do not re-offer or switch to a visible Chrome/Brave browser, report the exact browser error, and park the browser-dependent step."
          : "A connect card for the Stella browser extension was shown in the chat but the user did not respond in time. Do not re-offer or switch to a visible Chrome/Brave browser. Report the exact browser error and park the browser-dependent step.",
      );
    }

    return result;
  }

  const retried = await rerun();
  if (isBrowserExtensionFailure(command, execPayloadOf(retried) ?? undefined)) {

    gate.lastRefusedAt = now();
    return annotate(
      retried,
      "The user accepted the browser-extension connect card, but the browser service still cannot reach the extension (the browser may be closed or the extension disabled). Do not re-offer or switch to a visible Chrome/Brave browser. Report the exact browser error from the retry and park the browser-dependent step.",
    );
  }
  return annotate(
    retried,
    "The user connected the Stella browser extension via the inline card and the intercepted browser operation was re-run automatically above. Continue the original task.",
  );
};
