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
