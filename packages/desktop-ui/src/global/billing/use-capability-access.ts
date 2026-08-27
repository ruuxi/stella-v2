import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import {
  resolveBillingAudience,
  resolveFreeAllowance,
  type FreeAllowance,
  type ManagedModelAudience,
  type SubscriptionPlan,
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
        isAnonymous?: boolean | null;
      } | null;
    }
  | null
  | undefined;

type BillingStatusLite = {
  plan: SubscriptionPlan;
  usage: {
    rollingUsedUsd: number;
    rollingLimitUsd: number;
    weeklyUsedUsd: number;
    weeklyLimitUsd: number;
    monthlyUsedUsd: number;
    monthlyLimitUsd: number;
    lifetimeUsedUsd?: number;
    lifetimeLimitUsd?: number | null;
  };
  authenticated?: boolean;
};

export type CapabilityAccess = {

  audience: ManagedModelAudience | null;

  can: (capability: Capability) => boolean;
  restrictionFor: (capability: Capability) => CapabilityRestriction | null;

  freeAllowance: FreeAllowance | null;
};

export function useCapabilityAccess(): CapabilityAccess {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasConnectedAccount = Boolean(
    sessionData && user?.isAnonymous !== true,
  );

  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatusLite | undefined;

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
