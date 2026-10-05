/**
 * Sign in with ChatGPT (SIWC) for open-source apps: ChatGPT plan usage.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * Every place Stella talks to ChatGPT follows that contract, defined once
 * here: an install (or the owner's cloud) is an "agent host" with its own
 * persisted `ext_agent_host_id`; signing in registers a user-defined agent
 * (`client_id=dynamic_agent_client` the first time, the issued `client_id`
 * after that) through a 127.0.0.1 loopback redirect; the host keeps the
 * issued client id, the validated identity and the tokens, refreshes them
 * itself, and calls the public Responses API with the access token.
 *
 * Pure: nothing here touches the network. The calls to auth.openai.com and
 * api.openai.com live in `chatgpt-siwc-flows.ts`.
 */

import { formEncode } from "./engine-oauth.js";

export const CHATGPT_SIWC = {
  issuer: "https://auth.openai.com",
  discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
  /** Documented production values; the flows read them from discovery. */
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  /** The audience of the access token and the `resource` of every grant. */
  resource: "https://api.openai.com/v1",
  apiBaseUrl: "https://api.openai.com/v1",
  responsesUrl: "https://api.openai.com/v1/responses",
  modelsUrl: "https://api.openai.com/v1/models",
  /** First-time registration entrypoint; never saved or used for an exchange. */
  dynamicClientId: "dynamic_agent_client",
  /** `agent_name_hint`: the app's actual name, the same on every install. */
  agentName: "Stella",
  scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  /** Without this granted scope the sign-in holds, but inference must not run. */
  planUsageScope: "chatgpt.tokens.use.direct",
  loopbackHost: "127.0.0.1",
  loopbackPath: "/auth/callback",
  /** The documented example port; any free port works (only the port may vary). */
  defaultLoopbackPort: 1455,
  /** ChatGPT Settings › Usage: review app usage and manage this app's limits. */
  manageUsageUrl: "https://chatgpt.com/settings/usage",
} as const;

/** `http://127.0.0.1:<port>/auth/callback`; never `localhost`. */
export const chatGptLoopbackRedirectUri = (port: number): string =>
  `http://${CHATGPT_SIWC.loopbackHost}:${port}${CHATGPT_SIWC.loopbackPath}`;

/** A fresh `urn:uuid:` host id, generated once per host and persisted. */
export const createChatGptHostId = (): string => `urn:uuid:${crypto.randomUUID()}`;

const HOST_ID_PATTERN =
  /^(?:urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|urn:ietf:params:oauth:jwk-thumbprint:[A-Za-z0-9:_-]{1,200}|did:key:[A-Za-z0-9]{1,200})$/u;

export const isChatGptHostId = (value: unknown): value is string =>
  typeof value === "string" && HOST_ID_PATTERN.test(value);

const ISSUED_CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/u;

export const isIssuedChatGptClientId = (value: unknown): value is string =>
  typeof value === "string" &&
  ISSUED_CLIENT_ID.test(value) &&
  value !== CHATGPT_SIWC.dynamicClientId;

/**
 * The authorization request. A new registration sends
 * `dynamic_agent_client` and the app's `agent_name_hint`; reauthorizing a
 * saved account sends its issued client id and identity hints instead. Every
 * request carries this host's id. `reconsent` asks for consent again (to
 * enable ChatGPT plan usage after it was declined).
 */
export const chatGptAuthorizeUrl = (args: {
  authorizationEndpoint?: string;
  clientId?: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  idTokenHint?: string;
  loginHint?: string;
  reconsent?: boolean;
}): string => {
  const params: Record<string, string> = {
    client_id: args.clientId ?? CHATGPT_SIWC.dynamicClientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: CHATGPT_SIWC.scopes,
    resource: CHATGPT_SIWC.resource,
    state: args.state,
    nonce: args.nonce,
    code_challenge_method: "S256",
    code_challenge: args.challenge,
    ext_agent_host_id: args.hostId,
  };
  if (!args.clientId) params.agent_name_hint = CHATGPT_SIWC.agentName;
  if (args.clientId && args.idTokenHint) params.id_token_hint = args.idTokenHint;
  if (args.clientId && args.loginHint) params.login_hint = args.loginHint;
  if (args.reconsent) params.prompt = "consent";
  return `${args.authorizationEndpoint ?? CHATGPT_SIWC.authorizeUrl}?${formEncode(params)}`;
};

