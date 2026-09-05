import {
  memoryPoliciesMatch,
  type MemoryPolicy,
} from "@stella/contracts/turn-plane/memory-policy";
import {
  parseOwnerModelGrant,
  type OwnerModelGrant,
} from "./owner-model-grants.js";

export type LocalOwnerModelGrantExpectation = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  leaseId: string;
  fenceGeneration: string;
  memoryPolicy: MemoryPolicy;
}>;

type ActiveRequest = {
  controller: AbortController;
  ownerId: string;
  ownerGeneration: string;
  grantId: string;
};

const revokeKey = (
  ownerId: string,
  ownerGeneration: string,
  grantId: string,
): string => JSON.stringify([ownerId, ownerGeneration, grantId]);

export class LocalOwnerModelGrants {
  private readonly revoked = new Map<string, number>();
  private readonly active = new Set<ActiveRequest>();
  private readonly freezeEpochs = new Map<string, number>();

  constructor(
    private readonly readerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private ownerKey(ownerId: string, ownerGeneration: string): string {
    return JSON.stringify([ownerId, ownerGeneration]);
  }

  freezeEpoch(
    expected: Pick<
      LocalOwnerModelGrantExpectation,
      "ownerId" | "ownerGeneration"
    >,
  ): number {
    return (
      this.freezeEpochs.get(
        this.ownerKey(expected.ownerId, expected.ownerGeneration),
      ) ?? 0
    );
  }

  validAfter(
    value: unknown,
    expected: LocalOwnerModelGrantExpectation,
    freezeEpoch: number,
  ): OwnerModelGrant | null {
    if (this.freezeEpoch(expected) !== freezeEpoch) return null;
    return this.valid(value, expected);
  }

  private clean(): void {
    const now = this.now();
    for (const [grantId, expiresAt] of this.revoked) {
      if (expiresAt <= now) this.revoked.delete(grantId);
    }
  }

  valid(
    value: unknown,
    expected: LocalOwnerModelGrantExpectation,
  ): OwnerModelGrant | null {
    this.clean();
    const grant = parseOwnerModelGrant(value);
    if (
      !grant ||
      grant.readerId !== this.readerId ||
      grant.expiresAt <= this.now() ||
      this.revoked.has(
        revokeKey(grant.ownerId, grant.ownerGeneration, grant.grantId),
      ) ||
      grant.ownerId !== expected.ownerId ||
      grant.ownerGeneration !== expected.ownerGeneration ||
      grant.conversationId !== expected.conversationId ||
      grant.turnId !== expected.turnId ||
      grant.leaseId !== expected.leaseId ||
      grant.fenceGeneration !== expected.fenceGeneration ||
      !memoryPoliciesMatch(grant.memoryPolicy, expected.memoryPolicy)
    )
      return null;
    return grant;
  }

  begin(
    value: unknown,
    expected: LocalOwnerModelGrantExpectation,
    signal: AbortSignal,
  ): {
    requestSignal: AbortSignal;
    assertValid(): void;
    release(): void;
  } {
    const grant = this.valid(value, expected);
    if (!grant) throw new Error("OWNER_MODEL_GRANT_INVALID");
    const entry: ActiveRequest = {
      controller: new AbortController(),
      ownerId: grant.ownerId,
      ownerGeneration: grant.ownerGeneration,
      grantId: grant.grantId,
    };
    this.active.add(entry);
    const assertValid = (): void => {
      if (!this.valid(grant, expected) || entry.controller.signal.aborted) {
        throw new Error("OWNER_MODEL_GRANT_REVOKED");
      }
    };
    return {
      requestSignal: AbortSignal.any([signal, entry.controller.signal]),
      assertValid,
      release: () => {
        this.active.delete(entry);
      },
    };
  }

  freeze(args: {
    ownerId: string;
    ownerGeneration: string;
    readerId: string;
    grants: readonly { grantId: string; expiresAt: number }[];
  }): void {
    if (args.readerId !== this.readerId) return;
    this.clean();
    const ownerKey = this.ownerKey(args.ownerId, args.ownerGeneration);
    this.freezeEpochs.set(ownerKey, (this.freezeEpochs.get(ownerKey) ?? 0) + 1);
    const now = this.now();
    for (const grant of args.grants) {
      const key = revokeKey(args.ownerId, args.ownerGeneration, grant.grantId);
      // Expiry already prevents a new dispatch. Retain only useful future
      // tombstones, while still aborting a request that began before expiry.
      if (grant.expiresAt > now) this.revoked.set(key, grant.expiresAt);
      for (const active of this.active) {
        if (
          active.ownerId === args.ownerId &&
          active.ownerGeneration === args.ownerGeneration &&
          active.grantId === grant.grantId
        ) {
          active.controller.abort(new Error("OWNER_MODEL_GRANT_REVOKED"));
        }
      }
    }
  }
}

export const releaseOwnerModelGrantAfterBody = (
  response: Response,
  release: () => void,
): Response => {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let done = false;
  const finish = (): void => {
    if (!done) {
      done = true;
      release();
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    }),
    response,
  );
};
