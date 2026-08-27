import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEV_APPS_HOST_ORIGIN } from "../lib/dev_apps_host_origin";
import { buildCorsAllowedOrigins } from "./cors";

const validDevEnv = () => ({
  STELLA_DEPLOYMENT_IDENTITY: "dev:impartial-crab-34",
  CONVEX_SITE_URL: "https://impartial-crab-34.convex.site",
  CONVEX_CLOUD_URL: "https://impartial-crab-34.convex.cloud",
  APPS_HOST_ORIGIN: DEV_APPS_HOST_ORIGIN,
});

describe("Apps host CORS authority", () => {
  test("adds the Apps host only for the exact development contract", () => {
    assert.equal(
      buildCorsAllowedOrigins(validDevEnv()).has(DEV_APPS_HOST_ORIGIN),
      true,
    );
  });

  test("does not let generic origin configuration bypass the identity gate", () => {
    for (const env of [
      { SITE_URL: DEV_APPS_HOST_ORIGIN },
      { CORS_ALLOWED_ORIGINS: DEV_APPS_HOST_ORIGIN },
      { CORS_ALLOWED_ORIGINS: `${DEV_APPS_HOST_ORIGIN}/` },
      {
        ...validDevEnv(),
        STELLA_DEPLOYMENT_IDENTITY: "dev:flexible-panther-999",
        SITE_URL: DEV_APPS_HOST_ORIGIN,
        CORS_ALLOWED_ORIGINS: DEV_APPS_HOST_ORIGIN,
      },
    ]) {
      assert.equal(
        buildCorsAllowedOrigins(env).has(DEV_APPS_HOST_ORIGIN),
        false,
      );
    }
  });

  test("preserves unrelated configured origins", () => {
    const origins = buildCorsAllowedOrigins({
      SITE_URL: "https://stella.sh",
      CORS_ALLOWED_ORIGINS: "https://preview.example, http://localhost:4321",
    });
    assert.equal(origins.has("https://preview.example"), true);
    assert.equal(origins.has("http://localhost:4321"), true);
  });
});
