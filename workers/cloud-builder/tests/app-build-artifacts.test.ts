import { describe, expect, test } from "bun:test";
import {
  appBuildCallbackDisposition,
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
  ownerAppBuildRoot,
  retireTransientAppBuild,
} from "../src/app-build-artifacts.js";

const OWNER_HASH = "a".repeat(64);
const OTHER_OWNER_HASH = "b".repeat(64);

describe("app-build artifact ownership", () => {
  test("derives an owner-addressable prefix and rejects cross-owner reuse", () => {
    const prefix = ownerAppBuildPrefix(OWNER_HASH, "build_123");
    expect(prefix).toBe(`builds/${OWNER_HASH}/build_123`);
    expect(isOwnerAppBuildPrefix(prefix, OWNER_HASH)).toBe(true);
    expect(isOwnerAppBuildPrefix(prefix, OTHER_OWNER_HASH)).toBe(false);
    expect(() => ownerAppBuildPrefix("not-a-hash", "build_123")).toThrow(
      /owner hash/i,
    );
    expect(() => ownerAppBuildPrefix(OWNER_HASH, "../build")).toThrow(
      /build id/i,
    );
  });

  test("keeps a callback-lost build for exact replay", () => {
    expect(appBuildCallbackDisposition()).toBe("retry");
    expect(appBuildCallbackDisposition(500)).toBe("retry");
    expect(appBuildCallbackDisposition(429)).toBe("retry");
    // The same persisted callback body can be replayed; a successful replay
    // is the point where the transient recovery record becomes durable data.
    expect(appBuildCallbackDisposition(200)).toBe("accepted");
  });

  test("sweeps a definite callback failure before clearing recovery", async () => {
    const order: string[] = [];
    const retired = await retireTransientAppBuild({
      sweep: async () => {
        order.push("sweep-all-uploaded-objects");
        return { done: true };
      },
      clearRecovery: async () => {
        order.push("clear-transient-marker");
      },
    });
    expect(retired).toBe(true);
    expect(order).toEqual([
      "sweep-all-uploaded-objects",
      "clear-transient-marker",
    ]);
    expect(appBuildCallbackDisposition(409)).toBe("cleanup");
  });

  test("retains recovery when a partial sweep must be replayed", async () => {
    let markerPresent = true;
    const retired = await retireTransientAppBuild({
      sweep: async () => ({ done: false }),
      clearRecovery: async () => {
        markerPresent = false;
      },
    });
    expect(retired).toBe(false);
    expect(markerPresent).toBe(true);
  });

  test("owner purge root includes callback-less crash orphans", () => {
    const ownerRoot = `${ownerAppBuildRoot(OWNER_HASH)}/`;
    const objects = [
      `${ownerRoot}committed/index.html`,
      `${ownerRoot}callback-lost/assets/app.js`,
      `${ownerAppBuildRoot(OTHER_OWNER_HASH)}/other/index.html`,
    ];
    expect(objects.filter((key) => key.startsWith(ownerRoot))).toEqual([
      `${ownerRoot}committed/index.html`,
      `${ownerRoot}callback-lost/assets/app.js`,
    ]);
  });
});
