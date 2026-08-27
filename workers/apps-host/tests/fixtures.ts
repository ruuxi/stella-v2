import {
  DEV_APPS_HOST_ORIGIN,
  DEV_CLOUD_BUILDER_ORIGIN,
  DEV_CONVEX_CLOUD_ORIGIN,
  DEV_CONVEX_SITE_ORIGIN,
  DEV_DEPLOYMENT_IDENTITY,
  type AppsHostEnv,
} from "../src/config";

export const TEST_SERVICE_SECRET = "s".repeat(48);

export const createEnv = (overrides: Partial<AppsHostEnv> = {}): AppsHostEnv =>
  ({
    APP_BUILDS: {
      get: async () => null,
    } as unknown as R2Bucket,
    APP_ROUTES: {
      get: async () => null,
    } as unknown as KVNamespace,
    STELLA_DEPLOYMENT_IDENTITY: DEV_DEPLOYMENT_IDENTITY,
    SHARES_DISABLED: "false",
    CONVEX_SITE_URL: DEV_CONVEX_SITE_ORIGIN,
    CONVEX_CLOUD_URL: DEV_CONVEX_CLOUD_ORIGIN,
    APPS_HOST_ORIGIN: DEV_APPS_HOST_ORIGIN,
    CLOUD_BUILDER_ORIGIN: DEV_CLOUD_BUILDER_ORIGIN,
    BUILDER_SERVICE_SECRET: TEST_SERVICE_SECRET,
    ...overrides,
  }) as AppsHostEnv;

export const routeId = "sr_12345678-1234-4123-8123-123456789abc";
