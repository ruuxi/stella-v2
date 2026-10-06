import { CHATGPT_SIWC } from "@stella/contracts/chatgpt-siwc";
import type { GatewayNativeCredentialProvider } from "@stella/contracts/gateway/capability";

export type NativeCredentialProvider = GatewayNativeCredentialProvider;

/**
 * Server-only credential material for a request bound to the owner's
 * connected engine. Callers must never serialize, log, or return it.
 */
export type NativeRelayCredential = {
  provider: NativeCredentialProvider;
  accessToken: string;
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
  // The cloud host's Sign in with ChatGPT access token is the whole
  // credential on the public Responses API.
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
): string | null => {
  if (authorized.userCredential?.provider !== "chatgpt") return null;
  // ChatGPT plan usage serves `POST /v1/responses` only.
  const pathname = new URL(request.url).pathname;
  return pathname.endsWith("/responses") ? CHATGPT_SIWC.responsesUrl : null;
};
