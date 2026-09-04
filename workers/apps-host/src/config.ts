type AppsAuthRpc = {
  mintAppBootstrap(args: {
    appId: string;
    slug: string;
    origin: string;
  }): Promise<{ bootstrap: string; expiresAt: number }>;
  mintAnonymousSession(args: {
    bootstrap: string;
    origin: string;
    viewerToken: string | null;
  }): Promise<Record<string, unknown>>;
  verifyFetchCapability(args: {
    capability: string;
    origin: string;
    method: string;
    targetOrigin: string;
    targetUrl: string;
    requestHash: string;
    now: number;
  }): Promise<{
    ok: boolean;
    reason?: string;
    tokenId?: string;
    appId?: string;
    viewerNamespace?: string;
    expiresAt?: number;
  }>;
};

export type AppsHostUntrustedEnv = Omit<
  AppsHostUntrustedBindings,
  "APP_AUTH"
> & {
  APP_AUTH: AppsHostUntrustedBindings["APP_AUTH"] & AppsAuthRpc;
  BUILDER_SERVICE_SECRET?: never;
  APP_TOKEN_SIGNING_KEY?: never;
};

export type AppsHostTrustedEnv = AppsHostTrustedBindings & {
  APP_BUILDS?: never;
  APP_ROUTES?: never;
  APP_AUTH?: never;
  APP_FETCH_GATE?: never;
};

export type AppsHostEnv = AppsHostUntrustedEnv | AppsHostTrustedEnv;

export type AppsHostConfig = {
  hostRole: "trusted" | "untrusted";
  appBuilds: R2Bucket | null;
  appRoutes: KVNamespace | null;
  deploymentIdentity: AppsHostDeploymentIdentity;
  sharesDisabled: boolean;
  convexSiteOrigin: AppsHostConvexSiteOrigin;
  convexCloudOrigin: AppsHostConvexCloudOrigin;
  appsHostOrigin: AppsHostOrigin;
  trustedAppsHostOrigin: AppsHostTrustedOrigin;
  cloudBuilderOrigin: AppsHostCloudBuilderOrigin;
  cloudBuilderWebSocketOrigin: AppsHostCloudBuilderWebSocketOrigin;
  builderServiceSecret: string | null;
  appTokenSigningKey: string | null;
  appAuth: AppsHostUntrustedEnv["APP_AUTH"] | null;
  appFetchGate: AppsHostUntrustedEnv["APP_FETCH_GATE"] | null;
};

export const DEV_DEPLOYMENT_IDENTITY = "dev:outgoing-bulldog-865" as const;
export const DEV_CONVEX_SITE_ORIGIN =
  "https://outgoing-bulldog-865.convex.site" as const;
export const DEV_CONVEX_CLOUD_ORIGIN =
  "https://outgoing-bulldog-865.convex.cloud" as const;
export const DEV_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev" as const;
export const DEV_TRUSTED_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev" as const;
export const DEV_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev" as const;
export const DEV_CLOUD_BUILDER_WEBSOCKET_ORIGIN =
  "wss://stella-v2-cloud-builder-dev.lolruuxi.workers.dev" as const;

export const ACCEPTANCE_DEPLOYMENT_IDENTITY =
  "preview:basic-nightingale-118" as const;
export const ACCEPTANCE_CONVEX_SITE_ORIGIN =
  "https://basic-nightingale-118.convex.site" as const;
export const ACCEPTANCE_CONVEX_CLOUD_ORIGIN =
  "https://basic-nightingale-118.convex.cloud" as const;
export const ACCEPTANCE_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev" as const;
export const ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-auth-basic-nightingale-118.lolruuxi.workers.dev" as const;
export const ACCEPTANCE_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev" as const;
export const ACCEPTANCE_CLOUD_BUILDER_WEBSOCKET_ORIGIN =
  "wss://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev" as const;

export const PRODUCTION_DEPLOYMENT_IDENTITY = "prod:intent-jackal-330" as const;
export const PRODUCTION_CONVEX_SITE_ORIGIN =
  "https://intent-jackal-330.convex.site" as const;
export const PRODUCTION_CONVEX_CLOUD_ORIGIN =
  "https://intent-jackal-330.convex.cloud" as const;
export const PRODUCTION_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-prod.lolruuxi.workers.dev" as const;
export const PRODUCTION_TRUSTED_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-auth-prod.lolruuxi.workers.dev" as const;
export const PRODUCTION_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev" as const;
export const PRODUCTION_CLOUD_BUILDER_WEBSOCKET_ORIGIN =
  "wss://stella-v2-cloud-builder-prod.lolruuxi.workers.dev" as const;

