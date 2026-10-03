import { ConvexError, v } from "convex/values";
import {
  GATEWAY_ANONYMOUS_REQUEST_CHUNK,
  GATEWAY_NETWORK_POLICY,
  type IdentityLevel,
  type NetworkClass,
} from "@stella/contracts/gateway/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  anonymousIpBucketDeviceId,
  anonymousTrialOwnerKey,
  consumeDeviceAllowanceBulkAuthorized,
  readDeviceAllowance,
} from "./ai_proxy_data";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "./lib/anonymous_usage";
import { readOwnerEnforcement } from "./owner_enforcement";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import { ownerEnforcementStatusValidator } from "./schema/gateway";
import {
  identityLevelValidator,
  resolveIdentityLevel,
} from "./lib/identity_level";
import {
  isTurnstileEnabled,
  logTurnstileDisabledOnce,
  verifyTurnstileToken,
} from "./lib/turnstile";
import { evaluateSybilPressure, type SybilPressure } from "./lib/sybil";
import { recordOwnerOrigin } from "./owner_origins";
import { recordOwnerRiskSignals } from "./risk";

/**
 * Abuse admission for model-gateway session capabilities. The owner's object
 * on cloud-builder reserves the budget and signs the capability; before it
 * does, it asks here whether this owner, device and network may have one:
 * suspension, step-up challenges, sybil pressure, and the anonymous trial's
 * request chunk. Moves with abuse protection.
 */

const networkClassValidator = v.union(
  v.literal("hosting"),
  v.literal("vpn"),
  v.literal("residential"),
  v.literal("mobile"),
  v.literal("edu"),
  v.literal("unknown"),
);

const challengeRequiredError = (sybil?: SybilPressure) =>
  new ConvexError({
    code: "CHALLENGE_REQUIRED",
    message: "A human-presence challenge is required.",
    ...(sybil && sybil.action !== "ok"
      ? { sybilFlag: true, sybilReason: sybil.reason }
      : {}),
  });

const signInRequiredError = (sybil?: SybilPressure) =>
  new ConvexError({
    code: "SIGN_IN_REQUIRED",
    message: "Sign in with an account to continue from this network.",
    ...(sybil && sybil.action !== "ok"
      ? { sybilFlag: true, sybilReason: sybil.reason }
      : {}),
  });

const isSybilPressureError = (error: unknown): boolean => {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data as { sybilFlag?: unknown } | string | undefined;
  return typeof data === "object" && data?.sybilFlag === true;
};

type OwnerSessionChallengeState = {
  identityLevel: IdentityLevel;
  enforcementStatus: "ok" | "challenged" | "throttled" | "suspended";
  challengeRequired: boolean;
};

const hasNetworkClass = (
  classes: readonly NetworkClass[],
  networkClass: NetworkClass | undefined,
): boolean =>
  networkClass !== undefined &&
  classes.some((candidate) => candidate === networkClass);

const resolveOwnerSessionChallengeState = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    isAnonymous: boolean;
    paying: boolean;
    networkClass?: NetworkClass;
  },
): Promise<OwnerSessionChallengeState> => {
  const [enforcement, identityLevel] = await Promise.all([
    readOwnerEnforcement(ctx, args.ownerId),
    args.isAnonymous
      ? Promise.resolve(0 as const)
      : resolveIdentityLevel(ctx, args.ownerId, { paying: args.paying }),
  ]);
  if (
    args.isAnonymous &&
    hasNetworkClass(GATEWAY_NETWORK_POLICY.anonymousRefused, args.networkClass)
  ) {
    throw signInRequiredError();
  }
  return {
    identityLevel,
    enforcementStatus: enforcement.status,
    challengeRequired:
      enforcement.status === "challenged" ||
      (!args.isAnonymous &&
        identityLevel < 3 &&
        hasNetworkClass(
          GATEWAY_NETWORK_POLICY.freeChallenged,
          args.networkClass,
        )),
  };
};

export const getOwnerSessionChallengeStateInternal = internalQuery({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
    paying: v.boolean(),
    networkClass: v.optional(networkClassValidator),
  },
  returns: v.object({
    identityLevel: identityLevelValidator,
    enforcementStatus: ownerEnforcementStatusValidator,
    challengeRequired: v.boolean(),
  }),
  handler: async (ctx, args): Promise<OwnerSessionChallengeState> =>
    await resolveOwnerSessionChallengeState(ctx, args),
});

const readAnonymousRequestAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: { ownerId: string; ipHash?: string },
): Promise<number> => {
  try {
    const owner = await readDeviceAllowance(ctx, {
      deviceId: anonymousTrialOwnerKey(args.ownerId),
      maxRequests: getMaxAnonRequests(),
    });
    const ipHash = args.ipHash?.trim();
    const network = ipHash
      ? await readDeviceAllowance(ctx, {
          deviceId: anonymousIpBucketDeviceId(ipHash),
          maxRequests: getMaxAnonRequestsPerIp(),
        })
      : null;
    return Math.max(
      0,
      Math.min(
        owner.remaining,
        network?.remaining ?? Number.POSITIVE_INFINITY,
        GATEWAY_ANONYMOUS_REQUEST_CHUNK,
      ),
    );
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) throw error;
    logMissingSaltOnce("gateway-capabilities");
    return 0;
  }
};

const sessionAdmissionValidator = v.object({
  ownerGeneration: v.string(),
  isAnonymous: v.boolean(),
  identityLevel: identityLevelValidator,
  maxRequests: v.optional(v.number()),
});

