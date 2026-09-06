/**
 * How a cloud orchestrator turn identifies itself on account-scoped routes
 * that are otherwise called with a signed-in user's token. The Durable
 * Object sets this header and presents its control-plane turn capability as
 * the bearer; the route resolves the same owner id space either way, so
 * connectors, media jobs, quotas and entitlements see one owner regardless
 * of which surface asked.
 */
import type { ActionCtx } from "../_generated/server";
import { authorizeControlPlaneRequest } from "../lib/capability_verify";

export const CLOUD_TURN_CALLER_HEADER = "x-stella-caller";
export const CLOUD_TURN_CALLER_VALUE = "cloud-turn";

export const isCloudTurnCaller = (request: Request): boolean =>
  request.headers.get(CLOUD_TURN_CALLER_HEADER)?.trim() ===
  CLOUD_TURN_CALLER_VALUE;

export type CloudTurnOwner =
  | { ok: true; ownerId: string; ownerGeneration: string; anonymous: boolean }
  | { ok: false; response: Response };

/**
 * Resolve the owner behind a cloud-turn capability. Callers decide what an
 * anonymous audience may do; this only verifies and unpacks the capability.
 */
export const authorizeCloudTurnOwner = async (
  ctx: ActionCtx,
  request: Request,
): Promise<CloudTurnOwner> => {
  const auth = await authorizeControlPlaneRequest(ctx, request);
  if (!auth.ok) return { ok: false, response: auth.response };
  return {
    ok: true,
    ownerId: auth.authority.ownerId,
    ownerGeneration: auth.authority.ownerGeneration,
    anonymous: auth.authority.claims.audience === "anonymous",
  };
};
