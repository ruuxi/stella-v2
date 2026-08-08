/**
 * canvas-share serving Worker.
 *
 * Serves published canvas HTML documents from the `stella-canvas-shares` R2
 * bucket at `GET /c/:slug`.
 *
 * Security model: every share is served with a `Content-Security-Policy:
 * sandbox` header. `allow-scripts` is REQUIRED (canvases run JS — Chart.js,
 * D3, etc.), but `allow-same-origin` is deliberately OMITTED. Without
 * `allow-same-origin` the document gets an opaque origin, so shares cannot
 * read cookies/localStorage or reach across to each other. Never add
 * `allow-same-origin` alongside `allow-scripts` — that pairing is the classic
 * sandbox escape.
 */

export interface Env {
  /** R2 bucket binding for `stella-canvas-shares`. */
  SHARES_BUCKET: R2Bucket;
  /** Global kill-switch. Any truthy value returns 503 for all shares. */
  SHARES_DISABLED?: string;
}

const KEY_PREFIX = "shares";
/** Slugs are 128-bit base64url tokens (~22 chars); be lenient but strict. */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Content-Security-Policy applied to every served share. */
const SHARE_CSP =
  "sandbox allow-scripts allow-popups allow-forms allow-downloads;";

const isDisabled = (env: Env): boolean => {
  const flag = env.SHARES_DISABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

const textResponse = (
  status: number,
  body: string,
): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });

const notFound = (): Response => textResponse(404, "Not found");

const parseSlug = (pathname: string): string | null => {
  // Expect exactly `/c/<slug>`.
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  return SLUG_PATTERN.test(slug) ? slug : null;
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (isDisabled(env)) {
      return textResponse(503, "Canvas sharing is temporarily disabled.");
    }

    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Method not allowed");
    }

    const slug = parseSlug(url.pathname);
    if (!slug) return notFound();

    const key = `${KEY_PREFIX}/${slug}.html`;
    const object = await env.SHARES_BUCKET.get(key);
    if (!object) return notFound();

    // Enforce expiry from custom metadata (epoch-ms string). Past-due objects
    // 404 and are lazily deleted so storage doesn't linger before the cron.
    const expiresAtRaw = object.customMetadata?.["expires-at"];
    if (expiresAtRaw) {
      const expiresAt = Number(expiresAtRaw);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        ctx.waitUntil(env.SHARES_BUCKET.delete(key).catch(() => {}));
        return notFound();
      }
    }

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=60",
      "content-security-policy": SHARE_CSP,
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
} satisfies ExportedHandler<Env>;
