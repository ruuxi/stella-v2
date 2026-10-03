import { describe, expect, it } from "vitest";
import { BackendRequestError } from "@stella/contracts/backend/client";
import type { MemoryPreference } from "@stella/contracts/backend/home";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import {
  CloudMemoryPreferenceError,
  beginCloudMemoryPreferenceWrite,
  cloudMemoryPreferenceMutationInput,
  createCloudMemoryPreferenceClient,
  createCloudMemoryPreferenceRequestFence,
  decodeCloudMemoryPreferenceForSubject,
  isCloudMemoryPreferenceRequestCurrent,
  normalizeCloudMemoryPreferenceIssue,
} from "@/features/cloud/cloud-memory-preference";

const subjectA = "https://stella.example|owner-a";

const preference = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  ownerGeneration: "generation-a:1",
  memoryEpoch: "epoch-a:1",
  memoryEnabled: true,
  revision: 7,
  updatedAt: 1_000,
  ...overrides,
});

const envelope = (
  overrides: Partial<MemoryPreference> = {},
): MemoryPreference => ({
  subject: subjectA,
  state: "open",
  importDisposition: "automatic_allowed",
  ...preference(),
  ...overrides,
});

const attempt = () =>
  beginCloudMemoryPreferenceWrite({
    accountScope: "account:owner-a",
    identityRevision: 4,
    expectedSubject: subjectA,
    preference: preference(),
    memoryEnabled: false,
    createEntropy: () => "request-a",
  });

describe("cloud Memory preference protocol", () => {
  it("accepts only the exact subject-fenced preference envelope", () => {
    expect(decodeCloudMemoryPreferenceForSubject(envelope(), subjectA)).toEqual(
      preference(),
    );

    for (const invalid of [
      envelope({ subject: "https://stella.example|owner-b" }),
      { ...envelope(), extra: true },
      { subject: subjectA, preference: preference() },
    ]) {
      expect(() =>
        decodeCloudMemoryPreferenceForSubject(invalid, subjectA),
      ).toThrowError(
        expect.objectContaining<Partial<CloudMemoryPreferenceError>>({
          code: "invalid_response",
          retryable: false,
        }),
      );
    }
  });

  it("builds an immutable exact-CAS input and preserves it for replay", async () => {
    const writes: unknown[] = [];
    const client = createCloudMemoryPreferenceClient({
      write: async (input) => {
        writes.push(input);
        return envelope({ memoryEnabled: false, revision: 8 });
      },
    });
    const writeAttempt = attempt();
    const expectedInput = {
      memoryEnabled: false,
      expectedOwnerGeneration: "generation-a:1",
      expectedRevision: 7,
      requestId: "desktop-memory:request-a",
    };

    expect(Object.isFrozen(writeAttempt)).toBe(true);
    expect(cloudMemoryPreferenceMutationInput(writeAttempt)).toEqual(
      expectedInput,
    );
    await client.write(writeAttempt);
    await client.write(writeAttempt);

    expect(writes).toEqual([expectedInput, expectedInput]);

    // A fresh owner's view reports "" until the first write stamps a
    // generation; the attempt passes "" through and accepts the stamp.
    expect(
      decodeCloudMemoryPreferenceForSubject(
        envelope({ ownerGeneration: "" }),
        subjectA,
      ),
    ).toEqual(preference({ ownerGeneration: "" }));
    const freshAttempt = beginCloudMemoryPreferenceWrite({
      accountScope: "account:owner-a",
      identityRevision: 4,
      expectedSubject: subjectA,
      preference: preference({ ownerGeneration: "", revision: 0 }),
      memoryEnabled: false,
      createEntropy: () => "request-fresh",
    });
    expect(cloudMemoryPreferenceMutationInput(freshAttempt)).toMatchObject({
      expectedOwnerGeneration: "",
    });
    const stamped = createCloudMemoryPreferenceClient({
      write: async () => envelope({ memoryEnabled: false, revision: 1 }),
    });
    await expect(stamped.write(freshAttempt)).resolves.toMatchObject({
      status: "committed",
      preference: { ownerGeneration: "generation-a:1" },
    });
    const unstamped = createCloudMemoryPreferenceClient({
      write: async () =>
        envelope({ ownerGeneration: "", memoryEnabled: false, revision: 1 }),
    });
    await expect(unstamped.write(freshAttempt)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    ["subject", { subject: "https://stella.example|owner-b" }],
    ["owner generation", { ownerGeneration: "generation-a:2" }],
    ["value", { memoryEnabled: true }],
    ["revision", { revision: 9 }],
  ])("rejects a committed response with the wrong %s", async (_name, patch) => {
    const client = createCloudMemoryPreferenceClient({
      write: async () =>
        envelope({ memoryEnabled: false, revision: 8, ...patch }),
    });

    await expect(client.write(attempt())).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it("returns a revision conflict for the live view to resolve", async () => {
    const error = new BackendRequestError({
      code: "CONFLICT",
      message: "conflict",
      retryable: false,
      reason: "CLOUD_HOME_REVISION_CONFLICT",
    });
    const client = createCloudMemoryPreferenceClient({
      write: async () => {
        throw error;
      },
    });

    await expect(client.write(attempt())).resolves.toEqual({
      status: "conflict",
      fence: attempt(),
    });
    expect(normalizeCloudMemoryPreferenceIssue(error)).toEqual({
      code: "revision_conflict",
      retryable: false,
    });
  });

  it("rejects account, session, subject, and request changes in a request fence", () => {
    const fence = createCloudMemoryPreferenceRequestFence({
      accountScope: "account:owner-a",
      identityRevision: 4,
      expectedSubject: subjectA,
      createEntropy: () => "fence-a",
    });
    const current = {
      accountScope: fence.accountScope,
      identityRevision: fence.identityRevision,
      expectedSubject: fence.expectedSubject,
      requestId: fence.requestId,
    };

    expect(isCloudMemoryPreferenceRequestCurrent(fence, current)).toBe(true);
    expect(
      isCloudMemoryPreferenceRequestCurrent(fence, {
        ...current,
        accountScope: "account:owner-b",
      }),
    ).toBe(false);
    expect(
      isCloudMemoryPreferenceRequestCurrent(fence, {
        ...current,
        identityRevision: 5,
      }),
    ).toBe(false);
    expect(
      isCloudMemoryPreferenceRequestCurrent(fence, {
        ...current,
        expectedSubject: "https://stella.example|owner-b",
      }),
    ).toBe(false);
    expect(
      isCloudMemoryPreferenceRequestCurrent(fence, {
        ...current,
        requestId: "desktop-memory:fence-b",
      }),
    ).toBe(false);
  });
});
