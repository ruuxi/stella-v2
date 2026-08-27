import { describe, expect, test } from "bun:test";
import {
  mayReusePendingOwnerLookup,
  normalizeOwnerGeneration,
  ownerGenerationMatches,
  ownerPurgeBeginDisposition,
  ownerPurgeReleaseDisposition,
} from "../src/owner-generation.js";

describe("owner lifecycle generation", () => {
  test("requires a bounded explicit generation on worker dispatch", () => {
    expect(normalizeOwnerGeneration(" generation-1 ")).toBe("generation-1");
    expect(normalizeOwnerGeneration(undefined)).toBeNull();
    expect(normalizeOwnerGeneration("   ")).toBeNull();
    expect(normalizeOwnerGeneration("x".repeat(513))).toBeNull();
  });

  test("rejects callback or lease replay under a different generation", () => {
    expect(ownerGenerationMatches("generation-1", "generation-1")).toBe(true);
    expect(ownerGenerationMatches("generation-2", "generation-1")).toBe(false);
    expect(ownerGenerationMatches(undefined, "generation-1")).toBe(false);
  });

  test("does not reuse an in-flight owner lookup for a new local admission", () => {
    expect(mayReusePendingOwnerLookup(false)).toBe(true);
    expect(mayReusePendingOwnerLookup(true)).toBe(false);
  });

  test("accepts an exact temporary-purge release replay", () => {
    expect(
      ownerPurgeReleaseDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-1",
        requestedGeneration: "purge-1",
        activeLeaseCount: 0,
      }),
    ).toBe("release");
    expect(
      ownerPurgeReleaseDisposition({
        state: "open",
        generation: "next-open-generation",
        lastReleasedGeneration: "purge-1",
        requestedGeneration: "purge-1",
        activeLeaseCount: 0,
      }),
    ).toBe("already-released");
  });

  test("does not let a release replay open a different or permanent purge", () => {
    expect(
      ownerPurgeReleaseDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-1",
        requestedGeneration: "purge-1",
        activeLeaseCount: 1,
      }),
    ).toBe("reject");
    expect(
      ownerPurgeReleaseDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-2",
        lastReleasedGeneration: "purge-1",
        requestedGeneration: "purge-1",
        activeLeaseCount: 0,
      }),
    ).toBe("reject");
    expect(
      ownerPurgeReleaseDisposition({
        state: "blocked",
        mode: "permanent",
        generation: "purge-1",
        requestedGeneration: "purge-1",
        activeLeaseCount: 0,
      }),
    ).toBe("reject");
  });

  test("rejoins exactly the last released generation with a temporary fence", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "open",
        generation: "open-2",
        lastReleasedGeneration: "purge-1",
        requestId: "operation-1",
        expectedGeneration: "purge-1",
        requestedMode: "permanent",
      }),
    ).toEqual({ action: "start", mode: "temporary", rejoined: true });
  });

  test("recovers the same replacement generation after a lost rejoin response", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-2",
        rejoinedFromGeneration: "purge-1",
        requestId: "operation-1",
        expectedGeneration: "purge-1",
        requestedMode: "temporary",
      }),
    ).toEqual({
      action: "resume",
      upgradeToPermanent: false,
      rejoined: true,
    });
  });

  test("requires an exact expected generation while a fence is blocked", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-2",
        beginRequestId: "operation-1",
        requestId: "different-operation",
        expectedGeneration: undefined,
        requestedMode: "temporary",
      }),
    ).toEqual({ action: "reject" });
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-2",
        requestId: "operation-1",
        expectedGeneration: "purge-other",
        requestedMode: "temporary",
      }),
    ).toEqual({ action: "reject" });
  });

  test("allows permanent deletion to upgrade an exact blocked generation", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-2",
        requestId: "operation-1",
        expectedGeneration: "purge-2",
        requestedMode: "permanent",
      }),
    ).toEqual({
      action: "resume",
      upgradeToPermanent: true,
      rejoined: false,
    });
  });

  test("recovers a lost initial begin only for the exact operation id", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "open",
        generation: "open-1",
        requestId: "operation-1",
        expectedGeneration: undefined,
        requestedMode: "temporary",
      }),
    ).toEqual({
      action: "start",
      mode: "temporary",
      rejoined: false,
    });
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-1",
        beginRequestId: "operation-1",
        requestId: "operation-1",
        expectedGeneration: undefined,
        requestedMode: "temporary",
      }),
    ).toEqual({
      action: "resume",
      upgradeToPermanent: false,
      rejoined: false,
    });
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-1",
        beginRequestId: "operation-1",
        requestId: "operation-2",
        expectedGeneration: undefined,
        requestedMode: "temporary",
      }),
    ).toEqual({ action: "reject" });
  });

  test("lets the same initial operation monotonically upgrade to permanent", () => {
    expect(
      ownerPurgeBeginDisposition({
        state: "blocked",
        mode: "temporary",
        generation: "purge-1",
        beginRequestId: "operation-1",
        requestId: "operation-1",
        expectedGeneration: undefined,
        requestedMode: "permanent",
      }),
    ).toEqual({
      action: "resume",
      upgradeToPermanent: true,
      rejoined: false,
    });
  });
});
