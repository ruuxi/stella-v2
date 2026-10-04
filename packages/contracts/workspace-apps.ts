/** Owner-scoped apps discovered from the cloud world filesystem. */
export type WorkspaceApp = {
  appId: string;
  slug: string;
  title: string;
  /** Optional emoji from the manifest, shown on the app's tile. */
  icon?: string;
  revision: string;
  status: "ready" | "error";
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export function parseWorkspaceApps(value: unknown): WorkspaceApp[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some(
      (app) =>
        !app ||
        typeof app !== "object" ||
        typeof app.slug !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(app.slug) ||
        app.appId !== app.slug ||
        typeof app.title !== "string" ||
        (app.icon !== undefined && typeof app.icon !== "string") ||
        typeof app.revision !== "string" ||
        !["ready", "error"].includes(app.status) ||
        !Number.isFinite(app.createdAt) ||
        !Number.isFinite(app.updatedAt) ||
        (app.error !== undefined && typeof app.error !== "string"),
    )
  )
    throw new Error("Invalid app list.");
  return value;
}

/**
 * A reply points at an app the way it points at a file: a markdown link to
 * `stella://app/<slug>`. Clients render each linked app as an app card and
 * open the app when the link is tapped.
 */
export const STELLA_APP_URL_PREFIX = "stella://app/";

const APP_SLUG = /^[a-z][a-z0-9-]{0,31}$/;

/** The slug of a `stella://app/<slug>` URL, or null for anything else. */
export function parseStellaAppUrl(url: string): string | null {
  if (!url.startsWith(STELLA_APP_URL_PREFIX)) return null;
  const slug = url
    .slice(STELLA_APP_URL_PREFIX.length)
    .split(/[/?#]/)[0]!
    .toLowerCase();
  return APP_SLUG.test(slug) ? slug : null;
}

/** Distinct app slugs a reply links, in order of first mention. */
export function extractStellaAppLinkSlugs(text: string): string[] {
  const slugs: string[] = [];
  for (const match of text.matchAll(/stella:\/\/app\/[A-Za-z0-9-]+/g)) {
    const slug = parseStellaAppUrl(match[0]);
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs.slice(0, 4);
}
