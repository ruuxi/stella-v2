import type { GatewayCapabilityClaims } from "@stella/contracts/gateway/capability";
import type { OwnerRelayGate } from "./gates/owner-relay-gate.js";

export type OwnerRelayAccounting = Pick<OwnerRelayGate, "admitRelay" | "admitAndReserve" | "settleCapability" | "releaseRelay">;
import type {
  LedgerReserveArgs,
  LedgerReserveResult,
  LedgerSettleArgs,
  LedgerSettleResult,
} from "./ledger.js";

export type CapabilityLedgerClient = {
  reserve: (args: LedgerReserveArgs) => Promise<LedgerReserveResult>;
  settle: (args: LedgerSettleArgs) => Promise<LedgerSettleResult>;
};

/** Never fall back after dispatch: that would split a capability's budget/replay authority. */
export const capabilityLedgerClient = (
  env: Env,
  claims: GatewayCapabilityClaims,
  localOwner?: OwnerRelayAccounting,
): CapabilityLedgerClient => {
  if (claims.ledgerScope === "owner-relay-v2") {
    const gate = localOwner ?? env.OWNER_RELAY_GATE.get(env.OWNER_RELAY_GATE.idFromName(claims.sub));
    return {
      reserve: async () => { throw new Error("owner-relay-v2 requires atomic admission and reservation"); },
      settle: async (args) => await gate.settleCapability({ ...args, jti: claims.jti, generation: claims.gen }),
    };
  }
  if (claims.ledgerScope === "owner-v1") {
    const ledger = env.OWNER_CAPABILITY_LEDGER.getByName(
      JSON.stringify([claims.sub, claims.gen]),
    );
    return {
      reserve: async (args) =>
        await ledger.reserve({ ...args, jti: claims.jti }),
      settle: async (args) => await ledger.settle({ ...args, jti: claims.jti }),
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
