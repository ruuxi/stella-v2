type Env = {
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  SHARES_DISABLED: string;
  CONVEX_SITE_URL: string;
  CONVEX_CLOUD_URL: string;
  APPS_HOST_ORIGIN: string;
  INTERIOR_ORIGIN: string;
};

type RouteRecord = {
  artifactPrefix: string;
  suspended: boolean;
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

const securityHeaders = (env: Env) => ({
  "content-security-policy": `default-src 'self'; script-src 'self' ${env.APPS_HOST_ORIGIN}; style-src 'self' ${env.APPS_HOST_ORIGIN} 'unsafe-inline'; img-src 'self' ${env.APPS_HOST_ORIGIN} data: blob:; font-src 'self' ${env.APPS_HOST_ORIGIN}; connect-src 'self' ${env.CONVEX_SITE_URL} ${env.CONVEX_CLOUD_URL} ${env.CONVEX_CLOUD_URL.replace("https://", "wss://")}; object-src 'none'; base-uri 'none'; frame-ancestors 'self' http://localhost:57315 http://127.0.0.1:57315 https://stella.sh; form-action 'self'`,
  "cross-origin-opener-policy": "same-origin",
  // Embedded apps run in sandboxed opaque origins. CSP + the shell bridge
  // enforce capability boundaries; assets must remain loadable in that sandbox.
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

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
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "stella-v2-apps-host" });
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
    if (env.SHARES_DISABLED === "true") {
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
