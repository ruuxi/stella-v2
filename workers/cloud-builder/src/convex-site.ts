/** Convex site origin without a trailing slash; empty when unconfigured. */
export const convexSiteBase = (env: {
  STELLA_CONVEX_SITE_URL?: string;
}): string => (env.STELLA_CONVEX_SITE_URL ?? "").trim().replace(/\/+$/, "");
