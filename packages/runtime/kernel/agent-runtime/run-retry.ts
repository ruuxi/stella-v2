import { isTransientTransportError } from "../../ai/utils/retry.js";

export const AGENT_RUN_MAX_RETRIES = 3;
export const AGENT_RUN_MAX_ATTEMPTS = AGENT_RUN_MAX_RETRIES + 1;
export const AGENT_RUN_RETRY_DELAYS_MS = [1_000, 2_500, 6_000] as const;
export const AGENT_RUN_RETRY_JITTER_RATIO = 0.1;

export type AgentRunFailureCategory =
  | "server-error"
  | "quota"
  | "relay-stream-lost"
  | "relay-response-missing"
  | "transport"
  | "auth"
  | "invalid-model-route"
  | "canceled"
  | "unknown";

export type AgentRunFailureClassification = {
  retryable: boolean;
  category: AgentRunFailureCategory;
};

export type AgentRunRetryState = {
  retriesUsed: number;
};

export type AgentRunRetryInfo = {
  retryNumber: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  category: AgentRunFailureCategory;
  reason: string;
};

type ExecutionResult = {
  finalText: string;
  errorMessage?: string;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor !== undefined && cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    chain.push(cursor);
    cursor =
      typeof cursor === "object" && cursor !== null
        ? (cursor as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
};

const numericStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate =
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode ??
    (error as { response?: { status?: unknown } }).response?.status;
  return typeof candidate === "number" ? candidate : undefined;
};

const stringCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string"
    ? candidate.trim().toLowerCase()
    : undefined;
};

/**
 * Classify only failures that are safe to resume from the retained turn state.
 * A generic 404 is deliberately not retryable: only the relay's missing-response
 * shape is transient, while model/route 404s must fail fast.
 */
export const classifyAgentRunFailure = (
  error: unknown,
  abortSignal?: AbortSignal,
): AgentRunFailureClassification => {
  if (abortSignal?.aborted) {
    return { retryable: false, category: "canceled" };
  }

  const chain = errorChain(error);
  const messages = chain.map(errorMessage);
  const combined = messages.join("\n");
  const codes = chain
    .map(stringCode)
    .filter((code): code is string => Boolean(code));
  const statuses = chain
    .map(numericStatus)
    .filter((status): status is number => status !== undefined);

  if (
    /^(?:aborted|canceled|cancelled|canceled because .+|cancelled because .+|interrupted by .+|request was aborted|request aborted by user|this operation was aborted)\.?$/im.test(
      combined.trim(),
    )
  ) {
    return { retryable: false, category: "canceled" };
  }
  if (
    statuses.some((status) => status === 401 || status === 403) ||
    /\b(?:401|403)\b[^\n]*(?:unauthori[sz]ed|forbidden|auth)|(?:unauthori[sz]ed|forbidden|invalid api key|authentication failed)/i.test(
      combined,
    )
  ) {
    return { retryable: false, category: "auth" };
  }
  if (
    /(?:invalid|unknown|unsupported)\s+(?:model|route)|(?:model|route)\s+(?:is\s+)?(?:invalid|unknown|unsupported|not found)|no model configured|no api key for provider/i.test(
      combined,
    )
  ) {
    return { retryable: false, category: "invalid-model-route" };
  }

  if (
    codes.includes("relay_stream_lost") ||
    /\brelay_stream_lost\b|relay stream (?:was )?lost|upstream response (?:was )?lost before a terminal event/i.test(
      combined,
    )
  ) {
    return { retryable: true, category: "relay-stream-lost" };
  }
  if (
    /(?:\b404\b[^\n]*relay response[^\n]*not found|relay response[^\n]*(?:not found|\b404\b)|response not found[^\n]*relay)/i.test(
      combined,
    )
  ) {
    return { retryable: true, category: "relay-response-missing" };
  }
  if (
    statuses.some((status) => status === 429) ||
    /\b429\b|transient relay buffer quota exceeded|relay buffer quota|too many requests|rate limit(?:ed| exceeded)?/i.test(
      combined,
    )
  ) {
    return { retryable: true, category: "quota" };
  }
  if (
    statuses.some((status) => status >= 500 && status <= 599) ||
    /\b5\d\d\b[^\n]*(?:server error|status|response)|(?:server error|http status|response status)[^\n]*\b5\d\d\b/i.test(
      combined,
    )
  ) {
    return { retryable: true, category: "server-error" };
  }
  if (
    chain.some(isTransientTransportError) ||
    /unexpected\s+eof|\beof\b|end of file|transport eof|connection recovery failed|socket hang up|fetch failed|failed to fetch|connection (?:reset|refused|timed?\s*out)|\beconnreset\b|\betimedout\b|timed?\s*out|timeout|agent (?:did not produce|produced no) activity/i.test(
      combined,
    )
  ) {
    return { retryable: true, category: "transport" };
  }

  return { retryable: false, category: "unknown" };
};

