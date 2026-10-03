import { describe, expect, test } from "bun:test";
import { BackendRequestError } from "@stella/contracts/backend/client";
import {
  observeCloudConversationIdentity,
  resetCloudConversationIdentityForTests,
} from "../cloud-conversation-auth";
import {
  MobileCloudMemoryPreferenceError,
  acceptCurrentMobileCloudMemoryPreferenceResult,
  beginMobileCloudMemoryPreferenceWrite,
  createMobileCloudMemoryOwnerSubject,
  createMobileCloudMemoryPreferenceClient,
  createMobileCloudMemoryPreferenceRequestFence,
  decodeMobileCloudMemoryPreference,
  decodeMobileCloudMemoryPreferenceForSubject,
  isMobileCloudMemoryPreferenceRequestCurrent,
  normalizeMobileCloudMemoryPreferenceIssue,
  type MobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceMutationInput,
} from "../cloud-memory-preference";

const preference: MobileCloudMemoryPreference = {
  ownerGeneration: "generation:7",
  memoryEnabled: true,
  revision: 4,
  updatedAt: 1_754_000_000_000,
};

const ownerSubjectA = "https://issuer.test|user-a";
const identityA = {
  accountScope: "account:user-a",
  identityKey: "account:user-a:session:session-a",
  identityRevision: 7,
  expectedSubject: ownerSubjectA,
} as const;

const sessionPreference = (
  value: MobileCloudMemoryPreference = preference,
  subject = ownerSubjectA,
) => ({
  subject,
  memoryEpoch: "epoch:3",
  state: "open",
  importDisposition: "automatic_allowed",
  ...value,
});

const refusal = (
  code: "CONFLICT" | "UNAUTHENTICATED" | "UNAVAILABLE",
  reason?: string,
) =>
  new BackendRequestError({
    code,
    message: "refused",
    retryable: code === "UNAVAILABLE",
    ...(reason ? { reason } : {}),
  });

const attempt = () =>
  beginMobileCloudMemoryPreferenceWrite({
    ...identityA,
    preference,
    memoryEnabled: false,
    createEntropy: () => "attempt-1",
  });

