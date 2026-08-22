import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OVERLAP_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SIGNING_ORDER_AHEAD_MS = 5 * 60 * 1000;

const rotationStateValidator = v.union(
  v.literal("prepared"),
  v.literal("active"),
  v.literal("rolled_back"),
  v.literal("retired"),
);

const rotationSummaryValidator = v.object({
  operationId: v.string(),
  state: rotationStateValidator,
  previousKeyId: v.string(),
  newKeyId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  activatedAt: v.optional(v.number()),
  rolledBackAt: v.optional(v.number()),
  retireAfter: v.optional(v.number()),
  retiredAt: v.optional(v.number()),
});

const assertOperationId = (operationId: string) => {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new ConvexError(
      "operationId must be 1-128 URL-safe characters and start with a letter or number",
    );
  }
};

const assertNow = (nowMs: number) => {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new ConvexError("Invalid rotation timestamp");
  }
};

const assertOverlap = (overlapMs: number) => {
  if (
    !Number.isSafeInteger(overlapMs) ||
    overlapMs < 1_000 ||
    overlapMs > MAX_OVERLAP_MS
  ) {
    throw new ConvexError("Invalid JWKS overlap duration");
  }
};

const assertRsaPublicKey = (publicKey: string) => {
  try {
    const parsed = JSON.parse(publicKey) as Record<string, unknown>;
    const privateFields = ["d", "p", "q", "dp", "dq", "qi", "oth"];
    if (
      parsed.kty !== "RSA" ||
      typeof parsed.n !== "string" ||
      parsed.n.length === 0 ||
      typeof parsed.e !== "string" ||
      parsed.e.length === 0 ||
      privateFields.some((field) => field in parsed)
    ) {
      throw new Error("not an RSA public key");
    }
  } catch {
    throw new ConvexError("Generated JWKS public key is invalid");
  }
};

const summarize = (rotation: Doc<"jwksRotation">) => ({
  operationId: rotation.operationId,
  state: rotation.state,
  previousKeyId: String(rotation.previousKeyId),
  newKeyId: String(rotation.newKeyId),
  createdAt: rotation.createdAt,
  updatedAt: rotation.updatedAt,
  activatedAt: rotation.activatedAt,
  rolledBackAt: rotation.rolledBackAt,
  retireAfter: rotation.retireAfter,
  retiredAt: rotation.retiredAt,
});

const sortKeysNewestFirst = (keys: Doc<"jwks">[]) =>
  [...keys].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return b.createdAt - a.createdAt;
    }
    return String(b._id).localeCompare(String(a._id));
  });

const getSigningKey = (keys: Doc<"jwks">[], nowMs: number) => {
  const sorted = sortKeysNewestFirst(keys);
  const newest = sorted[0];
  if (!newest) {
    throw new ConvexError(
      "No database JWKS exists. Issue a token once in dynamic mode before rotating.",
    );
  }
  if (sorted[1]?.createdAt === newest.createdAt) {
    throw new ConvexError(
      "Multiple JWKS records have the same signing order. Refusing an ambiguous rotation.",
    );
  }
  if (newest.expiresAt != null && newest.expiresAt <= nowMs) {
    throw new ConvexError(
      "The newest JWKS record is expired. Refusing automatic key replacement.",
    );
  }
  return newest;
};

const getNextSigningOrder = (keys: Doc<"jwks">[], nowMs: number) => {
  const maximum = Math.max(...keys.map((key) => key.createdAt));
  if (maximum > nowMs + MAX_SIGNING_ORDER_AHEAD_MS) {
    throw new ConvexError(
      "JWKS signing order is unexpectedly far in the future. Refusing rotation.",
    );
  }
  const next = Math.max(maximum + 1, nowMs);
  if (!Number.isSafeInteger(next)) {
    throw new ConvexError("JWKS signing order overflow");
  }
  return next;
};

const getPreparedSigningOrder = (keys: Doc<"jwks">[]) => {
  const minimum = Math.min(...keys.map((key) => key.createdAt));
  if (!Number.isSafeInteger(minimum) || minimum <= Number.MIN_SAFE_INTEGER) {
    throw new ConvexError("JWKS signing order underflow");
  }
  return minimum - 1;
};

const findRotation = async (
  ctx: { db: QueryCtx["db"] },
  operationId: string,
): Promise<Doc<"jwksRotation"> | null> =>
  await ctx.db
    .query("jwksRotation")
    .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
    .unique();

