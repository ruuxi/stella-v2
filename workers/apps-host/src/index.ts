type Env = {
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  SHARES_DISABLED: string;
  CONVEX_SITE_URL: string;
  CONVEX_CLOUD_URL: string;
  APPS_HOST_ORIGIN: string;
  INTERIOR_ORIGIN: string;
  EMBED_APPS_ORIGIN?: string;
  // The cloud builder's origin, needed in connect-src so the interior can open
  // its conversation WebSocket. Optional: a deployment without it keeps every
  // existing behaviour and simply cannot stream — which is a visible, debuggable
  // failure, unlike an `undefined` spliced into the policy string.
  CLOUD_BUILDER_ORIGIN?: string;
  BUILDER_SERVICE_SECRET?: string;
};

type RouteRecord = {
  artifactPrefix: string;
  suspended: boolean;
};

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

const isPrivateTarget = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  )
    return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return (
    octets.some((part) => part > 255) ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

const withProxyCors = (response: Response, origin: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const proxyFetch = async (request: Request, env: Env): Promise<Response> => {
  const origin = request.headers.get("origin");
  const trustedOrigins = new Set([
    new URL(request.url).origin,
    env.INTERIOR_ORIGIN,
    "http://localhost:57315",
    "http://127.0.0.1:57315",
  ]);
  if (!origin || !trustedOrigins.has(origin)) {
    return Response.json(
      { error: "Stella fetch requires the app origin." },
      { status: 403 },
    );
  }
  const body = await request.json<{
    input?: string;
    init?: { method?: string; headers?: HeadersInit; body?: string };
  }>();
  if (!body.input)
    return Response.json(
      { error: "A target URL is required." },
      { status: 400 },
    );
  let target: URL;
  try {
    target = new URL(body.input);
  } catch {
    return Response.json(
      { error: "The target URL is invalid." },
      { status: 400 },
    );
  }
  if (target.protocol !== "https:" || isPrivateTarget(target.hostname)) {
    return Response.json(
      { error: "Only public HTTPS targets are allowed." },
      { status: 400 },
    );
  }
  const method = (body.init?.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return Response.json(
      { error: "That HTTP method is not allowed." },
      { status: 400 },
    );
  }
  const requestedHeaders = new Headers(body.init?.headers);
  const upstreamHeaders = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "if-none-match",
    "if-modified-since",
  ]) {
    const value = requestedHeaders.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  let currentTarget = target;
  let upstream: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    upstream = await fetch(currentTarget, {
      method,
      headers: upstreamHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : body.init?.body,
      redirect: "manual",
    });
    const location = upstream.headers.get("location");
    if (!location || upstream.status < 300 || upstream.status >= 400) break;
    const next = new URL(location, currentTarget);
    if (next.protocol !== "https:" || isPrivateTarget(next.hostname)) {
      return Response.json(
        { error: "The upstream redirect was blocked." },
        { status: 400 },
      );
    }
    currentTarget = next;
  }
  if (!upstream) {
    return Response.json(
      { error: "The upstream service did not respond." },
      { status: 502 },
    );
  }
  const responseHeaders = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-stella-proxy", "standalone");
  return withProxyCors(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
    origin,
  );
};

/**
 * The conversation socket's `connect-src` entries. Both forms are required:
 * `https:` covers the authenticated config fetch and any HTTP journal append,
 * and `wss:` covers the socket itself — a policy listing only the origin
 * blocks the upgrade, which fails in the shipped interior while working
 * everywhere a policy is not applied.
 */
const builderConnectSources = (env: Env): string => {
  const origin = env.CLOUD_BUILDER_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) return "";
  return ` ${origin} ${origin.replace(/^https:/, "wss:")}`;
};

