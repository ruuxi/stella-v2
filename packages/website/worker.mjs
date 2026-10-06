import openNext from "./.open-next/worker.js";

const SHARED_CACHE_ONLY = /^s-maxage=\d+(, stale-while-revalidate=\d+)?$/;
const BROWSER_CACHE = "public, max-age=0, must-revalidate";
const IMAGE_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const withHeaders = (response, changes) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(changes)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const imageCacheKey = (request) => {
  const accept = request.headers.get("Accept") ?? "";
  const format = accept.includes("image/avif")
    ? "avif"
    : accept.includes("image/webp")
      ? "webp"
      : "original";
  const url = new URL(request.url);
  url.searchParams.set("_format", format);
  return new Request(url.toString(), { method: "GET" });
};

const optimizedImage = async (request, env, ctx) => {
  const cache = caches.default;
  const key = imageCacheKey(request);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await openNext.fetch(request, env, ctx);
  if (response.status !== 200 || response.headers.has("Cache-Control")) {
    return response;
  }
  const cacheable = withHeaders(response, { "Cache-Control": IMAGE_CACHE });
  ctx.waitUntil(cache.put(key, cacheable.clone()));
  return cacheable;
};

const worker = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/_next/image") {
      return optimizedImage(request, env, ctx);
    }
    const response = await openNext.fetch(request, env, ctx);
    if (response.status === 101) return response;
    const changes = {};
    const cacheControl = response.headers.get("Cache-Control");
    if (!cacheControl || SHARED_CACHE_ONLY.test(cacheControl)) {
      changes["Cache-Control"] = BROWSER_CACHE;
    }
    if (
      pathname.startsWith("/chat-app/") &&
      !response.headers.has("X-Content-Type-Options")
    ) {
      changes["X-Content-Type-Options"] = "nosniff";
    }
    return Object.keys(changes).length > 0
      ? withHeaders(response, changes)
      : response;
  },
};

export default worker;