const collectOutstandingRotations = async (ctx: { db: QueryCtx["db"] }) => {
  const states = ["prepared", "active", "rolled_back"] as const;
  const matches = await Promise.all(
    states.map((state) =>
      ctx.db
        .query("jwksRotation")
        .withIndex("by_state", (q) => q.eq("state", state))
        .collect(),
    ),
  );
  return matches.flat() as Doc<"jwksRotation">[];
};

const assertOnlyOutstandingRotation = async (
  ctx: { db: QueryCtx["db"] },
  rotation: Doc<"jwksRotation">,
) => {
  const outstanding = await collectOutstandingRotations(ctx);
  if (outstanding.length !== 1 || outstanding[0]?._id !== rotation._id) {
    throw new ConvexError(
      "JWKS rotation recovery state is ambiguous. Manual inspection is required.",
    );
  }
};

const assertExpectedSigningKey = (
  keys: Doc<"jwks">[],
  expectedId: Id<"jwks">,
  nowMs: number,
) => {
  const signingKey = getSigningKey(keys, nowMs);
  if (signingKey._id !== expectedId) {
    throw new ConvexError(
      "JWKS signing state changed outside the rotation workflow. Refusing to continue.",
    );
  }
};

export const getRotation = query({
  args: { operationId: v.string() },
  returns: v.union(v.null(), rotationSummaryValidator),
  handler: async (ctx, { operationId }) => {
    assertOperationId(operationId);
    const rotation = await findRotation(ctx, operationId);
    return rotation ? summarize(rotation) : null;
  },
});

export const getKeysetStatus = query({
  args: {},
  returns: v.object({
    keyCount: v.number(),
    signingKeyId: v.optional(v.string()),
    signingKeyUsable: v.boolean(),
    outstandingRotation: v.optional(rotationSummaryValidator),
  }),
  handler: async (ctx) => {
    const keys = await ctx.db.query("jwks").collect();
    const sorted = sortKeysNewestFirst(keys);
    const newest = sorted[0];
    const signingKeyUsable = Boolean(
      newest &&
        sorted[1]?.createdAt !== newest.createdAt &&
        (newest.expiresAt == null || newest.expiresAt > Date.now()),
    );
    const outstanding = await collectOutstandingRotations(ctx);
    if (outstanding.length > 1) {
      throw new ConvexError(
        "Multiple unfinished JWKS rotations exist. Manual inspection is required.",
      );
    }
    return {
      keyCount: keys.length,
      signingKeyId: newest ? String(newest._id) : undefined,
      signingKeyUsable,
      outstandingRotation: outstanding[0]
        ? summarize(outstanding[0])
        : undefined,
    };
  },
});

