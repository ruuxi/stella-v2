import { describe, expect, it, vi } from "vitest";
import { BackendRequestError } from "@stella/contracts/backend/client";
import type { MemoryWipeStatus } from "@stella/contracts/backend/home";
import {
  CloudMemoryWipeError,
  beginCloudMemoryWipe,
  cloudMemoryWipeMutationInput,
  createCloudMemoryWipeClient,
  createCloudMemoryWipeRequestFence,
  decodeCloudMemoryWipeStatus,
  isCloudMemoryWipeComplete,
  isCloudMemoryWipeRequestCurrent,
  normalizeCloudMemoryWipeError,
} from "@/features/cloud/cloud-memory-wipe";

const ownerSubject = "https://stella.example|owner-a";
const identity = {
  accountScope: "account:owner-a",
  identityRevision: 7,
  ownerSubject,
};

const activeStatus = (
  overrides: Partial<MemoryWipeStatus> = {},
): MemoryWipeStatus => ({
  subject: ownerSubject,
  ownerGeneration: "generation-1",
  state: "wiping",
  memoryEpoch: "epoch-1",
  importDisposition: "automatic_allowed",
  job: {
    operationId: "memorywipe-operation-1",
    stage: "metadata",
    attempts: 1,
    nextRetryAt: 100,
    objectsDeleted: 4,
    rowsDeleted: 2,
    updatedAt: 90,
  },
  ...overrides,
});

const readyStatus = (
  overrides: Partial<MemoryWipeStatus> = {},
): MemoryWipeStatus => ({
  subject: ownerSubject,
  ownerGeneration: "generation-1",
  state: "open",
  memoryEpoch: "epoch-1",
  importDisposition: "automatic_allowed",
  job: null,
  ...overrides,
});

const completedStatus = (): MemoryWipeStatus => ({
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
    objectsDeleted: 6,
    rowsDeleted: 3,
    completedAt: 200,
    updatedAt: 200,
  },
});

const refusal = (
  code: "CONFLICT" | "UNAUTHENTICATED",
  reason?: string,
): BackendRequestError =>
  new BackendRequestError({
    code,
    message: "refused",
    retryable: false,
    ...(reason ? { reason } : {}),
  });

