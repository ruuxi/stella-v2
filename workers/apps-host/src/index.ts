type Env = {
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  SHARES_DISABLED: string;
};

type RouteRecord = {
  artifactPrefix: string;
  suspended: boolean;
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const notice = (title: string, message: string, status: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;display:grid;min-height:100vh;place-content:center;background:#f4f1e8;color:#182019}main{max-width:520px;padding:42px;background:white;border-radius:20px}h1{font:42px Georgia,serif;margin:0 0 14px}p{line-height:1.6}</style><main><h1>${title}</h1><p>${message}</p></main>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders } },
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "stella-v2-apps-host" });
    }
    if (env.SHARES_DISABLED === "true") {
      return notice("Temporarily unavailable", "Shared Stella apps are paused right now.", 503);
    }
    const match = url.pathname.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const route = await env.APP_ROUTES.get<RouteRecord>(`app:${match[1]}`, "json");
    if (!route) return notice("App not found", "This Stella app does not exist.", 404);
    if (route.suspended) return notice("App suspended", "This Stella app is currently unavailable.", 403);
    let assetPath = (match[2] ?? "/").replace(/^\/+/, "");
    if (!assetPath || assetPath.endsWith("/")) assetPath += "index.html";
    const object = await env.APP_BUILDS.get(`${route.artifactPrefix}/${assetPath}`);
    if (!object) {
      if (!assetPath.includes(".")) {
        const fallback = await env.APP_BUILDS.get(`${route.artifactPrefix}/index.html`);
        if (fallback) {
          const headers = new Headers(securityHeaders);
          fallback.writeHttpMetadata(headers);
          headers.set("cache-control", "no-cache");
          return new Response(fallback.body, { headers });
        }
      }
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers(securityHeaders);
    object.writeHttpMetadata(headers);
    headers.set(
      "cache-control",
      assetPath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  },
} satisfies ExportedHandler<Env>;
