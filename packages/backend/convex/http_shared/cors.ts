import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import {
  getTrustedAppsHostOrigin,
  resolveManagedAppsHostOrigin,
  type AppsHostTrustEnv,
} from "../lib/dev_apps_host_origin";

const DEFAULT_CORS_ALLOWED_ORIGINS = [
  "http://localhost:57314",
  "https://stella.sh",
  "null",
];

const PERMISSIONS_POLICY =
  "accelerometer=(), browsing-topics=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=()";

const parseCorsOriginList = (rawValue: string | undefined): string[] =>
  (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

type CorsOriginEnv = AppsHostTrustEnv &
  Readonly<{
    SITE_URL?: string;
    CORS_ALLOWED_ORIGINS?: string;
  }>;

export const buildCorsAllowedOrigins = (env: CorsOriginEnv): Set<string> => {
  const configured = new Set<string>(DEFAULT_CORS_ALLOWED_ORIGINS);
  const trustedAppsHostOrigin = getTrustedAppsHostOrigin(env);
  const addConfiguredOrigin = (origin: string | undefined) => {
    if (!origin) return;
    const managedAppsHostOrigin = resolveManagedAppsHostOrigin(origin);
    if (
      managedAppsHostOrigin &&
      managedAppsHostOrigin !== trustedAppsHostOrigin
    ) {
      return;
    }
    configured.add(origin);
  };
  const siteUrl = env.SITE_URL;
  addConfiguredOrigin(siteUrl);
  const extraOrigins = parseCorsOriginList(env.CORS_ALLOWED_ORIGINS);
  for (const origin of extraOrigins) {
    addConfiguredOrigin(origin);
  }
  addConfiguredOrigin(trustedAppsHostOrigin ?? undefined);
  return configured;
};

const CORS_ALLOWED_ORIGINS = buildCorsAllowedOrigins(process.env);

const isAllowedCorsOrigin = (origin: string | null) => {
  if (!origin) return true;
  if (origin.match(/^http:\/\/localhost(:\d+)?$/)) return true;
  if (origin.match(/^http:\/\/127\.0\.0\.1(:\d+)?$/)) return true;
  if (origin.match(/^https:\/\/t-[a-z0-9]+(?:-[a-z0-9]+)+\.stellatunnel\.com$/))
    return true;
  return CORS_ALLOWED_ORIGINS.has(origin);
};

export const getCorsHeaders = (origin: string | null) => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Idempotency-Key, X-Stella-Request-Hash, X-Device-ID, X-Stella-Agent-Type, X-Stella-Relay-Request-Id, X-Stella-Voice-Session-ID, X-Stella-Mobile-Device-Id, X-Stella-Mobile-Pair-Secret, X-Stella-Mobile-Pair-Proof, X-Stella-Mobile-Pair-Proof-Issued-At, X-Stella-Mobile-Pair-Proof-Challenge, X-Stella-Mobile-Public-Key, X-Stella-Bridge-Session-Id, X-Stella-Bridge-Session-Secret, X-Stella-Bridge-Challenge-Id, X-Stella-Bridge-Encrypted",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Permissions-Policy": PERMISSIONS_POLICY,
    Vary: "Origin",
  };
  if (origin && isAllowedCorsOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
};

export const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const rejectDisallowedCorsOrigin = (
  request: Request,
): Response | null => {
  const origin = request.headers.get("origin");
  if (origin && !isAllowedCorsOrigin(origin)) {
    return new Response("CORS origin denied", { status: 403 });
  }
  return null;
};

export const preflightCorsResponse = (request: Request): Response =>
  new Response(null, {
    status: 204,
    headers: getCorsHeaders(request.headers.get("origin")),
  });

export const jsonResponse = (
  data: unknown,
  status: number = 200,
  origin?: string | null,
): Response => {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  return origin !== undefined ? withCors(response, origin) : response;
};

export const errorResponse = (
  status: number,
  message: string,
  origin?: string | null,
): Response => jsonResponse({ error: message }, status, origin);

/**
 * Wraps an HTTP handler with automatic CORS rejection checking and origin extraction.
 * The handler receives the origin already extracted and its response is automatically
 * returned as-is (the handler is responsible for calling withCors/jsonResponse/errorResponse
 * with the origin).
 */
export const handleCorsRequest = async (
  request: Request,
  handler: (origin: string | null) => Promise<Response>,
): Promise<Response> => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  const origin = request.headers.get("origin");
  return handler(origin);
};

/**
 * Standard CORS preflight handler for use by route modules.
 * Import `httpAction` from `../_generated/server` in each module and wrap this.
 */
export const corsPreflightHandler = async (
  request: Request,
): Promise<Response> => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  return preflightCorsResponse(request);
};

export const registerCorsOptions = (http: HttpRouter, paths: string[]) => {
  for (const path of paths) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) =>
        corsPreflightHandler(request),
      ),
    });
  }
};
