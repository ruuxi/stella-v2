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
  deploymentIdentity: typeof DEV_DEPLOYMENT_IDENTITY;
  sharesDisabled: boolean;
  convexSiteOrigin: typeof DEV_CONVEX_SITE_ORIGIN;
  convexCloudOrigin: typeof DEV_CONVEX_CLOUD_ORIGIN;
  appsHostOrigin: typeof DEV_APPS_HOST_ORIGIN;
  cloudBuilderOrigin: typeof DEV_CLOUD_BUILDER_ORIGIN;
  cloudBuilderWebSocketOrigin: typeof DEV_CLOUD_BUILDER_WEBSOCKET_ORIGIN;
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

const MIN_SERVICE_SECRET_LENGTH = 32;
const MAX_SERVICE_SECRET_LENGTH = 4_096;

export class AppsHostConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: string[]) {
    super("The Stella Apps host development configuration is invalid.");
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
 * This Worker is deliberately a development-only authority. It must never
 * infer a Convex target from the request host, a generic environment name, or
 * a fallback URL: every control-plane origin is checked against the one
 * authorized development deployment before any route is served.
 */
export const readAppsHostConfig = (env: AppsHostEnv): AppsHostConfig => {
  const invalid: string[] = [];

  if (!isBindingWithGet(env.APP_BUILDS)) invalid.push("APP_BUILDS");
  if (!isBindingWithGet(env.APP_ROUTES)) invalid.push("APP_ROUTES");
  if (env.STELLA_DEPLOYMENT_IDENTITY !== DEV_DEPLOYMENT_IDENTITY) {
    invalid.push("STELLA_DEPLOYMENT_IDENTITY");
  }
  if (env.SHARES_DISABLED !== "true" && env.SHARES_DISABLED !== "false") {
    invalid.push("SHARES_DISABLED");
  }
  if (!isExactHttpsOrigin(env.CONVEX_SITE_URL, DEV_CONVEX_SITE_ORIGIN)) {
    invalid.push("CONVEX_SITE_URL");
  }
  if (!isExactHttpsOrigin(env.CONVEX_CLOUD_URL, DEV_CONVEX_CLOUD_ORIGIN)) {
    invalid.push("CONVEX_CLOUD_URL");
  }
  if (!isExactHttpsOrigin(env.APPS_HOST_ORIGIN, DEV_APPS_HOST_ORIGIN)) {
    invalid.push("APPS_HOST_ORIGIN");
  }
  if (!isExactHttpsOrigin(env.CLOUD_BUILDER_ORIGIN, DEV_CLOUD_BUILDER_ORIGIN)) {
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

  if (invalid.length > 0) {
    throw new AppsHostConfigurationError(invalid);
  }

  return {
    appBuilds: env.APP_BUILDS,
    appRoutes: env.APP_ROUTES,
    deploymentIdentity: DEV_DEPLOYMENT_IDENTITY,
    sharesDisabled: env.SHARES_DISABLED === "true",
    convexSiteOrigin: DEV_CONVEX_SITE_ORIGIN,
    convexCloudOrigin: DEV_CONVEX_CLOUD_ORIGIN,
    appsHostOrigin: DEV_APPS_HOST_ORIGIN,
    cloudBuilderOrigin: DEV_CLOUD_BUILDER_ORIGIN,
    cloudBuilderWebSocketOrigin: DEV_CLOUD_BUILDER_WEBSOCKET_ORIGIN,
    builderServiceSecret: secret,
  };
};
