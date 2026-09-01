import {
  AppsHostConfigurationError,
  readAppsHostConfig,
  type AppsHostConfig,
  type AppsHostEnv,
} from "./config";
import {
  BROWSER_AUTH_HANDOFF_SCRIPT_PATH,
  RETIRED_BROWSER_AUTH_STORAGE_KEYS,
  browserAuthHandoffResponse,
  browserAuthHandoffScriptResponse,
} from "./auth-handoff";
import {
  handleProxyPreflight,
  hostedContentSecurityHeaders,
  isSafeArtifactPrefix,
  MAX_APP_ASSET_BYTES,
  MAX_INTERIOR_ASSET_BYTES,
  parseAssetPath,
  pathHasExtension,
  proxyFetch,
  readBoundedBytes,
} from "./http-security";
import { verifyAppBootstrap } from "./app-auth-service";
import {
  INTERIOR_WRAPPER_SCRIPT_PATH,
  interiorWrapperResponse,
  interiorWrapperScript,
} from "./interior-shell-wrapper";
import type { InteriorRouteBuildIdentity } from "./interior-shell-policy";
import {
  handleInteriorConversationSocket,
  handleInteriorConvexSocket,
  handleInteriorDictationSocket,
  handleInteriorService,
  handleInteriorSession,
} from "./interior-shell-gateway";

export { AppsAuthService } from "./app-auth-service";
export { AppFetchGate } from "./app-fetch-gate";

type RouteRecord = {
  artifactPrefix: string;
  suspended: boolean;
  appId?: string;
  slug?: string;
};

type RouteLookup =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "route"; route: RouteRecord };

const ACTIVE_ROUTE_MAX_BYTES = 16 * 1024;
const ACTIVE_ROUTE_TIMEOUT_MS = 10_000;
const ACTIVE_ROUTE_ID =
  /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTERIOR_BUILD_ID = /^interior-[0-9a-f]{48}$/;
const OWNER_HASH = /^[0-9a-f]{64}$/;
const APP_BUILD_PREFIX = /^builds\/[0-9a-f]{64}\/[A-Za-z0-9_-]{1,64}$/;
const APP_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_INTERIOR_PREFIX = /^interior\/[A-Za-z0-9._-]{1,128}$/;
const APP_WRAPPER_SCRIPT_PATH = "/_stella/app-wrapper.js";
const AUTH_EXCHANGE_PATH = "/_stella/auth/exchange";

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-apps-host",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const methodNotAllowed = (allowed: string): Response =>
  new Response("Method not allowed", {
    status: 405,
    headers: { allow: allowed, "cache-control": "no-store" },
  });

const unavailable = (): Response =>
  Response.json(
    { error: "The Stella Apps host is unavailable." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );

const readRoute = async (
  config: AppsHostConfig,
  key: string,
  expectedKind: "app" | "default-interior",
  expectedSlug?: string,
): Promise<RouteLookup> => {
  if (!config.appRoutes) return { kind: "invalid" };
  const value = await config.appRoutes.get<unknown>(key, "json");
  if (value === null) return { kind: "missing" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.artifactPrefix !== "string" ||
    !isSafeArtifactPrefix(candidate.artifactPrefix) ||
    (expectedKind === "app" &&
      !APP_BUILD_PREFIX.test(candidate.artifactPrefix)) ||
    (expectedKind === "default-interior" &&
      !DEFAULT_INTERIOR_PREFIX.test(candidate.artifactPrefix)) ||
    typeof candidate.suspended !== "boolean"
  ) {
    return { kind: "invalid" };
  }
  if (
    expectedKind === "app" &&
    (typeof candidate.appId !== "string" ||
      candidate.appId.length < 1 ||
      candidate.appId.length > 256 ||
      candidate.slug !== expectedSlug)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "route",
    route: {
      artifactPrefix: candidate.artifactPrefix,
      suspended: candidate.suspended,
      ...(typeof candidate.appId === "string"
        ? { appId: candidate.appId }
        : {}),
      ...(typeof candidate.slug === "string" ? { slug: candidate.slug } : {}),
    },
  };
};

const notice = (
  config: AppsHostConfig,
  title: string,
  message: string,
  status: number,
): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;display:grid;min-height:100vh;place-content:center;background:#f4f1e8;color:#182019}main{max-width:520px;padding:42px;background:white;border-radius:20px}h1{font:42px Georgia,serif;margin:0 0 14px}p{line-height:1.6}</style><main><h1>${title}</h1><p>${message}</p></main>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...hostedContentSecurityHeaders(config),
      },
    },
  );

