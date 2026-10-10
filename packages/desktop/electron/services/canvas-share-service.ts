import fs from "node:fs/promises";
import path from "node:path";
import {
  isCanvasShareSlug,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
} from "@stella/contracts/canvas-share";

/**
 * Main-process side of the canvas-share deep link. Given a
 * `<CANVAS_SHARE_BASE_URL>/c/<slug>` URL, fetch the remote HTML and
 * materialize it into the same `~/.stella/outputs/html/<slug>.html` store the
 * `html` tool writes local canvases to, so the renderer can display it through
 * the identical sandboxed canvas path with no extra privileges.
 *
 * Fetching + writing happen here (privileged, and free of renderer CORS). The
 * slug is validated against the shared grammar before it ever reaches the
 * filesystem, so a share URL can't smuggle path traversal into the target
 * file name.
 */

const MAX_SHARED_CANVAS_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export type SharedCanvasPayload = {
  kind: "canvas-html";
  filePath: string;
  slug: string;
  title: string;
  createdAt: number;
};

/**
 * Fetch a share link. The owner's own private link arrives with a `?grant=`
 * (`shares.viewLink`), which the share domain answers with a view cookie and
 * a redirect to the clean link; that one hop is followed here with the cookie,
 * since this fetch keeps no cookie jar. Any other redirect is not followed.
 */
const fetchShare = async (
  url: string,
  signal: AbortSignal,
): Promise<Response | null> => {
  const headers = { accept: "text/html" };
  const first = await fetch(url, { signal, redirect: "manual", headers });
  if (first.status < 300 || first.status >= 400) return first;
  const location = first.headers.get("location");
  if (!location) return null;
  const next = new URL(location, url);
  if (next.origin !== new URL(url).origin) return null;
  const cookie = first.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
  return await fetch(next, {
    signal,
    redirect: "manual",
    headers: cookie ? { ...headers, cookie } : headers,
  });
};

/** Configured public base URL for shared canvases (final domain TBD/pending). */
export const readConfiguredCanvasShareBaseUrl = (): string | null =>
  readCanvasShareBaseUrl(process.env.CANVAS_SHARE_BASE_URL);

const titleFromHtml = (html: string, slug: string): string => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.replace(/\s+/g, " ").trim();
  if (raw) return raw;
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char: string) => char.toUpperCase());
};

/**
 * Resolve a canvas-share URL into a file-backed canvas payload, or `null` when
 * the URL is not a valid share link for the configured base, the fetch fails,
 * or the response is empty / oversized.
 */
export const resolveSharedCanvasPayload = async (options: {
  url: string;
  baseUrl: string | null;
  stellaDataDir: string;
}): Promise<SharedCanvasPayload | null> => {
  const { url, baseUrl, stellaDataDir } = options;
  const slug = parseCanvasShareSlug(url, baseUrl);
  if (!slug || !isCanvasShareSlug(slug)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const response = await fetchShare(url, controller.signal);
    if (!response?.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SHARED_CANVAS_BYTES) {
      return null;
    }
    html = buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!html.trim()) return null;

  const htmlDir = path.join(stellaDataDir, "outputs", "html");
  await fs.mkdir(htmlDir, { recursive: true });
  const filePath = path.join(htmlDir, `${slug}.html`);
  await fs.writeFile(filePath, html, "utf8");

  return {
    kind: "canvas-html",
    filePath,
    slug,
    title: titleFromHtml(html, slug),
    createdAt: Date.now(),
  };
};