type SessionAdmission = {
  ownerGeneration: string;
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
  maxRequests?: number;
};

/**
 * Sybil pressure, step-up, origins and risk for one exchange, and the
 * anonymous trial's request chunk, in one transaction.
 */
export const admitOwnerSessionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.boolean(),
    paying: v.boolean(),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(networkClassValidator),
    deviceKeyHash: v.string(),
    challengeVerified: v.boolean(),
    now: v.number(),
  },
  returns: sessionAdmissionValidator,
  handler: async (ctx, args): Promise<SessionAdmission> => {
    await assertOwnerMigrationWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const challengeState = await resolveOwnerSessionChallengeState(ctx, {
      ownerId: args.ownerId,
      isAnonymous: args.isAnonymous,
      paying: args.paying,
      ...(args.networkClass ? { networkClass: args.networkClass } : {}),
    });
    if (challengeState.enforcementStatus === "suspended") {
      throw new ConvexError({ code: "OWNER_SUSPENDED", message: "This owner is suspended." });
    }
    const sybil = await evaluateSybilPressure(ctx, {
      ownerId: args.ownerId,
      deviceKeyHash: args.deviceKeyHash,
      ...(args.ipHash ? { ipHash: args.ipHash } : {}),
      ...(args.networkClass ? { networkClass: args.networkClass } : {}),
      identityLevel: challengeState.identityLevel,
      now: args.now,
    });
    if (sybil.action === "sign_in_required") throw signInRequiredError(sybil);
    // A challenge is only meaningful when Turnstile can verify an answer.
    // Without TURNSTILE_SECRET_KEY (dev deployments) no client can satisfy
    // one, so the challenge outcomes are skipped; sign-in and suspension
    // still apply.
    if (
      isTurnstileEnabled() &&
      (challengeState.challengeRequired || sybil.action === "challenge") &&
      !args.challengeVerified
    ) {
      if (sybil.action === "challenge") throw challengeRequiredError(sybil);
      throw challengeRequiredError();
    }
    await recordOwnerOrigin(ctx, {
      ownerId: args.ownerId,
      deviceKeyHash: args.deviceKeyHash,
      ...(args.ipHash ? { ipHash: args.ipHash } : {}),
      ...(args.networkClass ? { networkClass: args.networkClass } : {}),
      identityLevel: challengeState.identityLevel,
      now: args.now,
    });
    if (sybil.action !== "ok") {
      await recordOwnerRiskSignals(ctx, args.ownerId, { sybilFlags: 1 }, args.now);
    }
    let maxRequests: number | undefined;
    if (args.isAnonymous) {
      maxRequests = await readAnonymousRequestAllowance(ctx, args);
      if (maxRequests > 0) {
        await consumeDeviceAllowanceBulkAuthorized(ctx, {
          deviceId: anonymousTrialOwnerKey(args.ownerId),
          maxRequests: getMaxAnonRequests(),
          count: maxRequests,
        });
      }
    }
    return {
      ownerGeneration: args.ownerGeneration,
      isAnonymous: args.isAnonymous,
      identityLevel: challengeState.identityLevel,
      ...(maxRequests !== undefined ? { maxRequests } : {}),
    };
  },
});

export const admitSessionInternal = internalAction({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
    paying: v.boolean(),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(networkClassValidator),
    turnstileToken: v.optional(v.string()),
    deviceKeyHash: v.string(),
  },
  returns: sessionAdmissionValidator,
  handler: async (ctx, args): Promise<SessionAdmission> => {
    const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
    const challengeState: OwnerSessionChallengeState = await ctx.runQuery(
      internal.gateway_capabilities.getOwnerSessionChallengeStateInternal,
      {
        ownerId: args.ownerId,
        isAnonymous: args.isAnonymous,
        paying: args.paying,
        ...(args.networkClass ? { networkClass: args.networkClass } : {}),
      },
    );
    const turnstileToken = args.turnstileToken?.trim();
    const challengesEnabled = isTurnstileEnabled();
    if (!challengesEnabled) logTurnstileDisabledOnce();
    let challengeVerified = false;
    if (turnstileToken && challengesEnabled) {
      challengeVerified = (await verifyTurnstileToken(turnstileToken)).ok;
    }
    if (challengeState.challengeRequired && challengesEnabled && !challengeVerified) {
      throw challengeRequiredError();
    }
    const now = Date.now();
    try {
      const admission: SessionAdmission = await ctx.runMutation(
        internal.gateway_capabilities.admitOwnerSessionInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: generation,
          isAnonymous: args.isAnonymous,
          paying: args.paying,
          ...(args.ipHash ? { ipHash: args.ipHash } : {}),
          ...(args.networkClass ? { networkClass: args.networkClass } : {}),
          deviceKeyHash: args.deviceKeyHash,
          challengeVerified,
          now,
        },
      );
      await ctx.runMutation(internal.risk.recordGatewayMintRiskSignalInternal, {
        ownerId: args.ownerId,
        mints: 1,
        sybilFlags: 0,
        now,
      });
      return admission;
    } catch (error) {
      if (isSybilPressureError(error)) {
        await ctx.runMutation(internal.risk.recordGatewayMintRiskSignalInternal, {
          ownerId: args.ownerId,
          mints: 0,
          sybilFlags: 1,
          now,
        });
      }
      throw error;
    }
  },
});
