// Keep these aligned with the browser origins trusted by Convex auth.
const BROWSER_ORIGINS = new Set([
  "https://stella.sh",
  "http://localhost:57314",
  "http://127.0.0.1:57314",
]);
const ALLOWED_HEADERS = new Set(["authorization", "content-type", "x-stella-expected-subject"]);

const isBrowserRoute = (path: string): boolean =>
  /^\/conversations\/[^/]+\/(turns|history|socket|journal|local-turns\/(begin|finish))$/u.test(path) ||
  /^\/owners\/me\/(devices|dispatches)(\/|$)/u.test(path) ||
  path.startsWith("/cloud-home/");

/** CORS grants browser access only; the router still authenticates every operation. */
export async function withBrowserCors(
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !isBrowserRoute(new URL(request.url).pathname)) return handle();
  const allowed = BROWSER_ORIGINS.has(origin);
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    const headers = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!allowed || !method || !["GET", "POST"].includes(method) ||
        headers.some((header) => !ALLOWED_HEADERS.has(header))) {
      return new Response(null, { status: 403, headers: { Vary: "Origin" } });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": [...ALLOWED_HEADERS].join(", "),
        "Access-Control-Max-Age": "600",
        Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      },
    });
  }
  const response = await handle();
  // WebSocket upgrades carry a Workers-specific webSocket handle. Preserve it.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");
  if (allowed) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
