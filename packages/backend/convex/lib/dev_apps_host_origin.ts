export const DEV_APPS_HOST_DEPLOYMENT_IDENTITY =
  "dev:impartial-crab-34" as const;
export const DEV_APPS_HOST_CONVEX_SITE_ORIGIN =
  "https://impartial-crab-34.convex.site" as const;
export const DEV_APPS_HOST_CONVEX_CLOUD_ORIGIN =
  "https://impartial-crab-34.convex.cloud" as const;
export const DEV_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev" as const;

export type DevAppsHostTrustEnv = Readonly<{
  STELLA_DEPLOYMENT_IDENTITY?: string;
  CONVEX_SITE_URL?: string;
  CONVEX_CLOUD_URL?: string;
  STELLA_AUTH_BASE_URL?: string;
  APPS_HOST_ORIGIN?: string;
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

export const resolvesToDevAppsHostOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === DEV_APPS_HOST_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * Return the single Apps host origin authorized to call this development
 * backend. Missing or mismatched deployment metadata intentionally returns
 * null; callers must not infer an environment from a hostname or fall back to
 * another Convex deployment.
 */
export const getTrustedDevAppsHostOrigin = (
  env: DevAppsHostTrustEnv,
): typeof DEV_APPS_HOST_ORIGIN | null => {
  if (
    env.STELLA_DEPLOYMENT_IDENTITY !== DEV_APPS_HOST_DEPLOYMENT_IDENTITY ||
    !isExactHttpsOrigin(
      env.CONVEX_SITE_URL,
      DEV_APPS_HOST_CONVEX_SITE_ORIGIN,
    ) ||
    !isExactHttpsOrigin(
      env.CONVEX_CLOUD_URL,
      DEV_APPS_HOST_CONVEX_CLOUD_ORIGIN,
    ) ||
    !isExactHttpsOrigin(env.APPS_HOST_ORIGIN, DEV_APPS_HOST_ORIGIN)
  ) {
    return null;
  }

  const configuredAuthBaseUrl = env.STELLA_AUTH_BASE_URL?.trim();
  if (
    configuredAuthBaseUrl &&
    !isExactHttpsOrigin(configuredAuthBaseUrl, DEV_APPS_HOST_CONVEX_SITE_ORIGIN)
  ) {
    return null;
  }

  return DEV_APPS_HOST_ORIGIN;
};
