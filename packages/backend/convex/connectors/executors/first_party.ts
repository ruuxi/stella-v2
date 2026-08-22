import { ConnectorError, classifyProviderStatus } from "../errors";
import { MOCK_PROVIDER_KEY, type ProviderManifest } from "../oauth/providers";
import {
  createMicrosoftHandler,
  MICROSOFT_ACTION_OPERATIONS,
  MICROSOFT_CONNECTOR_ACTIONS,
} from "./microsoft";
import {
  buildSocialProviderRequest,
  SOCIAL_ACTION_OPERATIONS,
} from "./social";

/**
 * First-party executor. Provider-family modules register a handler here that
 * builds FIXED-ORIGIN requests (never a model-chosen base URL or Authorization
 * header) and returns normalized output. Provider families plug in their
 * handlers and server-owned operation/connector maps exactly here.
 */

export type FirstPartyExecuteContext = {
  manifest: ProviderManifest;
  accessToken: string;
  action: string;
  input: Record<string, unknown>;
  operation: "read" | "write" | "destructive";
  maxResponseBytes: number;
  requestTimeoutMs: number;
};

export type ProviderExecuteHandler = (
  ctx: FirstPartyExecuteContext,
) => Promise<{ output: unknown; providerStatusClass: string }>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const readBoundedJson = async (
  response: Response,
  maxBytes: number,
): Promise<unknown> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body
      ?.cancel("response byte limit exceeded")
      .catch(() => undefined);
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
        await reader
          .cancel("response byte limit exceeded")
          .catch(() => undefined);
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

/**
 * Fixed-origin authenticated fetch. `path` is appended to the manifest's
 * `apiOrigin`; a handler can never target an arbitrary host. Provider errors are
 * classified by status only — bodies are never propagated or logged.
 */
