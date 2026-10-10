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
 *
 * Private canvases: an object whose metadata says `visibility: private` is
 * served only to its owner. The owner arrives with a `?grant=` minted by the
 * backend's `shares.viewLink`; a valid grant for this slug and this object's
 * owner is traded for an HttpOnly view cookie, and the browser is redirected
 * to the clean link (so the grant never sits where the canvas's scripts could
 * read it). After that the cookie opens the owner's private canvases until it
 * expires. Anyone else gets the "private" page. Without
 * `CANVAS_SHARE_VIEW_SECRET` no private canvas opens here at all. Objects
 * written before visibility existed carry none and stay public.
 */

import {
  CANVAS_VIEW_COOKIE,
  CANVAS_VIEW_COOKIE_TTL_MS,
  CANVAS_VIEW_GRANT_PARAM,
  signCanvasViewToken,
  verifyCanvasViewToken,
} from "../../shared/canvas-view-grant.js";

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

const viewSecretOf = (env: Env): string | null => {
  const value = (env as unknown as Record<string, unknown>).CANVAS_SHARE_VIEW_SECRET;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
};

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
};

const PRIVATE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private canvas</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f7f6f3; color: #1f1f1d; }
  main { max-width: 420px; padding: 32px 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #6b6a66; }
  @media (prefers-color-scheme: dark) {
    body { background: #161615; color: #ecebe8; }
    p { color: #a3a29e; }
  }
</style>
</head>
<body>
<main>
  <h1>This canvas is private</h1>
  <p>Only its owner can open it. If it's yours, open it from Stella. To let others see it, make it public from the canvas's Share menu.</p>
</main>
</body>
</html>`;

const privatePage = (method: string): Response =>
  new Response(method === "HEAD" ? null : PRIVATE_PAGE, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });

const parseSlug = (pathname: string): string | null => {
  // Expect exactly `/c/<slug>`.
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding is an invalid public route, not a Worker
    // failure. Keep the response indistinguishable from every other invalid
    // or missing share slug.
    return null;
  }
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

    const isPrivate = object.customMetadata?.visibility === "private";
    if (isPrivate) {
      const owner = object.customMetadata?.owner;
      const secret = viewSecretOf(env);
      if (!owner || !secret) {
        object.body.cancel().catch(() => {});
        return privatePage(request.method);
      }
      const now = Date.now();
      const grant = url.searchParams.get(CANVAS_VIEW_GRANT_PARAM);
      if (grant) {
        const claims = await verifyCanvasViewToken(secret, grant, now);
        object.body.cancel().catch(() => {});
        if (claims?.k === "grant" && claims.s === slug && claims.o === owner) {
          const view = await signCanvasViewToken(secret, {
            k: "view",
            o: owner,
            e: now + CANVAS_VIEW_COOKIE_TTL_MS,
          });
          return new Response(null, {
            status: 302,
            headers: {
              location: `/c/${slug}`,
              "set-cookie": `${CANVAS_VIEW_COOKIE}=${view}; Path=/c/; Max-Age=${Math.floor(CANVAS_VIEW_COOKIE_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          });
        }
        return privatePage(request.method);
      }
      const cookie = readCookie(request, CANVAS_VIEW_COOKIE);
      const claims = cookie ? await verifyCanvasViewToken(secret, cookie, now) : null;
      if (claims?.k !== "view" || claims.o !== owner) {
        object.body.cancel().catch(() => {});
        return privatePage(request.method);
      }
    }

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "cache-control": isPrivate ? "private, no-store" : "public, max-age=60",
      "content-security-policy": SHARE_CSP,
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
} satisfies ExportedHandler<Env>;
