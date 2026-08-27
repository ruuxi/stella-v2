export type OwnershipMigrationStatus =
  | "pending"
  | "running"
  | "failed"
  | "complete";

export type AnonymousLinkBindingDecision =
  | { ok: true; fromOwnerId?: string }
  | {
      ok: false;
      reason: "invalid_authorization" | "anonymous_authorization_required";
    };

/**
 * Bind a link request only to the identity Convex derived from its bearer JWT.
 * No owner id supplied by the renderer participates in this decision.
 */
export const decideAnonymousLinkBinding = ({
  hasAuthorizationHeader,
  hasBearerAuthorization,
  identityOwnerId,
  identityIsAnonymous,
  requireAnonymousOwner,
}: {
  hasAuthorizationHeader: boolean;
  hasBearerAuthorization: boolean;
  identityOwnerId?: string;
  identityIsAnonymous: boolean;
  requireAnonymousOwner: boolean;
}): AnonymousLinkBindingDecision => {
  if (hasAuthorizationHeader && !hasBearerAuthorization) {
    return { ok: false, reason: "invalid_authorization" };
  }
  if (hasBearerAuthorization && !identityOwnerId) {
    return { ok: false, reason: "invalid_authorization" };
  }
  if (
    requireAnonymousOwner &&
    (!hasBearerAuthorization || !identityOwnerId || !identityIsAnonymous)
  ) {
    return { ok: false, reason: "anonymous_authorization_required" };
  }
  if (identityOwnerId && identityIsAnonymous) {
    return { ok: true, fromOwnerId: identityOwnerId };
  }
  return { ok: true };
};

export type LinkCompletionPlan =
  | { kind: "replay" }
  | { kind: "complete_without_migration" }
  | {
      kind: "complete_with_migration";
      schedule: boolean;
      migrationStatus: OwnershipMigrationStatus;
    };

export const planLinkCompletion = ({
  requestStatus,
  fromOwnerId,
  toOwnerId,
  existingMigrationStatus,
}: {
  requestStatus: "pending" | "completed";
  fromOwnerId?: string;
  toOwnerId: string;
  existingMigrationStatus?: OwnershipMigrationStatus;
}): LinkCompletionPlan => {
  if (requestStatus === "completed") {
    return { kind: "replay" };
  }
  if (!fromOwnerId || fromOwnerId === toOwnerId) {
    return { kind: "complete_without_migration" };
  }
  const migrationStatus = existingMigrationStatus ?? "pending";
  return {
    kind: "complete_with_migration",
    schedule: migrationStatus === "pending",
    migrationStatus,
  };
};
