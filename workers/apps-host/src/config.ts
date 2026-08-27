export type AppsHostEnv = {
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  STELLA_DEPLOYMENT_IDENTITY: string;
  SHARES_DISABLED: string;
  CONVEX_SITE_URL: string;
  CONVEX_CLOUD_URL: string;
  APPS_HOST_ORIGIN: string;
  CLOUD_BUILDER_ORIGIN: string;
  BUILDER_SERVICE_SECRET: string;
};

export type AppsHostConfig = {
  appBuilds: R2Bucket;
  appRoutes: KVNamespace;
  deploymentIdentity: AppsHostDeploymentIdentity;
  sharesDisabled: boolean;
  convexSiteOrigin: AppsHostConvexSiteOrigin;
  convexCloudOrigin: AppsHostConvexCloudOrigin;
  appsHostOrigin: AppsHostOrigin;
  cloudBuilderOrigin: AppsHostCloudBuilderOrigin;
  cloudBuilderWebSocketOrigin: AppsHostCloudBuilderWebSocketOrigin;
  builderServiceSecret: string;
};

export const DEV_DEPLOYMENT_IDENTITY = "dev:impartial-crab-34" as const;
export const DEV_CONVEX_SITE_ORIGIN =
  "https://impartial-crab-34.convex.site" as const;
export const DEV_CONVEX_CLOUD_ORIGIN =
  "https://impartial-crab-34.convex.cloud" as const;
export const DEV_APPS_HOST_ORIGIN =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev" as const;
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
export const ACCEPTANCE_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev" as const;
export const ACCEPTANCE_CLOUD_BUILDER_WEBSOCKET_ORIGIN =
  "wss://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev" as const;

const AUTHORIZED_PROFILES = [
  {
    deploymentIdentity: DEV_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: DEV_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: DEV_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: DEV_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: DEV_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: DEV_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
  },
  {
    deploymentIdentity: ACCEPTANCE_DEPLOYMENT_IDENTITY,
    convexSiteOrigin: ACCEPTANCE_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: ACCEPTANCE_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: ACCEPTANCE_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: ACCEPTANCE_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
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

const isBindingWithGet = (value: unknown): value is { get: Function } =>
  Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { get?: unknown }).get === "function",
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
export const readAppsHostConfig = (env: AppsHostEnv): AppsHostConfig => {
  const invalid: string[] = [];
  const profile = AUTHORIZED_PROFILES.find(
    (candidate) =>
      candidate.deploymentIdentity === env.STELLA_DEPLOYMENT_IDENTITY,
  );

  if (!isBindingWithGet(env.APP_BUILDS)) invalid.push("APP_BUILDS");
  if (!isBindingWithGet(env.APP_ROUTES)) invalid.push("APP_ROUTES");
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
    !isExactHttpsOrigin(env.CLOUD_BUILDER_ORIGIN, profile.cloudBuilderOrigin)
  ) {
    invalid.push("CLOUD_BUILDER_ORIGIN");
  }
  const secret =
    typeof env.BUILDER_SERVICE_SECRET === "string"
      ? env.BUILDER_SERVICE_SECRET.trim()
      : "";
  if (
    secret !== env.BUILDER_SERVICE_SECRET ||
    secret.length < MIN_SERVICE_SECRET_LENGTH ||
    secret.length > MAX_SERVICE_SECRET_LENGTH ||
    !/^[\x21-\x7e]+$/.test(secret)
  ) {
    invalid.push("BUILDER_SERVICE_SECRET");
  }

  if (invalid.length > 0 || !profile) {
    throw new AppsHostConfigurationError(invalid);
  }

  return {
    appBuilds: env.APP_BUILDS,
    appRoutes: env.APP_ROUTES,
    deploymentIdentity: profile.deploymentIdentity,
    sharesDisabled: env.SHARES_DISABLED === "true",
    convexSiteOrigin: profile.convexSiteOrigin,
    convexCloudOrigin: profile.convexCloudOrigin,
    appsHostOrigin: profile.appsHostOrigin,
    cloudBuilderOrigin: profile.cloudBuilderOrigin,
    cloudBuilderWebSocketOrigin: profile.cloudBuilderWebSocketOrigin,
    builderServiceSecret: secret,
  };
};