const securityHeaders = (env: Env) => ({
  // The interior deployment sets EMBED_APPS_ORIGIN to the apps host so the
  // in-shell app page can frame published apps; without an explicit
  // frame-src, default-src 'self' silently blocks every embedded app.
  "content-security-policy": `default-src 'self'; script-src 'self' ${env.APPS_HOST_ORIGIN}; style-src 'self' ${env.APPS_HOST_ORIGIN} 'unsafe-inline'; img-src 'self' ${env.APPS_HOST_ORIGIN} data: blob:; font-src 'self' ${env.APPS_HOST_ORIGIN}; connect-src 'self' ${env.CONVEX_SITE_URL} ${env.CONVEX_CLOUD_URL} ${env.CONVEX_CLOUD_URL.replace("https://", "wss://")}${builderConnectSources(env)}; frame-src 'self'${env.EMBED_APPS_ORIGIN ? ` ${env.EMBED_APPS_ORIGIN}` : ""}; object-src 'none'; base-uri 'none'; frame-ancestors 'self' ${env.INTERIOR_ORIGIN} file: http://localhost:* http://127.0.0.1:* https://stella.sh; form-action 'self'`,
  "cross-origin-opener-policy": "same-origin",
  // Embedded apps run in sandboxed opaque origins. CSP + the shell bridge
  // enforce capability boundaries; assets must remain loadable in that sandbox.
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const BROWSER_AUTH_HANDOFF_SCRIPT_PATH =
  "/_stella/browser-auth-handoff.js" as const;

const authHandoffSecurityHeaders = (env: Env) => ({
  "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src ${new URL(env.CONVEX_SITE_URL).origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
});

export const browserAuthHandoffHtml = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Opening Stella</title>
  <style>
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f1e8;color:#182019;font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(100%,480px);padding:40px;background:#fff;border:1px solid #dedbd1;border-radius:22px;box-shadow:0 18px 60px rgba(24,32,25,.09)}
    h1{margin:0 0 12px;font:42px/1.05 Georgia,serif;letter-spacing:-.025em}
    p{margin:0;color:#536057}
    nav{display:none;gap:12px;align-items:center;margin-top:24px}
    button,a{border:0;border-radius:999px;padding:11px 17px;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer}
    button{background:#182019;color:#fff}
    a{color:#304337;background:#eef0eb}
    main[data-state="error"] nav{display:flex}
  </style>
</head>
<body>
  <main id="handoff" aria-live="polite">
    <h1 id="title">Opening Stella</h1>
    <p id="message">Finishing your secure sign-in…</p>
    <nav>
      <button id="retry" type="button">Retry</button>
      <a href="https://stella.sh/chat" rel="noreferrer">Back to Stella</a>
    </nav>
  </main>
  <script src="${BROWSER_AUTH_HANDOFF_SCRIPT_PATH}"></script>
</body>
</html>`;

export const browserAuthHandoffScript = (env: Env): string => {
  const verifyUrl = new URL(
    "/api/auth/cross-domain/one-time-token/verify",
    env.CONVEX_SITE_URL,
  ).toString();
  return `(() => {
  "use strict";

  const VERIFY_URL = ${JSON.stringify(verifyUrl)};
  const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;
  const COOKIE_KEY = "better-auth_cookie";
  const SESSION_DATA_KEY = "better-auth_session_data";
  const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\\-.^_|~]+$/;
  const root = document.getElementById("handoff");
  const title = document.getElementById("title");
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  let token = null;
  let verifying = false;

  const showError = (text, canRetry) => {
    root.dataset.state = "error";
    title.textContent = "Sign-in didn’t finish";
    message.textContent = text;
    retry.hidden = !canRetry;
  };

  const readStoredCookies = () => {
    const raw = localStorage.getItem(COOKIE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  };

  const cookieHeader = (cookies) => {
    const now = Date.now();
    return Object.entries(cookies)
      .filter(([, record]) => {
        if (!record || typeof record !== "object") return false;
        if (typeof record.value !== "string") return false;
        if (!record.expires) return true;
        const expiry = Date.parse(record.expires);
        return Number.isFinite(expiry) && expiry >= now;
      })
      .filter(([name]) => COOKIE_NAME_PATTERN.test(name))
      .map(([name, record]) => name + "=" + record.value)
      .join("; ");
  };

  const mergeSetCookie = (header, previous) => {
    const next = { ...previous };
    const cookies = header.split(
      /,(?=\\s*[A-Za-z0-9!#$%&'*+\\-.^_|~]+=)/g,
    );
    for (const cookie of cookies) {
      const parts = cookie.split(";").map((part) => part.trim());
      const first = parts.shift() || "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      if (!COOKIE_NAME_PATTERN.test(name)) continue;
      const value = first.slice(separator + 1);
      let expiresAt = null;
      let maxAgeSeconds = null;
      for (const attribute of parts) {
        const attributeSeparator = attribute.indexOf("=");
        const attributeName = (
          attributeSeparator < 0
            ? attribute
            : attribute.slice(0, attributeSeparator)
        ).trim().toLowerCase();
        const attributeValue =
          attributeSeparator < 0
            ? ""
            : attribute.slice(attributeSeparator + 1).trim();
        if (attributeName === "max-age") {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) {
            maxAgeSeconds = seconds;
          }
        } else if (attributeName === "expires") {
          const timestamp = Date.parse(attributeValue);
          if (Number.isFinite(timestamp)) {
            expiresAt = timestamp;
          }
        }
      }
      const expires =
        expiresAt === null
          ? maxAgeSeconds === null
            ? null
            : new Date(Date.now() + maxAgeSeconds * 1000).toISOString()
          : new Date(expiresAt).toISOString();
      next[name] = { value, expires };
    }
    return next;
  };

  const hasLiveSessionToken = (cookies) => {
    const now = Date.now();
    return Object.entries(cookies).some(([name, record]) => {
      if (!name.includes("session_token")) return false;
      if (!record || typeof record.value !== "string" || !record.value) {
        return false;
      }
      if (!record.expires) return true;
      const expiry = Date.parse(record.expires);
      return Number.isFinite(expiry) && expiry >= now;
    });
  };

  const verify = async () => {
    if (!token || verifying) return;
    verifying = true;
    root.dataset.state = "loading";
    title.textContent = "Opening Stella";
    message.textContent = "Finishing your secure sign-in…";
    try {
      const stored = readStoredCookies();
      stored.stella_auth_bootstrap = { value: "1", expires: null };
      localStorage.setItem(COOKIE_KEY, JSON.stringify(stored));
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "Better-Auth-Cookie": cookieHeader(stored),
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        throw new Error("verification rejected");
      }
      const setCookie = response.headers.get("set-better-auth-cookie");
      if (!setCookie) {
        throw new Error("session cookie missing");
      }
      const mirrored = mergeSetCookie(setCookie, stored);
      if (!hasLiveSessionToken(mirrored)) {
        throw new Error("session cookie invalid");
      }
      localStorage.setItem(COOKIE_KEY, JSON.stringify(mirrored));
      localStorage.removeItem(SESSION_DATA_KEY);
      const destination = location.pathname.replace(/\\/auth\\/?$/, "/");
      location.replace(destination);
    } catch {
      showError(
        "We couldn’t complete the secure handoff. Retry, or return to stella.sh/chat for a new link.",
        true,
      );
    } finally {
      verifying = false;
    }
  };

  retry.addEventListener("click", () => void verify());

  const rawFragment = location.hash.replace(/^#\\??/, "");
  if (location.hash) {
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }
  const params = new URLSearchParams(rawFragment);
  const tokens = params.getAll("ott");
  if (tokens.length !== 1 || !TOKEN_PATTERN.test(tokens[0] || "")) {
    showError(
      "This sign-in link is missing or invalid. Return to stella.sh/chat and try again.",
      false,
    );
    return;
  }
  token = tokens[0];
  void verify();
})();`;
};

const browserAuthHandoffResponse = (
  request: Request,
  env: Env,
): Response => {
  const headers = {
    ...authHandoffSecurityHeaders(env),
    "content-type": "text/html; charset=utf-8",
  };
  return new Response(
    request.method === "HEAD" ? null : browserAuthHandoffHtml(),
    { headers },
  );
};

const browserAuthHandoffScriptResponse = (
  request: Request,
  env: Env,
): Response => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  return new Response(
    request.method === "HEAD" ? null : browserAuthHandoffScript(env),
    {
      headers: {
        ...authHandoffSecurityHeaders(env),
        "content-type": "text/javascript; charset=utf-8",
      },
    },
  );
};

const immutableInteriorAsset = async (
  requestId: string,
  env: Env,
  ownerHash: string,
  buildId: string,
  rawAssetPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawAssetPath ?? "").replace(/^\/+/, "");
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!assetPath || assetPath.endsWith("/")) assetPath += "index.html";
  if (
    assetPath.length > 1_024 ||
    assetPath.includes("\\") ||
    assetPath.includes("\0") ||
    assetPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    log("error", "interior_asset_path_rejected", {
      requestId,
      ownerHash,
      buildId,
    });
    return new Response("Not found", { status: 404 });
  }
  const artifactPrefix = `interiors/${ownerHash}/${buildId}`;
  const load = (relative: string) =>
    env.APP_BUILDS.get(`${artifactPrefix}/${relative}`);
  let object = await load(assetPath);
  // A build URL is exact and immutable, but the renderer remains an SPA:
  // browser refreshes on a client route resolve to that same build's full
  // entrypoint, never to a mutable owner/app pointer.
  if (!object && !pathHasExtension(assetPath)) {
    object = await load("index.html");
  }
  if (!object) {
    log("error", "interior_asset_not_found", {
      requestId,
      ownerHash,
      buildId,
      assetPath,
    });
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers(securityHeaders(env));
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", object.httpEtag);
  return new Response(headOnly ? null : object.body, { headers });
};

const pathHasExtension = (assetPath: string): boolean => {
  const name = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  return name.includes(".");
};

const publishedDefaultInteriorAsset = async (
  env: Env,
  requestId: string,
  rawPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  const route = await env.APP_ROUTES.get<RouteRecord>(
    "app:stella-interior",
    "json",
  );
  if (!route || route.suspended) {
    log("error", "default_interior_unavailable", { requestId });
    return new Response("The packaged Stella interior is unavailable.", {
      status: 503,
    });
  }
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawPath ?? "").replace(/^\/+/, "");
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!assetPath || assetPath.endsWith("/")) assetPath += "index.html";
  if (
    assetPath.length > 1_024 ||
    assetPath.includes("\\") ||
    assetPath.includes("\0") ||
    assetPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return new Response("Not found", { status: 404 });
  }
  const load = (relative: string) =>
    env.APP_BUILDS.get(`${route.artifactPrefix}/${relative}`);
  let object = await load(assetPath);
  if (!object && !pathHasExtension(assetPath)) {
    object = await load("index.html");
  }
  if (!object) {
    log("error", "default_interior_asset_not_found", {
      requestId,
      assetPath,
    });
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers(securityHeaders(env));
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "no-store");
  headers.set("etag", object.httpEtag);
  return new Response(headOnly ? null : object.body, { headers });
};

const activeInteriorAsset = async (
  env: Env,
  requestId: string,
  stableRouteId: string,
  rawPath: string | undefined,
  headOnly: boolean,
): Promise<Response> => {
  const secret = env.BUILDER_SERVICE_SECRET?.trim();
  if (!secret) {
    return new Response("The active Stella route is not configured.", {
      status: 503,
    });
  }
  // Resolve every request so rotating the opaque route revokes the old URL
  // immediately; a process-local cache would leave a retired capability live.
  const response = await fetch(
    `${env.CONVEX_SITE_URL.replace(/\/+$/, "")}/api/cloud/interior-active-route?stableRouteId=${encodeURIComponent(stableRouteId)}`,
    {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    return new Response(
      response.status === 404
        ? "Stella interior route not found."
        : "The active Stella route is unavailable.",
      { status: response.status === 404 ? 404 : 503 },
    );
  }
  const route = (await response.json()) as {
    mode?: unknown;
    ownerHash?: unknown;
    buildId?: unknown;
    artifactPrefix?: unknown;
  };
  if (route.mode === "default") {
    return await publishedDefaultInteriorAsset(
      env,
      requestId,
      rawPath,
      headOnly,
    );
  }
  const ownerHash = typeof route.ownerHash === "string" ? route.ownerHash : "";
  const buildId = typeof route.buildId === "string" ? route.buildId : "";
  if (
    route.mode !== "custom" ||
    !/^[0-9a-f]{64}$/.test(ownerHash) ||
    !/^interior-[0-9a-f]{48}$/.test(buildId) ||
    route.artifactPrefix !== `interiors/${ownerHash}/${buildId}`
  ) {
    return new Response("The active Stella route is invalid.", {
      status: 502,
    });
  }
  const assetResponse = await immutableInteriorAsset(
    requestId,
    env,
    ownerHash,
    buildId!,
    rawPath,
    headOnly,
  );
  const headers = new Headers(assetResponse.headers);
  headers.set("cache-control", "no-store");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
};

const notice = (env: Env, title: string, message: string, status: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;display:grid;min-height:100vh;place-content:center;background:#f4f1e8;color:#182019}main{max-width:520px;padding:42px;background:white;border-radius:20px}h1{font:42px Georgia,serif;margin:0 0 14px}p{line-height:1.6}</style><main><h1>${title}</h1><p>${message}</p></main>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...securityHeaders(env),
      },
    },
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: url.pathname,
      host: url.host,
    });
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "stella-v2-apps-host" });
    }
    if (url.pathname === BROWSER_AUTH_HANDOFF_SCRIPT_PATH) {
      return browserAuthHandoffScriptResponse(request, env);
    }
    if (url.pathname === "/api/interior/manifest") {
      const route = await env.APP_ROUTES.get<RouteRecord>(
        "app:stella-interior",
        "json",
      );
      if (!route || route.suspended) {
        log("error", "interior_manifest_unavailable", { requestId });
        return Response.json(
          { error: "The Stella interior is not available." },
          { status: 503 },
        );
      }
      return Response.json(
        {
          version: route.artifactPrefix,
          bundleUrl: `${url.origin}/apps/stella-interior/bundle.zip`,
          remoteUrl: `${url.origin}/apps/stella-interior/`,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/api/apps/fetch" && request.method === "OPTIONS") {
      const origin = request.headers.get("origin") ?? "";
      return withProxyCors(new Response(null, { status: 204 }), origin);
    }
    if (url.pathname === "/api/apps/fetch" && request.method === "POST") {
      try {
        return await proxyFetch(request, env);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "standalone_proxy_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return Response.json(
          { error: "The upstream service could not be reached. Try again." },
          { status: 502 },
        );
      }
    }
    const interiorBuild = url.pathname.match(
      /^\/interior-builds\/([0-9a-f]{64})\/(interior-[0-9a-f]{48})(\/.*)?$/,
    );
    if (interiorBuild) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return await immutableInteriorAsset(
        requestId,
        env,
        interiorBuild[1],
        interiorBuild[2],
        interiorBuild[3],
        request.method === "HEAD",
      );
    }
    const activeInterior = url.pathname.match(
      /^\/stella\/(sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)?$/,
    );
    if (activeInterior) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      if (activeInterior[2] === "/auth" || activeInterior[2] === "/auth/") {
        return browserAuthHandoffResponse(request, env);
      }
      return await activeInteriorAsset(
        env,
        requestId,
        activeInterior[1],
        activeInterior[2],
        request.method === "HEAD",
      );
    }
    if (env.SHARES_DISABLED === "true") {
      log("error", "global_kill_switch_served", { requestId });
      return notice(
        env,
        "Temporarily unavailable",
        "Shared Stella apps are paused right now.",
        503,
      );
    }
    const match = url.pathname.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const route = await env.APP_ROUTES.get<RouteRecord>(
      `app:${match[1]}`,
      "json",
    );
    if (!route)
      return notice(
        env,
        "App not found",
        "This Stella app does not exist.",
        404,
      );
    if (route.suspended)
      log("info", "suspended_notice_served", {
        requestId,
        slug: match[1],
      });
    if (route.suspended)
      return notice(
        env,
        "App suspended",
        "This Stella app is currently unavailable.",
        403,
      );
    let assetPath = (match[2] ?? "/").replace(/^\/+/, "");
    if (!assetPath || assetPath.endsWith("/")) assetPath += "index.html";
    const object = await env.APP_BUILDS.get(
      `${route.artifactPrefix}/${assetPath}`,
    );
    if (!object) {
      if (!assetPath.includes(".")) {
        const fallback = await env.APP_BUILDS.get(
          `${route.artifactPrefix}/index.html`,
        );
        if (fallback) {
          const headers = new Headers(securityHeaders(env));
          fallback.writeHttpMetadata(headers);
          headers.set("cache-control", "no-cache");
          return new Response(fallback.body, { headers });
        }
      }
      log("error", "asset_not_found", {
        requestId,
        slug: match[1],
        assetPath,
      });
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers(securityHeaders(env));
    object.writeHttpMetadata(headers);
    headers.set(
      "cache-control",
      assetPath === "index.html" || assetPath === "stella-context.js"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    );
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  },
} satisfies ExportedHandler<Env>;
