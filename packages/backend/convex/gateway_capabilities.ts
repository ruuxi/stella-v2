import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  GATEWAY_ANONYMOUS_REQUEST_CHUNK,
  GATEWAY_NETWORK_POLICY,
  GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS,
  limitsAudienceFor,
  type GatewaySessionCapabilityResponse,
  type IdentityLevel,
  type NetworkClass,
} from "@stella/contracts/gateway/api";
import {
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  anonymousIpBucketDeviceId,
  anonymousTrialOwnerKey,
  consumeDeviceAllowanceBulkAuthorized,
  readDeviceAllowance,
  refundDeviceAllowanceAuthorized,
} from "./ai_proxy_data";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import {
  runPeekManagedModelAllowance,
  runResolveManagedModelAllowance,
  type ManagedModelAllowanceResult,
} from "./billing";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import {
  MODEL_GATEWAY_URL_ENV,
  resolveModelGatewayOrigin,
} from "./http_routes/stella_models";
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "./lib/anonymous_usage";
import {
  importCapabilitySigningKey,
  signCapability,
  type CapabilitySigningKey,
} from "./lib/capability_signing";
import { readOwnerEnforcement } from "./owner_enforcement";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import {
  managedModelAudienceValidator,
  ownerEnforcementStatusValidator,
} from "./schema/gateway";
import {
  identityLevelValidator,
  resolveIdentityLevel,
} from "./lib/identity_level";
import { verifyTurnstileToken } from "./lib/turnstile";

export const CAPABILITY_SIGNING_KEY_ENV = "CAPABILITY_SIGNING_KEY";
export const CAPABILITY_SIGNING_KID_ENV = "CAPABILITY_SIGNING_KID";
export const GATEWAY_GRANT_SETTLEMENT_GRACE_MS = 10 * 60_000;

const MAX_UNRELEASED_GRANTS_PER_OWNER = 256;
const GRANT_RELEASE_BATCH_SIZE = 200;

const releaseExpiredGatewayCapabilityGrantsRef = makeFunctionReference<
  "mutation",
  { now?: number; batchSize?: number },
  { released: number; refundedRequests: number; hasMore: boolean }
>("gateway_capabilities:releaseExpiredGatewayCapabilityGrantsInternal");

export const getModelGatewayConfig = query({
  args: {},
  returns: v.object({ origin: v.string() }),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const origin = resolveModelGatewayOrigin(process.env);
    if (!origin) {
      throw new ConvexError({
        code: "SERVICE_UNAVAILABLE",
        message: `Stella model gateway is not configured (${MODEL_GATEWAY_URL_ENV}).`,
      });
    }
    return { origin };
  },
});

export type OwnerModelAllowance = {
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  maxRequests?: number;
  unlimited: boolean;
  identityLevel: IdentityLevel;
};

const ownerModelAllowanceValidator = v.object({
  audience: managedModelAudienceValidator,
  budgetMicroCents: v.number(),
  maxRequests: v.optional(v.number()),
  unlimited: v.boolean(),
  identityLevel: identityLevelValidator,
});

const networkClassValidator = v.union(
  v.literal("hosting"),
  v.literal("vpn"),
  v.literal("residential"),
  v.literal("mobile"),
  v.literal("edu"),
  v.literal("unknown"),
);

const challengeRequiredError = () =>
  new ConvexError({
    code: "CHALLENGE_REQUIRED",
    message: "A human-presence challenge is required.",
  });