// --- Errors -------------------------------------------------------------------

/** A sign-in, refresh or request failure with the provider's own code. */
export class ChatGptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatGptError";
  }
}

export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
export const CHATGPT_USAGE_UNAVAILABLE_CODE = "subscription_sharing_usage_unavailable";

/** Refresh errors after which the tokens are unusable: sign in again. */
export const CHATGPT_UNUSABLE_REFRESH_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const ERROR_MESSAGES: Record<string, string> = {
  subscription_sharing_user_not_eligible:
    "ChatGPT plan usage isn't available for this ChatGPT account or workspace.",
  [CHATGPT_USAGE_LIMIT_CODE]:
    "You've reached a ChatGPT usage limit for Stella. Review your plan or Stella's limit in ChatGPT Settings › Usage.",
  [CHATGPT_USAGE_UNAVAILABLE_CODE]: "ChatGPT couldn't check your usage right now. Try again shortly.",
  subscription_sharing_unsupported_capability:
    "This request uses something ChatGPT plan usage doesn't support.",
  subscription_sharing_route_not_supported: "ChatGPT plan usage doesn't support this request route.",
  subscription_sharing_invalid_user:
    "ChatGPT couldn't validate this account's plan. Sign in to ChatGPT again.",
  subscription_sharing_user_unavailable:
    "Your ChatGPT account or workspace is temporarily unavailable. Try again shortly.",
  chatpass_v2_scope_not_authorized:
    "Your ChatGPT sign-in doesn't permit this request. Sign in to ChatGPT again.",
  chatpass_v2_invalid_authorization_context:
    "Your ChatGPT sign-in doesn't permit this request. Sign in to ChatGPT again.",
  invalid_client: "ChatGPT rejected Stella's saved registration. Sign in to ChatGPT again.",
  access_denied: "ChatGPT sign-in was not completed.",
  model_not_found: "This model isn't available to your ChatGPT account. Choose another model.",
};

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  CHATGPT_USAGE_UNAVAILABLE_CODE,
  "subscription_sharing_user_unavailable",
]);

const safeCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/u.test(value)
    ? value
    : undefined;

/**
 * The machine-readable code of an error body: OAuth errors carry a string
 * `error`, Responses errors `error.code`. Direct-admission `{ detail }` text
 * is diagnostic, not a code.
 */
export const chatGptErrorCode = (body: unknown): string | undefined => {
  let current: unknown = body;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.error === "string") return safeCode(record.error);
    const code = safeCode(record.code);
    if (code) return code;
    const next = record.error ?? record.response;
    if (!next || typeof next !== "object") return undefined;
    current = next;
  }
  return undefined;
};

/** A ChatGptError for an HTTP failure or a failed stream. */
export const chatGptErrorFrom = (body: unknown, status?: number): ChatGptError => {
  const code = chatGptErrorCode(body) ?? "api_error";
  const known = ERROR_MESSAGES[code];
  if (known) return new ChatGptError(code, known, RETRYABLE_CODES.has(code), status);
  if (CHATGPT_UNUSABLE_REFRESH_CODES.has(code)) {
    return new ChatGptError(code, "Your ChatGPT sign-in has ended. Sign in to ChatGPT again.", false, status);
  }
  const message = (() => {
    const error =
      body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
    const text =
      error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 500) : undefined;
  })();
  if (status === 401) {
    return new ChatGptError(code, message ?? "ChatGPT didn't accept this sign-in. Sign in to ChatGPT again.", false, status);
  }
  if (status === 403) {
    return new ChatGptError(code, message ?? "A ChatGPT policy or permission check blocked this request.", false, status);
  }
  if (status === 503 || (status !== undefined && status >= 500)) {
    return new ChatGptError(code, message ?? "ChatGPT is temporarily unavailable. Try again shortly.", true, status);
  }
  if (status === 429) {
    return new ChatGptError(code, message ?? "Too many ChatGPT requests. Wait a moment and try again.", true, status);
  }
  return new ChatGptError(code, message ?? "ChatGPT couldn't complete this request.", false, status);
};