describe("cloud Memory wipe contract", () => {
  it("strictly decodes the subject, lifecycle, epoch, and job receipt", () => {
    expect(decodeCloudMemoryWipeStatus(activeStatus(), ownerSubject)).toEqual(
      activeStatus(),
    );
    expect(isCloudMemoryWipeComplete(activeStatus())).toBe(false);
    expect(isCloudMemoryWipeComplete(completedStatus())).toBe(true);

    expect(() =>
      decodeCloudMemoryWipeStatus(
        { ...activeStatus(), subject: "https://stella.example|owner-b" },
        ownerSubject,
      ),
    ).toThrow(CloudMemoryWipeError);
    expect(() =>
      decodeCloudMemoryWipeStatus(
        { ...activeStatus(), unexpected: true },
        ownerSubject,
      ),
    ).toThrow(CloudMemoryWipeError);
    expect(() =>
      decodeCloudMemoryWipeStatus(
        {
          ...activeStatus(),
          job: { ...activeStatus().job!, completedAt: 100 },
        },
        ownerSubject,
      ),
    ).toThrow(CloudMemoryWipeError);
    expect(() =>
      decodeCloudMemoryWipeStatus(
        {
          ...completedStatus(),
          state: "wiping",
        },
        ownerSubject,
      ),
    ).toThrow(CloudMemoryWipeError);
    expect(() =>
      decodeCloudMemoryWipeStatus(
        {
          ...completedStatus(),
          job: { ...completedStatus().job!, completedAt: undefined },
        },
        ownerSubject,
      ),
    ).toThrow(CloudMemoryWipeError);
  });

  it("freezes one identity-fenced request id and the exact generation/epoch head", () => {
    const attempt = beginCloudMemoryWipe({
      identity,
      status: readyStatus({
        job: {
          ...completedStatus().job!,
          operationId: "memorywipe-previous",
        },
      }),
      createEntropy: () => "stable-attempt",
    });

    expect(Object.isFrozen(attempt)).toBe(true);
    expect(attempt).toMatchObject({
      accountScope: "account:owner-a",
      identityRevision: 7,
      ownerSubject,
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "epoch-1",
      previousOperationId: "memorywipe-previous",
      requestId: "desktop-memory-wipe:stable-attempt",
    });
    expect(cloudMemoryWipeMutationInput(attempt)).toEqual({
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "epoch-1",
      requestId: "desktop-memory-wipe:stable-attempt",
    });
  });

  it("reuses the exact start payload for an ambiguous retry", async () => {
    const start = vi.fn().mockResolvedValue(activeStatus());
    const client = createCloudMemoryWipeClient({ start });
    const attempt = beginCloudMemoryWipe({
      identity,
      status: readyStatus(),
      createEntropy: () => "one-request",
    });

    await client.start(attempt);
    await client.start(attempt);

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0]).toEqual(start.mock.calls[1]?.[0]);
    expect(start.mock.calls[0]?.[0].requestId).toBe(
      "desktop-memory-wipe:one-request",
    );
  });

  it("starts a fresh owner's wipe from the empty generation and accepts the stamped one", async () => {
    const fresh = readyStatus({ ownerGeneration: "" });
    expect(decodeCloudMemoryWipeStatus(fresh, ownerSubject)).toEqual(fresh);
    const attempt = beginCloudMemoryWipe({ identity, status: fresh });
    expect(cloudMemoryWipeMutationInput(attempt).expectedOwnerGeneration).toBe(
      "",
    );

    const stamped = createCloudMemoryWipeClient({
      start: vi.fn().mockResolvedValue(activeStatus()),
    });
    await expect(stamped.start(attempt)).resolves.toMatchObject({
      status: { ownerGeneration: "generation-1", state: "wiping" },
    });
    const unstamped = createCloudMemoryWipeClient({
      start: vi.fn().mockResolvedValue(activeStatus({ ownerGeneration: "" })),
    });
    await expect(unstamped.start(attempt)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("fails closed on echoed generation, epoch, or operation drift", async () => {
    const attempt = beginCloudMemoryWipe({
      identity,
      status: readyStatus({
        job: {
          ...completedStatus().job!,
          operationId: "memorywipe-old",
        },
      }),
      createEntropy: () => "fenced",
    });
    const cases = [
      activeStatus({ ownerGeneration: "generation-2" }),
      activeStatus({ memoryEpoch: "epoch-other" }),
      activeStatus({
        job: {
          ...activeStatus().job!,
          operationId: "memorywipe-old",
        },
      }),
      {
        ...completedStatus(),
        memoryEpoch: attempt.expectedMemoryEpoch,
      },
    ];

    for (const response of cases) {
      const client = createCloudMemoryWipeClient({
        start: vi.fn().mockResolvedValue(response),
      });
      await expect(client.start(attempt)).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("requires the full account, identity revision, subject, and request fence", () => {
    const fence = createCloudMemoryWipeRequestFence({
      ...identity,
      createEntropy: () => "read-1",
    });
    expect(
      isCloudMemoryWipeRequestCurrent(fence, {
        ...identity,
        requestId: fence.requestId,
      }),
    ).toBe(true);
    expect(
      isCloudMemoryWipeRequestCurrent(fence, {
        ...identity,
        identityRevision: 8,
        requestId: fence.requestId,
      }),
    ).toBe(false);
    expect(
      isCloudMemoryWipeRequestCurrent(fence, {
        ...identity,
        ownerSubject: "https://stella.example|owner-b",
        requestId: fence.requestId,
      }),
    ).toBe(false);
  });

  it("separates retryable transport loss from lifecycle and identity conflicts", () => {
    expect(normalizeCloudMemoryWipeError(new Error("offline"))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(
      normalizeCloudMemoryWipeError(
        refusal("CONFLICT", "CLOUD_MEMORY_EPOCH_STALE"),
      ),
    ).toMatchObject({ code: "stale_epoch", retryable: false });
    expect(
      normalizeCloudMemoryWipeError(
        refusal("CONFLICT", "owner_generation_stale"),
      ),
    ).toMatchObject({
      code: "owner_generation_changed",
      retryable: false,
    });
    expect(
      normalizeCloudMemoryWipeError(refusal("UNAUTHENTICATED")),
    ).toMatchObject({ code: "unauthorized", retryable: false });
  });
});
