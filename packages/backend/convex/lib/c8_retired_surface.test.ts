import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  C8_DEV_CLOUD_URL,
  C8_DEV_SITE_URL,
  assertC8CleanupDeployment,
  assertC8RetiredSurfaceUnavailable,
  getC8WriterCutoverStatus,
} from "./c8_retired_surface";

const exactEnv = () => ({
  CONVEX_CLOUD_URL: C8_DEV_CLOUD_URL,
  CONVEX_SITE_URL: C8_DEV_SITE_URL,
  STELLA_C8_RETIRED_WRITES_DISABLED: "1",
});

describe("c8 Phase-1 authority", () => {
  test("accepts only the exact dev deployment and armed writer marker", () => {
    assert.doesNotThrow(() => assertC8CleanupDeployment(exactEnv()));
    assert.deepEqual(getC8WriterCutoverStatus(exactEnv()), {
      cloudUrlMatches: true,
      siteUrlMatches: true,
      retiredWritesDisabled: true,
    });
  });

  test("rejects absent, mixed, and noncanonical deployment authority", () => {
    for (const env of [
      {},
      { ...exactEnv(), STELLA_C8_RETIRED_WRITES_DISABLED: "0" },
      {
        ...exactEnv(),
        CONVEX_CLOUD_URL: "https://flexible-panther-999.convex.cloud",
      },
      { ...exactEnv(), CONVEX_CLOUD_URL: `${C8_DEV_CLOUD_URL}/` },
      { ...exactEnv(), CONVEX_SITE_URL: `${C8_DEV_SITE_URL}/` },
    ]) {
      assert.throws(() => assertC8CleanupDeployment(env));
    }
  });

  test("retired writers activate only for the explicit dev marker", () => {
    assert.doesNotThrow(() => assertC8RetiredSurfaceUnavailable("Store", {}));
    assert.throws(() =>
      assertC8RetiredSurfaceUnavailable("Store", {
        ...exactEnv(),
        CONVEX_CLOUD_URL: "https://benevolent-panda-1.convex.cloud",
      }),
    );
    assert.throws(() =>
      assertC8RetiredSurfaceUnavailable("Store", {
        ...exactEnv(),
        CONVEX_SITE_URL: "https://benevolent-panda-1.convex.site",
      }),
    );
    assert.throws(
      () =>
        assertC8RetiredSurfaceUnavailable("Store", {
          ...exactEnv(),
          STELLA_C8_RETIRED_WRITES_DISABLED: "0",
        }),
      /invalid c8 cutover marker/u,
    );
    assert.throws(
      () => assertC8RetiredSurfaceUnavailable("Store", exactEnv()),
      /retired and unavailable/u,
    );
  });
});
