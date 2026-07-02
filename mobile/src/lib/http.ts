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

const readErrorMessage = async (response: Response) => {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "Could not complete that request. Try again.";
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.error === "string" && o.error.trim()) {
      return o.error.trim();
    }
    if (typeof o.message === "string" && o.message.trim()) {
      return o.message.trim();
    }
  }
  return "Could not complete that request. Try again.";
};

async function requestJson(
  path: string,
  request: JsonRequest,
  options?: { anonymous?: boolean },
) {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const authHeader = options?.anonymous
    ? null
    : `Bearer ${await getConvexToken()}`;
  const response = await fetch(`${env.convexSiteUrl}${path}`, {
    ...request,
    headers: {
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(request.method === "POST"
        ? { "Content-Type": "application/json" }
        : {}),
      ...request.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
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
  options?: { headers?: Record<string, string> },
) => requestJson(path, { method: "GET", headers: options?.headers });

export const postJson = (
  path: string,
  body: unknown,
  options?: { headers?: Record<string, string> },
) =>
  requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: options?.headers,
  });

export const postJsonAnonymous = (
  path: string,
  body: unknown,
  options?: { headers?: Record<string, string> },
) =>
  requestJson(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: options?.headers,
    },
    { anonymous: true },
  );

function executeStream(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
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

    xhr.onprogress = () => {
      const chunk = xhr.responseText.slice(processed);
      processed = xhr.responseText.length;

      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as { t?: string; error?: string };
          if (parsed.error) {
            reject(new Error(parsed.error));
            xhr.abort();
            return;
          }
          if (parsed.t) onDelta(parsed.t);
        } catch {
          // skip malformed lines
        }
      }
    };

    xhr.onload = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return;
      if (xhr.status >= 200 && xhr.status < 300) {
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
  onDelta: (text: string) => void,
  options?: StreamRequestOptions,
): Promise<void> {
  return getConvexToken().then((token) =>
    executeStream(path, body, onDelta, `Bearer ${token}`, options),
  );
}

export function postStreamAnonymous(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  options?: StreamRequestOptions,
): Promise<void> {
  return executeStream(path, body, onDelta, null, options);
}
