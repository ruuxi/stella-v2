/**
 * Capability gating for HTTP routes.
 *
 * `requireCapabilityAction` mirrors `requireSignedInAccountAction`'s shape —
 * either an `ok: true` result carrying the resolved managed access, or an
 * `ok: false` result carrying the Response to return verbatim — so a route
 * gains a plan gate with the same two lines it already spends on auth.
 *
 * The denial is a 402 whose body is machine-readable end to end: the
 * renderer reads `capability` / `audience` / `minimumPlan` to build its
 * upgrade toast without re-deriving an entitlement decision, and the
 * `[capability/<id>]` marker inside `error` keeps the older
 * flatten-to-a-string error paths classifying correctly.
 */
import type { ActionCtx } from "../_generated/server";
import type { Capability, CapabilityDenial } from "../capability_contract";
import {
  resolveCapabilityAccess,
  type ManagedModelAccess,
} from "../lib/managed_billing";
import { jsonResponse } from "./cors";

const DEFAULT_UPGRADE_ACTION =
  "Tell the user this feature is not on their current Stella plan and that they can upgrade from Settings → Billing in the Stella desktop app.";

type CapabilityRequiredOptions = {
  action?: string;
  docsUrl?: string;
};

/**
 * HTTP 402 Payment Required — the caller is authenticated and inside their
 * usage budget, they simply do not own this surface. Deliberately not 403:
 * `403` already means "bad credential" to the shared error classifier, and
 * conflating the two would send users to the sign-in flow instead of the
 * upgrade flow.
 */
export const capabilityRequiredResponse = (
  denial: CapabilityDenial,
  origin: string | null,
  options: CapabilityRequiredOptions = {},
): Response =>
  jsonResponse(
    {
      error: denial.message,
      code: denial.code,
      capability: denial.capability,
      audience: denial.audience,
      minimumPlan: denial.minimumPlan,
      action: options.action ?? DEFAULT_UPGRADE_ACTION,
      ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
    },
    402,
    origin,
  );

type CapabilityActionResult =
  | { ok: false; response: Response }
  | { ok: true; access: ManagedModelAccess };

export const requireCapabilityAction = async (
  ctx: { runMutation: ActionCtx["runMutation"] },
  ownerId: string,
  capability: Capability,
  origin: string | null,
  options?: CapabilityRequiredOptions,
): Promise<CapabilityActionResult> => {
  const result = await resolveCapabilityAccess(ctx, ownerId, capability);
  if (!result.allowed) {
    return {
      ok: false,
      response: capabilityRequiredResponse(result.denial, origin, options),
    };
  }
  return { ok: true, access: result.access };
};
