import type { GatewayCapabilityClaims } from "@stella/contracts/gateway/capability";
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
): CapabilityLedgerClient => {
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
