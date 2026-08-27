import {
  AppsHostConfigurationError,
  readAppsHostConfig,
  type AppsHostConfig,
  type AppsHostEnv,
} from "./config";
import {
  BROWSER_AUTH_HANDOFF_SCRIPT_PATH,
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

type RouteRecord = {
  artifactPrefix: string;
  suspended: boolean;
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
): Promise<RouteLookup> => {
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
  return {
    kind: "route",
    route: {
      artifactPrefix: candidate.artifactPrefix,
      suspended: candidate.suspended,
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
  const assetPath = parseAssetPath(args.rawAssetPath);
  if (!assetPath) {
    log("error", "asset_path_rejected", {
      requestId: args.requestId,
      ...args.logContext,
    });
    return new Response("Not found", { status: 404 });
  }
  const load = (relative: string) =>
    args.config.appBuilds.get(`${args.artifactPrefix}/${relative}`);
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
  const url = new URL(
    "/api/cloud/interior-active-route",
    config.convexSiteOrigin,
  );
  url.searchParams.set("stableRouteId", stableRouteId);
  return fetch(url, {
    headers: { authorization: `Bearer ${config.builderServiceSecret}` },
    redirect: "error",
    signal: AbortSignal.timeout(ACTIVE_ROUTE_TIMEOUT_MS),
  });
};

const activeInteriorAsset = async (
  config: AppsHostConfig,
  requestId: string,
  stableRouteId: string,
  rawAssetPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  let response: Response;
  try {
    response = await readActiveRoute(config, stableRouteId);
  } catch {
    return new Response("The active Stella route is unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
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
  let route: Record<string, unknown>;
  try {
    const bytes = await readBoundedBytes(response.body, ACTIVE_ROUTE_MAX_BYTES);
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid route payload");
    }
    route = parsed as Record<string, unknown>;
  } catch {
    return new Response("The active Stella route is invalid.", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
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
          }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  if (url.pathname === BROWSER_AUTH_HANDOFF_SCRIPT_PATH) {
    return browserAuthHandoffScriptResponse(request, config);
  }
  if (url.pathname === "/api/interior/manifest") {
    return interiorManifest(request, config, requestId);
  }
  if (url.pathname === "/api/apps/fetch") {
    if (request.method === "OPTIONS")
      return handleProxyPreflight(request, config);
    if (request.method === "POST") return proxyFetch(request, config);
    return methodNotAllowed("POST, OPTIONS");
  }

  const interiorBuild = url.pathname.match(
    /^\/interior-builds\/([0-9a-f]{64})\/(interior-[0-9a-f]{48})(\/.*)?$/,
  );
  if (interiorBuild) {
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    if (activeInterior[2] === "/auth" || activeInterior[2] === "/auth/") {
      return browserAuthHandoffResponse(request, config);
    }
    return activeInteriorAsset(
      config,
      requestId,
      activeInterior[1],
      activeInterior[2],
      request.method === "HEAD",
    );
  }

  const app = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (!app || !APP_SLUG.test(app[1])) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  return appAsset(request, config, requestId, app[1], app[2]);
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
