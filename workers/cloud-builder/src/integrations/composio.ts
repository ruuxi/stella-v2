/**
 * Composio's tool router: one session per (owner, integration) under the
 * owner's Composio principal. Sessions mint connect links, report whether the
 * toolkit has a connected account, and execute actions. Provider error bodies
 * are never reflected or logged: they can carry request arguments.
 */

import { sha256Hex } from "../hash.js";

export type ComposioConfig = { apiKey: string; baseUrl: string };

const DEFAULT_TOOL_ROUTER_URL = "https://backend.composio.dev/api/v3.1/tool_router";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_PAGES = 4;
/** Responses that prove the provider did not accept the request. */
const DEFINITE_REJECTIONS = new Set([400, 401, 403, 404, 405, 413, 415, 422]);

export class ComposioHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Composio request failed (${status}).`);
    this.name = "ComposioHttpError";
    this.status = status;
  }
}

/** True when a failed provider call certainly did not run. */
export const composioDefinitelyRejected = (error: unknown): boolean =>
  error instanceof ComposioHttpError && DEFINITE_REJECTIONS.has(error.status);

const secret = (env: Cloudflare.Env, name: string): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const composioConfig = (env: Cloudflare.Env): ComposioConfig | null => {
  const apiKey = secret(env, "COMPOSIO_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (secret(env, "COMPOSIO_TOOL_ROUTER_URL") ?? DEFAULT_TOOL_ROUTER_URL).replace(/\/+$/u, ""),
  };
};

/** The stable Composio user every session of one owner runs as. */
export const composioPrincipalFor = async (ownerId: string): Promise<string> =>
  `stella_${(await sha256Hex(ownerId)).slice(0, 32)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readBoundedText = async (response: Response): Promise<string> => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Composio response exceeded the safe size limit.");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Composio response exceeded the safe size limit.");
  }
  return text;
};

export const composioFetch = async (
  config: ComposioConfig,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  options: { baseUrl?: string } = {},
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${options.baseUrl ?? config.baseUrl}${path}`, {
    method: init.method,
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "x-consumer-api-key": config.apiKey,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedText(response);
  if (!response.ok) throw new ComposioHttpError(response.status);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { data: parsed };
  } catch {
    return { text };
  }
};

/** The v3.1 API next to the tool router, for connected-account cleanup. */
const toolsApiBaseUrl = (toolRouterBaseUrl: string): string => {
  const url = new URL(toolRouterBaseUrl);
  if (!url.pathname.endsWith("/tool_router")) {
    throw new Error("Composio tool router URL has an unsupported shape.");
  }
  url.pathname = url.pathname.slice(0, -"/tool_router".length);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
};

const sessionIdFromPayload = (payload: Record<string, unknown>): string | null => {
  const session = isRecord(payload.session) ? payload.session : null;
  return (
    readString(payload.id) ??
    readString(payload.sessionId) ??
    readString(payload.session_id) ??
    readString(session?.id) ??
    readString(session?.sessionId) ??
    readString(session?.session_id)
  );
};

const linkFromPayload = (payload: Record<string, unknown>): string | null => {
  const data = isRecord(payload.data) ? payload.data : null;
  return (
    readString(payload.link) ??
    readString(payload.url) ??
    readString(payload.redirectUrl) ??
    readString(payload.redirect_url) ??
    readString(data?.link) ??
    readString(data?.url) ??
    readString(data?.redirectUrl) ??
    readString(data?.redirect_url)
  );
};

/**
 * Whether a `GET /session/{id}/toolkits` payload shows `toolkit` with an
 * active connected account. Tolerant of the response shapes the router has
 * returned (items/data/toolkits arrays, nested toolkit slugs, item-level or
 * connection-level accounts, bare booleans).
 */
export const toolkitConnectedFromPayload = (
  payload: Record<string, unknown>,
  toolkit: string,
): boolean => {
  const wanted = toolkit.trim().toLowerCase();
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.toolkits)
        ? payload.toolkits
        : [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const toolkitRecord = isRecord(raw.toolkit) ? raw.toolkit : null;
    const slug = (
      readString(toolkitRecord?.slug) ??
      readString(raw.slug) ??
      readString(raw.name) ??
      ""
    ).toLowerCase();
    if (slug !== wanted) continue;
    if (raw.is_connected === true || raw.isConnected === true) return true;
    const itemAccount = isRecord(raw.connected_account)
      ? raw.connected_account
      : isRecord(raw.connectedAccount)
        ? raw.connectedAccount
        : null;
    const itemStatus = readString(itemAccount?.status)?.toUpperCase();
    if (itemStatus) return itemStatus === "ACTIVE";
    const connection = isRecord(raw.connection) ? raw.connection : null;
    if (!connection) return false;
    const account = isRecord(connection.connectedAccount)
      ? connection.connectedAccount
      : isRecord(connection.connected_account)
        ? connection.connected_account
        : null;
    const status = readString(account?.status)?.toUpperCase();
    if (status) return status === "ACTIVE";
    return connection.isActive === true || connection.is_active === true;
  }
  return false;
};

const sessionPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}`;

/** Create a session for one toolkit. Composio has no idempotency key for this. */
export const createComposioSession = async (
  config: ComposioConfig,
  userId: string,
  toolkit: string,
): Promise<string> => {
  const payload = await composioFetch(config, "/session", {
    method: "POST",
    body: { user_id: userId, toolkits: { enable: [toolkit] } },
  });
  const sessionId = sessionIdFromPayload(payload);
  if (!sessionId) throw new Error("Composio did not return a session id.");
  return sessionId;
};

/** Delete a session; one already gone is fine. */
export const deleteComposioSession = async (config: ComposioConfig, sessionId: string): Promise<void> =>
  await ignoreStatus(composioFetch(config, sessionPath(sessionId), { method: "DELETE" }), [404]);

export const composioToolkitConnected = async (
  config: ComposioConfig,
  sessionId: string,
  toolkit: string,
): Promise<boolean> =>
  toolkitConnectedFromPayload(
    await composioFetch(config, `${sessionPath(sessionId)}/toolkits`, { method: "GET" }),
    toolkit,
  );

export const composioConnectLink = async (
  config: ComposioConfig,
  sessionId: string,
  toolkit: string,
): Promise<string> => {
  const url = linkFromPayload(
    await composioFetch(config, `${sessionPath(sessionId)}/link`, {
      method: "POST",
      body: { toolkit },
    }),
  );
  if (!url) throw new Error("Composio did not return a connect link.");
  return url;
};

/** Run one action, or a raw proxy request (Google Ads mutations). */
export const composioExecute = async (
  config: ComposioConfig,
  sessionId: string,
  body: { proxy: Record<string, unknown> } | { action: string; input: Record<string, unknown> },
): Promise<Record<string, unknown>> =>
  "proxy" in body
    ? await composioFetch(config, `${sessionPath(sessionId)}/proxy_execute`, {
        method: "POST",
        body: body.proxy,
      })
    : await composioFetch(config, `${sessionPath(sessionId)}/execute`, {
        method: "POST",
        body: { tool_slug: body.action, arguments: body.input },
      });

const ignoreStatus = async (call: Promise<unknown>, statuses: number[]): Promise<void> => {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ComposioHttpError && statuses.includes(error.status))) throw error;
  }
};

