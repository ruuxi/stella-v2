import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";

type JsonRequest =
  | {
      method: "GET";
      headers?: Record<string, string>;
    }
  | {
      method: "POST";
      body: string;
      headers?: Record<string, string>;
    };

type StreamRequestOptions = {
  headers?: Record<string, string>;
  /** Aborts the in-flight XHR. Callers receive an `AbortError` rejection. */
  signal?: AbortSignal;
};

export class StreamAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/** One refused request, carrying the status so callers can branch on it. */
export class HttpRequestError extends Error {
  readonly status: number;
  /** Contract error code when the service sent one (`{ error: { code } }`). */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
  }
}

const GENERIC_REQUEST_FAILURE = "Could not complete that request. Try again.";

const readErrorDetail = async (
  response: Response,
): Promise<{ message: string; code: string | null }> => {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { message: GENERIC_REQUEST_FAILURE, code: null };
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.error === "string" && o.error.trim()) {
      return { message: o.error.trim(), code: null };
    }
    // The cloud builder answers `{ error: { code, message, retryable } }`.
    if (o.error && typeof o.error === "object") {
      const detail = o.error as Record<string, unknown>;
      return {
        message:
          typeof detail.message === "string" && detail.message.trim()
            ? detail.message.trim()
            : GENERIC_REQUEST_FAILURE,
        code: typeof detail.code === "string" ? detail.code : null,
      };
    }
    if (typeof o.message === "string" && o.message.trim()) {
      return { message: o.message.trim(), code: null };
    }
  }
  return { message: GENERIC_REQUEST_FAILURE, code: null };
};

// Without an explicit timeout, a black-holed connection (captive portal,
// cellular handoff) pins callers for the OS default (~60s on iOS).
const REQUEST_TIMEOUT_MS = 15_000;

async function requestJson(
  path: string,
  request: JsonRequest,
  options?: {
    anonymous?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Absolute origin for a non-Convex service (the cloud builder). */
    origin?: string;
  },
) {
  const origin = options?.origin?.replace(/\/+$/, "") || env.convexSiteUrl;
  assert(origin, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const authHeader = options?.anonymous
    ? null
    : `Bearer ${await getConvexToken()}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...request,
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
        ...(request.method === "POST"
          ? { "Content-Type": "application/json" }
          : {}),
        ...request.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new StreamAbortError();
    }
    if (timedOut) {
      throw new Error("Request timed out. Try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new HttpRequestError(detail.message, response.status, detail.code);
  }

  // Guarded parse: a 200 with a non-JSON body (proxy/error interstitial)
  // must surface as clean copy, never a raw "JSON Parse error: …".
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Could not complete that request. Try again.");
  }
}

export const getJson = (
  path: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    origin?: string;
  },
) =>
  requestJson(
    path,
    { method: "GET", headers: options?.headers },
    {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      ...(options?.origin ? { origin: options.origin } : {}),
    },
  );

export const postJson = (
  path: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    origin?: string;
  },
) =>
  requestJson(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: options?.headers,
    },
    {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      ...(options?.origin ? { origin: options.origin } : {}),
    },
  );

export const postJsonAnonymous = (
  path: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) =>
  requestJson(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: options?.headers,
    },
    {
      anonymous: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    },
  );

/** Authenticated non-JSON POST used by Stella's SDP signaling boundary. */
export const postText = async (
  path: string,
  body: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<string> => {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${env.convexSiteUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getConvexToken()}`,
        "Content-Type": "text/plain",
        ...options?.headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new HttpRequestError(detail.message, response.status, detail.code);
    }
    return await response.text();
  } catch (error) {
    if (options?.signal?.aborted) throw new StreamAbortError();
    if (timedOut) throw new Error("Request timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Drive the offline-chat SSE lane.
 *
 * The transport is unchanged, but the payload contract is: a `{"t": …}` frame
 * now arrives exactly ONCE per completed assistant text segment and carries
 * that segment's full text (tool-loop interleaving preserved). So `onSegment`
 * fires per whole message segment, not per token — there is nothing to smooth
 * or reassemble on this side. The only buffering left is at the LINE level:
 * progress events fire on arbitrary network-buffer boundaries, so a frame can
 * still arrive split in two.
 */
function executeStream(
  path: string,
  body: unknown,
  onSegment: (text: string) => void,
  authHeader: string | null,
  options?: StreamRequestOptions,
): Promise<void> {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${env.convexSiteUrl}${path}`);
    if (authHeader) {
      xhr.setRequestHeader("Authorization", authHeader);
    }
    xhr.setRequestHeader("Content-Type", "application/json");
    for (const [name, value] of Object.entries(options?.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.responseType = "text";

    const signal = options?.signal;
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // ignore: xhr may already be done
      }
      reject(new StreamAbortError());
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    let processed = 0;
    let pending = "";
    let finished = false;

    // Returns false once the stream is finished ([DONE] or an error frame).
    const handleLine = (line: string): boolean => {
      if (!line.startsWith("data: ")) return true;
      const payload = line.slice(6);
      if (payload === "[DONE]") return false;
      try {
        const parsed = JSON.parse(payload) as { t?: string; error?: string };
        if (parsed.error) {
          reject(new Error(parsed.error));
          xhr.abort();
          return false;
        }
        if (parsed.t) onSegment(parsed.t);
      } catch {
        // skip malformed lines
      }
      return true;
    };

    // Only complete lines are parseable: hold the trailing partial line until
    // the next chunk (or the final flush in onload), otherwise its segment is
    // silently lost.
    const consume = (flush: boolean) => {
      if (finished) return;
      pending += xhr.responseText.slice(processed);
      processed = xhr.responseText.length;
      const cut = pending.lastIndexOf("\n");
      let complete: string;
      if (flush) {
        complete = pending;
        pending = "";
      } else if (cut === -1) {
        return;
      } else {
        complete = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
      }
      for (const line of complete.split("\n")) {
        if (!handleLine(line)) {
          finished = true;
          return;
        }
      }
    };

    xhr.onprogress = () => consume(false);

    xhr.onload = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        consume(true);
        resolve();
      } else {
        let msg = "Could not complete that request. Try again.";
        try {
          const parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
          if (typeof parsed.error === "string") msg = parsed.error;
          else if (typeof parsed.message === "string") msg = parsed.message;
        } catch { /* use default */ }
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return;
      reject(new Error("Network error"));
    };
    xhr.ontimeout = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return;
      reject(new Error("Request timed out"));
    };

    xhr.send(JSON.stringify(body));
  });
}

export function postStream(
  path: string,
  body: unknown,
  onSegment: (text: string) => void,
  options?: StreamRequestOptions,
): Promise<void> {
  return getConvexToken().then((token) =>
    executeStream(path, body, onSegment, `Bearer ${token}`, options),
  );
}

export function postStreamAnonymous(
  path: string,
  body: unknown,
  onSegment: (text: string) => void,
  options?: StreamRequestOptions,
): Promise<void> {
  return executeStream(path, body, onSegment, null, options);
}
