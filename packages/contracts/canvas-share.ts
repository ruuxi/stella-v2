export const CANVAS_SHARE_PATH_PREFIX = "/c/";

const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export const isCanvasShareSlug = (value: unknown): value is string =>
  typeof value === "string" && SLUG_PATTERN.test(value);

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

export const readCanvasShareBaseUrl = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = trimTrailingSlashes(value.trim());
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
};

export const canvasSharePathForSlug = (slug: string): string =>
  `${CANVAS_SHARE_PATH_PREFIX}${slug}`;

export const buildCanvasShareUrl = (baseUrl: string, slug: string): string =>
  `${trimTrailingSlashes(baseUrl)}${canvasSharePathForSlug(slug)}`;

export const parseCanvasShareSlug = (
  value: string,
  baseUrl: string | null | undefined,
): string | null => {
  const base = readCanvasShareBaseUrl(baseUrl);
  if (!base) return null;
  let target: URL;
  let root: URL;
  try {
    target = new URL(value);
    root = new URL(base);
  } catch {
    return null;
  }
  if (target.origin !== root.origin) return null;
  const rootPath = trimTrailingSlashes(root.pathname);
  const expectedPrefix = `${rootPath}${CANVAS_SHARE_PATH_PREFIX}`;
  if (!target.pathname.startsWith(expectedPrefix)) return null;
  const slug = target.pathname.slice(expectedPrefix.length);

  if (!slug || slug.includes("/")) return null;
  return isCanvasShareSlug(slug) ? slug : null;
};

export const isCanvasShareUrl = (
  value: string,
  baseUrl: string | null | undefined,
): boolean => parseCanvasShareSlug(value, baseUrl) !== null;
