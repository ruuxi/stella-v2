import { z } from "zod";

const headerRecordSchema = z.record(z.string(), z.unknown());

export interface RetryOptions {

  maxAttempts?: number;

  baseDelayMs?: number;

  maxDelayMs?: number;

  maxTotalDelayMs?: number;
  signal?: AbortSignal;

  isRetryable?: (error: unknown) => boolean;

  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 10;
  const baseDelayMs = options?.baseDelayMs ?? 1_000;
  const maxDelayMs = options?.maxDelayMs ?? 16_000;
  const maxTotalDelayMs = options?.maxTotalDelayMs ?? 60_000;
  const signal = options?.signal;
  const isRetryable = options?.isRetryable ?? isRetryableConnectionError;

  let lastError: unknown;
  let elapsedDelayMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Request was aborted");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (isAbortError(error)) throw error;

      const isLast = attempt >= maxAttempts - 1;
      if (isLast || !isRetryable(error)) throw error;

      const requestedDelayMs =
        readRetryAfterMs(error) ?? retryDelay(attempt, baseDelayMs, maxDelayMs);
      const remainingBudgetMs = Math.max(0, maxTotalDelayMs - elapsedDelayMs);
      if (remainingBudgetMs <= 0) throw error;
      const delayMs = Math.min(requestedDelayMs, remainingBudgetMs);
      elapsedDelayMs += delayMs;
      if (options?.onRetry) {
        try {
          options.onRetry({
            attempt: attempt + 1,
            delayMs,
            reason: error instanceof Error ? error.message : undefined,
          });
        } catch {

        }
      }
      await retrySleep(delayMs, signal);
    }
  }

  throw lastError;
}

function retryDelay(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (retryIndex < 3) return baseDelayMs;
  return Math.min(baseDelayMs * 2 ** (retryIndex - 2), maxDelayMs);
}

function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message === "Request was aborted";
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headerRecordSchema.safeParse(headers);
  if (!record.success) return undefined;
  const value = record.data[name] ?? record.data[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

export function readRetryAfterMs(error: unknown): number | undefined {
  const headers =
    (error as { headers?: unknown })?.headers ??
    (error as { responseHeaders?: unknown })?.responseHeaders ??
    (error as { response?: { headers?: unknown } })?.response?.headers;
  const retryAfterMs = readHeader(headers, "retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0)
      return Math.min(parsed, 2_147_483_647);
  }
  const retryAfter = readHeader(headers, "retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.ceil(seconds * 1000), 2_147_483_647);
  const dateMs = Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(dateMs) && dateMs > 0)
    return Math.min(Math.ceil(dateMs), 2_147_483_647);
  return undefined;
}

export function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const status = (error as { status?: number }).status;
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (
    statusCode === 429 ||
    (typeof statusCode === "number" && statusCode >= 500)
  )
    return true;

  const code = (error as { code?: string }).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  return (
    /connection.?(refused|reset|timed?\s*out|error)|network|fetch\s*failed|socket\s*hang\s*up/i.test(
      error.message,
    ) ||
    /rate limit|too many requests|resource.?exhausted|temporarily unavailable|overloaded/i.test(
      error.message,
    )
  );
}

export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.message === "Request was aborted") {
    return false;
  }
  const status =
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") return false;

  const codes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "UND_ERR_SOCKET",
  ]);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && codes.has(code.toUpperCase())) return true;

  const message = error.message;
  if (
    /(?:socket|connection).*(?:closed|closure|reset|refused|terminated|timed?\s*out|unexpected)|(?:closed|reset).*(?:socket|connection)|unexpected\s+eof|premature\s+close|fetch\s+failed|failed\s+to\s+fetch|network\s+(?:error|offline)|internet\s+connection\s+appears\s+to\s+be\s+offline|load\s+failed/i.test(
      message,
    )
  ) {
    return true;
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error
    ? isTransientTransportError(cause)
    : false;
}