const AUTHORIZED_PROFILES = [
  {
    deploymentIdentity: DEV_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: DEV_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: DEV_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: DEV_APPS_HOST_ORIGIN,
    trustedAppsHostOrigin: DEV_TRUSTED_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: DEV_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: DEV_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
  },
  {
    deploymentIdentity: ACCEPTANCE_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: ACCEPTANCE_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: ACCEPTANCE_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: ACCEPTANCE_APPS_HOST_ORIGIN,
    trustedAppsHostOrigin: ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: ACCEPTANCE_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
  },
  {
    deploymentIdentity: PRODUCTION_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: PRODUCTION_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: PRODUCTION_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: PRODUCTION_APPS_HOST_ORIGIN,
    trustedAppsHostOrigin: PRODUCTION_TRUSTED_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: PRODUCTION_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: PRODUCTION_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
  },
] as const;

export type AppsHostDeploymentIdentity =
  (typeof AUTHORIZED_PROFILES)[number]["deploymentIdentity"];
export type AppsHostConvexSiteOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["convexSiteOrigin"];
export type AppsHostConvexCloudOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["convexCloudOrigin"];
export type AppsHostOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["appsHostOrigin"];
export type AppsHostTrustedOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["trustedAppsHostOrigin"];
export type AppsHostCloudBuilderOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["cloudBuilderOrigin"];
export type AppsHostCloudBuilderWebSocketOrigin =
  (typeof AUTHORIZED_PROFILES)[number]["cloudBuilderWebSocketOrigin"];

const MIN_SERVICE_SECRET_LENGTH = 32;
const MAX_SERVICE_SECRET_LENGTH = 4_096;

export class AppsHostConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: string[]) {
    super("The Stella Apps host non-production configuration is invalid.");
    this.name = "AppsHostConfigurationError";
    this.fields = fields;
  }
}

const isAppBuildsBinding = (
  value: unknown,
): value is AppsHostUntrustedEnv["APP_BUILDS"] =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { get?: unknown }).get === "function",
  );

const isAppRoutesBinding = (
  value: unknown,
): value is AppsHostUntrustedEnv["APP_ROUTES"] =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { get?: unknown }).get === "function",
  );

const isAppAuthBinding = (
  value: unknown,
): value is AppsHostUntrustedEnv["APP_AUTH"] =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { mintAnonymousSession?: unknown })
        .mintAnonymousSession === "function" &&
      typeof (value as { mintAppBootstrap?: unknown }).mintAppBootstrap ===
        "function" &&
      typeof (value as { verifyFetchCapability?: unknown })
        .verifyFetchCapability === "function",
  );

const isFetchGateBinding = (
  value: unknown,
): value is AppsHostUntrustedEnv["APP_FETCH_GATE"] =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { getByName?: unknown }).getByName === "function",
  );

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

/**
 * This Worker is deliberately a non-production authority. It must never infer
 * a Convex target from the request host, a generic environment name, or a
 * fallback URL: every control-plane origin is checked against one exact
 * checked-in deployment tuple before any route is served.
 */
