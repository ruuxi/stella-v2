import { describe, expect, test } from "vitest";
import {
  LOCAL_CACHE_RETRY_MAX_ATTEMPTS,
  localCacheRetryDelayMs,
} from "../../../src/features/chat/hooks/local-cache-retry";

describe("cloud UI resilience boundaries", () => {
  test("backs rebuildable local-cache reads off exponentially and then stops", () => {
    expect(
      Array.from({ length: LOCAL_CACHE_RETRY_MAX_ATTEMPTS + 1 }, (_, attempt) =>
        localCacheRetryDelayMs(attempt),
      ),
    ).toEqual([300, 600, 1_200, 2_400, 4_800, null]);
  });
});
