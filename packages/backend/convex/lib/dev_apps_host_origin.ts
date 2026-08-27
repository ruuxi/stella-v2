export const DEV_APPS_HOST_DEPLOYMENT_IDENTITY =
  "dev:impartial-crab-34" as const;
export const DEV_APPS_HOST_CONVEX_SITE_ORIGIN =
  "https://impartial-crab-34.convex.site" as const;
export const DEV_APPS_HOST_CONVEX_CLOUD_ORIGIN =
  "https://impartial-crab-34.convex.cloud" as const;
export const DEV_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev" as const;
export const DEV_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev" as const;

export const ACCEPTANCE_APPS_HOST_DEPLOYMENT_IDENTITY =
  "preview:basic-nightingale-118" as const;
export const ACCEPTANCE_APPS_HOST_CONVEX_SITE_ORIGIN =
  "https://basic-nightingale-118.convex.site" as const;
export const ACCEPTANCE_APPS_HOST_CONVEX_CLOUD_ORIGIN =
  "https://basic-nightingale-118.convex.cloud" as const;
export const ACCEPTANCE_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev" as const;
export const ACCEPTANCE_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev" as const;

const TRUSTED_APPS_HOST_PROFILES = [
  {
    deploymentIdentity: DEV_APPS_HOST_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: DEV_APPS_HOST_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: DEV_APPS_HOST_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: DEV_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: DEV_CLOUD_BUILDER_ORIGIN,
  },
  {
    deploymentIdentity: ACCEPTANCE_APPS_HOST_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: ACCEPTANCE_APPS_HOST_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: ACCEPTANCE_APPS_HOST_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: ACCEPTANCE_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
  },
] as const;

export type TrustedAppsHostOrigin =
  (typeof TRUSTED_APPS_HOST_PROFILES)[number]["appsHostOrigin"];

export type AppsHostTrustEnv = Readonly<{
  STELLA_DEPLOYMENT_IDENTITY?: string;
  CONVEX_SITE_URL?: string;
  CONVEX_CLOUD_URL?: string;
  STELLA_AUTH_BASE_URL?: string;
  APPS_HOST_ORIGIN?: string;
  CLOUD_BUILDER_URL?: string;
}>;

const isExactHttpsOrigin = (value: unknown, expected: string): boolean => {
  if (typeof value !== "string" || value !== expected) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === expected &&
      parsed.pathname === "/" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
};

export const resolveManagedAppsHostOrigin = (
  value: string,
): TrustedAppsHostOrigin | null => {
  try {
    const origin = new URL(value).origin;
    return (
      TRUSTED_APPS_HOST_PROFILES.find(
        (profile) => profile.appsHostOrigin === origin,
      )?.appsHostOrigin ?? null
    );
  } catch {
    return null;
  }
};

export const resolvesToManagedAppsHostOrigin = (value: string): boolean =>
  resolveManagedAppsHostOrigin(value) !== null;

/**
 * Return the single Apps host origin authorized by an exact checked-in
 * non-production deployment tuple. Missing or mixed deployment metadata
 * intentionally returns null; callers must not infer an environment from a
 * hostname or fall back to another Convex deployment.
 */
export const getTrustedAppsHostOrigin = (
  env: AppsHostTrustEnv,
): TrustedAppsHostOrigin | null => {
  const profile = TRUSTED_APPS_HOST_PROFILES.find(
    (candidate) =>
      candidate.deploymentIdentity === env.STELLA_DEPLOYMENT_IDENTITY,
  );
  if (!profile) return null;

  if (
    !isExactHttpsOrigin(env.CONVEX_SITE_URL, profile.convexSiteOrigin) ||
    !isExactHttpsOrigin(env.CONVEX_CLOUD_URL, profile.convexCloudOrigin) ||
    !isExactHttpsOrigin(env.APPS_HOST_ORIGIN, profile.appsHostOrigin) ||
    !isExactHttpsOrigin(env.CLOUD_BUILDER_URL, profile.cloudBuilderOrigin)
  )
    return null;

  const configuredAuthBaseUrl = env.STELLA_AUTH_BASE_URL?.trim();
  if (
    configuredAuthBaseUrl &&
    !isExactHttpsOrigin(configuredAuthBaseUrl, profile.convexSiteOrigin)
  ) {
    return null;
  }

  return profile.appsHostOrigin;
};
