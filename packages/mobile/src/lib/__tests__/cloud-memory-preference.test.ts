import { describe, expect, test } from "bun:test";
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
) => ({ subject, ...value });

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
    const reads: { expectedSubject: string }[] = [];
    const client = createMobileCloudMemoryPreferenceClient({
      getMyMemoryPreference: async (input) => {
        reads.push(input);
        return sessionPreference();
      },
      setMyMemoryEnabled: async (input) => {
        inputs.push(input);
        return sessionPreference({
          ...preference,
          memoryEnabled: false,
          revision: 5,
        });
      },
    });

    const readFence = createMobileCloudMemoryPreferenceRequestFence(
      identityA,
      () => "read-attested",
    );
    await client.read(readFence);
    const first = await client.write(writeAttempt);
    const retried = await client.write(writeAttempt);

    expect(entropyCalls).toBe(1);
    expect(Object.isFrozen(writeAttempt)).toBe(true);
    expect(writeAttempt.requestId).toBe("mobile-memory:attempt-stable");
    expect(reads).toEqual([{ expectedSubject: ownerSubjectA }]);
    expect(inputs).toEqual([
      {
        expectedSubject: ownerSubjectA,
        memoryEnabled: false,
        expectedOwnerGeneration: "generation:7",
        expectedRevision: 4,
        requestId: "mobile-memory:attempt-stable",
      },
      {
        expectedSubject: ownerSubjectA,
        memoryEnabled: false,
        expectedOwnerGeneration: "generation:7",
        expectedRevision: 4,
        requestId: "mobile-memory:attempt-stable",
      },
    ]);
    expect(first.status).toBe("committed");
    expect(retried.status).toBe("committed");
    expect(first.fence).toBe(writeAttempt);
  });

  test("normalizes a CAS conflict without inventing a new write", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      getMyMemoryPreference: async () => sessionPreference(),
      setMyMemoryEnabled: async () => {
        throw {
          data: {
            code: "CLOUD_HOME_REVISION_CONFLICT",
            message: "changed",
            currentRevision: 8,
            currentMemoryEnabled: false,
          },
        };
      },
    });

    expect(await client.write(attempt())).toEqual({
      status: "conflict",
      fence: attempt(),
      current: { revision: 8, memoryEnabled: false },
    });

    expect(
      normalizeMobileCloudMemoryPreferenceIssue(
        new Error(
          'ConvexError: {"code":"CLOUD_HOME_REVISION_CONFLICT","currentRevision":9,"currentMemoryEnabled":true}',
        ),
      ),
    ).toEqual({
      code: "revision_conflict",
      retryable: false,
      current: { revision: 9, memoryEnabled: true },
    });
  });

  test("fails closed when a mutation response crosses owner generations", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      getMyMemoryPreference: async () => sessionPreference(),
      setMyMemoryEnabled: async () => ({
        subject: ownerSubjectA,
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
      getMyMemoryPreference: async () => sessionPreference(),
      setMyMemoryEnabled: async () => ({
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
      getMyMemoryPreference: async () => sessionPreference(),
      setMyMemoryEnabled: async () => ({
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
    const client = createMobileCloudMemoryPreferenceClient({
      getMyMemoryPreference: async () => sessionPreference(),
      setMyMemoryEnabled: async () => sessionPreference(),
    });
    const result = await client.read(fence);
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
      getMyMemoryPreference: async () =>
        sessionPreference(preference, "https://issuer.test|user-b"),
      setMyMemoryEnabled: async () =>
        sessionPreference(
          { ...preference, memoryEnabled: false, revision: 5 },
          "https://issuer.test|user-b",
        ),
    });
    const fence = createMobileCloudMemoryPreferenceRequestFence(
      identityA,
      () => "subject-read",
    );

    let readError: unknown = null;
    try {
      await client.read(fence);
    } catch (error) {
      readError = error;
    }
    expect(readError).toMatchObject({
      code: "invalid_response",
      retryable: false,
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

  test("rejects malformed reads and normalizes known lifecycle errors", async () => {
    const client = createMobileCloudMemoryPreferenceClient({
      getMyMemoryPreference: async () =>
        sessionPreference({ ...preference, revision: Number.NaN }),
      setMyMemoryEnabled: async () => sessionPreference(),
    });
    const fence = createMobileCloudMemoryPreferenceRequestFence(
      identityA,
      () => "load-invalid",
    );

    let thrown: unknown = null;
    try {
      await client.read(fence);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "OWNER_DATA_GENERATION_STALE" },
      }),
    ).toEqual({ code: "owner_generation_changed", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "CLOUD_HOME_IDEMPOTENCY_CONFLICT" },
      }),
    ).toEqual({ code: "idempotency_conflict", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "UNAUTHENTICATED" },
      }),
    ).toEqual({ code: "unauthorized", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "SESSION_IDENTITY_MISMATCH" },
      }),
    ).toEqual({ code: "unauthorized", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "OWNER_DATA_PURGE_ACTIVE", state: "resetting" },
      }),
    ).toEqual({ code: "account_unavailable", retryable: false });
    expect(
      normalizeMobileCloudMemoryPreferenceIssue({
        data: { code: "OWNER_DATA_PURGE_ACTIVE", state: "deleting" },
      }),
    ).toEqual({ code: "account_unavailable", retryable: false });
  });
});
