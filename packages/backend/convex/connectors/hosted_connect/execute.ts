import { ConnectorError } from "../errors";
import {
  buildHostedConnectRequest,
  getHostedConnectActionDescriptor,
  type HostedConnectProviderDescriptor,
} from "./providers";
import { assertHostedConnectRequestUrl } from "./origin";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_PROVIDER_REQUEST_HEADERS = new Set(["x-api-version"]);
const SENSITIVE_INPUT_KEY =
  /^(?:api[_-]?key|authorization|access[_-]?token|password|secret|token)$/iu;

const assertNoCredentialFields = (value: unknown, depth = 0): void => {
  if (depth > 20) throw new ConnectorError("invalid_input");
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialFields(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_INPUT_KEY.test(key)) {
      throw new ConnectorError("invalid_input");
    }
    assertNoCredentialFields(child, depth + 1);
  }
};

const readBoundedJson = async (
  response: Response,
  maxBytes: number,
): Promise<unknown> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("response_too_large");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectorError("response_too_large");
      }
      chunks.push(value);
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
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("normalization_error");
  }
};

const replaceAll = (value: string, target: string): string =>
  target ? value.split(target).join("[REDACTED]") : value;

/**
 * Redact the Connect token from any value that will be returned or logged. The
 * token is a bearer credential, so we scrub the raw token and its `Bearer `
 * form, longest-first.
 */
export const redactHostedConnectToken = (
  value: unknown,
  token: string,
): unknown => {
  const candidates = [token, encodeURIComponent(token), `Bearer ${token}`].sort(
    (a, b) => b.length - a.length,
  );
  const redactString = (input: string) => candidates.reduce(replaceAll, input);
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 40) return "[REDACTED]";
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input))
      return input.map((item) => visit(item, depth + 1));
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, child]) => [
        redactString(key),
        visit(child, depth + 1),
      ]),
    );
  };
  return visit(value, 0);
};

/**
 * Build the authenticated request against the OWNER'S bound origin. The origin
 * is re-validated (SSRF) and the path is fixed-constructed via
 * `assertHostedConnectRequestUrl`. The token is placed only in the Authorization
 * header, redirects are never followed, and only an allowlisted set of provider
 * headers may be forwarded.
 */
export const buildAuthenticatedHostedConnectRequest = (args: {
  descriptor: HostedConnectProviderDescriptor;
  token: string;
  boundOrigin: string;
  request: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
    bodyEncoding?: "json" | "form";
    headers?: Record<string, string>;
  };
  signal?: AbortSignal;
}): { url: string; init: RequestInit } => {
  const { descriptor, token, boundOrigin, request } = args;
  const url = assertHostedConnectRequestUrl(boundOrigin, request.path);
  const providerHeaders = request.headers ?? {};
  for (const [name, value] of Object.entries(providerHeaders)) {
    if (
      !SAFE_PROVIDER_REQUEST_HEADERS.has(name.toLowerCase()) ||
      /[\r\n]/u.test(value)
    ) {
      throw new ConnectorError("normalization_error");
    }
  }
  const headers = new Headers({
    accept: "application/json",
    ...(request.body === undefined
      ? {}
      : {
          "content-type":
            request.bodyEncoding === "form"
              ? "application/x-www-form-urlencoded"
              : "application/json",
        }),
    ...providerHeaders,
  });
  // Hosted connect authenticates with a bearer token only.
  headers.set("authorization", `Bearer ${token}`);
  return {
    url: url.toString(),
    init: {
      method: request.method,
      headers,
      body:
        request.body === undefined
          ? undefined
          : request.bodyEncoding === "form"
            ? new URLSearchParams(
                Object.entries(request.body).map(([key, value]) => [
                  key,
                  String(value),
                ]),
              ).toString()
            : JSON.stringify(request.body),
      signal: args.signal,
      // A credential-bearing redirect is never followed. Any 3xx — even to the
      // same host — is treated as a provider failure so the token cannot be
      // resent to a redirected (possibly internal) location.
      redirect: "manual",
    },
  };
};

const classifyHostedConnectFailure = (
  status: number,
  operation: "read" | "write",
): ConnectorError => {
  if (status === 401 || status === 403) {
    return new ConnectorError("invalid_credential");
  }
  if (status >= 300 && status < 400) {
    return new ConnectorError("provider_unavailable");
  }
  if (status === 429) {
    return new ConnectorError("provider_rate_limited", operation === "read");
  }
  if (status >= 500) {
    return operation === "write"
      ? new ConnectorError("ambiguous_write")
      : new ConnectorError("provider_unavailable", true);
  }
  return new ConnectorError("invalid_input");
};

/**
 * Execute exactly one request against the owner's bound Connect origin. There is
 * intentionally no retry loop. Read errors may be marked retryable for an
 * explicit caller-owned retry; write failures after dispatch are non-retryable
 * and may be ambiguous.
 */
export const executeHostedConnectAction = async (args: {
  descriptor: HostedConnectProviderDescriptor;
  token: string;
  boundOrigin: string;
  action: string;
  input: Record<string, unknown>;
  operation: "read" | "write";
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}): Promise<{ output: unknown; providerStatusClass: string }> => {
  const actionDescriptor = getHostedConnectActionDescriptor(
    args.descriptor,
    args.action,
  );
  if (!actionDescriptor || actionDescriptor.operation !== args.operation) {
    throw new ConnectorError("action_not_found");
  }
  assertNoCredentialFields(args.input);
  if (
    JSON.stringify(redactHostedConnectToken(args.input, args.token)) !==
    JSON.stringify(args.input)
  ) {
    throw new ConnectorError("invalid_input");
  }
  const request = buildHostedConnectRequest(
    args.descriptor,
    args.action,
    args.input,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const prepared = buildAuthenticatedHostedConnectRequest({
    descriptor: args.descriptor,
    token: args.token,
    boundOrigin: args.boundOrigin,
    request,
    signal: controller.signal,
  });
  try {
    const response = await fetch(prepared.url, prepared.init);
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyHostedConnectFailure(response.status, args.operation);
    }
    const output = await readBoundedJson(
      response,
      args.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    return {
      output: redactHostedConnectToken(output, args.token),
      providerStatusClass: "ok",
    };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (args.operation === "write") {
      throw new ConnectorError("ambiguous_write");
    }
    if (controller.signal.aborted) {
      throw new ConnectorError("provider_timeout", true);
    }
    throw new ConnectorError("provider_unavailable", true);
  } finally {
    clearTimeout(timeout);
  }
};