const signInRequiredError = () =>
  new ConvexError({
    code: "SIGN_IN_REQUIRED",
    message: "Sign in with an account to continue from this network.",
  });

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
    networkClass?: NetworkClass;
  },
): Promise<OwnerSessionChallengeState> => {
  const [enforcement, identityLevel] = await Promise.all([
    readOwnerEnforcement(ctx, args.ownerId),
    args.isAnonymous
      ? Promise.resolve(0 as const)
      : resolveIdentityLevel(ctx, args.ownerId),
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

type OwnerModelAllowanceArgs = {
  ownerId: string;
  ownerGeneration: string;
  isAnonymous?: boolean;
  ipHash?: string;
};

const readAnonymousRequestAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: Pick<OwnerModelAllowanceArgs, "ownerId" | "ipHash">,
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

const listUnreleasedOwnerGrants = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
) =>
  await ctx.db
    .query("gateway_capability_grants")
    .withIndex("by_owner_released", (q) =>
      q.eq("ownerId", ownerId).eq("released", false),
    )
    .take(MAX_UNRELEASED_GRANTS_PER_OWNER + 1);

const reservedGrantMicroCents = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  now: number,
): Promise<number> => {
  const grants = await listUnreleasedOwnerGrants(ctx, ownerId);
  if (grants.length > MAX_UNRELEASED_GRANTS_PER_OWNER) {
    return Number.POSITIVE_INFINITY;
  }
  return grants.reduce(
    (total, grant) =>
      grant.expiresAt + GATEWAY_GRANT_SETTLEMENT_GRACE_MS < now
        ? total
        : total + Math.max(0, grant.budgetMicroCents - grant.settledMicroCents),
    0,
  );
};

const toOwnerModelAllowance = (
  resolved: ManagedModelAllowanceResult,
  reservedMicroCents: number,
  maxRequests: number | undefined,
  identityLevel: IdentityLevel,
): OwnerModelAllowance => {
  if (resolved.access.unlimited || resolved.remainingMicroCents === null) {
    return {
      audience: resolved.access.modelAudience,
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      unlimited: true,
      identityLevel,
    };
  }
  const chunk =
    GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS[
      limitsAudienceFor(resolved.access.modelAudience)
    ];
  const headroom = Math.max(
    0,
    Math.floor(resolved.remainingMicroCents - reservedMicroCents),
  );
  return {
    audience: resolved.access.modelAudience,
    budgetMicroCents: Math.min(headroom, chunk),
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    unlimited: false,
    identityLevel,
  };
};

export const runPeekOwnerModelAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: OwnerModelAllowanceArgs,
): Promise<OwnerModelAllowance> => {
  const [resolved, maxRequests, reservedMicroCents, identityLevel] =
    await Promise.all([
      runPeekManagedModelAllowance(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        isAnonymous: args.isAnonymous,
      }),
      args.isAnonymous
        ? readAnonymousRequestAllowance(ctx, args)
        : Promise.resolve(undefined),
      reservedGrantMicroCents(ctx, args.ownerId, Date.now()),
      args.isAnonymous
        ? Promise.resolve(0 as const)
        : resolveIdentityLevel(ctx, args.ownerId),
    ]);
  return toOwnerModelAllowance(
    resolved,
    reservedMicroCents,
    maxRequests,
    identityLevel,
  );
};

export const peekOwnerModelAllowanceInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.optional(v.boolean()),
    ipHash: v.optional(v.string()),
  },
  returns: ownerModelAllowanceValidator,
  handler: async (ctx, args): Promise<OwnerModelAllowance> =>
    await runPeekOwnerModelAllowance(ctx, args),
});

const releaseGrant = async (
  ctx: MutationCtx,
  grant: Awaited<ReturnType<typeof listUnreleasedOwnerGrants>>[number],
): Promise<number> => {
  if (grant.released) return 0;
  const unusedRequests =
    grant.audience === "anonymous" && grant.maxRequests !== undefined
      ? Math.max(0, grant.maxRequests - grant.settledRequests)
      : 0;
  let refundedRequests = 0;
  if (unusedRequests > 0) {
    try {
      refundedRequests = await refundDeviceAllowanceAuthorized(ctx, {
        deviceId: anonymousTrialOwnerKey(grant.ownerId),
        count: unusedRequests,
      });
    } catch (error) {
      if (!isAnonDeviceHashSaltMissingError(error)) throw error;
      logMissingSaltOnce("gateway-grant-release");
    }
  }
  await ctx.db.patch(grant._id, { released: true });
  return refundedRequests;
};

const releaseExpiredOwnerGrants = async (
  ctx: MutationCtx,
  ownerId: string,
  now: number,
): Promise<void> => {
  const grants = await listUnreleasedOwnerGrants(ctx, ownerId);
  for (const grant of grants.slice(0, MAX_UNRELEASED_GRANTS_PER_OWNER)) {
    if (grant.expiresAt + GATEWAY_GRANT_SETTLEMENT_GRACE_MS < now) {
      await releaseGrant(ctx, grant);
    }
  }
};

export const getOwnerModelAllowanceInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.optional(v.boolean()),
  },
  returns: ownerModelAllowanceValidator,
  handler: async (ctx, args): Promise<OwnerModelAllowance> => {
    const enforcement = await readOwnerEnforcement(ctx, args.ownerId);
    if (enforcement.status === "suspended") {
      throw new ConvexError({
        code: "OWNER_SUSPENDED",
        message: "This owner is suspended.",
      });
    }
    const resolved = await runResolveManagedModelAllowance(ctx, args);
    const identityLevel = args.isAnonymous
      ? 0
      : await resolveIdentityLevel(ctx, args.ownerId);
    const reservedMicroCents = await reservedGrantMicroCents(
      ctx,
      args.ownerId,
      Date.now(),
    );
    return toOwnerModelAllowance(
      resolved,
      reservedMicroCents,
      undefined,
      identityLevel,
    );
  },
});

export const reserveOwnerSessionModelAllowanceInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.optional(v.boolean()),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(networkClassValidator),
    turnstileToken: v.optional(v.string()),
    jti: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  },
  returns: ownerModelAllowanceValidator,
  handler: async (ctx, args): Promise<OwnerModelAllowance> => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const challengeState = await resolveOwnerSessionChallengeState(ctx, {
      ownerId: args.ownerId,
      isAnonymous: args.isAnonymous === true,
      ...(args.networkClass ? { networkClass: args.networkClass } : {}),
    });
    if (challengeState.enforcementStatus === "suspended") {
      throw new ConvexError({
        code: "OWNER_SUSPENDED",
        message: "This owner is suspended.",
      });
    }
    if (
      challengeState.challengeRequired &&
      !args.turnstileToken?.trim()
    ) {
      throw challengeRequiredError();
    }

    await releaseExpiredOwnerGrants(ctx, args.ownerId, args.issuedAt);
    const resolved = await runResolveManagedModelAllowance(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      isAnonymous: args.isAnonymous,
    });
    if (resolved.access.unlimited || resolved.remainingMicroCents === null) {
      return toOwnerModelAllowance(
        resolved,
        0,
        undefined,
        challengeState.identityLevel,
      );
    }

    const maxRequests = args.isAnonymous
      ? await readAnonymousRequestAllowance(ctx, args)
      : undefined;
    const reservedMicroCents = await reservedGrantMicroCents(
      ctx,
      args.ownerId,
      args.issuedAt,
    );
    const allowance = toOwnerModelAllowance(
      resolved,
      reservedMicroCents,
      maxRequests,
      challengeState.identityLevel,
    );

    const existing = await ctx.db
      .query("gateway_capability_grants")
      .withIndex("by_jti", (q) => q.eq("jti", args.jti))
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Capability grant id already exists.",
      });
    }
    if (args.isAnonymous && maxRequests !== undefined && maxRequests > 0) {
      await consumeDeviceAllowanceBulkAuthorized(ctx, {
        deviceId: anonymousTrialOwnerKey(args.ownerId),
        maxRequests: getMaxAnonRequests(),
        count: maxRequests,
      });
    }
    await ctx.db.insert("gateway_capability_grants", {
      jti: args.jti,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      audience: allowance.audience,
      budgetMicroCents: allowance.budgetMicroCents,
      ...(allowance.maxRequests !== undefined
        ? { maxRequests: allowance.maxRequests }
        : {}),
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
      settledMicroCents: 0,
      settledRequests: 0,
      released: false,
    });
    return allowance;
  },
});

export const releaseExpiredGatewayCapabilityGrantsInternal = internalMutation({
  args: {
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    released: v.number(),
    refundedRequests: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const batchSize = Math.max(
      1,
      Math.min(
        GRANT_RELEASE_BATCH_SIZE,
        Math.floor(args.batchSize ?? GRANT_RELEASE_BATCH_SIZE),
      ),
    );
    const cutoff = now - GATEWAY_GRANT_SETTLEMENT_GRACE_MS;
    const grants = await ctx.db
      .query("gateway_capability_grants")
      .withIndex("by_released_expires", (q) =>
        q.eq("released", false).lt("expiresAt", cutoff),
      )
      .take(batchSize);
    let refundedRequests = 0;
    for (const grant of grants) {
      refundedRequests += await releaseGrant(ctx, grant);
    }
    const hasMore = grants.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        releaseExpiredGatewayCapabilityGrantsRef,
        { now, batchSize },
      );
    }
    return {
      released: grants.length,
      refundedRequests,
      hasMore,
    };
  },
});

let cachedSigningKey: {
  pem: string;
  kid: string;
  key: Promise<CapabilitySigningKey>;
} | null = null;

