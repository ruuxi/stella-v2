import { describe, expect, test } from "bun:test";
import {
  ACCEPTANCE_CONVEX_SITE_ORIGIN,
  ACCEPTANCE_DEPLOYMENT_IDENTITY,
  AppsHostConfigurationError,
  DEV_CONVEX_SITE_ORIGIN,
  DEV_DEPLOYMENT_IDENTITY,
  readAppsHostConfig,
} from "../src/config";
import worker from "../src/index";
import { createAcceptanceEnv, createEnv } from "./fixtures";

describe("non-production authority configuration", () => {
  test("accepts only the explicit outgoing-bulldog development deployment", () => {
    const config = readAppsHostConfig(createEnv());
    expect(config.deploymentIdentity).toBe(DEV_DEPLOYMENT_IDENTITY);
    expect(config.convexSiteOrigin).toBe(DEV_CONVEX_SITE_ORIGIN);
    expect(config.sharesDisabled).toBeFalse();
  });

  test("accepts only the exact isolated acceptance preview tuple", () => {
    const config = readAppsHostConfig(createAcceptanceEnv());
    expect(config.deploymentIdentity).toBe(ACCEPTANCE_DEPLOYMENT_IDENTITY);
    expect(config.convexSiteOrigin).toBe(ACCEPTANCE_CONVEX_SITE_ORIGIN);
    expect(config.sharesDisabled).toBeFalse();
  });

  test("rejects mixed development and acceptance tuples", () => {
    for (const [field, value] of [
      ["CONVEX_SITE_URL", DEV_CONVEX_SITE_ORIGIN],
      ["CONVEX_CLOUD_URL", "https://outgoing-bulldog-865.convex.cloud"],
      [
        "APPS_HOST_ORIGIN",
        "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
      ],
      [
        "CLOUD_BUILDER_ORIGIN",
        "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
      ],
    ] as const) {
      expect(() =>
        readAppsHostConfig(createAcceptanceEnv({ [field]: value })),
      ).toThrow(AppsHostConfigurationError);
    }
  });

  test.each([
    ["STELLA_DEPLOYMENT_IDENTITY", "dev:flexible-panther-999"],
    ["CONVEX_SITE_URL", "https://flexible-panther-999.convex.site"],
    ["CONVEX_CLOUD_URL", "https://flexible-panther-999.convex.cloud"],
    ["APPS_HOST_ORIGIN", "https://apps.example.com"],
    ["CLOUD_BUILDER_ORIGIN", "https://builder.example.com"],
    ["SHARES_DISABLED", "False"],
    ["BUILDER_SERVICE_SECRET", "short"],
    ["BUILDER_SERVICE_SECRET", `${"s".repeat(32)}\ninvalid`],
  ] as const)("rejects a stale or malformed %s", (field, value) => {
    expect(() => readAppsHostConfig(createEnv({ [field]: value }))).toThrow(
      AppsHostConfigurationError,
    );
    try {
      readAppsHostConfig(createEnv({ [field]: value }));
    } catch (error) {
      expect((error as AppsHostConfigurationError).fields).toContain(field);
    }
  });

  test("fails closed before health is reported when configuration is invalid", async () => {
    const response = await worker.fetch(
      new Request("https://apps.example.com/healthz"),
      createEnv({
        STELLA_DEPLOYMENT_IDENTITY: "dev:flexible-panther-999",
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "The Stella Apps host is unavailable.",
    });
  });

  test("reports the one authorized identity only after validation", async () => {
    const response = await worker.fetch(
      new Request("https://apps.example.com/healthz"),
      createEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "stella-v2-apps-host",
      deployment: "dev:outgoing-bulldog-865",
    });
  });
});
