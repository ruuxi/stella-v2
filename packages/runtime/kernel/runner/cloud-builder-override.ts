// Development/harness-only override for the cloud-builder (conversation DO +
// journal) origin. Normally the runtime resolves this origin from Convex
// (`cloud_apps.getCloudRealtimeConfig`, derived from Convex's CLOUD_BUILDER_URL),
// which in dev points every signed-in caller at `cloud-builder-dev`. This
// override lets a disposable dev/harness profile route to an isolated staging
// worker (e.g. stella-v2-cloud-builder-staging) WITHOUT repointing the shared
// dev Convex for everyone.
//
// Safety contract (must be impossible to leak into production packaging):
//  - Honored ONLY in non-packaged (development) runs. If the override env var is
//    present in a packaged/production build, we THROW rather than silently
//    honoring or silently ignoring it — a packaged app that somehow carries this
//    var is a build mistake that must fail loudly.
//  - Fail-visible on a malformed URL.
//  - Absent override => null (fall back to the Convex-resolved origin).

export class CloudBuilderOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudBuilderOverrideError";
  }
}

export interface CloudBuilderOverrideEnv {
  /** STELLA_DEV_CLOUD_BUILDER_URL — dev/harness-only staging origin. */
  readonly overrideUrl: string | undefined;
  /**
   * STELLA_PACKAGED — "1"/"true" in a packaged/production build (set by the
   * Electron bootstrap from app.isPackaged). Undefined/other => development.
   */
  readonly packaged: string | undefined;
}

const isPackaged = (value: string | undefined): boolean =>
  value === "1" || value === "true";

/**
 * Resolve the dev cloud-builder override origin, or null when unset. Throws in
 * packaged builds if the override is present, and on a malformed URL.
 */
export function resolveCloudBuilderOverride(
  env: CloudBuilderOverrideEnv,
): string | null {
  const raw = (env.overrideUrl ?? "").trim();
  if (!raw) return null;

  if (isPackaged(env.packaged)) {
    throw new CloudBuilderOverrideError(
      "STELLA_DEV_CLOUD_BUILDER_URL is set in a packaged/production build. This " +
        "development-only staging override must never ship; refusing to route " +
        "conversations through it.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudBuilderOverrideError(
      `STELLA_DEV_CLOUD_BUILDER_URL is not a valid URL: ${raw}`,
    );
  }
  const isLocalhost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new CloudBuilderOverrideError(
      `STELLA_DEV_CLOUD_BUILDER_URL must be https (or localhost for a local worker): ${raw}`,
    );
  }
  return url.origin;
}
