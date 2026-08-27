import { describe, expect, test } from "bun:test";
import {
  AppsHostConfigurationError,
  DEV_CONVEX_SITE_ORIGIN,
  DEV_DEPLOYMENT_IDENTITY,
  readAppsHostConfig,
} from "../src/config";
import worker from "../src/index";
import { createEnv } from "./fixtures";

describe("development authority configuration", () => {
  test("accepts only the explicit impartial-crab development deployment", () => {
    const config = readAppsHostConfig(createEnv());
    expect(config.deploymentIdentity).toBe(DEV_DEPLOYMENT_IDENTITY);
    expect(config.convexSiteOrigin).toBe(DEV_CONVEX_SITE_ORIGIN);
    expect(config.sharesDisabled).toBeFalse();
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
      deployment: "dev:impartial-crab-34",
    });
  });
});