export const readAppsHostConfig = (
  env: AppsHostEnv | Record<string, unknown>,
): AppsHostConfig => {
  const invalid: string[] = [];
  const role =
    env.HOST_ROLE === "trusted" || env.HOST_ROLE === "untrusted"
      ? env.HOST_ROLE
      : null;
  const profile = AUTHORIZED_PROFILES.find(
    (candidate) =>
      candidate.deploymentIdentity === env.STELLA_DEPLOYMENT_IDENTITY,
  );

  if (!role) invalid.push("HOST_ROLE");
  if (!profile) {
    invalid.push("STELLA_DEPLOYMENT_IDENTITY");
  }
  if (env.SHARES_DISABLED !== "true" && env.SHARES_DISABLED !== "false") {
    invalid.push("SHARES_DISABLED");
  }
  if (
    !profile ||
    !isExactHttpsOrigin(env.CONVEX_SITE_URL, profile.convexSiteOrigin)
  ) {
    invalid.push("CONVEX_SITE_URL");
  }
  if (
    !profile ||
    !isExactHttpsOrigin(env.CONVEX_CLOUD_URL, profile.convexCloudOrigin)
  ) {
    invalid.push("CONVEX_CLOUD_URL");
  }
  if (
    !profile ||
    !isExactHttpsOrigin(env.APPS_HOST_ORIGIN, profile.appsHostOrigin)
  ) {
    invalid.push("APPS_HOST_ORIGIN");
  }
  if (
    !profile ||
    !isExactHttpsOrigin(
      env.TRUSTED_APPS_HOST_ORIGIN,
      profile.trustedAppsHostOrigin,
    ) ||
    env.TRUSTED_APPS_HOST_ORIGIN === env.APPS_HOST_ORIGIN
  ) {
    invalid.push("TRUSTED_APPS_HOST_ORIGIN");
  }
  if (
    !profile ||
    !isExactHttpsOrigin(env.CLOUD_BUILDER_ORIGIN, profile.cloudBuilderOrigin)
  ) {
    invalid.push("CLOUD_BUILDER_ORIGIN");
  }
  const builderSecret =
    typeof env.BUILDER_SERVICE_SECRET === "string"
      ? env.BUILDER_SERVICE_SECRET.trim()
      : "";
  const appTokenSigningKey =
    typeof env.APP_TOKEN_SIGNING_KEY === "string"
      ? env.APP_TOKEN_SIGNING_KEY.trim()
      : "";
  let appBuilds: AppsHostUntrustedEnv["APP_BUILDS"] | null = null;
  let appRoutes: AppsHostUntrustedEnv["APP_ROUTES"] | null = null;
  let appAuth: AppsHostUntrustedEnv["APP_AUTH"] | null = null;
  let appFetchGate: AppsHostUntrustedEnv["APP_FETCH_GATE"] | null = null;
  if (role === "trusted") {
    for (const [name, secret, raw] of [
      ["BUILDER_SERVICE_SECRET", builderSecret, env.BUILDER_SERVICE_SECRET],
      ["APP_TOKEN_SIGNING_KEY", appTokenSigningKey, env.APP_TOKEN_SIGNING_KEY],
    ] as const) {
      if (
        secret !== raw ||
        secret.length < MIN_SERVICE_SECRET_LENGTH ||
        secret.length > MAX_SERVICE_SECRET_LENGTH ||
        !/^[\x21-\x7e]+$/.test(secret)
      ) {
        invalid.push(name);
      }
    }
    if (env.APP_BUILDS !== undefined) invalid.push("APP_BUILDS");
    if (env.APP_ROUTES !== undefined) invalid.push("APP_ROUTES");
    if (env.APP_AUTH !== undefined) invalid.push("APP_AUTH");
    if (env.APP_FETCH_GATE !== undefined) invalid.push("APP_FETCH_GATE");
  } else if (role === "untrusted") {
    if (isAppBuildsBinding(env.APP_BUILDS)) {
      appBuilds = env.APP_BUILDS;
    } else {
      invalid.push("APP_BUILDS");
    }
    if (isAppRoutesBinding(env.APP_ROUTES)) {
      appRoutes = env.APP_ROUTES;
    } else {
      invalid.push("APP_ROUTES");
    }
    if (env.BUILDER_SERVICE_SECRET !== undefined) {
      invalid.push("BUILDER_SERVICE_SECRET");
    }
    if (env.APP_TOKEN_SIGNING_KEY !== undefined) {
      invalid.push("APP_TOKEN_SIGNING_KEY");
    }
    if (isAppAuthBinding(env.APP_AUTH)) {
      appAuth = env.APP_AUTH;
    } else {
      invalid.push("APP_AUTH");
    }
    if (isFetchGateBinding(env.APP_FETCH_GATE)) {
      appFetchGate = env.APP_FETCH_GATE;
    } else {
      invalid.push("APP_FETCH_GATE");
    }
  }

  if (invalid.length > 0 || !profile || !role) {
    throw new AppsHostConfigurationError(invalid);
  }

  return {
    hostRole: role,
    appBuilds,
    appRoutes,
    deploymentIdentity: profile.deploymentIdentity,
    sharesDisabled: env.SHARES_DISABLED === "true",
    convexSiteOrigin: profile.convexSiteOrigin,
    convexCloudOrigin: profile.convexCloudOrigin,
    appsHostOrigin: profile.appsHostOrigin,
    trustedAppsHostOrigin: profile.trustedAppsHostOrigin,
    cloudBuilderOrigin: profile.cloudBuilderOrigin,
    cloudBuilderWebSocketOrigin: profile.cloudBuilderWebSocketOrigin,
    builderServiceSecret: role === "trusted" ? builderSecret : null,
    appTokenSigningKey: role === "trusted" ? appTokenSigningKey : null,
    appAuth,
    appFetchGate,
  };
};
