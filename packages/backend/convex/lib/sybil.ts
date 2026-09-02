import type {
  IdentityLevel,
  NetworkClass,
} from "@stella/contracts/gateway/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const DAY_MS = 24 * 60 * 60_000;
const DEVICE_WINDOW_MS = 30 * DAY_MS;
const DEVICE_CHALLENGE_COUNT = 2;
const ANONYMOUS_IP_CHALLENGE_COUNT = 5;
const ANONYMOUS_IP_SIGN_IN_COUNT = 20;
const HOSTING_NETWORK_CHALLENGE_COUNT = 5;

export type SybilPressure =
  | { action: "ok"; reason: "none" }
  | {
      action: "challenge";
      reason: "device_key" | "anonymous_ip" | "hosting_network";
    }
  | { action: "sign_in_required"; reason: "anonymous_ip" };

type SybilReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const prospectiveDistinctOwnerCount = (
  rows: Array<{ ownerId: string }>,
  ownerId: string,
): number => new Set([...rows.map((row) => row.ownerId), ownerId]).size;

export const evaluateSybilPressure = async (
  ctx: SybilReadCtx,
  args: {
    ownerId: string;
    deviceKeyHash?: string;
    ipHash?: string;
    networkClass?: NetworkClass;
    identityLevel: IdentityLevel;
    now?: number;
  },
): Promise<SybilPressure> => {
  if (args.identityLevel >= 2) return { action: "ok", reason: "none" };
  const now = args.now ?? Date.now();

  if (args.identityLevel === 0 && args.ipHash) {
    const rows = await ctx.db
      .query("owner_origins")
      .withIndex("by_ipHash_identityLevel_createdAt", (q) =>
        q
          .eq("ipHash", args.ipHash)
          .eq("identityLevel", 0)
          .gte("createdAt", now - DAY_MS),
      )
      .take(ANONYMOUS_IP_SIGN_IN_COUNT);
    const count = prospectiveDistinctOwnerCount(rows, args.ownerId);
    if (count >= ANONYMOUS_IP_SIGN_IN_COUNT) {
      return { action: "sign_in_required", reason: "anonymous_ip" };
    }
    if (count >= ANONYMOUS_IP_CHALLENGE_COUNT) {
      return { action: "challenge", reason: "anonymous_ip" };
    }
  }

  if (args.deviceKeyHash) {
    const rows = await ctx.db
      .query("owner_origins")
      .withIndex("by_deviceKeyHash_createdAt", (q) =>
        q
          .eq("deviceKeyHash", args.deviceKeyHash)
          .gte("createdAt", now - DEVICE_WINDOW_MS),
      )
      .take(DEVICE_CHALLENGE_COUNT + 1);
    if (
      prospectiveDistinctOwnerCount(rows, args.ownerId) >=
      DEVICE_CHALLENGE_COUNT
    ) {
      return { action: "challenge", reason: "device_key" };
    }
  }

  if (args.networkClass === "hosting" && args.ipHash) {
    const rows = await ctx.db
      .query("owner_origins")
      .withIndex("by_ipHash_networkClass_createdAt", (q) =>
        q
          .eq("ipHash", args.ipHash)
          .eq("networkClass", "hosting")
          .gte("createdAt", now - DAY_MS),
      )
      .take(HOSTING_NETWORK_CHALLENGE_COUNT);
    if (
      prospectiveDistinctOwnerCount(rows, args.ownerId) >=
      HOSTING_NETWORK_CHALLENGE_COUNT
    ) {
      return { action: "challenge", reason: "hosting_network" };
    }
  }

  return { action: "ok", reason: "none" };
};

export {
  ANONYMOUS_IP_CHALLENGE_COUNT,
  ANONYMOUS_IP_SIGN_IN_COUNT,
  DAY_MS,
  DEVICE_CHALLENGE_COUNT,
  DEVICE_WINDOW_MS,
  HOSTING_NETWORK_CHALLENGE_COUNT,
};
