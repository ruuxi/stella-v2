import type { GatewayCapabilityClaims } from "@stella/contracts/gateway/capability";
import type { OwnerRelayGate } from "./gates/owner-relay-gate.js";
import type {
  LedgerReserveArgs,
  LedgerReserveResult,
  LedgerSettleArgs,
  LedgerSettleResult,
} from "./ledger.js";

export type OwnerRelayAccounting = Pick<
  OwnerRelayGate,
  "admitRelay" | "admitAndReserve" | "settleCapability" | "releaseRelay"
>;

export type CapabilityLedgerClient = {
  /**
   * Absent for owner-relay-v2 capabilities: their reservation commits with
   * owner admission in `OwnerRelayGate.admitAndReserve`.
   */
  reserve?: (args: LedgerReserveArgs) => Promise<LedgerReserveResult>;
  settle: (args: LedgerSettleArgs) => Promise<LedgerSettleResult>;
};

/** Never fall back after dispatch: that would split a capability's budget/replay authority. */
export const capabilityLedgerClient = (
  env: Env,
  claims: GatewayCapabilityClaims,
  localOwner?: OwnerRelayAccounting,
): CapabilityLedgerClient => {
  if (claims.ledgerScope === "owner-relay-v2") {
    const gate =
      localOwner ??
      env.OWNER_RELAY_GATE.get(env.OWNER_RELAY_GATE.idFromName(claims.sub));
    return {
      settle: async (args) =>
        await gate.settleCapability({
          ...args,
          jti: claims.jti,
          generation: claims.gen,
        }),
    };
  }
  const ledger = env.CAPABILITY_LEDGER.get(
    env.CAPABILITY_LEDGER.idFromName(claims.jti),
  );
  return {
    reserve: async (args) => await ledger.reserve(args),
    settle: async (args) => await ledger.settle(args),
  };
};
