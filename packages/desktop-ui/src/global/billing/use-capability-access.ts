/**
 * React access to the client-side capability gate.
 *
 * One billing subscription, one audience, one verdict — components ask
 * this hook instead of re-deriving entitlement from a plan string. It
 * also publishes the resolved audience to the module snapshot in
 * `./capabilities` so the non-React streaming error path can pick the
 * right call to action without billing state being threaded through the
 * transport.
 */
import { useBackendValue } from "@/platform/backend/use-backend-view";
import { useCallback, useEffect, useMemo } from "react";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import {
  resolveBillingAudience,
  resolveFreeAllowance,
  type FreeAllowance,
  type ManagedModelAudience,
} from "./audience";
import {
  canUseCapability,
  publishBillingAudience,
  resolveCapabilityRestriction,
  type Capability,
  type CapabilityRestriction,
} from "./capabilities";

type AuthSessionData =
  | {
      user?: {
        id?: string | null;
        email?: string | null;
      } | null;
    }
  | null
  | undefined;

export type CapabilityAccess = {
  /** `null` while billing is still resolving for a signed-in user. */
  audience: ManagedModelAudience | null;
  /** Optimistic during the hydration gap — see `canUseCapability`. */
  can: (capability: Capability) => boolean;
  restrictionFor: (capability: Capability) => CapabilityRestriction | null;
  /** Present only for Free accounts with a lifetime ceiling. */
  freeAllowance: FreeAllowance | null;
};

export function useCapabilityAccess(): CapabilityAccess {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const hasConnectedAccount = Boolean(sessionData?.user?.id);

  const billingStatus = useBackendValue(
    "billing.status",
    hasConnectedAccount ? {} : "skip",
  );

  const audience = useMemo<ManagedModelAudience | null>(
    () => resolveBillingAudience({ hasConnectedAccount, billingStatus }),
    [billingStatus, hasConnectedAccount],
  );

  useEffect(() => {
    publishBillingAudience(audience);
  }, [audience]);

  const freeAllowance = useMemo(
    () => resolveFreeAllowance(billingStatus),
    [billingStatus],
  );

  const can = useCallback(
    (capability: Capability) => canUseCapability(audience, capability),
    [audience],
  );

  const restrictionFor = useCallback(
    (capability: Capability) =>
      resolveCapabilityRestriction(audience, capability),
    [audience],
  );

  return { audience, can, restrictionFor, freeAllowance };
}
