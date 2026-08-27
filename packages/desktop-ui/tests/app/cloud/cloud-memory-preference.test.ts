import { describe, expect, it, vi } from "vitest";
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
import type { CloudMemoryPreference } from "@/features/cloud/cloud-home-api";

const subjectA = "https://stella.example|owner-a";

const preference = (
  overrides: Partial<CloudMemoryPreference> = {},
): CloudMemoryPreference => ({
  ownerGeneration: "generation-a:1",
  memoryEnabled: true,
  revision: 7,
  updatedAt: 1_000,
  ...overrides,
});

const envelope = (
  overrides: Partial<CloudMemoryPreference & { subject: string }> = {},
) => ({
  subject: subjectA,
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
      read: vi.fn(),
      write: async (input) => {
        writes.push(input);
        return envelope({ memoryEnabled: false, revision: 8 });
      },
    });
    const writeAttempt = attempt();
    const expectedInput = {
      expectedSubject: subjectA,
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
  });

  it("passes only the immutable expected subject to the authoritative read", async () => {
    const read = vi.fn(async () => envelope());
    const client = createCloudMemoryPreferenceClient({
      read,
      write: vi.fn(),
    });
    const fence = createCloudMemoryPreferenceRequestFence({
      accountScope: "account:owner-a",
      identityRevision: 4,
      expectedSubject: subjectA,
      createEntropy: () => "read-a",
    });

    await expect(client.read(fence)).resolves.toEqual({
      fence,
      preference: preference(),
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      expectedSubject: subjectA,
    });
  });

  it.each([
    ["subject", { subject: "https://stella.example|owner-b" }],
    ["owner generation", { ownerGeneration: "generation-a:2" }],
    ["value", { memoryEnabled: true }],
    ["revision", { revision: 9 }],
  ])("rejects a committed response with the wrong %s", async (_name, patch) => {
    const client = createCloudMemoryPreferenceClient({
      read: vi.fn(),
      write: async () =>
        envelope({ memoryEnabled: false, revision: 8, ...patch }),
    });

    await expect(client.write(attempt())).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it("normalizes a revision conflict without treating its partial head as authority", async () => {
    const error = Object.assign(new Error("conflict"), {
      data: {
        code: "CLOUD_HOME_REVISION_CONFLICT",
        currentRevision: 9,
        currentMemoryEnabled: false,
      },
    });
    const client = createCloudMemoryPreferenceClient({
      read: vi.fn(),
      write: async () => {
        throw error;
      },
    });

    await expect(client.write(attempt())).resolves.toEqual({
      status: "conflict",
      fence: attempt(),
      current: { revision: 9, memoryEnabled: false },
    });
    expect(normalizeCloudMemoryPreferenceIssue(error)).toEqual({
      code: "revision_conflict",
      retryable: false,
      current: { revision: 9, memoryEnabled: false },
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
