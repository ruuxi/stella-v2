import {
  ACCEPTANCE_APPS_HOST_ORIGIN,
  ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
  ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
  ACCEPTANCE_CONVEX_CLOUD_ORIGIN,
  ACCEPTANCE_CONVEX_SITE_ORIGIN,
  ACCEPTANCE_DEPLOYMENT_IDENTITY,
  DEV_APPS_HOST_ORIGIN,
  DEV_TRUSTED_APPS_HOST_ORIGIN,
  DEV_CLOUD_BUILDER_ORIGIN,
  DEV_CONVEX_CLOUD_ORIGIN,
  DEV_CONVEX_SITE_ORIGIN,
  DEV_DEPLOYMENT_IDENTITY,
  type AppsHostEnv,
} from "../src/config";

export const TEST_SERVICE_SECRET = "s".repeat(48);
export const TEST_APP_TOKEN_SIGNING_KEY = "t".repeat(48);

const appAuth = {
  mintInteriorBootstrap: async () => ({
    bootstrap: "test-interior-bootstrap",
    expiresAt: Date.now() + 60_000,
  }),
  mintAppBootstrap: async () => ({
    bootstrap: "test-bootstrap",
    expiresAt: Date.now() + 60_000,
  }),
  mintAnonymousSession: async () => ({}),
  verifyFetchCapability: async () => ({
    ok: true,
    tokenId: "00000000-0000-4000-8000-000000000001",
    appId: "app-test",
    viewerNamespace: "viewer-test",
    expiresAt: Date.now() + 60_000,
  }),
  getInteriorRoute: async () => null,
};
const appFetchGate = {
  getByName: () => ({ consume: async () => ({ ok: true }) }),
};

export const createEnv = (overrides: Partial<AppsHostEnv> = {}): AppsHostEnv =>
  ({
    STELLA_DEPLOYMENT_IDENTITY: DEV_DEPLOYMENT_IDENTITY,
    HOST_ROLE: "trusted",
    SHARES_DISABLED: "false",
    CONVEX_SITE_URL: DEV_CONVEX_SITE_ORIGIN,
    CONVEX_CLOUD_URL: DEV_CONVEX_CLOUD_ORIGIN,
    APPS_HOST_ORIGIN: DEV_APPS_HOST_ORIGIN,
    TRUSTED_APPS_HOST_ORIGIN: DEV_TRUSTED_APPS_HOST_ORIGIN,
    CLOUD_BUILDER_ORIGIN: DEV_CLOUD_BUILDER_ORIGIN,
    BUILDER_SERVICE_SECRET: TEST_SERVICE_SECRET,
    APP_TOKEN_SIGNING_KEY: TEST_APP_TOKEN_SIGNING_KEY,
    ...overrides,
  }) as AppsHostEnv;

export const createAcceptanceEnv = (
  overrides: Partial<AppsHostEnv> = {},
): AppsHostEnv =>
  createEnv({
    STELLA_DEPLOYMENT_IDENTITY: ACCEPTANCE_DEPLOYMENT_IDENTITY,
    CONVEX_SITE_URL: ACCEPTANCE_CONVEX_SITE_ORIGIN,
    CONVEX_CLOUD_URL: ACCEPTANCE_CONVEX_CLOUD_ORIGIN,
    APPS_HOST_ORIGIN: ACCEPTANCE_APPS_HOST_ORIGIN,
    TRUSTED_APPS_HOST_ORIGIN: ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
    CLOUD_BUILDER_ORIGIN: ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
    ...overrides,
  });

export const createUntrustedEnv = (
  overrides: Partial<AppsHostEnv> = {},
): AppsHostEnv => {
  const env = createEnv({
    HOST_ROLE: "untrusted",
    APP_BUILDS: {
      get: async () => null,
    } as unknown as R2Bucket,
    APP_ROUTES: {
      get: async () => null,
    } as unknown as KVNamespace,
    BUILDER_SERVICE_SECRET: undefined,
    APP_TOKEN_SIGNING_KEY: undefined,
    APP_AUTH: appAuth,
    APP_FETCH_GATE: appFetchGate,
    ...overrides,
  });
  return env;
};

export const routeId = "sr_12345678-1234-4123-8123-123456789abc";
