export interface Env {

  SHARES_BUCKET: R2Bucket;

  SHARES_DISABLED?: string;
}

const KEY_PREFIX = "shares";

const SLUG_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

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
