import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEV_APPS_HOST_ORIGIN,
  getTrustedDevAppsHostOrigin,
  resolvesToDevAppsHostOrigin,
} from "./dev_apps_host_origin";

const validEnv = () => ({
  STELLA_DEPLOYMENT_IDENTITY: "dev:impartial-crab-34",
  CONVEX_SITE_URL: "https://impartial-crab-34.convex.site",
  CONVEX_CLOUD_URL: "https://impartial-crab-34.convex.cloud",
  APPS_HOST_ORIGIN: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
});

describe("development Apps host origin authority", () => {
  test("trusts the exact impartial-crab development contract", () => {
    assert.equal(getTrustedDevAppsHostOrigin(validEnv()), DEV_APPS_HOST_ORIGIN);
    assert.equal(
      getTrustedDevAppsHostOrigin({
        ...validEnv(),
        STELLA_AUTH_BASE_URL: "https://impartial-crab-34.convex.site",
      }),
      DEV_APPS_HOST_ORIGIN,
    );
  });

  test("fails closed when any required deployment field is absent", () => {
    for (const field of [
      "STELLA_DEPLOYMENT_IDENTITY",
      "CONVEX_SITE_URL",
      "CONVEX_CLOUD_URL",
      "APPS_HOST_ORIGIN",
    ] as const) {
      const env = validEnv();
      delete env[field];
      assert.equal(getTrustedDevAppsHostOrigin(env), null, field);
    }
  });

  test("rejects the retired deployment and mixed-environment authority", () => {
    for (const override of [
      { STELLA_DEPLOYMENT_IDENTITY: "dev:flexible-panther-999" },
      { CONVEX_SITE_URL: "https://flexible-panther-999.convex.site" },
      { CONVEX_CLOUD_URL: "https://flexible-panther-999.convex.cloud" },
      { APPS_HOST_ORIGIN: "https://apps.example.com" },
      { STELLA_AUTH_BASE_URL: "https://auth.example.com" },
    ]) {
      assert.equal(
        getTrustedDevAppsHostOrigin({ ...validEnv(), ...override }),
        null,
      );
    }
  });

  test("requires canonical origins without paths or trailing separators", () => {
    for (const override of [
      { CONVEX_SITE_URL: "https://impartial-crab-34.convex.site/" },
      { CONVEX_CLOUD_URL: "https://impartial-crab-34.convex.cloud/" },
      {
        APPS_HOST_ORIGIN:
          "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/",
      },
      {
        APPS_HOST_ORIGIN:
          "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/path",
      },
    ]) {
      assert.equal(
        getTrustedDevAppsHostOrigin({ ...validEnv(), ...override }),
        null,
      );
    }
  });

  test("recognizes noncanonical URLs that would resolve to the Apps host", () => {
    assert.equal(resolvesToDevAppsHostOrigin(DEV_APPS_HOST_ORIGIN), true);
    assert.equal(resolvesToDevAppsHostOrigin(`${DEV_APPS_HOST_ORIGIN}/`), true);
    assert.equal(
      resolvesToDevAppsHostOrigin(`${DEV_APPS_HOST_ORIGIN}/auth`),
      true,
    );
    assert.equal(
      resolvesToDevAppsHostOrigin("https://stella.sh/apps-host"),
      false,
    );
  });
});
