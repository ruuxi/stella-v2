import { describe, expect, test } from "bun:test";
import {
  CLOUD_BUILDER_REQUIRED_FIELDS,
  evaluateCloudBuilderReadiness,
  type CloudBuilderReadinessInput,
} from "../src/readiness.js";

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const readyInput = (): CloudBuilderReadinessInput => ({
  Sandbox: methods("getByName"),
  APP_BUILD_SANDBOX: methods("getByName"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_TRANSFER_COORDINATORS: methods("getByName"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: methods("get", "put", "delete", "list"),
  APP_ROUTES: methods("get", "put", "delete", "list"),
  BACKUP_BUCKET: methods("get", "put", "delete", "list"),
  AGENT_HOME: methods("get", "put", "delete", "list"),
  CONVERSATION_ARCHIVE: methods("get", "put", "delete", "list"),
  LOADER: methods("get", "load"),
  BUILDER_SERVICE_SECRET: "must-never-appear-in-readiness-output",
  SANDBOX_TRANSPORT: "rpc",
  TURN_TIMEOUT_MS: "900000",
  SANDBOX_IDLE_TIMEOUT_MS: "600000",
  APPS_HOST_BASE_URL: "https://apps-untrusted.example",
  TRUSTED_APPS_HOST_BASE_URL: "https://apps-auth.example",
  STELLA_CONVEX_SITE_URL: "https://deployment.convex.site",
  STELLA_CONVEX_CLOUD_URL: "https://deployment.convex.cloud",
});

describe("Cloud Builder readiness evaluation", () => {
  test("accepts a fully configured environment", () => {
    expect(evaluateCloudBuilderReadiness(readyInput())).toEqual({
      ready: true,
      missing: [],
      invalid: [],
    });
  });

  test("returns every missing field by safe allowlisted name only", () => {
    const result = evaluateCloudBuilderReadiness({});
    expect(result).toEqual({
      ready: false,
      missing: [...CLOUD_BUILDER_REQUIRED_FIELDS],
      invalid: [],
    });
  });

  test("reports invalid bindings, timeouts, origins, and origin separation", () => {
    const input = readyInput();
    input.BROWSER_GATEWAY = {};
    input.TURN_TIMEOUT_MS = "NaN";
    input.SANDBOX_IDLE_TIMEOUT_MS = "0";
    input.APPS_HOST_BASE_URL = "https://same.example";
    input.TRUSTED_APPS_HOST_BASE_URL = "https://same.example/";
    input.STELLA_CONVEX_SITE_URL = "https://user:secret@example.com/path";
    const result = evaluateCloudBuilderReadiness(input);
    expect(result).toEqual({
      ready: false,
      missing: [],
      invalid: [
        "BROWSER_GATEWAY",
        "TURN_TIMEOUT_MS",
        "SANDBOX_IDLE_TIMEOUT_MS",
        "STELLA_CONVEX_SITE_URL",
        "APPS_HOST_BASE_URL",
        "TRUSTED_APPS_HOST_BASE_URL",
      ],
    });
  });

  test("never includes secret or invalid configuration contents", () => {
    const input = readyInput();
    input.BUILDER_SERVICE_SECRET = "invalid secret must not leak";
    input.STELLA_CONVEX_SITE_URL =
      "https://embedded-user:embedded-password@example.com/private-path?token=sensitive";
    const result = evaluateCloudBuilderReadiness(input);
    expect(result.invalid).toContain("BUILDER_SERVICE_SECRET");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("embedded-user");
    expect(serialized).not.toContain("embedded-password");
    expect(serialized).not.toContain("private-path");
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("invalid secret must not leak");
    expect(serialized).not.toContain("must-never-appear-in-readiness-output");
  });
});