export const loadCapabilitySigningKey = (): Promise<CapabilitySigningKey> => {
  const pem = process.env[CAPABILITY_SIGNING_KEY_ENV]?.trim();
  const kid = process.env[CAPABILITY_SIGNING_KID_ENV]?.trim();
  if (!pem || !kid) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: `Capability signing is not configured (${CAPABILITY_SIGNING_KEY_ENV} / ${CAPABILITY_SIGNING_KID_ENV}).`,
    });
  }
  if (
    !cachedSigningKey ||
    cachedSigningKey.pem !== pem ||
    cachedSigningKey.kid !== kid
  ) {
    const key = importCapabilitySigningKey(pem.replace(/\\n/g, "\n"), kid);
    key.catch(() => {
      cachedSigningKey = null;
    });
    cachedSigningKey = { pem, kid, key };
  }
  return cachedSigningKey.key;
};

const getOwnerModelAllowanceRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    isAnonymous?: boolean;
    ipHash?: string;
    networkClass?: NetworkClass;
    turnstileToken?: string;
    jti: string;
    issuedAt: number;
    expiresAt: number;
  },
  OwnerModelAllowance
>("gateway_capabilities:reserveOwnerSessionModelAllowanceInternal");

const getOwnerSessionChallengeStateRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    isAnonymous: boolean;
    networkClass?: NetworkClass;
  },
  OwnerSessionChallengeState
>("gateway_capabilities:getOwnerSessionChallengeStateInternal");

export const signSessionCapabilityInternal = internalAction({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(networkClassValidator),
    turnstileToken: v.optional(v.string()),
  },
  returns: v.object({
    capability: v.string(),
    expiresAt: v.number(),
    audience: v.string(),
    budgetMicroCents: v.number(),
    maxRequests: v.optional(v.number()),
    identityLevel: identityLevelValidator,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<
    GatewaySessionCapabilityResponse & { identityLevel: IdentityLevel }
  > => {
    const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
    const challengeState: OwnerSessionChallengeState = await ctx.runQuery(
      getOwnerSessionChallengeStateRef,
      {
        ownerId: args.ownerId,
        isAnonymous: args.isAnonymous,
        ...(args.networkClass ? { networkClass: args.networkClass } : {}),
      },
    );
    const turnstileToken = args.turnstileToken?.trim();
    if (challengeState.challengeRequired) {
      if (!turnstileToken) throw challengeRequiredError();
      const verification = await verifyTurnstileToken(turnstileToken);
      if (!verification.ok) throw challengeRequiredError();
    }
    const signingKey = await loadCapabilitySigningKey();
    const now = Date.now();
    const jti = crypto.randomUUID();
    const expiresAt =
      (Math.floor(now / 1_000) +
        Math.ceil(GATEWAY_SESSION_CAPABILITY_TTL_MS / 1_000)) *
      1_000;
    const allowance: OwnerModelAllowance = await ctx.runMutation(
      getOwnerModelAllowanceRef,
      {
        ownerId: args.ownerId,
        ownerGeneration: generation,
        isAnonymous: args.isAnonymous,
        ...(args.ipHash ? { ipHash: args.ipHash } : {}),
        ...(args.networkClass ? { networkClass: args.networkClass } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
        jti,
        issuedAt: now,
        expiresAt,
      },
    );
    const { token, claims } = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.convex,
        sub: args.ownerId,
        jti,
        gen: generation,
        kind: "session",
        audience: allowance.audience,
        budgetMicroCents: allowance.budgetMicroCents,
        ...(allowance.maxRequests !== undefined
          ? { maxRequests: allowance.maxRequests }
          : {}),
      },
      signingKey,
      { ttlMs: GATEWAY_SESSION_CAPABILITY_TTL_MS, now },
    );
    if (challengeState.enforcementStatus === "challenged") {
      await ctx.runMutation(
        internal.owner_enforcement.setOwnerEnforcementInternal,
        {
          ownerId: args.ownerId,
          status: "ok",
          reason: "turnstile verified",
          actor: "challenge-passed",
        },
      );
    }
    return {
      capability: token,
      expiresAt: claims.exp * 1_000,
      audience: allowance.audience,
      budgetMicroCents: allowance.budgetMicroCents,
      identityLevel: allowance.identityLevel,
      ...(allowance.maxRequests !== undefined
        ? { maxRequests: allowance.maxRequests }
        : {}),
    };
  },
});
