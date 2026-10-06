/** This site's public origin; a self-hosted deployment sets NEXT_PUBLIC_STELLA_SITE_URL. */
export const PUBLIC_SITE = (process.env.NEXT_PUBLIC_STELLA_SITE_URL?.trim() || "https://stella.sh").replace(
  /\/+$/,
  "",
);

/** Canonical site URL for metadata, sitemap, and robots. */
export function getSiteUrl(): URL {
  if (process.env.NODE_ENV !== "production") {
    return new URL("http://localhost:3000");
  }
  return new URL(`${PUBLIC_SITE}/`);
}