const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Request was aborted"),
      );
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Request was aborted"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const retryDelayMs = (retryIndex: number, random: () => number): number => {
  const base =
    AGENT_RUN_RETRY_DELAYS_MS[retryIndex] ?? AGENT_RUN_RETRY_DELAYS_MS.at(-1)!;
  const jitter = 1 + (random() * 2 - 1) * AGENT_RUN_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(base * jitter));
};

const exhaustedMessage = (reason: string): string =>
  `Agent run failed after ${AGENT_RUN_MAX_ATTEMPTS} attempts (${AGENT_RUN_MAX_RETRIES} automatic retries): ${reason}`;

/**
 * Retry a native agent execution by resuming its existing state. The caller's
 * `prepareResume` must remove only the errored assistant tail; prior user,
 * tool-call, tool-result, and report acknowledgement state remains in place.
 */
export const executeAgentRunWithRetry = async <
  T extends ExecutionResult,
>(args: {
  state: AgentRunRetryState;
  execute: (resume: boolean) => Promise<T>;
  initialResume?: boolean;
  prepareResume: (reason: string) => boolean;
  abortSignal?: AbortSignal;
  onRetry?: (info: AgentRunRetryInfo) => void;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> => {
  let resume = args.initialResume === true;
  const random = args.random ?? Math.random;
  const sleep = args.sleep ?? sleepWithAbort;

  for (;;) {
    let result: T;
    try {
      result = await args.execute(resume);
    } catch (error) {
      const reason = errorMessage(error);
      const classification = classifyAgentRunFailure(error, args.abortSignal);
      if (
        !classification.retryable ||
        args.state.retriesUsed >= AGENT_RUN_MAX_RETRIES
      ) {
        if (
          classification.retryable &&
          args.state.retriesUsed >= AGENT_RUN_MAX_RETRIES
        ) {
          throw new Error(exhaustedMessage(reason), { cause: error });
        }
        throw error;
      }
      if (!args.prepareResume(reason)) throw error;
      const retryNumber = args.state.retriesUsed + 1;
      const delayMs = retryDelayMs(args.state.retriesUsed, random);
      args.state.retriesUsed = retryNumber;
      try {
        args.onRetry?.({
          retryNumber,
          nextAttempt: retryNumber + 1,
          maxAttempts: AGENT_RUN_MAX_ATTEMPTS,
          delayMs,
          category: classification.category,
          reason,
        });
      } catch {
        // Activity reporting cannot break recovery.
      }
      await sleep(delayMs, args.abortSignal);
      resume = true;
      continue;
    }

    const reason = result.errorMessage?.trim();
    if (!reason) return result;
    const classification = classifyAgentRunFailure(reason, args.abortSignal);
    if (!classification.retryable) return result;
    if (args.state.retriesUsed >= AGENT_RUN_MAX_RETRIES) {
      return { ...result, errorMessage: exhaustedMessage(reason) };
    }
    if (!args.prepareResume(reason)) return result;

    const retryNumber = args.state.retriesUsed + 1;
    const delayMs = retryDelayMs(args.state.retriesUsed, random);
    args.state.retriesUsed = retryNumber;
    try {
      args.onRetry?.({
        retryNumber,
        nextAttempt: retryNumber + 1,
        maxAttempts: AGENT_RUN_MAX_ATTEMPTS,
        delayMs,
        category: classification.category,
        reason,
      });
    } catch {
      // Activity reporting cannot break recovery.
    }
    await sleep(delayMs, args.abortSignal);
    resume = true;
  }
};
