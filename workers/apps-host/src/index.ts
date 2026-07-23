type Env = {
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  SHARES_DISABLED: string;
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json(
        { ok: true, service: "stella-v2-apps-host" },
        { headers: { ...securityHeaders, "cache-control": "no-store" } },
      );
    }

    if (env.SHARES_DISABLED === "true") {
      return html(
        "<!doctype html><title>Stella Apps unavailable</title><main><h1>Stella Apps are temporarily unavailable.</h1><p>Please try again later.</p></main>",
        503,
      );
    }

    return html(
      "<!doctype html><title>App not found</title><main><h1>App not found.</h1></main>",
      404,
    );
  },
} satisfies ExportedHandler<Env>;
