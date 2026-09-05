import type { GatewayCapabilityClaims } from "@stella/contracts/gateway/capability";

export type ManagedCancellationIdentity = {
  ownerId: string;
  ownerGeneration: string;
  capabilityId: string;
  requestId: string;
  turnId: string;
  conversationId: string;
  expiresAt: number;
};

export const managedCancellationIdentity = (args: {
  claims: GatewayCapabilityClaims;
  requestId: string;
}): ManagedCancellationIdentity | null => {
  const { claims } = args;
  if (
    claims.kind !== "turn" ||
    !claims.turn ||
    claims.credential ||
    claims.ledgerScope !== "owner-relay-v2"
  ) {
    return null;
  }
  return {
    ownerId: claims.sub,
    ownerGeneration: claims.gen,
    capabilityId: claims.jti,
    requestId: args.requestId,
    turnId: claims.turn.turnId,
    conversationId: claims.turn.conversationId,
    expiresAt: claims.exp * 1_000,
  };
};

export const managedCancellationKey = (
  identity: ManagedCancellationIdentity,
): string => JSON.stringify([
  identity.ownerGeneration,
  identity.capabilityId,
  identity.requestId,
  identity.turnId,
  identity.conversationId,
]);