const loadHostedAsset = async (args: {
  config: AppsHostConfig;
  requestId: string;
  artifactPrefix: string;
  rawAssetPath: string | undefined;
  headOnly: boolean;
  immutable: boolean;
  maxBytes: number;
  logContext: Record<string, unknown>;
}): Promise<Response> => {
  if (!args.config.appBuilds) {
    return new Response("The hosted asset store is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const assetPath = parseAssetPath(args.rawAssetPath);
  if (!assetPath) {
    log("error", "asset_path_rejected", {
      requestId: args.requestId,
      ...args.logContext,
    });
    return new Response("Not found", { status: 404 });
  }
  const load = (relative: string) =>
    args.config.appBuilds!.get(`${args.artifactPrefix}/${relative}`);
  let object = await load(assetPath);
  let resolvedAssetPath = assetPath;
  if (!object && !pathHasExtension(assetPath)) {
    object = await load("index.html");
    resolvedAssetPath = "index.html";
  }
  if (!object) {
    log("error", "asset_not_found", {
      requestId: args.requestId,
      assetPath,
      ...args.logContext,
    });
    return new Response("Not found", { status: 404 });
  }
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > args.maxBytes
  ) {
    await object.body.cancel().catch(() => undefined);
    log("error", "asset_size_rejected", {
      requestId: args.requestId,
      assetPath,
      assetBytes: object.size,
      ...args.logContext,
    });
    return new Response("The hosted asset is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const headers = new Headers(hostedContentSecurityHeaders(args.config));
  object.writeHttpMetadata(headers);
  headers.set(
    "cache-control",
    args.immutable
      ? "public, max-age=31536000, immutable"
      : resolvedAssetPath === "index.html" ||
          resolvedAssetPath === "stella-context.js"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
  );
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  if (args.headOnly) {
    await object.body.cancel().catch(() => undefined);
  }
  return new Response(args.headOnly ? null : object.body, { headers });
};

const immutableInteriorAsset = async (
  config: AppsHostConfig,
  requestId: string,
  ownerHash: string,
  buildId: string,
  rawAssetPath: string | undefined,
  headOnly: boolean,
): Promise<Response> =>
  loadHostedAsset({
    config,
    requestId,
    artifactPrefix: `interiors/${ownerHash}/${buildId}`,
    rawAssetPath,
    headOnly,
    immutable: true,
    maxBytes: MAX_INTERIOR_ASSET_BYTES,
    logContext: { ownerHash, buildId },
  });

const publishedDefaultInteriorAsset = async (
  config: AppsHostConfig,
  requestId: string,
  rawAssetPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  const lookup = await readRoute(
    config,
    "app:stella-interior",
    "default-interior",
  );
  if (lookup.kind !== "route" || lookup.route.suspended) {
    log("error", "default_interior_unavailable", {
      requestId,
      routeState: lookup.kind,
    });
    return new Response("The packaged Stella interior is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const response = await loadHostedAsset({
    config,
    requestId,
    artifactPrefix: lookup.route.artifactPrefix,
    rawAssetPath,
    headOnly,
    immutable: false,
    maxBytes: MAX_INTERIOR_ASSET_BYTES,
    logContext: { route: "default-interior" },
  });
  if (response.ok) response.headers.set("cache-control", "no-store");
  return response;
};

const readActiveRoute = async (
  config: AppsHostConfig,
  stableRouteId: string,
): Promise<Response> => {
  if (!config.appAuth) {
    return new Response("The active Stella route is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  try {
    const route = await config.appAuth.getInteriorRoute({ stableRouteId });
    return route
      ? Response.json(route)
      : Response.json(
          { error: "Stella interior route not found." },
          { status: 404 },
        );
  } catch {
    return Response.json(
      { error: "The active Stella route is unavailable." },
      { status: 503 },
    );
  }
};

const readActiveRoutePayload = async (
  config: AppsHostConfig,
  stableRouteId: string,
): Promise<Record<string, unknown> | Response> => {
  const response = await readActiveRoute(config, stableRouteId);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return new Response(
      response.status === 404
        ? "Stella interior route not found."
        : "The active Stella route is unavailable.",
      {
        status: response.status === 404 ? 404 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > ACTIVE_ROUTE_MAX_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return new Response("The active Stella route is invalid.", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
  try {
    const bytes = await readBoundedBytes(response.body, ACTIVE_ROUTE_MAX_BYTES);
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid route payload");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return new Response("The active Stella route is invalid.", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
};

const resolveInteriorRouteBuild = async (
  config: AppsHostConfig,
  stableRouteId: string,
): Promise<InteriorRouteBuildIdentity | Response> => {
  const route = await readActiveRoutePayload(config, stableRouteId);
  if (route instanceof Response) return route;
  if (route.mode === "default") {
    const lookup = await readRoute(
      config,
      "app:stella-interior",
      "default-interior",
    );
    if (lookup.kind !== "route" || lookup.route.suspended) {
      return new Response("The packaged Stella interior is unavailable.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    return { mode: "default", buildId: lookup.route.artifactPrefix };
  }
  const ownerHash = typeof route.ownerHash === "string" ? route.ownerHash : "";
  const buildId = typeof route.buildId === "string" ? route.buildId : "";
  if (
    route.mode !== "custom" ||
    !OWNER_HASH.test(ownerHash) ||
    !INTERIOR_BUILD_ID.test(buildId) ||
    route.artifactPrefix !== `interiors/${ownerHash}/${buildId}`
  ) {
    return new Response("The active Stella route is invalid.", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
  return { mode: "custom", buildId };
};

const ANONYMOUS_VIEWER_COOKIE = "__Host-stella_app_viewer";
const ACCOUNT_SESSION_COOKIE = "__Host-stella_account_session";
const IDENTITY_INTENT_COOKIE = "__Host-stella_identity_intent";
const ANONYMOUS_VIEWER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const parseCookie = (request: Request, name: string): string | null => {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    return value.length > 0 && value.length <= 8_192 ? value : null;
  }
  return null;
};

const BETTER_AUTH_SESSION_PATTERN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const MAX_AUTH_PROXY_BODY_BYTES = 256 * 1024;

const trustedAuthProxy = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  if (config.hostRole !== "trusted") {
    return new Response("Not found", { status: 404 });
  }
  const incomingUrl = new URL(request.url);
  if (
    incomingUrl.pathname !== AUTH_EXCHANGE_PATH ||
    request.method !== "POST"
  ) {
    return new Response("Not found", { status: 404 });
  }
  if (request.headers.get("origin") !== config.trustedAppsHostOrigin) {
    return new Response("Forbidden", { status: 403 });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  const fetchMode = request.headers.get("sec-fetch-mode");
  if (fetchSite !== "same-origin" || fetchMode !== "cors") {
    return new Response("Forbidden", { status: 403 });
  }
  const body = await readBoundedBytes(request.body, MAX_AUTH_PROXY_BODY_BYTES);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const accept = request.headers.get("accept");
  if (contentType) headers.set("content-type", contentType);
  if (accept) headers.set("accept", accept);
  headers.set("origin", config.trustedAppsHostOrigin);
  const upstreamUrl = new URL(
    "/api/auth/one-time-token/verify",
    config.convexSiteOrigin,
  );
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "location"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set(
    "access-control-allow-origin",
    config.trustedAppsHostOrigin,
  );
  responseHeaders.set("access-control-allow-credentials", "true");
  responseHeaders.set("vary", "Origin");
  const rotated = (upstream.headers.get("set-auth-token") ?? "").trim();
  if (BETTER_AUTH_SESSION_PATTERN.test(rotated)) {
    responseHeaders.append(
      "set-cookie",
      `${ACCOUNT_SESSION_COOKIE}=${rotated}; Path=/; HttpOnly; Secure; SameSite=None`,
    );
    responseHeaders.append(
      "set-cookie",
      `${IDENTITY_INTENT_COOKIE}=connected; Path=/; HttpOnly; Secure; SameSite=None`,
    );
  }
  // set-auth-token and upstream cookies are intentionally never forwarded.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};

const connectedAppSession = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  const corsHeaders = {
    "access-control-allow-origin": config.appsHostOrigin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") !== config.appsHostOrigin) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== config.appsHostOrigin
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  const fetchMode = request.headers.get("sec-fetch-mode");
  if (
    (fetchSite !== "same-site" && fetchSite !== "cross-site") ||
    fetchMode !== "cors"
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const bearer = parseCookie(request, ACCOUNT_SESSION_COOKIE);
  if (!bearer || !BETTER_AUTH_SESSION_PATTERN.test(bearer)) {
    return Response.json(
      { error: "Sign in required." },
      { status: 401, headers: corsHeaders },
    );
  }
  let bootstrap: string;
  try {
    const bytes = await readBoundedBytes(request.body, 16 * 1024);
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as { bootstrap?: unknown };
    if (typeof body.bootstrap !== "string") throw new Error("invalid");
    bootstrap = body.bootstrap;
  } catch {
    return Response.json(
      { error: "A valid app bootstrap is required." },
      { status: 400, headers: corsHeaders },
    );
  }
  let appId: string;
  try {
    ({ appId } = await verifyAppBootstrap(config, {
      bootstrap,
      origin: config.appsHostOrigin,
    }));
  } catch {
    return Response.json(
      { error: "The app bootstrap is invalid." },
      { status: 401, headers: corsHeaders },
    );
  }
  const upstream = await fetch(
    new URL("/api/apps/session", config.convexSiteOrigin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        origin: config.appsHostOrigin,
      },
      body: JSON.stringify({ appId }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders,
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
};

const anonymousAppSession = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!config.appAuth) return unavailable();
  let body: unknown;
  try {
    const bytes = await readBoundedBytes(request.body, 8 * 1024);
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return Response.json(
      { error: "A valid app-session request is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const bootstrap =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).bootstrap
      : null;
  if (
    typeof bootstrap !== "string" ||
    bootstrap.length < 32 ||
    bootstrap.length > 8_192
  ) {
    return Response.json(
      { error: "A valid app bootstrap is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const requestOrigin = request.headers.get("origin");
  const actualOrigin = new URL(request.url).origin;
  if (
    requestOrigin !== actualOrigin ||
    requestOrigin === "null" ||
    (actualOrigin !== config.appsHostOrigin &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(actualOrigin))
  ) {
    return Response.json(
      { error: "The app-session origin is invalid." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const existingViewerToken = parseCookie(request, ANONYMOUS_VIEWER_COOKIE);
  let result: Record<string, unknown>;
  try {
    result = await config.appAuth.mintAnonymousSession({
      bootstrap,
      origin: actualOrigin,
      viewerToken: existingViewerToken,
    });
  } catch {
    const headers = new Headers({ "cache-control": "no-store" });
    if (existingViewerToken) {
      headers.set(
        "set-cookie",
        `${ANONYMOUS_VIEWER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
    }
    return Response.json(
      { error: "The anonymous app session could not be started." },
      { status: 401, headers },
    );
  }
  const viewerToken = result.viewerToken;
  const viewerTokenExpiresAt = result.viewerTokenExpiresAt;
  if (
    typeof result.token !== "string" ||
    typeof result.expiresAt !== "number" ||
    !result.user ||
    typeof result.user !== "object" ||
    typeof viewerToken !== "string" ||
    typeof viewerTokenExpiresAt !== "number"
  ) {
    return unavailable();
  }
  const publicResult = { ...result };
  delete publicResult.viewerToken;
  delete publicResult.viewerTokenExpiresAt;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  const cookieMaxAge = Math.max(
    0,
    Math.min(
      ANONYMOUS_VIEWER_COOKIE_MAX_AGE_SECONDS,
      Math.floor((viewerTokenExpiresAt - Date.now()) / 1_000),
    ),
  );
  headers.set(
    "set-cookie",
    `${ANONYMOUS_VIEWER_COOKIE}=${viewerToken}; Path=/; Max-Age=${cookieMaxAge}; HttpOnly; Secure; SameSite=Lax`,
  );
  return new Response(JSON.stringify(publicResult), { headers });
};

export const appWrapperScript = (): string => `(() => {
  "use strict";
  const PROTOCOL = 2;
  const PREFIX = "stella-bridge-v2:";
  const root = document.documentElement;
  const frame = document.getElementById("stella-generated-app");
  let bootstrap = root.dataset.bootstrap;
  let bootstrapExpiresAt = Number(root.dataset.bootstrapExpiresAt);
  const bootstrapRefreshUrl = root.dataset.bootstrapRefreshUrl;
  const convexSiteUrl = root.dataset.convexSiteUrl;
  const trustedAuthOrigin = root.dataset.trustedAuthOrigin;
  const innerNonce = crypto.randomUUID();
  const retiredAuthKeys = ${JSON.stringify(RETIRED_BROWSER_AUTH_STORAGE_KEYS)};
  for (const key of retiredAuthKeys) {
    try { localStorage.removeItem(key); } catch {}
    try { sessionStorage.removeItem(key); } catch {}
  }
  let outer = null;
  let outerInitClosed = false;
  let outerInitTimer = null;
  let childStarted = false;
  const child = () => frame.contentWindow;
  const initializeChild = () => child()?.postMessage({
    source: "stella-host-init",
    protocol: PROTOCOL,
    nonce: innerNonce,
    parentOrigin: location.origin,
  }, "*");
  const startChild = () => {
    if (childStarted) return;
    childStarted = true;
    outerInitClosed = true;
    frame.addEventListener("load", initializeChild, { once: true });
    frame.src = frame.dataset.rawSrc;
  };
  frame.name = PREFIX + encodeURIComponent(JSON.stringify({
    nonce: innerNonce,
    parentOrigin: location.origin,
  }));
  let sessionPromise = null;
  const ensureBootstrap = async () => {
    if (bootstrap && Number.isSafeInteger(bootstrapExpiresAt) &&
        bootstrapExpiresAt > Date.now() + 5000) return;
    const response = await fetch(bootstrapRefreshUrl, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const value = await response.json();
    if (!response.ok || typeof value.bootstrap !== "string" ||
        !Number.isSafeInteger(value.expiresAt)) {
      throw new Error(value.error || "Could not refresh app authorization.");
    }
    bootstrap = value.bootstrap;
    bootstrapExpiresAt = value.expiresAt;
  };
  const session = async () => {
    if (!sessionPromise) sessionPromise = (async () => {
      await ensureBootstrap();
      let response = await fetch(trustedAuthOrigin + "/api/apps/connected-session", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrap }),
      });
      if (response.status === 401) {
        response = await fetch("/api/apps/session", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bootstrap }),
        });
      }
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Could not start app session.");
      return value;
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
    const value = await sessionPromise;
    if (value.expiresAt <= Date.now() + 5000) {
      sessionPromise = null;
      return session();
    }
    return value;
  };
  const call = async (path, body) => {
    const current = await session();
    const response = await fetch(convexSiteUrl + "/api/apps/" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + current.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "The app request failed.");
    return value;
  };
  const respond = (id, result, error) => child()?.postMessage({
    source: "stella-host", protocol: PROTOCOL, nonce: innerNonce, id, result, error,
  }, "*");
  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (event.source === window.parent && message.source === "stella-host-init" &&
        message.protocol === PROTOCOL && !outer && !outerInitClosed &&
        typeof message.nonce === "string" &&
        /^[0-9a-f-]{36}$/i.test(message.nonce) &&
        message.parentOrigin === event.origin) {
      outer = { nonce: message.nonce, parentOrigin: event.origin };
      if (outerInitTimer !== null) clearTimeout(outerInitTimer);
      startChild();
      return;
    }
    if (outer && event.source === window.parent) {
      if (event.origin !== outer.parentOrigin || message.source !== "stella-host" ||
          message.protocol !== PROTOCOL || message.nonce !== outer.nonce) return;
      child()?.postMessage({ ...message, nonce: innerNonce }, "*");
      return;
    }
    if (event.source !== child() || event.origin !== "null" ||
        message.source !== "stella-app" || message.protocol !== PROTOCOL ||
        message.nonce !== innerNonce) return;
    if (outer) {
      window.parent.postMessage(
        { ...message, nonce: outer.nonce },
        outer.parentOrigin === "null" ? "*" : outer.parentOrigin,
      );
      return;
    }
    if (!message.id || typeof message.method !== "string") return;
    void (async () => {
      try {
        if (message.method === "session") return respond(message.id, await session());
        if (["storage/get", "storage/list", "storage/set", "storage/delete",
             "operations/describe", "operations/poll", "operations/result"].includes(message.method)) {
          return respond(message.id, await call(message.method, message.params));
        }
        if (message.method === "fetch") {
          const current = await session();
          const capResponse = await fetch(convexSiteUrl + "/api/apps/fetch-capability", {
            method: "POST",
            headers: { authorization: "Bearer " + current.token, "content-type": "application/json" },
            body: JSON.stringify(message.params || {}),
          });
          const cap = await capResponse.json();
          if (!capResponse.ok || typeof cap.capability !== "string") throw new Error(cap.error || "Fetch denied.");
          const response = await fetch("/api/apps/fetch", {
            method: "POST",
            headers: { authorization: "Bearer " + cap.capability, "content-type": "application/json" },
            body: JSON.stringify(message.params || {}),
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return respond(message.id, { status: response.status, headers: Object.fromEntries(response.headers), body: btoa(binary), base64: true });
        }
        if (message.method === "share") {
          if (navigator.share) await navigator.share(message.params);
          else await navigator.clipboard.writeText(message.params?.url || message.params?.text || "");
          return respond(message.id, { ok: true });
        }
        throw new Error("This app capability is not available.");
      } catch (error) {
        respond(message.id, undefined, error instanceof Error ? error.message : "The app request failed.");
      }
    })();
  });
  if (window.parent === window || outer) {
    startChild();
  } else {
    window.parent.postMessage({ source: "stella-wrapper-ready", protocol: PROTOCOL }, "*");
    outerInitTimer = setTimeout(startChild, 1000);
  }
})();`;

const appWrapper = async (
  request: Request,
  config: AppsHostConfig,
  slug: string,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  if (!config.appAuth) return unavailable();
  const lookup = await readRoute(config, `app:${slug}`, "app", slug);
  if (
    lookup.kind !== "route" ||
    lookup.route.suspended ||
    !lookup.route.appId
  ) {
    return notice(
      config,
      "App unavailable",
      "This Stella app is unavailable.",
      lookup.kind === "missing" ? 404 : 503,
    );
  }
  let minted: { bootstrap: string; expiresAt: number };
  try {
    minted = await config.appAuth.mintAppBootstrap({
      appId: lookup.route.appId,
      slug,
      origin: config.appsHostOrigin,
    });
  } catch {
    return unavailable();
  }
  const rawUrl = `/_stella/apps-assets/${encodeURIComponent(slug)}/`;
  const bootstrapRefreshUrl = `/apps/${encodeURIComponent(slug)}/_bootstrap`;
  const html = `<!doctype html><html data-bootstrap="${minted.bootstrap}" data-bootstrap-expires-at="${minted.expiresAt}" data-bootstrap-refresh-url="${bootstrapRefreshUrl}" data-convex-site-url="${config.convexSiteOrigin}" data-trusted-auth-origin="${config.trustedAppsHostOrigin}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stella app</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{overflow:hidden}</style><iframe id="stella-generated-app" title="Stella app" data-raw-src="${rawUrl}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe><script src="${APP_WRAPPER_SCRIPT_PATH}"></script></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self' " +
        config.convexSiteOrigin +
        " " +
        config.trustedAppsHostOrigin +
        "; object-src 'none'; base-uri 'none'; frame-ancestors file: http://localhost:* http://127.0.0.1:* https://stella.sh",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};

const refreshAppBootstrap = async (
  request: Request,
  config: AppsHostConfig,
  slug: string,
): Promise<Response> => {
  const actualOrigin = new URL(request.url).origin;
  if (
    request.method !== "POST" ||
    actualOrigin !== config.appsHostOrigin ||
    request.headers.get("origin") !== actualOrigin ||
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    request.headers.get("sec-fetch-mode") !== "cors"
  ) {
    return Response.json(
      { error: "The app bootstrap refresh is unavailable." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  if (request.body) {
    let body: Uint8Array;
    try {
      body = await readBoundedBytes(request.body, 1);
    } catch {
      return Response.json(
        { error: "The app bootstrap refresh body must be empty." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (body.byteLength > 0) {
      return Response.json(
        { error: "The app bootstrap refresh body must be empty." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  }
  if (!config.appAuth) return unavailable();
  const lookup = await readRoute(config, `app:${slug}`, "app", slug);
  if (
    lookup.kind !== "route" ||
    lookup.route.suspended ||
    !lookup.route.appId
  ) {
    return Response.json(
      { error: "The Stella app is unavailable." },
      {
        status: lookup.kind === "missing" ? 404 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  try {
    const minted = await config.appAuth.mintAppBootstrap({
      appId: lookup.route.appId,
      slug,
      origin: config.appsHostOrigin,
    });
    return Response.json(minted, {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return unavailable();
  }
};

const activeInteriorAsset = async (
  config: AppsHostConfig,
  requestId: string,
  stableRouteId: string,
  rawAssetPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  let routeOrResponse: Record<string, unknown> | Response;
  try {
    routeOrResponse = await readActiveRoutePayload(config, stableRouteId);
  } catch {
    return new Response("The active Stella route is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (routeOrResponse instanceof Response) return routeOrResponse;
  const route = routeOrResponse;
  if (route.mode === "default") {
    return publishedDefaultInteriorAsset(
      config,
      requestId,
      rawAssetPath,
      headOnly,
    );
  }
  const ownerHash = typeof route.ownerHash === "string" ? route.ownerHash : "";
  const buildId = typeof route.buildId === "string" ? route.buildId : "";
  if (
    route.mode !== "custom" ||
    !OWNER_HASH.test(ownerHash) ||
    !INTERIOR_BUILD_ID.test(buildId) ||
    route.artifactPrefix !== `interiors/${ownerHash}/${buildId}`
  ) {
    return new Response("The active Stella route is invalid.", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
  const assetResponse = await immutableInteriorAsset(
    config,
    requestId,
    ownerHash,
    buildId,
    rawAssetPath,
    headOnly,
  );
  if (assetResponse.ok) assetResponse.headers.set("cache-control", "no-store");
  return assetResponse;
};

const interiorManifest = async (
  request: Request,
  config: AppsHostConfig,
  requestId: string,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  const lookup = await readRoute(
    config,
    "app:stella-interior",
    "default-interior",
  );
  if (lookup.kind !== "route" || lookup.route.suspended) {
    log("error", "interior_manifest_unavailable", {
      requestId,
      routeState: lookup.kind,
    });
    return Response.json(
      { error: "The Stella interior is not available." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const origin = new URL(request.url).origin;
  const body = JSON.stringify({
    version: lookup.route.artifactPrefix,
    bundleUrl: `${origin}/apps/stella-interior/bundle.zip`,
    remoteUrl: `${origin}/apps/stella-interior/`,
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};

const appAsset = async (
  request: Request,
  config: AppsHostConfig,
  requestId: string,
  slug: string,
  rawAssetPath: string | undefined,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  if (config.sharesDisabled) {
    log("error", "global_kill_switch_served", { requestId });
    return notice(
      config,
      "Temporarily unavailable",
      "Shared Stella apps are paused right now.",
      503,
    );
  }
  const isPackagedInterior = slug === "stella-interior";
  const lookup = await readRoute(
    config,
    `app:${slug}`,
    isPackagedInterior ? "default-interior" : "app",
    isPackagedInterior ? undefined : slug,
  );
  if (lookup.kind === "missing") {
    return notice(
      config,
      "App not found",
      "This Stella app does not exist.",
      404,
    );
  }
  if (lookup.kind === "invalid") {
    log("error", "app_route_invalid", { requestId, slug });
    return notice(
      config,
      "App unavailable",
      "This Stella app is temporarily unavailable.",
      503,
    );
  }
  if (lookup.route.suspended) {
    log("info", "suspended_notice_served", { requestId, slug });
    return notice(
      config,
      "App suspended",
      "This Stella app is currently unavailable.",
      403,
    );
  }
  return loadHostedAsset({
    config,
    requestId,
    artifactPrefix: lookup.route.artifactPrefix,
    rawAssetPath,
    headOnly: request.method === "HEAD",
    immutable: false,
    maxBytes: isPackagedInterior
      ? MAX_INTERIOR_ASSET_BYTES
      : MAX_APP_ASSET_BYTES,
    logContext: { slug },
  });
};

const handleRequest = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  const url = new URL(request.url);
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  log("info", "request_started", {
    requestId,
    method: request.method,
    path: url.pathname,
    host: url.host,
  });

  if (url.pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({
            ok: true,
            service: "stella-v2-apps-host",
            deployment: config.deploymentIdentity,
            role: config.hostRole,
          }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  if (
    config.hostRole === "trusted" &&
    url.pathname === BROWSER_AUTH_HANDOFF_SCRIPT_PATH
  ) {
    return browserAuthHandoffScriptResponse(request, config);
  }
  if (url.pathname === AUTH_EXCHANGE_PATH) {
    if (config.hostRole !== "trusted")
      return new Response("Not found", { status: 404 });
    try {
      return await trustedAuthProxy(request, config);
    } catch {
      return unavailable();
    }
  }
  if (url.pathname === "/api/apps/connected-session") {
    if (config.hostRole !== "trusted")
      return new Response("Not found", { status: 404 });
    try {
      return await connectedAppSession(request, config);
    } catch {
      return unavailable();
    }
  }
  if (url.pathname === "/api/interior/session") {
    if (config.hostRole !== "trusted") {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await handleInteriorSession(request, config);
    } catch {
      return unavailable();
    }
  }
  if (config.hostRole === "trusted") {
    try {
      const convexSocket = await handleInteriorConvexSocket(request, config);
      if (convexSocket) return convexSocket;
      const conversationSocket = await handleInteriorConversationSocket(
        request,
        config,
      );
      if (conversationSocket) return conversationSocket;
      const dictationSocket = await handleInteriorDictationSocket(
        request,
        config,
      );
      if (dictationSocket) return dictationSocket;
      const service = await handleInteriorService(request, config);
      if (service) return service;
    } catch {
      return unavailable();
    }
  }
  if (url.pathname === APP_WRAPPER_SCRIPT_PATH) {
    if (config.hostRole !== "untrusted")
      return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return methodNotAllowed("GET, HEAD");
    return new Response(request.method === "HEAD" ? null : appWrapperScript(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (url.pathname === INTERIOR_WRAPPER_SCRIPT_PATH) {
    if (config.hostRole !== "untrusted") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return new Response(
      request.method === "HEAD" ? null : interiorWrapperScript(),
      {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
  if (
    config.hostRole === "untrusted" &&
    url.pathname === "/api/interior/manifest"
  ) {
    return interiorManifest(request, config, requestId);
  }
  if (url.pathname === "/api/apps/fetch") {
    if (config.hostRole !== "untrusted")
      return new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS")
      return handleProxyPreflight(request, config);
    if (request.method === "POST") return proxyFetch(request, config);
    return methodNotAllowed("POST, OPTIONS");
  }
  if (url.pathname === "/api/apps/session") {
    if (config.hostRole !== "untrusted")
      return new Response("Not found", { status: 404 });
    return anonymousAppSession(request, config);
  }

  const interiorBuild = url.pathname.match(
    /^\/interior-builds\/([0-9a-f]{64})\/(interior-[0-9a-f]{48})(\/.*)?$/,
  );
  if (interiorBuild) {
    if (config.hostRole !== "untrusted")
      return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return immutableInteriorAsset(
      config,
      requestId,
      interiorBuild[1],
      interiorBuild[2],
      interiorBuild[3],
      request.method === "HEAD",
    );
  }

  const activeInterior = url.pathname.match(
    /^\/stella\/(sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)?$/,
  );
  if (activeInterior && ACTIVE_ROUTE_ID.test(activeInterior[1])) {
    if (
      config.hostRole === "trusted" &&
      (activeInterior[2] === "/auth" || activeInterior[2] === "/auth/")
    ) {
      return browserAuthHandoffResponse(request, config);
    }
    if (config.hostRole !== "untrusted")
      return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    if (!config.appAuth) return unavailable();
    const routeBuild = await resolveInteriorRouteBuild(
      config,
      activeInterior[1],
    );
    if (routeBuild instanceof Response) return routeBuild;
    let minted: { bootstrap: string; expiresAt: number };
    try {
      minted = await config.appAuth.mintInteriorBootstrap({
        stableRouteId: activeInterior[1],
        routeBuild,
        origin: config.appsHostOrigin,
      });
    } catch {
      return unavailable();
    }
    return interiorWrapperResponse({
      request,
      config,
      stableRouteId: activeInterior[1],
      bootstrap: minted.bootstrap,
      rawUrl: `/_stella/interior-assets/${activeInterior[1]}${activeInterior[2] ?? "/"}`,
    });
  }

  const rawInterior = url.pathname.match(
    /^\/_stella\/interior-assets\/(sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)?$/,
  );
  if (rawInterior && ACTIVE_ROUTE_ID.test(rawInterior[1])) {
    if (config.hostRole !== "untrusted") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    const response = await activeInteriorAsset(
      config,
      requestId,
      rawInterior[1],
      rawInterior[2],
      request.method === "HEAD",
    );
    response.headers.set(
      "content-security-policy",
      `${response.headers.get("content-security-policy") ?? "default-src 'self'"}; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads`,
    );
    return response;
  }

  const app = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (config.hostRole !== "untrusted") {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const rawApp = url.pathname.match(/^\/_stella\/apps-assets\/([^/]+)(\/.*)?$/);
  if (rawApp && APP_SLUG.test(rawApp[1])) {
    const response = await appAsset(
      request,
      config,
      requestId,
      rawApp[1],
      rawApp[2],
    );
    // A raw asset can be opened as a top-level document, independent of the
    // wrapper iframe. Apply the opaque-origin sandbox to every response so
    // active non-HTML formats (for example SVG/XML) cannot recover the
    // untrusted host's wrapper state or storage on direct navigation.
    response.headers.set(
      "content-security-policy",
      `${response.headers.get("content-security-policy") ?? "default-src 'self'"}; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads`,
    );
    return response;
  }
  if (!app || !APP_SLUG.test(app[1])) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  if (app[1] === "stella-interior") {
    return appAsset(request, config, requestId, app[1], app[2]);
  }
  if (app[2] === "/_bootstrap" || app[2] === "/_bootstrap/") {
    return refreshAppBootstrap(request, config, app[1]);
  }
  return appWrapper(request, config, app[1]);
};

export default {
  async fetch(request: Request, env: AppsHostEnv): Promise<Response> {
    let config: AppsHostConfig;
    try {
      config = readAppsHostConfig(env);
    } catch (error) {
      log("error", "configuration_rejected", {
        invalidFields:
          error instanceof AppsHostConfigurationError
            ? error.fields
            : ["unknown"],
      });
      return unavailable();
    }
    try {
      return await handleRequest(request, config);
    } catch (error) {
      log("error", "request_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return unavailable();
    }
  },
} satisfies ExportedHandler<AppsHostEnv>;