describe("mobile cloud memory preference adapter", () => {
  test("strictly decodes the exact authoritative projection", () => {
    expect(decodeMobileCloudMemoryPreference({ ...preference })).toEqual(
      preference,
    );

    const invalid: unknown[] = [
      null,
      { ...preference, extra: true },
      { ...preference, ownerGeneration: " generation:7" },
      { ...preference, ownerGeneration: "bad/generation" },
      { ...preference, memoryEnabled: 1 },
      { ...preference, revision: -1 },
      { ...preference, revision: 1.5 },
      { ...preference, updatedAt: Number.MAX_SAFE_INTEGER },
    ];

    for (const value of invalid) {
      expect(() => decodeMobileCloudMemoryPreference(value)).toThrow(
        MobileCloudMemoryPreferenceError,
      );
    }

    expect(
      createMobileCloudMemoryOwnerSubject("https://issuer.test", "user-a"),
    ).toBe(ownerSubjectA);
    expect(
      decodeMobileCloudMemoryPreferenceForSubject(
        sessionPreference(),
        ownerSubjectA,
      ),
    ).toEqual(preference);
    for (const value of [
      preference,
      sessionPreference(preference, "https://issuer.test|user-b"),
      { ...sessionPreference(), extra: true },
    ]) {
      expect(() =>
        decodeMobileCloudMemoryPreferenceForSubject(value, ownerSubjectA),
      ).toThrow(MobileCloudMemoryPreferenceError);
    }
  });

  test("captures one stable id and sends only the frozen CAS contract", async () => {
    let entropyCalls = 0;
    const writeAttempt = beginMobileCloudMemoryPreferenceWrite({
      ...identityA,
      preference,
      memoryEnabled: false,
      createEntropy: () => {
        entropyCalls += 1;
        return "attempt-stable";
      },
    });
    const inputs: MobileCloudMemoryPreferenceMutationInput[] = [];
    const client = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async (input) => {
        inputs.push(input);
        return sessionPreference({
          ...preference,
          memoryEnabled: false,
          revision: 5,
        });
      },
    });

    const first = await client.write(writeAttempt);
    const retried = await client.write(writeAttempt);

    expect(entropyCalls).toBe(1);
    expect(Object.isFrozen(writeAttempt)).toBe(true);
    expect(writeAttempt.requestId).toBe("mobile-memory:attempt-stable");
    expect(inputs).toEqual([
      {
        memoryEnabled: false,
        expectedOwnerGeneration: "generation:7",
        expectedRevision: 4,
        requestId: "mobile-memory:attempt-stable",
      },
      {
        memoryEnabled: false,
        expectedOwnerGeneration: "generation:7",
        expectedRevision: 4,
        requestId: "mobile-memory:attempt-stable",
      },
    ]);
    expect(first.status).toBe("committed");
    expect(retried.status).toBe("committed");
    expect(first.fence).toBe(writeAttempt);

    // A fresh owner's view reports "" until the first write stamps a
    // generation; the attempt passes "" through and accepts the stamp.
    const fresh = { ...preference, ownerGeneration: "", revision: 0 };
    expect(
      decodeMobileCloudMemoryPreferenceForSubject(
        sessionPreference(fresh),
        ownerSubjectA,
      ),
    ).toEqual(fresh);
    const freshAttempt = beginMobileCloudMemoryPreferenceWrite({
      ...identityA,
      preference: fresh,
      memoryEnabled: false,
      createEntropy: () => "attempt-fresh",
    });
    expect(freshAttempt.expectedOwnerGeneration).toBe("");
    const stamped = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () =>
        sessionPreference({ ...preference, memoryEnabled: false, revision: 1 }),
    });
    expect((await stamped.write(freshAttempt)).status).toBe("committed");
    const unstamped = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () =>
        sessionPreference({ ...fresh, memoryEnabled: false, revision: 1 }),
    });
    let unstampedError: unknown = null;
    try {
      await unstamped.write(freshAttempt);
    } catch (error) {
      unstampedError = error;
    }
    expect(unstampedError).toMatchObject({ code: "owner_generation_changed" });
  });

  test("normalizes a CAS conflict without inventing a new write", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () => {
        throw refusal("CONFLICT", "CLOUD_HOME_REVISION_CONFLICT");
      },
    });

    expect(await client.write(attempt())).toEqual({
      status: "conflict",
      fence: attempt(),
    });

    expect(
      normalizeMobileCloudMemoryPreferenceIssue(
        refusal("CONFLICT", "CLOUD_HOME_REVISION_CONFLICT"),
      ),
    ).toEqual({ code: "revision_conflict", retryable: false });
  });

  test("fails closed when a mutation response crosses owner generations", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () =>
        sessionPreference({
          ownerGeneration: "generation:8",
          memoryEnabled: false,
          revision: 5,
          updatedAt: preference.updatedAt,
        }),
    });

    let thrown: unknown = null;
    try {
      await client.write(attempt());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MobileCloudMemoryPreferenceError);
    expect(thrown).toMatchObject({
      code: "owner_generation_changed",
      retryable: false,
    });
  });

  test("rejects a well-shaped response for different mutation input", async () => {
    const wrongValueClient = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () => ({
        ...sessionPreference(),
        // This is valid data, but cannot be the result of the attempted write.
        memoryEnabled: true,
        revision: 5,
      }),
    });

    let thrown: unknown = null;
    try {
      await wrongValueClient.write(attempt());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });

    const wrongRevisionClient = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () => ({
        ...sessionPreference(),
        memoryEnabled: false,
        revision: 6,
      }),
    });
    thrown = null;
    try {
      await wrongRevisionClient.write(attempt());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  test("fences account, session, request, and owner-generation changes", async () => {
    const fence = createMobileCloudMemoryPreferenceRequestFence(
      identityA,
      () => "load-1",
    );
    const result = { fence, preference };
    const current = {
      accountScope: identityA.accountScope,
      identityKey: identityA.identityKey,
      identityRevision: identityA.identityRevision,
      requestId: "mobile-memory:load-1",
      ownerGeneration: preference.ownerGeneration,
    };

    expect(isMobileCloudMemoryPreferenceRequestCurrent(fence, current)).toBe(
      true,
    );
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, {
        ...current,
        accountScope: "account:user-b",
        identityKey: "account:user-b:session:session-b",
        identityRevision: 8,
      }),
    ).toBeNull();
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, {
        ...current,
        identityKey: "account:user-a:session:session-a-rotated",
        identityRevision: 8,
      }),
    ).toBeNull();
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, {
        ...current,
        identityRevision: 8,
      }),
    ).toBeNull();
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, {
        ...current,
        requestId: "mobile-memory:load-2",
      }),
    ).toBeNull();
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, {
        ...current,
        ownerGeneration: "generation:8",
      }),
    ).toBeNull();
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(result, current),
    ).toBe(result);

    const rotatedPreference: MobileCloudMemoryPreference = {
      ownerGeneration: "generation:8",
      memoryEnabled: true,
      revision: 0,
      updatedAt: 0,
    };
    const rotatedResult = { fence, preference: rotatedPreference };
    const currentWithoutGeneration = {
      accountScope: current.accountScope,
      identityKey: current.identityKey,
      identityRevision: current.identityRevision,
      requestId: current.requestId,
    };
    expect(
      acceptCurrentMobileCloudMemoryPreferenceResult(
        rotatedResult,
        currentWithoutGeneration,
      ),
    ).toBe(rotatedResult);
    const postResetAttempt = beginMobileCloudMemoryPreferenceWrite({
      ...identityA,
      preference: rotatedPreference,
      memoryEnabled: false,
      createEntropy: () => "post-reset-write",
    });
    expect(postResetAttempt).toMatchObject({
      expectedOwnerGeneration: "generation:8",
      expectedRevision: 0,
      requestId: "mobile-memory:post-reset-write",
    });
    expect(postResetAttempt.requestId === attempt().requestId).toBe(false);
  });

  test("rotates the local identity fence across sessions and account succession", () => {
    resetCloudConversationIdentityForTests();
    try {
      const first = observeCloudConversationIdentity({
        user: { id: "user-a" },
        session: { id: "session-1" },
      });
      const repeated = observeCloudConversationIdentity({
        user: { id: "user-a" },
        session: { id: "session-1" },
      });
      const nextSession = observeCloudConversationIdentity({
        user: { id: "user-a" },
        session: { id: "session-2" },
      });
      const accountB = observeCloudConversationIdentity({
        user: { id: "user-b" },
        session: { id: "session-b" },
      });
      const returnedA = observeCloudConversationIdentity({
        user: { id: "user-a" },
        session: { id: "session-3" },
      });

      expect(repeated).toEqual(first);
      expect(nextSession?.accountScope).toBe("account:user-a");
      expect(nextSession?.identityKey === first?.identityKey).toBe(false);
      expect(nextSession?.revision).toBe((first?.revision ?? 0) + 1);
      expect(accountB?.accountScope).toBe("account:user-b");
      expect(accountB?.revision).toBe((nextSession?.revision ?? 0) + 1);
      expect(returnedA?.accountScope).toBe("account:user-a");
      expect(returnedA?.identityKey === first?.identityKey).toBe(false);
      expect(returnedA?.revision).toBe((accountB?.revision ?? 0) + 1);
    } finally {
      resetCloudConversationIdentityForTests();
    }
  });

  test("rejects a response that echoes a different authenticated subject", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      setMemoryEnabled: async () =>
        sessionPreference(
          { ...preference, memoryEnabled: false, revision: 5 },
          "https://issuer.test|user-b",
        ),
    });

    let writeError: unknown = null;
    try {
      await client.write(attempt());
    } catch (error) {
      writeError = error;
    }
    expect(writeError).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  test("rejects malformed view values and normalizes known lifecycle errors", () => {
    expect(() =>
      decodeMobileCloudMemoryPreferenceForSubject(
        sessionPreference({ ...preference, revision: Number.NaN }),
        ownerSubjectA,
      ),
    ).toThrow(MobileCloudMemoryPreferenceError);
    expect(
      normalizeMobileCloudMemoryPreferenceIssue(
        refusal("CONFLICT", "owner_generation_stale"),
      ),
    ).toEqual({ code: "owner_generation_changed", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue(
        refusal("CONFLICT", "CLOUD_HOME_IDEMPOTENCY_CONFLICT"),
      ),
    ).toEqual({ code: "idempotency_conflict", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue(refusal("UNAUTHENTICATED")),
    ).toEqual({ code: "unauthorized", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue(
        refusal("UNAVAILABLE", "MEMORY_POLICY_CHANGING"),
      ),
    ).toEqual({ code: "unavailable", retryable: true });
  });
});
