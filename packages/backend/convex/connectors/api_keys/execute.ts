import { ConnectorError } from "../errors";
import {
  buildDescriptorRequest,
  getApiKeyActionDescriptor,
  getApiKeyActionTarget,
  type ApiKeyProviderDescriptor,
} from "./providers";

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

export const redactApiKeyMaterial = (
  value: unknown,
  apiKey: string,
): unknown => {
  const queryEncodedApiKey = new URLSearchParams([["api_key", apiKey]])
    .toString()
    .slice("api_key=".length);
  const candidates = [
    apiKey,
    encodeURIComponent(apiKey),
    queryEncodedApiKey,
    `Bearer ${apiKey}`,
    `Basic ${btoa(`${apiKey}:`)}`,
    `Basic ${btoa(apiKey)}`,
  ].sort((a, b) => b.length - a.length);
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

const assertFixedRequestPath = (apiOrigin: string, path: string): URL => {
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/u.test(path)) {
    throw new ConnectorError("normalization_error");
  }
  const url = new URL(path, `${apiOrigin}/`);
  if (url.origin !== apiOrigin) {
    throw new ConnectorError("normalization_error");
  }
  return url;
};

export const buildAuthenticatedApiKeyRequest = (args: {
  descriptor: ApiKeyProviderDescriptor;
  action: string;
  apiKey: string;
  request: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
    bodyEncoding?: "json" | "form";
    headers?: Record<string, string>;
  };
  signal?: AbortSignal;
}): { url: string; init: RequestInit } => {
  const { descriptor, action, apiKey, request } = args;
  const target = getApiKeyActionTarget(descriptor, action);
  if (!target) throw new ConnectorError("action_not_found");
  const url = assertFixedRequestPath(target.apiOrigin, request.path);
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
  switch (descriptor.auth.type) {
    case "bearer":
      headers.set("authorization", `Bearer ${apiKey}`);
      break;
    case "header":
      headers.set(descriptor.auth.headerName, apiKey);
      break;
    case "query":
      url.searchParams.set(descriptor.auth.queryParam, apiKey);
      break;
    case "basic":
      headers.set(
        "authorization",
        `Basic ${btoa(
          descriptor.auth.format === "credentials_pair" ? apiKey : `${apiKey}:`,
        )}`,
      );
      break;
    default: {
      const exhaustive: never = descriptor.auth;
      throw new Error(
        `Unhandled API-key auth placement: ${String(exhaustive)}`,
      );
    }
  }
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
      // Credential-bearing redirects are never followed, including same-origin
      // redirects, because a future provider change could cross origins.
      redirect: "manual",
    },
  };
};

const classifyApiKeyProviderFailure = (
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
 * Executes exactly one fixed-origin provider request. There is intentionally no
 * retry loop. Read errors may be marked retryable for an explicit caller-owned
 * retry; write failures after dispatch are non-retryable and may be ambiguous.
 */
export const executeApiKeyProviderAction = async (args: {
  descriptor: ApiKeyProviderDescriptor;
  apiKey: string;
  action: string;
  input: Record<string, unknown>;
  operation: "read" | "write";
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}): Promise<{ output: unknown; providerStatusClass: string }> => {
  const actionDescriptor = getApiKeyActionDescriptor(
    args.descriptor,
    args.action,
  );
  if (!actionDescriptor || actionDescriptor.operation !== args.operation) {
    throw new ConnectorError("action_not_found");
  }
  assertNoCredentialFields(args.input);
  if (
    JSON.stringify(redactApiKeyMaterial(args.input, args.apiKey)) !==
    JSON.stringify(args.input)
  ) {
    throw new ConnectorError("invalid_input");
  }
  const request = buildDescriptorRequest(
    args.descriptor,
    args.action,
    args.input,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const prepared = buildAuthenticatedApiKeyRequest({
    descriptor: args.descriptor,
    action: args.action,
    apiKey: args.apiKey,
    request,
    signal: controller.signal,
  });
  try {
    const response = await fetch(prepared.url, prepared.init);
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyApiKeyProviderFailure(response.status, args.operation);
    }
    const output = await readBoundedJson(
      response,
      args.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    return {
      output: redactApiKeyMaterial(output, args.apiKey),
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
