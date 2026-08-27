import { describe, expect, it, vi } from "vitest";
import type { CloudMemoryWipeStatus } from "@/features/cloud/cloud-home-api";
import {
  beginCloudMemoryReimport,
  CloudMemoryReimportError,
  cloudMemoryReimportMutationInput,
  createCloudMemoryReimportClient,
  createCloudMemoryReimportRequestFence,
  isCloudMemoryReimportRequestCurrent,
  normalizeCloudMemoryReimportError,
} from "@/features/cloud/cloud-memory-reimport";

const ownerSubject = "https://stella.example|owner-a";
const identity = {
  accountScope: "account:owner-a",
  identityRevision: 7,
  ownerSubject,
};

const status = (
  overrides: Partial<CloudMemoryWipeStatus> = {},
): CloudMemoryWipeStatus => ({
  subject: ownerSubject,
  ownerGeneration: "generation-1",
  state: "open",
  memoryEpoch: "epoch-2",
  importDisposition: "explicit_required",
  lastWipedEpoch: "epoch-1",
  job: {
    operationId: "memorywipe-operation-1",
    stage: "completed",
    attempts: 1,
    nextRetryAt: 200,
    objectsDeleted: 4,
    rowsDeleted: 2,
    completedAt: 200,
    updatedAt: 200,
  },
  ...overrides,
});

describe("cloud Memory reimport authorization contract", () => {
  it("freezes the exact subject, account, revision, generation, epoch, and request fence", () => {
    const attempt = beginCloudMemoryReimport({
      identity,
      status: status(),
      createEntropy: () => "stable-attempt",
    });

    expect(Object.isFrozen(attempt)).toBe(true);
    expect(attempt).toEqual({
      accountScope: "account:owner-a",
      identityRevision: 7,
      ownerSubject,
      expectedSubject: ownerSubject,
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "epoch-2",
      requestId: "desktop-memory-reimport:stable-attempt",
    });
    expect(cloudMemoryReimportMutationInput(attempt)).toEqual({
      expectedSubject: ownerSubject,
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "epoch-2",
      requestId: "desktop-memory-reimport:stable-attempt",
    });
  });

  it("only begins from an open epoch that explicitly requires authorization", () => {
    expect(() =>
      beginCloudMemoryReimport({
        identity,
        status: status({ importDisposition: "explicit_allowed" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "not_required" }));
    expect(() =>
      beginCloudMemoryReimport({
        identity,
        status: status({
          state: "wiping",
          importDisposition: "explicit_required",
          job: {
            ...status().job!,
            stage: "sweeping",
            completedAt: undefined,
          },
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "active" }));
  });

  it("reuses the exact idempotent mutation payload on an ambiguous retry", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValue(status({ importDisposition: "explicit_allowed" }));
    const client = createCloudMemoryReimportClient({
      read: vi.fn().mockResolvedValue(status()),
      authorize,
    });
    const attempt = beginCloudMemoryReimport({
      identity,
      status: status(),
      createEntropy: () => "one-request",
    });

    await client.authorize(attempt);
    await client.authorize(attempt);

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[0]?.[0]).toEqual(authorize.mock.calls[1]?.[0]);
    expect(authorize.mock.calls[0]?.[0].requestId).toBe(
      "desktop-memory-reimport:one-request",
    );
  });

  it("fails closed unless the mutation echoes the exact subject, generation, epoch, and allowed result", async () => {
    const attempt = beginCloudMemoryReimport({ identity, status: status() });
    const cases: Array<{
      response: CloudMemoryWipeStatus;
      code: string;
    }> = [
      {
        response: status({
          subject: "https://stella.example|owner-b",
          importDisposition: "explicit_allowed",
        }),
        code: "invalid_response",
      },
      {
        response: status({
          ownerGeneration: "generation-2",
          importDisposition: "explicit_allowed",
        }),
        code: "owner_generation_changed",
      },
      {
        response: status({
          memoryEpoch: "epoch-3",
          importDisposition: "explicit_allowed",
        }),
        code: "stale_epoch",
      },
      { response: status(), code: "invalid_response" },
    ];

    for (const testCase of cases) {
      const client = createCloudMemoryReimportClient({
        read: vi.fn(),
        authorize: vi.fn().mockResolvedValue(testCase.response),
      });
      await expect(client.authorize(attempt)).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });

  it("requires the full account, identity revision, subject, and request id to remain current", () => {
    const fence = createCloudMemoryReimportRequestFence({
      ...identity,
      createEntropy: () => "read-1",
    });
    expect(
      isCloudMemoryReimportRequestCurrent(fence, {
        ...identity,
        requestId: fence.requestId,
      }),
    ).toBe(true);
    expect(
      isCloudMemoryReimportRequestCurrent(fence, {
        ...identity,
        identityRevision: 8,
        requestId: fence.requestId,
      }),
    ).toBe(false);
    expect(
      isCloudMemoryReimportRequestCurrent(fence, {
        ...identity,
        ownerSubject: "https://stella.example|owner-b",
        requestId: fence.requestId,
      }),
    ).toBe(false);
    expect(
      isCloudMemoryReimportRequestCurrent(fence, {
        ...identity,
        requestId: "desktop-memory-reimport:other",
      }),
    ).toBe(false);
  });

  it("separates an ambiguous transport loss from deterministic lifecycle failures", () => {
    expect(
      normalizeCloudMemoryReimportError(new Error("offline")),
    ).toMatchObject({ code: "unavailable", retryable: true });
    expect(
      normalizeCloudMemoryReimportError({
        data: { code: "CLOUD_MEMORY_REIMPORT_NOT_REQUIRED" },
      }),
    ).toMatchObject({ code: "not_required", retryable: false });
    expect(
      normalizeCloudMemoryReimportError({
        data: { code: "CLOUD_MEMORY_EPOCH_STALE" },
      }),
    ).toMatchObject({ code: "stale_epoch", retryable: false });
    expect(
      normalizeCloudMemoryReimportError({
        data: { code: "SESSION_IDENTITY_MISMATCH" },
      }),
    ).toMatchObject({ code: "unauthorized", retryable: false });
    expect(new CloudMemoryReimportError("invalid_response").retryable).toBe(
      false,
    );
  });
});
