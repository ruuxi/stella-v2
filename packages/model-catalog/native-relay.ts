import type { GatewayNativeCredentialProvider } from "@stella/contracts/gateway/capability";

export const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type NativeCredentialProvider = GatewayNativeCredentialProvider;

/**
 * Server-only credential material for a request bound to the owner's
 * connected engine. Callers must never serialize, log, or return it.
 */
export type NativeRelayCredential = {
  provider: NativeCredentialProvider;
  accessToken: string;
  /** Required by ChatGPT's Codex backend; absent for Anthropic. */
  accountId?: string;
};

/** The fields of an authorized relay request the native lane reads. */
export type NativeRelayRequest = {
  requestJson: Record<string, unknown>;
  upstreamModel: string;
  userCredential?: NativeRelayCredential;
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
  credential: NativeRelayCredential,
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
  }
  // Anthropic: the caller is the real Claude Code CLI, which sends its own
  // anthropic-beta, x-app and anthropic-version headers. Pass them through.
  return headers;
};

/**
 * Native connected-engine requests already have the provider's exact body
 * shape. Do not run them through Stella's cross-provider normalization.
 */
export const nativeCredentialBody = (
  authorized: NativeRelayRequest,
): string => {
  const body: Record<string, unknown> = {
    ...authorized.requestJson,
    model: authorized.upstreamModel,
  };
  delete body.agentType;
  return JSON.stringify(body);
};

export const connectedCredentialUpstreamUrl = (
  authorized: Pick<NativeRelayRequest, "userCredential">,
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