export const providerFetchJson = async (args: {
  ctx: FirstPartyExecuteContext;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  bodyEncoding?: "json" | "form";
  headers?: Record<string, string>;
}): Promise<{ output: unknown; providerStatusClass: string }> => {
  const { ctx, method, path } = args;
  const url = new URL(path, `${ctx.manifest.apiOrigin}/`);
  if (url.origin !== new URL(ctx.manifest.apiOrigin).origin) {
    throw new ConnectorError("normalization_error");
  }
  const extraHeaders = args.headers ?? {};
  if (
    Object.keys(extraHeaders).some((name) =>
      ["authorization", "cookie", "host"].includes(name.toLowerCase()),
    )
  ) {
    throw new ConnectorError("normalization_error");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("provider request timed out"),
    ctx.requestTimeoutMs,
  );
  try {
    const reservedHeaders = new Set(["authorization", "host", "content-length"]);
    if (Object.keys(args.headers ?? {}).some((key) => reservedHeaders.has(key.toLowerCase()))) {
      throw new ConnectorError("normalization_error");
    }
    const body =
      args.body === undefined
        ? undefined
        : args.bodyEncoding === "form"
          ? new URLSearchParams(
              Object.entries(args.body as Record<string, unknown>).flatMap(([key, value]) =>
                value === undefined || value === null ? [] : [[key, String(value)]],
              ),
            ).toString()
          : JSON.stringify(args.body);
    const response = await fetch(url.toString(), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ctx.accessToken}`,
        ...(args.body !== undefined
          ? {
              "content-type":
                args.bodyEncoding === "form"
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            }
          : {}),
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const classified = classifyProviderStatus(response.status);
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError(classified.code, classified.retryable);
    }
    const output = await readBoundedJson(response, ctx.maxResponseBytes);
    return { output, providerStatusClass: "ok" };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ConnectorError("provider_timeout", true);
    }
    throw new ConnectorError("provider_unavailable", true);
  } finally {
    clearTimeout(timeout);
  }
};

// ---------------------------------------------------------------------------
// Mock provider handler (test/dev only)
// ---------------------------------------------------------------------------

const mockHandler: ProviderExecuteHandler = async (ctx) => {
  switch (ctx.action) {
    case "MOCK_READ_ITEMS":
      return providerFetchJson({ ctx, method: "GET", path: "v1/items" });
    case "MOCK_CREATE_ITEM":
      return providerFetchJson({
        ctx,
        method: "POST",
        path: "v1/items",
        body: ctx.input,
      });
    default:
      throw new ConnectorError("action_not_found");
  }
};

const socialHandler: ProviderExecuteHandler = async (ctx) => {
  const request = buildSocialProviderRequest(ctx.manifest.key, ctx.action, ctx.input);
  if (!request) throw new ConnectorError("action_not_found");
  return providerFetchJson({ ctx, ...request });
};

const PROVIDER_HANDLERS: Readonly<Record<string, ProviderExecuteHandler>> = {
  [MOCK_PROVIDER_KEY]: mockHandler,
  microsoft: createMicrosoftHandler(providerFetchJson),
  twitter: socialHandler,
  youtube: socialHandler,
  reddit: socialHandler,
  meta: socialHandler,
  linkedin: socialHandler,
};

/**
 * Server-authoritative operation class per action. The operation is NEVER taken
 * from client input: it decides whether a failure may fall back (reads only)
 * and is recorded in audit. Provider families extend this map alongside their
 * handler.
 */
const PROVIDER_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, "read" | "write" | "destructive">>>
> = {
  [MOCK_PROVIDER_KEY]: {
    MOCK_READ_ITEMS: "read",
    MOCK_CREATE_ITEM: "write",
  },
  microsoft: MICROSOFT_ACTION_OPERATIONS,
  ...SOCIAL_ACTION_OPERATIONS,
};

export const firstPartyActionOperation = (
  providerKey: string,
  action: string,
): "read" | "write" | "destructive" | null =>
  PROVIDER_ACTION_OPERATIONS[providerKey]?.[action] ?? null;

const PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  microsoft: MICROSOFT_CONNECTOR_ACTIONS,
};

export const firstPartyActionBelongsToConnector = (
  providerKey: string,
  connectorId: string,
  action: string,
): boolean => {
  const registry = PROVIDER_CONNECTOR_ACTIONS[providerKey];
  // Legacy providers without a connector map retain their existing behavior.
  if (!registry) return firstPartyActionOperation(providerKey, action) !== null;
  return registry[connectorId.trim().toLowerCase()]?.includes(action) ?? false;
};

export const firstPartyProviderForConnectorAction = (
  connectorId: string,
  action: string,
): string | null => {
  for (const providerKey of Object.keys(PROVIDER_CONNECTOR_ACTIONS)) {
    if (firstPartyActionBelongsToConnector(providerKey, connectorId, action)) {
      return providerKey;
    }
  }
  return null;
};

export const firstPartyProviderForConnector = (
  connectorId: string,
): string | null => {
  const normalized = connectorId.trim().toLowerCase();
  for (const [providerKey, registry] of Object.entries(
    PROVIDER_CONNECTOR_ACTIONS,
  )) {
    if (registry[normalized]) return providerKey;
  }
  return null;
};

/** Dispatch a validated action to its provider family handler. */
export const executeFirstPartyAction = async (args: {
  manifest: ProviderManifest;
  accessToken: string;
  action: string;
  input: Record<string, unknown>;
  operation: "read" | "write" | "destructive";
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}): Promise<{ output: unknown; providerStatusClass: string }> => {
  const handler = PROVIDER_HANDLERS[args.manifest.key];
  if (!handler) {
    // A routed-but-unimplemented provider is a deployment defect, not a reason
    // to silently fall back to Composio.
    throw new ConnectorError("normalization_error");
  }
  return handler({
    manifest: args.manifest,
    accessToken: args.accessToken,
    action: args.action,
    input: args.input,
    operation: args.operation,
    maxResponseBytes: args.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    requestTimeoutMs: args.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
};

export const hasProviderHandler = (providerKey: string): boolean =>
  Boolean(PROVIDER_HANDLERS[providerKey]);
