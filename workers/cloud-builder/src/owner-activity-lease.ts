import { OwnerPurgeFenceError } from "./build-session/shared/errors.js";

/** One owner-fence host call, already scoped to the owner. */
export type OwnerFenceCaller = (
  path: string,
  body: Record<string, unknown>,
) => Promise<Response>;

/**
 * Run `operation` under an owner-fence activity lease, so an owner purge
 * waits for it instead of deleting state underneath it.
 */
export const withOwnerActivityLease = async <T>(
  fence: OwnerFenceCaller,
  ownerGeneration: string,
  activityId: string,
  operation: (generation: string, leaseId: string) => Promise<T>,
): Promise<T> => {
  const sessionId = `activity-${activityId}`;
  const turnId = activityId;
  const leaseId = crypto.randomUUID();
  // Activity leases cannot be canceled by owner purge, so every one needs a
  // durable crash expiry. Thirty minutes leaves ample room for large world
  // operations while guaranteeing an evicted isolate cannot wedge the owner.
  // The fence caps leases at thirty minutes from its own clock, which can
  // trail this isolate's, so ask for a minute less than the cap.
  const expiresAt = Date.now() + 29 * 60_000;
  const registered = await fence("register", {
    leaseId,
    sessionId,
    turnId,
    ownerGeneration,
    namespace: "activity",
    role: "activity",
    expiresAt,
  });
  const registration = (await registered.json().catch(() => null)) as {
    generation?: string;
  } | null;
  if (!registered.ok || !registration?.generation) {
    throw new OwnerPurgeFenceError();
  }
  try {
    return await operation(registration.generation, leaseId);
  } finally {
    await fence("unregister", {
      leaseId,
      sessionId,
      turnId,
      ownerGeneration,
      generation: registration.generation,
    }).catch(() => undefined);
  }
};
