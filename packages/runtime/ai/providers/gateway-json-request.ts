import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai/core/error";
import { VERSION } from "openai/version";
import {
  GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayRequestHeaders,
} from "./model-gateway.js";

const readEnv = (name: string): string | undefined =>
  typeof process === "undefined"
    ? undefined
    : process.env[name]?.trim() || undefined;

/** Keep SDK header defaults and override order without its resource/client modules. */
export const gatewayJsonHeaders = (args: {
  apiKey: string | undefined;
  defaults: Record<string, string | null>;
  perRequest: Record<string, string>;
  timeoutMs: number;
}): Headers => {
  const headers = new Headers({
    accept: "application/json",
    "user-agent": `OpenAI/JS ${VERSION}`,
    "x-stainless-timeout": String(Math.trunc(args.timeoutMs / 1000)),
    authorization: `Bearer ${args.apiKey}`,
  });
  const organization = readEnv("OPENAI_ORG_ID");
  const project = readEnv("OPENAI_PROJECT_ID");
  if (organization) headers.set("openai-organization", organization);
  if (project) headers.set("openai-project", project);
  for (const line of readEnv("OPENAI_CUSTOM_HEADERS")?.split("\n") ?? []) {
    const colon = line.indexOf(":");
    if (colon >= 0)
      headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  for (const [key, value] of Object.entries(args.defaults)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(args.perRequest))
    headers.set(key, value);
  return headers;
};

/** The pinned OpenAI SDK's JSON retry policy, without loading its resource catalog. */
export const gatewayRetryDelay = (
  attempt: number,
  headers?: Headers,
): number => {
  let delay: number | undefined;
  const millis = headers?.get("retry-after-ms");
  if (millis && !Number.isNaN(Number.parseFloat(millis)))
    delay = Number.parseFloat(millis);
  const seconds = headers?.get("retry-after");
  if (seconds && !delay) {
    const parsed = Number.parseFloat(seconds);
    delay = Number.isNaN(parsed)
      ? Date.parse(seconds) - Date.now()
      : parsed * 1000;
  }
  return (
    delay ?? Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25)
  );
};

const retryable = (response: Response): boolean => {
  const override = response.headers.get("x-should-retry");
  if (override === "true") return true;
  if (override === "false") return false;
  return [408, 409, 429].includes(response.status) || response.status >= 500;
};

const waitForRetry = async (
  delay: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) throw new APIUserAbortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new APIUserAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** One logical JSON call: transport retries retain its body and idempotency headers. */
export const requestGatewayJson = async <T>(args: {
  url: string;
  body: unknown;
  headers: Headers;
  timeoutMs: number;
  maxRetries?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  readResponse: (response: Response) => Promise<T>;
}): Promise<{ response: Response; data: T }> => {
  const maxRetries = args.maxRetries ?? 2;
  const body = JSON.stringify(args.body);
  for (let attempt = 0; ; attempt++) {
    if (args.signal?.aborted) throw new APIUserAbortError();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    args.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, args.timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(args.headers);
      if (!headers.has("x-stainless-retry-count"))
        headers.set("x-stainless-retry-count", String(attempt));
      response = await (args.fetch ?? fetch)(args.url, {
        method: "POST",
        headers,
        body,
        signal: abort.signal,
      });
    } catch (error) {
      args.signal?.removeEventListener("abort", onAbort);
      if (args.signal?.aborted) throw new APIUserAbortError();
      if (attempt < maxRetries) {
        clearTimeout(timer);
        args.signal?.removeEventListener("abort", onAbort);
        await waitForRetry(gatewayRetryDelay(attempt), args.signal);
        continue;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      if (
        failure.name === "AbortError" ||
        /timed? ?out/i.test(String(failure) + String(failure.cause ?? ""))
      ) {
        throw new APIConnectionTimeoutError();
      }
      throw new APIConnectionError({ cause: failure });
    } finally {
      // Match the SDK: timeout ends at response headers, while caller
      // cancellation remains wired until JSON consumption completes.
      clearTimeout(timer);
    }
    if (response.ok) {
      try {
        return { response, data: await args.readResponse(response) };
      } finally {
        args.signal?.removeEventListener("abort", onAbort);
      }
    }
    if (attempt < maxRetries && retryable(response)) {
      args.signal?.removeEventListener("abort", onAbort);
      await response.body?.cancel().catch(() => undefined);
      await waitForRetry(
        gatewayRetryDelay(attempt, response.headers),
        args.signal,
      );
      continue;
    }
    const text = await response
      .text()
      .catch((error) =>
        error instanceof Error ? error.message : String(error),
      );
    args.signal?.removeEventListener("abort", onAbort);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* The SDK retains non-JSON error text. */
    }
    throw APIError.generate(
      response.status,
      parsed !== null && typeof parsed === "object" ? parsed : undefined,
      parsed ? undefined : text,
      response.headers,
    );
  }
};

/**
 * One managed-lane POST from an adapter's client configuration. The lane is
 * request/response and the runtime recovery envelope owns every physical
 * retry, so the transport makes exactly one attempt; `idempotencyKey` names
 * the logical request across an auth-refresh re-dispatch.
 */
export const postGatewayJson = async <T>(args: {
  config: {
    apiKey: string | undefined;
    baseURL: string;
    defaultHeaders: Record<string, string | null>;
    fetch?: typeof fetch;
  };
  path: "/chat/completions" | "/responses";
  body: unknown;
  idempotencyKey: string;
  signal?: AbortSignal;
  readResponse: (response: Response) => Promise<T>;
}): Promise<{ response: Response; data: T }> =>
  requestGatewayJson({
    url: `${args.config.baseURL.replace(/\/+$/, "")}${args.path}`,
    body: args.body,
    headers: gatewayJsonHeaders({
      apiKey: args.config.apiKey,
      defaults: args.config.defaultHeaders,
      perRequest: {
        "Idempotency-Key": args.idempotencyKey,
        ...gatewayRequestHeaders(),
      },
      timeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
    }),
    timeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.config.fetch ? { fetch: args.config.fetch } : {}),
    readResponse: args.readResponse,
  });