export const checkStaticKeysetMatch = query({
  args: {
    staticKeys: v.array(v.object({ id: v.string(), publicKey: v.string() })),
    staticSigningKeyId: v.string(),
  },
  returns: v.object({
    databaseKeyCount: v.number(),
    databaseSigningKeyId: v.optional(v.string()),
    allStaticKeysMatch: v.boolean(),
    signingKeyMatches: v.boolean(),
    hasOutstandingRotation: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (args.staticKeys.length === 0 || args.staticKeys.length > 100) {
      throw new ConvexError("Static JWKS comparison set has an invalid size");
    }
    const keys = await ctx.db.query("jwks").collect();
    const sorted = sortKeysNewestFirst(keys);
    const newest = sorted[0];
    const signingKeyUsable = Boolean(
      newest &&
      sorted[1]?.createdAt !== newest.createdAt &&
      (newest.expiresAt == null || newest.expiresAt > Date.now()),
    );
    let allStaticKeysMatch = keys.length === args.staticKeys.length;
    for (const expected of args.staticKeys) {
      const id = ctx.db.normalizeId("jwks", expected.id);
      const actual = id ? await ctx.db.get(id) : null;
      if (!actual || actual.publicKey !== expected.publicKey) {
        allStaticKeysMatch = false;
        break;
      }
    }
    const outstanding = await collectOutstandingRotations(ctx);
    return {
      databaseKeyCount: keys.length,
      databaseSigningKeyId: newest ? String(newest._id) : undefined,
      allStaticKeysMatch,
      signingKeyMatches:
        signingKeyUsable && newest?._id === args.staticSigningKeyId,
      hasOutstandingRotation: outstanding.length > 0,
    };
  },
});

/**
 * Insert an inactive candidate and its recovery record atomically. The
 * candidate sorts below every existing key, so Better Auth keeps signing with
 * the old key until `activateRotation` commits.
 */
export const prepareRotation = mutation({
  args: {
    operationId: v.string(),
    nowMs: v.number(),
    publicKey: v.string(),
    privateKey: v.string(),
  },
  returns: rotationSummaryValidator,
  handler: async (ctx, args) => {
    assertOperationId(args.operationId);
    assertNow(args.nowMs);

    const existing = await findRotation(ctx, args.operationId);
    if (existing) {
      return summarize(existing);
    }
    const outstanding = await collectOutstandingRotations(ctx);
    if (outstanding.length > 0) {
      throw new ConvexError(
        "Another JWKS rotation is unfinished. Retire or roll it back first.",
      );
    }
    assertRsaPublicKey(args.publicKey);
    if (args.privateKey.length === 0) {
      throw new ConvexError("Generated JWKS private key is invalid");
    }

    const keys = await ctx.db.query("jwks").collect();
    const previousKey = getSigningKey(keys, args.nowMs);
    const newKeyId = await ctx.db.insert("jwks", {
      publicKey: args.publicKey,
      privateKey: args.privateKey,
      createdAt: getPreparedSigningOrder(keys),
    });
    const rotationId = await ctx.db.insert("jwksRotation", {
      operationId: args.operationId,
      state: "prepared",
      previousKeyId: previousKey._id,
      newKeyId,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    const rotation = await ctx.db.get(rotationId);
    if (!rotation) {
      throw new ConvexError("Failed to persist JWKS rotation recovery state");
    }
    return summarize(rotation);
  },
});

/** Atomically switch signing to the candidate and start the old-key overlap. */
export const activateRotation = mutation({
  args: {
    operationId: v.string(),
    nowMs: v.number(),
    overlapMs: v.number(),
  },
  returns: rotationSummaryValidator,
  handler: async (ctx, args) => {
    assertOperationId(args.operationId);
    assertNow(args.nowMs);
    assertOverlap(args.overlapMs);
    const rotation = await findRotation(ctx, args.operationId);
    if (!rotation) {
      throw new ConvexError("JWKS rotation operation was not prepared");
    }
    if (rotation.state === "retired") {
      return summarize(rotation);
    }
    await assertOnlyOutstandingRotation(ctx, rotation);

    const keys = await ctx.db.query("jwks").collect();
    const previousKey = await ctx.db.get(rotation.previousKeyId);
    const newKey = await ctx.db.get(rotation.newKeyId);
    if (!previousKey || !newKey) {
      throw new ConvexError(
        "JWKS rotation key is missing. Refusing to regenerate or delete keys.",
      );
    }
    if (rotation.state === "active") {
      assertExpectedSigningKey(keys, rotation.newKeyId, args.nowMs);
      if (
        rotation.activatedAt === undefined ||
        rotation.retireAfter === undefined ||
        rotation.retirementTargetKeyId !== rotation.previousKeyId ||
        previousKey.expiresAt !== rotation.retireAfter ||
        newKey.expiresAt !== undefined
      ) {
        throw new ConvexError("Active JWKS rotation metadata is inconsistent");
      }
      return summarize(rotation);
    }
    if (rotation.state !== "prepared") {
      return summarize(rotation);
    }
    assertExpectedSigningKey(keys, rotation.previousKeyId, args.nowMs);

    const retireAfter = args.nowMs + args.overlapMs;
    if (!Number.isSafeInteger(retireAfter)) {
      throw new ConvexError("JWKS retirement timestamp overflow");
    }
    await ctx.db.patch(rotation.newKeyId, {
      createdAt: getNextSigningOrder(keys, args.nowMs),
      expiresAt: undefined,
    });
    await ctx.db.patch(rotation.previousKeyId, { expiresAt: retireAfter });
    await ctx.db.patch(rotation._id, {
      state: "active",
      activatedAt: args.nowMs,
      retireAfter,
      retirementTargetKeyId: rotation.previousKeyId,
      updatedAt: args.nowMs,
    });
    const updated = await ctx.db.get(rotation._id);
    if (!updated) {
      throw new ConvexError("Failed to activate JWKS rotation");
    }
    return summarize(updated);
  },
});

/**
 * Restore the previous signer without destroying the candidate. Tokens minted
 * by the candidate retain a fresh, fully enforced overlap before retirement.
 */
export const rollbackRotation = mutation({
  args: {
    operationId: v.string(),
    nowMs: v.number(),
    overlapMs: v.number(),
  },
  returns: rotationSummaryValidator,
  handler: async (ctx, args) => {
    assertOperationId(args.operationId);
    assertNow(args.nowMs);
    assertOverlap(args.overlapMs);
    const rotation = await findRotation(ctx, args.operationId);
    if (!rotation) {
      throw new ConvexError("JWKS rotation operation does not exist");
    }
    if (rotation.state === "retired") {
      return summarize(rotation);
    }
    await assertOnlyOutstandingRotation(ctx, rotation);

    const keys = await ctx.db.query("jwks").collect();
    const previousKey = await ctx.db.get(rotation.previousKeyId);
    const newKey = await ctx.db.get(rotation.newKeyId);
    if (!previousKey || !newKey) {
      throw new ConvexError(
        "JWKS rollback key is missing. Refusing to regenerate or delete keys.",
      );
    }
    if (rotation.state === "rolled_back") {
      assertExpectedSigningKey(keys, rotation.previousKeyId, args.nowMs);
      if (
        rotation.retireAfter === undefined ||
        rotation.retirementTargetKeyId !== rotation.newKeyId ||
        newKey.expiresAt !== rotation.retireAfter ||
        previousKey.expiresAt !== undefined
      ) {
        throw new ConvexError(
          "Rolled-back JWKS rotation metadata is inconsistent",
        );
      }
      return summarize(rotation);
    }
    if (rotation.state === "prepared") {
      assertExpectedSigningKey(keys, rotation.previousKeyId, args.nowMs);
      await ctx.db.delete(rotation.newKeyId);
      await ctx.db.patch(rotation._id, {
        state: "retired",
        rolledBackAt: args.nowMs,
        retiredAt: args.nowMs,
        retirementTargetKeyId: rotation.newKeyId,
        updatedAt: args.nowMs,
      });
      const canceled = await ctx.db.get(rotation._id);
      if (!canceled) {
        throw new ConvexError("Failed to cancel prepared JWKS rotation");
      }
      return summarize(canceled);
    }

    assertExpectedSigningKey(keys, rotation.newKeyId, args.nowMs);
    const retireAfter = args.nowMs + args.overlapMs;
    if (!Number.isSafeInteger(retireAfter)) {
      throw new ConvexError("JWKS retirement timestamp overflow");
    }
    await ctx.db.patch(rotation.previousKeyId, {
      createdAt: getNextSigningOrder(keys, args.nowMs),
      expiresAt: undefined,
    });
    await ctx.db.patch(rotation.newKeyId, { expiresAt: retireAfter });
    await ctx.db.patch(rotation._id, {
      state: "rolled_back",
      rolledBackAt: args.nowMs,
      retireAfter,
      retirementTargetKeyId: rotation.newKeyId,
      updatedAt: args.nowMs,
    });
    const updated = await ctx.db.get(rotation._id);
    if (!updated) {
      throw new ConvexError("Failed to roll back JWKS rotation");
    }
    return summarize(updated);
  },
});

/** Delete only the scheduled non-signing key, and never before its deadline. */
export const retireRotation = mutation({
  args: { operationId: v.string(), nowMs: v.number() },
  returns: rotationSummaryValidator,
  handler: async (ctx, args) => {
    assertOperationId(args.operationId);
    assertNow(args.nowMs);
    const rotation = await findRotation(ctx, args.operationId);
    if (!rotation) {
      throw new ConvexError("JWKS rotation operation does not exist");
    }
    if (rotation.state === "retired") {
      return summarize(rotation);
    }
    if (rotation.state === "prepared") {
      throw new ConvexError(
        "Prepared JWKS rotation must be rolled back, not retired",
      );
    }
    await assertOnlyOutstandingRotation(ctx, rotation);
    if (
      rotation.retireAfter === undefined ||
      rotation.retirementTargetKeyId === undefined
    ) {
      throw new ConvexError("JWKS retirement metadata is incomplete");
    }
    if (args.nowMs < rotation.retireAfter) {
      throw new ConvexError(
        "JWKS overlap is still active. Retirement is not yet allowed.",
      );
    }

    const keys = await ctx.db.query("jwks").collect();
    const expectedSigningKeyId =
      rotation.state === "active" ? rotation.newKeyId : rotation.previousKeyId;
    assertExpectedSigningKey(keys, expectedSigningKeyId, args.nowMs);
    if (rotation.retirementTargetKeyId === expectedSigningKeyId) {
      throw new ConvexError("Refusing to retire the active JWKS signing key");
    }
    const target = await ctx.db.get(rotation.retirementTargetKeyId);
    if (!target) {
      throw new ConvexError(
        "Scheduled JWKS retirement key is missing. Manual inspection is required.",
      );
    }
    if (target.expiresAt !== rotation.retireAfter) {
      throw new ConvexError("Scheduled JWKS retirement state is inconsistent");
    }

    await ctx.db.delete(rotation.retirementTargetKeyId);
    await ctx.db.patch(rotation._id, {
      state: "retired",
      retiredAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    const updated = await ctx.db.get(rotation._id);
    if (!updated) {
      throw new ConvexError("Failed to record JWKS retirement");
    }
    return summarize(updated);
  },
});
