import type { AuthorizedStellaRequest } from "./shared";

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type CloudTurnTokenResult =
  | { ok: true; token: string | null }
  | { ok: false };

/**
 * Native Claude Code and Codex authenticate their configured provider with an
 * Authorization bearer. Cloud executors also send the explicit Stella header
 * for compatibility with the managed relay. If both are present they must be
 * the same capability, preventing an ambiguous-token confused-deputy path.
 */
export const cloudTurnTokenFromRequest = (
  request: Request,
): CloudTurnTokenResult => {
  const explicit = request.headers.get("x-stella-turn-token")?.trim() || null;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/iu.exec(authorization);
  const bearer = bearerMatch?.[1]?.trim() || null;
  if (explicit && bearer && explicit !== bearer) return { ok: false };
  return { ok: true, token: explicit ?? bearer };
};

/**
 * Never forward Stella capabilities, browser/session identity, or network
 * edge metadata to an upstream model provider.
 */
export const isInternalRelayRequestHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    lower === "authorization" ||
    lower === "x-api-key" ||
    lower === "x-goog-api-key" ||
    lower === "chatgpt-account-id" ||
    lower.startsWith("x-stella-") ||
    lower.startsWith("cf-") ||
    lower === "forwarded" ||
    lower.startsWith("x-forwarded-") ||
    lower === "x-real-ip" ||
    lower === "host" ||
    lower === "content-length" ||
    lower === "connection" ||
    lower === "keep-alive" ||
    lower === "proxy-authorization" ||
    lower === "proxy-authenticate" ||
    lower === "te" ||
    lower === "trailer" ||
    lower === "transfer-encoding" ||
    lower === "upgrade" ||
    lower === "cookie" ||
    lower === "set-cookie"
  );
};

export const connectedCredentialForwardHeaders = (
  request: Request,
  credential: NonNullable<AuthorizedStellaRequest["userCredential"]>,
): Headers => {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!isInternalRelayRequestHeader(key)) headers.set(key, value);
  });
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${credential.accessToken}`);

  if (credential.provider === "openai-codex") {
    if (!credential.accountId) {
      throw new Error("ChatGPT account identity is unavailable.");
    }
    headers.set("chatgpt-account-id", credential.accountId);
    return headers;
  }

  const incomingBetas = request.headers
    .get("anthropic-beta")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const betas = new Set([
    "claude-code-20250219",
    "oauth-2025-04-20",
    ...(incomingBetas ?? []),
  ]);
  headers.set("anthropic-beta", Array.from(betas).join(","));
  if (!headers.has("x-app")) headers.set("x-app", "cli");
  return headers;
};

export const withClaudeCodeIdentity = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  const system = body.system;
  if (typeof system === "string") {
    return { ...body, system: [identityBlock, { type: "text", text: system }] };
  }
  if (Array.isArray(system)) {
    const first = system[0] as { text?: unknown } | undefined;
    if (first?.text === CLAUDE_CODE_IDENTITY) return body;
    return { ...body, system: [identityBlock, ...system] };
  }
  return { ...body, system: [identityBlock] };
};

/**
 * Native connected-engine requests already have the provider's exact body
 * shape. Do not run them through Stella's cross-provider normalization.
 */
export const nativeCredentialBody = (
  authorized: AuthorizedStellaRequest,
): string => {
  const body: Record<string, unknown> = {
    ...authorized.requestJson,
    model: authorized.upstreamModel,
  };
  delete body.agentType;
  return JSON.stringify(
    authorized.userCredential?.provider === "anthropic" &&
      authorized.userCredential.injectClaudeCodeIdentity === true
      ? withClaudeCodeIdentity(body)
      : body,
  );
};

export const connectedCredentialUpstreamUrl = (
  authorized: AuthorizedStellaRequest,
  request: Request,
  anthropicBaseUrl: string,
): string | null => {
  const credentialProvider = authorized.userCredential?.provider;
  if (credentialProvider === "openai-codex") {
    const pathname = new URL(request.url).pathname;
    if (
      pathname.endsWith("/responses/compact") ||
      pathname.endsWith("/v1/responses/compact")
    ) {
      return `${CODEX_UPSTREAM_BASE_URL}/responses/compact`;
    }
    if (pathname.endsWith("/responses") || pathname.endsWith("/v1/responses")) {
      return `${CODEX_UPSTREAM_BASE_URL}/responses`;
    }
    return null;
  }
  if (credentialProvider === "anthropic") {
    const pathname = new URL(request.url).pathname;
    const base = anthropicBaseUrl.replace(/\/+$/u, "");
    if (pathname.endsWith("/v1/messages/count_tokens")) {
      return `${base}/messages/count_tokens`;
    }
    return pathname.endsWith("/v1/messages") ? `${base}/messages` : null;
  }
  return null;
};