const listConnectedAccountIds = async (
  config: ComposioConfig,
  apiBaseUrl: string,
  toolkit: string,
  userId: string,
): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({ toolkit_slugs: toolkit, user_ids: userId, limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const payload = await composioFetch(
      config,
      `/connected_accounts?${params.toString()}`,
      { method: "GET" },
      { baseUrl: apiBaseUrl },
    );
    if (!Array.isArray(payload.items)) throw new Error("Composio account list is malformed.");
    for (const item of payload.items) {
      if (!isRecord(item)) continue;
      const id = readString(item.id);
      const slug = readString(isRecord(item.toolkit) ? item.toolkit.slug : null)?.toLowerCase();
      // Only accounts that are exactly this owner's, for this toolkit.
      if (id && slug === toolkit && readString(item.user_id) === userId) ids.push(id);
    }
    cursor = readString(payload.next_cursor);
    if (!cursor) return ids;
  }
  throw new Error("Composio account listing exceeded its page bound.");
};

/**
 * Account deletion for one integration: delete the session first (so no
 * issued link can attach a new account), then revoke and delete every
 * connected account the owner's principal holds for the toolkit, and confirm
 * none remain. Throws while anything may be left; a later call retries.
 */
export const purgeComposioConnection = async (
  config: ComposioConfig,
  input: { sessionId: string | null; toolkit: string; userId: string },
): Promise<void> => {
  if (input.sessionId) await deleteComposioSession(config, input.sessionId);
  const apiBaseUrl = toolsApiBaseUrl(config.baseUrl);
  for (const accountId of await listConnectedAccountIds(config, apiBaseUrl, input.toolkit, input.userId)) {
    const accountPath = `/connected_accounts/${encodeURIComponent(accountId)}`;
    await ignoreStatus(
      composioFetch(config, `${accountPath}/revoke`, { method: "POST", body: {} }, { baseUrl: apiBaseUrl }),
      [404, 409],
    );
    await ignoreStatus(
      composioFetch(config, `${accountPath}?revoke_on_delete=true`, { method: "DELETE" }, { baseUrl: apiBaseUrl }),
      [404],
    );
  }
  if ((await listConnectedAccountIds(config, apiBaseUrl, input.toolkit, input.userId)).length > 0) {
    throw new Error("Composio connected accounts remain after deletion.");
  }
};