// --- Callback ---------------------------------------------------------------------

export type ChatGptCallback = {
  code: string;
  /** The issued client id: from the callback, else the attempt's saved one. */
  clientId: string;
};

const queryOf = (input: string): string => {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    const start = value.indexOf("?");
    return start === -1 ? "" : (value.slice(start + 1).split("#", 1)[0] ?? "");
  }
  return value.replace(/^\?/u, "").split("#", 1)[0] ?? "";
};

const queryValues = (query: string): Map<string, string[]> => {
  const values = new Map<string, string[]>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const [rawKey = "", rawValue = ""] = pair.split("=", 2);
    try {
      const key = decodeURIComponent(rawKey.replaceAll("+", " "));
      const value = decodeURIComponent(rawValue.replaceAll("+", " "));
      values.set(key, [...(values.get(key) ?? []), value]);
    } catch {
      // A malformed pair is skipped.
    }
  }
  return values;
};

/**
 * Validate the loopback callback (the full redirect URL, or its query) for
 * one attempt: exactly one `state`, matching; an OAuth `error` ends the
 * attempt; a new registration must return its issued `client_id`, and a
 * reauthorization must not return a different one.
 */
export const parseChatGptCallback = (
  input: string,
  expected: { state: string; savedClientId?: string },
): ChatGptCallback => {
  const values = queryValues(queryOf(input));
  const one = (key: string): string | undefined => {
    const list = values.get(key);
    return list?.length === 1 ? list[0] : undefined;
  };
  const state = one("state");
  if (!state || state !== expected.state) {
    throw new ChatGptError(
      "state_mismatch",
      "This sign-in link belongs to a different attempt. Start signing in to ChatGPT again.",
    );
  }
  const error = one("error");
  if (error) {
    throw error === "access_denied"
      ? new ChatGptError("access_denied", "ChatGPT sign-in was declined.")
      : new ChatGptError(safeCode(error) ?? "authorization_failed", "ChatGPT sign-in didn't complete. Try again.");
  }
  const code = one("code");
  const returned = values.get("client_id");
  if (!code || (returned && returned.length > 1)) {
    throw new ChatGptError(
      "registration_incomplete",
      "ChatGPT didn't complete Stella's registration. Try signing in again.",
    );
  }
  const returnedClientId = returned?.[0];
  if (expected.savedClientId && returnedClientId && returnedClientId !== expected.savedClientId) {
    throw new ChatGptError(
      "client_mismatch",
      "ChatGPT returned a different registration than the account being signed in. Start again.",
    );
  }
  const clientId = returnedClientId ?? expected.savedClientId;
  if (!isIssuedChatGptClientId(clientId)) {
    throw new ChatGptError(
      "registration_incomplete",
      "ChatGPT didn't complete Stella's registration. Try signing in again.",
    );
  }
  return { code, clientId };
};

// --- Tokens -------------------------------------------------------------------------

export type ChatGptTokenSet = {
  access: string;
  refresh: string;
  /** Epoch ms on the receiving clock. */
  expiresAt: number;
  /** Epoch ms, when the token response said refreshing may start. */
  earliestRefreshAt?: number;
  /** Granted scopes, from the response's space-separated `scope`. */
  scopes: string[];
  idToken?: string;
};

const epochMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epochMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * A token-endpoint response. A refresh may omit `scope` (unchanged grant);
 * `previousScopes` then stands. Plan usage needs a refresh token
 * (`offline_access`) and a bearer access token.
 */
