import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCEPTANCE_APPS_HOST_ORIGIN,
  ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
  ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
  DEV_APPS_HOST_ORIGIN,
  DEV_TRUSTED_APPS_HOST_ORIGIN,
  DEV_CLOUD_BUILDER_ORIGIN,
  getTrustedAppsHostOrigin,
  getTrustedAppsAuthOrigin,
  resolveManagedAppsHostOrigin,
  resolvesToManagedAppsHostOrigin,
} from "./dev_apps_host_origin";

const validEnv = () => ({
  STELLA_DEPLOYMENT_IDENTITY: "dev:outgoing-bulldog-865",
  CONVEX_SITE_URL: "https://outgoing-bulldog-865.convex.site",
  CONVEX_CLOUD_URL: "https://outgoing-bulldog-865.convex.cloud",
  APPS_HOST_ORIGIN: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
  TRUSTED_APPS_HOST_ORIGIN: DEV_TRUSTED_APPS_HOST_ORIGIN,
  CLOUD_BUILDER_URL: DEV_CLOUD_BUILDER_ORIGIN,
});

const validAcceptanceEnv = () => ({
  STELLA_DEPLOYMENT_IDENTITY: "preview:basic-nightingale-118",
  CONVEX_SITE_URL: "https://basic-nightingale-118.convex.site",
  CONVEX_CLOUD_URL: "https://basic-nightingale-118.convex.cloud",
  APPS_HOST_ORIGIN: ACCEPTANCE_APPS_HOST_ORIGIN,
  TRUSTED_APPS_HOST_ORIGIN: ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
  CLOUD_BUILDER_URL: ACCEPTANCE_CLOUD_BUILDER_ORIGIN,
});

describe("non-production Apps host origin authority", () => {
  test("trusts the exact outgoing-bulldog development contract", () => {
    assert.equal(getTrustedAppsHostOrigin(validEnv()), DEV_APPS_HOST_ORIGIN);
    assert.equal(
      getTrustedAppsAuthOrigin(validEnv()),
      DEV_TRUSTED_APPS_HOST_ORIGIN,
    );
    assert.equal(
      getTrustedAppsHostOrigin({
        ...validEnv(),
        STELLA_AUTH_BASE_URL: "https://outgoing-bulldog-865.convex.site",
      }),
      DEV_APPS_HOST_ORIGIN,
    );
  });

  test("trusts the exact isolated acceptance preview contract", () => {
    assert.equal(
      getTrustedAppsHostOrigin(validAcceptanceEnv()),
      ACCEPTANCE_APPS_HOST_ORIGIN,
    );
    assert.equal(
      getTrustedAppsAuthOrigin(validAcceptanceEnv()),
      ACCEPTANCE_TRUSTED_APPS_HOST_ORIGIN,
    );
    assert.equal(
      getTrustedAppsHostOrigin({
        ...validAcceptanceEnv(),
        STELLA_AUTH_BASE_URL: "https://basic-nightingale-118.convex.site",
      }),
      ACCEPTANCE_APPS_HOST_ORIGIN,
    );
  });

  test("fails closed when any required deployment field is absent", () => {
    for (const field of [
      "STELLA_DEPLOYMENT_IDENTITY",
      "CONVEX_SITE_URL",
      "CONVEX_CLOUD_URL",
      "APPS_HOST_ORIGIN",
      "TRUSTED_APPS_HOST_ORIGIN",
      "CLOUD_BUILDER_URL",
    ] as const) {
      const env = validEnv();
      delete env[field];
      assert.equal(getTrustedAppsHostOrigin(env), null, field);
    }
  });

  test("rejects the retired deployment and mixed-environment authority", () => {
    for (const override of [
      { STELLA_DEPLOYMENT_IDENTITY: "dev:flexible-panther-999" },
      { CONVEX_SITE_URL: "https://flexible-panther-999.convex.site" },
      { CONVEX_CLOUD_URL: "https://flexible-panther-999.convex.cloud" },
      { APPS_HOST_ORIGIN: "https://apps.example.com" },
      { TRUSTED_APPS_HOST_ORIGIN: "https://auth.example.com" },
      { STELLA_AUTH_BASE_URL: "https://auth.example.com" },
    ]) {
      assert.equal(
        getTrustedAppsHostOrigin({ ...validEnv(), ...override }),
        null,
      );
    }
  });

  test("rejects mixed development and acceptance tuples", () => {
    for (const override of [
      { CONVEX_SITE_URL: "https://outgoing-bulldog-865.convex.site" },
      { CONVEX_CLOUD_URL: "https://outgoing-bulldog-865.convex.cloud" },
      { APPS_HOST_ORIGIN: DEV_APPS_HOST_ORIGIN },
      { TRUSTED_APPS_HOST_ORIGIN: DEV_TRUSTED_APPS_HOST_ORIGIN },
      { CLOUD_BUILDER_URL: DEV_CLOUD_BUILDER_ORIGIN },
      { STELLA_AUTH_BASE_URL: "https://outgoing-bulldog-865.convex.site" },
    ]) {
      assert.equal(
        getTrustedAppsHostOrigin({ ...validAcceptanceEnv(), ...override }),
        null,
      );
    }
  });

  test("requires canonical origins without paths or trailing separators", () => {
    for (const override of [
      { CONVEX_SITE_URL: "https://outgoing-bulldog-865.convex.site/" },
      { CONVEX_CLOUD_URL: "https://outgoing-bulldog-865.convex.cloud/" },
      {
        APPS_HOST_ORIGIN:
          "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/",
      },
      {
        APPS_HOST_ORIGIN:
          "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/path",
      },
      {
        TRUSTED_APPS_HOST_ORIGIN:
          "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev/path",
      },
    ]) {
      assert.equal(
        getTrustedAppsHostOrigin({ ...validEnv(), ...override }),
        null,
      );
    }
  });

  test("recognizes noncanonical URLs that would resolve to the Apps host", () => {
    assert.equal(
      resolveManagedAppsHostOrigin(DEV_APPS_HOST_ORIGIN),
      DEV_APPS_HOST_ORIGIN,
    );
    assert.equal(
      resolveManagedAppsHostOrigin(`${ACCEPTANCE_APPS_HOST_ORIGIN}/auth`),
      ACCEPTANCE_APPS_HOST_ORIGIN,
    );
    assert.equal(resolvesToManagedAppsHostOrigin(DEV_APPS_HOST_ORIGIN), true);
    assert.equal(
      resolvesToManagedAppsHostOrigin(`${DEV_APPS_HOST_ORIGIN}/`),
      true,
    );
    assert.equal(
      resolvesToManagedAppsHostOrigin(`${DEV_APPS_HOST_ORIGIN}/auth`),
      true,
    );
    assert.equal(
      resolveManagedAppsHostOrigin(`${DEV_TRUSTED_APPS_HOST_ORIGIN}/auth`),
      DEV_TRUSTED_APPS_HOST_ORIGIN,
    );
    assert.equal(
      resolvesToManagedAppsHostOrigin("https://stella.sh/apps-host"),
      false,
    );
  });
});