export const chatGptTokenSet = (
  json: Record<string, unknown>,
  now = Date.now(),
  previousScopes?: readonly string[],
): ChatGptTokenSet => {
  const scope =
    typeof json.scope === "string" ? json.scope : previousScopes ? previousScopes.join(" ") : undefined;
  const expiresIn = Number(json.expires_in);
  if (
    typeof scope !== "string" ||
    typeof json.access_token !== "string" ||
    !json.access_token ||
    typeof json.refresh_token !== "string" ||
    !json.refresh_token ||
    (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer") ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new ChatGptError(
      "invalid_token_response",
      "ChatGPT returned incomplete credentials. Sign in to ChatGPT again.",
    );
  }
  const earliestRefreshAt = epochMs(json.earliest_refresh_at);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: now + expiresIn * 1000,
    ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    scopes: scope.split(/\s+/u).filter(Boolean),
    ...(typeof json.id_token === "string" && json.id_token ? { idToken: json.id_token } : {}),
  };
};

export const hasChatGptPlanUsage = (scopes: readonly string[]): boolean =>
  scopes.includes(CHATGPT_SIWC.planUsageScope);

/** The verified identity an ID token names. */
export type ChatGptIdentity = { subject: string; email?: string; name?: string };

/**
 * One ChatGPT account as a host saved it: the issued client id (one per
 * user and workspace), the verified identity, the retained ID token (for
 * `id_token_hint`), and its tokens.
 */
export type ChatGptRegistration = ChatGptIdentity & {
  clientId: string;
  idToken: string;
  tokens: ChatGptTokenSet;
  /** `chatgpt.tokens.use.direct` was granted. */
  planUsage: boolean;
};

// --- Models ---------------------------------------------------------------------------

export type ChatGptModel = { id: string; name: string };

/** `GET /v1/models`: the models meant for display, in the server's order. */
export const parseChatGptModels = (body: unknown): ChatGptModel[] => {
  const models =
    body && typeof body === "object" ? (body as Record<string, unknown>).models : undefined;
  if (!Array.isArray(models)) {
    throw new ChatGptError("invalid_model_catalog", "ChatGPT returned an unexpected model list.", true);
  }
  const result: ChatGptModel[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as Record<string, unknown>;
    if (model.visibility !== "list") continue;
    const slug = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(slug)) continue;
    const name = typeof model.display_name === "string" ? model.display_name.trim().slice(0, 200) : "";
    result.push({ id: slug, name: name || slug });
  }
  return result;
};

// --- Responses requests (preview limitations) ------------------------------------------

/**
 * Body fields the ChatGPT plan route rejects.
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */
export const CHATGPT_UNSUPPORTED_REQUEST_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  // HTTP requests carry the full history in `input`.
  "previous_response_id",
] as const;

/**
 * Tool types the route accepts: function and custom tools (optionally in
 * namespaces), and web search, which stays subject to model and workspace
 * policy. Hosted tools (image generation, file search, Code Interpreter,
 * computer use, hosted MCP/connectors, `tool_search`) are refused.
 */
export const CHATGPT_SUPPORTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  "function",
  "custom",
  "namespace",
  "web_search",
]);

/**
 * Why a Responses request body breaks the preview limits, or null when it
 * keeps them: `store: false`, `stream: true`, history as an `input` array
 * without system-role messages, no unsupported fields, supported tools only.
 */
export const chatGptRequestViolation = (body: Record<string, unknown>): string | null => {
  if (body.store !== false) return "ChatGPT plan requests must set store to false.";
  if (body.stream !== true) return "ChatGPT plan requests must stream.";
  for (const field of CHATGPT_UNSUPPORTED_REQUEST_FIELDS) {
    if (body[field] !== undefined) return `ChatGPT plan requests can't set "${field}".`;
  }
  if (!Array.isArray(body.input)) return "ChatGPT plan requests must send input as a list.";
  for (const item of body.input) {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).role === "system" &&
      ((item as Record<string, unknown>).type ?? "message") === "message"
    ) {
      return "ChatGPT plan requests carry system guidance in instructions, not system messages.";
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "ChatGPT plan requests must send tools as a list.";
    for (const tool of body.tools) {
      const type =
        tool && typeof tool === "object" ? (tool as Record<string, unknown>).type : undefined;
      if (typeof type !== "string" || !CHATGPT_SUPPORTED_TOOL_TYPES.has(type)) {
        return `ChatGPT plan requests can't use the "${String(type)}" tool.`;
      }
    }
  }
  return null;
};

export type { ChatGptProfileSummary, ChatGptProfilesState } from "./chatgpt-siwc-types.js";
