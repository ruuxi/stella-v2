import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "./owner_lifecycle";

const LEGACY_UPLOAD_AUTHORITY_FENCE_MS = 20 * 60_000;
const SWEEP_PROTOCOL_VERSION = 1;
const LEGACY_ROW_FENCE_BATCH = 32;
const MAX_PAGE_KEYS = 32;
const MAX_EXACT_REFERENCES = 64;
const MAX_KEY_LENGTH = 1_024;
const sha256HexPattern = /^[a-f0-9]{64}$/u;

const migrationControlArgs = {
  fromOwnerId: v.string(),
  toOwnerId: v.string(),
  migrationId: v.string(),
  leaseId: v.string(),
  leaseGeneration: v.number(),
  fromOwnerGeneration: v.string(),
  toOwnerGeneration: v.string(),
  planRevision: v.number(),
  now: v.number(),
} as const;

const purgeControlArgs = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
  leaseId: v.string(),
  mode: v.union(v.literal("reset"), v.literal("delete")),
} as const;

type MigrationControlArgs = {
  fromOwnerId: string;
  toOwnerId: string;
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  planRevision: number;
  now: number;
};

type PurgeControlArgs = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
  mode: "reset" | "delete";
};

type SweepAuthority =
  | { kind: "migration"; args: MigrationControlArgs }
  | { kind: "purge"; args: PurgeControlArgs };

const phaseValidator = v.union(
  v.literal("cleanup"),
  v.literal("verify"),
  v.literal("ready"),
);

const sweepSnapshotValidator = v.object({
  revision: v.number(),
  notBefore: v.number(),
  legacyRowFenceComplete: v.boolean(),
  goal: v.union(v.literal("preserve_refs"), v.literal("empty")),
  phase: phaseValidator,
  targetIndex: v.number(),
  startAfter: v.optional(v.string()),
  targetPrefix: v.optional(v.string()),
});

const pageCursorArgs = {
  expectedRevision: v.number(),
  expectedPhase: v.union(v.literal("cleanup"), v.literal("verify")),
  expectedTargetIndex: v.number(),
  expectedStartAfter: v.optional(v.string()),
} as const;

const staleSweep = (message: string): never => {
  throw new ConvexError({
    code: "STALE_BACKUP_LEGACY_SWEEP",
    message,
  });
};

const requireSweepState = (
  state: Doc<"backup_legacy_r2_sweeps"> | null,
): Doc<"backup_legacy_r2_sweeps"> => {
  if (!state) {
    throw new ConvexError({
      code: "STALE_BACKUP_LEGACY_SWEEP",
      message: "The raw-storage sweep receipt is missing.",
    });
  }
  return state;
};

const repairRequired = (message: string): never => {
  throw new Error(`backup_migration_repair_required: ${message}`);
};

const assertMigrationAuthority = async (
  ctx: MutationCtx,
  args: MigrationControlArgs,
) => {
  const rows = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
      q.eq("fromOwnerId", args.fromOwnerId),
    )
    .take(2);
  const migration = rows[0];
  if (
    rows.length !== 1 ||
    !migration ||
    String(migration._id) !== args.migrationId ||
    migration.toOwnerId !== args.toOwnerId ||
    migration.status !== "running" ||
    migration.leaseId !== args.leaseId ||
    migration.leaseGeneration !== args.leaseGeneration ||
    (migration.leaseExpiresAt ?? 0) <= Date.now() ||
    migration.fromOwnerGeneration !== args.fromOwnerGeneration ||
    migration.toOwnerGeneration !== args.toOwnerGeneration ||
    (migration.planRevision ?? 1) !== args.planRevision
  ) {
    staleSweep(
      "Backup raw-storage cleanup no longer owns the migration lease.",
    );
  }
  await Promise.all([
    assertOwnerDataWriteAllowed(
      ctx,
      args.fromOwnerId,
      args.fromOwnerGeneration,
    ),
    assertOwnerDataWriteAllowed(ctx, args.toOwnerId, args.toOwnerGeneration),
  ]);
};

const assertPurgeAuthority = async (
  ctx: MutationCtx,
  args: PurgeControlArgs,
) => {
  await assertOwnerPurgeLease(ctx, {
    ownerId: args.ownerId,
    operationId: args.operationId,
    generation: args.generation,
    stage: "core",
    leaseId: args.leaseId,
    mode: args.mode,
  });
};

const assertAuthority = async (ctx: MutationCtx, authority: SweepAuthority) => {
  if (authority.kind === "migration") {
    await assertMigrationAuthority(ctx, authority.args);
  } else {
    await assertPurgeAuthority(ctx, authority.args);
  }
};

const scopeKeyFor = (authority: SweepAuthority) =>
  authority.kind === "migration"
    ? `migration:${encodeURIComponent(authority.args.fromOwnerId)}:${authority.args.migrationId}`
    : `purge:${encodeURIComponent(authority.args.ownerId)}:${authority.args.operationId}`;

const ownersFor = (state: Doc<"backup_legacy_r2_sweeps">) => [
  {
    ownerId: state.sourceOwnerId,
    ownerGeneration: state.sourceOwnerGeneration,
  },
  ...(state.destinationOwnerId && state.destinationOwnerGeneration
    ? [
        {
          ownerId: state.destinationOwnerId,
          ownerGeneration: state.destinationOwnerGeneration,
        },
      ]
    : []),
];

const legacyPrefix = (ownerId: string, kind: "objects" | "manifests") =>
  `backups/${encodeURIComponent(ownerId)}/${kind}/`;

const sweepTargets = (state: Doc<"backup_legacy_r2_sweeps">) =>
  ownersFor(state).flatMap((owner) => [
    { ...owner, table: "objects" as const },
    { ...owner, table: "manifests" as const },
  ]);

const currentTarget = (state: Doc<"backup_legacy_r2_sweeps">) => {
  const target = sweepTargets(state)[state.targetIndex];
  if (!target) repairRequired("The durable sweep target cursor is invalid.");
  return target;
};

const snapshot = (state: Doc<"backup_legacy_r2_sweeps">) => ({
  revision: state.revision,
  notBefore: state.notBefore,
  legacyRowFenceComplete: state.legacyRowFenceComplete,
  goal: state.goal,
  phase: state.phase,
  targetIndex: state.targetIndex,
  ...(state.startAfter ? { startAfter: state.startAfter } : {}),
  ...(state.phase === "ready"
    ? {}
    : {
        targetPrefix: legacyPrefix(
          currentTarget(state).ownerId,
          currentTarget(state).table,
        ),
      }),
});

const getState = async (ctx: MutationCtx, authority: SweepAuthority) =>
  await ctx.db
    .query("backup_legacy_r2_sweeps")
    .withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKeyFor(authority)))
    .unique();

const assertStateBinding = (
  state: Doc<"backup_legacy_r2_sweeps">,
  authority: SweepAuthority,
) => {
  if (state.protocolVersion !== SWEEP_PROTOCOL_VERSION) {
    repairRequired("The backup sweep protocol version is unsupported.");
  }
  if (authority.kind === "migration") {
    const args = authority.args;
    if (
      state.kind !== "migration" ||
      state.operationId !== args.migrationId ||
      state.sourceOwnerId !== args.fromOwnerId ||
      state.sourceOwnerGeneration !== args.fromOwnerGeneration ||
      state.destinationOwnerId !== args.toOwnerId ||
      state.destinationOwnerGeneration !== args.toOwnerGeneration ||
      state.planRevision !== args.planRevision
    ) {
      repairRequired(
        "The migration sweep receipt conflicts with its owner plan.",
      );
    }
    return;
  }
  const args = authority.args;
  if (
    state.kind !== "purge" ||
    state.operationId !== args.operationId ||
    state.sourceOwnerId !== args.ownerId ||
    state.sourceOwnerGeneration !== args.generation ||
    state.destinationOwnerId !== undefined ||
    state.destinationOwnerGeneration !== undefined
  ) {
    repairRequired("The purge sweep receipt conflicts with its owner fence.");
  }
};

const latestTrackedUploadExpiry = async (ctx: MutationCtx, ownerId: string) => {
  const [object, manifest, reservation] = await Promise.all([
    ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("backup_upload_reservations")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId),
      )
      .order("desc")
      .first(),
  ]);
  return Math.max(
    0,
    object?.uploadExpiresAt ?? 0,
    manifest?.uploadExpiresAt ?? 0,
    reservation?.uploadExpiresAt ?? 0,
  );
};

const createState = async (ctx: MutationCtx, authority: SweepAuthority) => {
  const now = Date.now();
  const owners =
    authority.kind === "migration"
      ? [authority.args.fromOwnerId, authority.args.toOwnerId]
      : [authority.args.ownerId];
  const latestExpiries = await Promise.all(
    owners.map((ownerId) => latestTrackedUploadExpiry(ctx, ownerId)),
  );
  const notBefore = Math.max(
    now + LEGACY_UPLOAD_AUTHORITY_FENCE_MS,
    ...latestExpiries,
  );
  const values =
    authority.kind === "migration"
      ? {
          scopeKey: scopeKeyFor(authority),
          kind: "migration" as const,
          operationId: authority.args.migrationId,
          sourceOwnerId: authority.args.fromOwnerId,
          sourceOwnerGeneration: authority.args.fromOwnerGeneration,
          destinationOwnerId: authority.args.toOwnerId,
          destinationOwnerGeneration: authority.args.toOwnerGeneration,
          planRevision: authority.args.planRevision,
        }
      : {
          scopeKey: scopeKeyFor(authority),
          kind: "purge" as const,
          operationId: authority.args.operationId,
          sourceOwnerId: authority.args.ownerId,
          sourceOwnerGeneration: authority.args.generation,
        };
  const id = await ctx.db.insert("backup_legacy_r2_sweeps", {
    protocolVersion: SWEEP_PROTOCOL_VERSION,
    revision: 0,
    ...values,
    notBefore,
    legacyRowFenceComplete: false,
    legacyRowFenceTargetIndex: 0,
    goal: "preserve_refs",
    phase: "cleanup",
    targetIndex: 0,
    verifyDirty: false,
    listedCount: 0,
    deletedCount: 0,
    protectedCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  return requireSweepState(created);
};

const fenceNextLegacyRowBatch = async (
  ctx: MutationCtx,
  state: Doc<"backup_legacy_r2_sweeps">,
) => {
  if (state.legacyRowFenceComplete) return state;
  const targets = sweepTargets(state);
  const target = targets[state.legacyRowFenceTargetIndex];
  if (!target) repairRequired("The legacy row-fence cursor is invalid.");
  const rows =
    target.table === "objects"
      ? await ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", target.ownerId).eq("uploadExpiresAt", undefined),
          )
          .take(LEGACY_ROW_FENCE_BATCH + 1)
      : await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", target.ownerId).eq("uploadExpiresAt", undefined),
          )
          .take(LEGACY_ROW_FENCE_BATCH + 1);
  for (const row of rows.slice(0, LEGACY_ROW_FENCE_BATCH)) {
    await ctx.db.patch(row._id, { uploadExpiresAt: state.notBefore });
  }
  const targetComplete = rows.length <= LEGACY_ROW_FENCE_BATCH;
  const nextTargetIndex = targetComplete
    ? state.legacyRowFenceTargetIndex + 1
    : state.legacyRowFenceTargetIndex;
  const legacyRowFenceComplete = nextTargetIndex >= targets.length;
  await ctx.db.patch(state._id, {
    revision: state.revision + 1,
    legacyRowFenceTargetIndex: legacyRowFenceComplete
      ? targets.length
      : nextTargetIndex,
    legacyRowFenceComplete,
    updatedAt: Date.now(),
  });
  const updated = await ctx.db.get(state._id);
  return requireSweepState(updated);
};

const prepareSweep = async (ctx: MutationCtx, authority: SweepAuthority) => {
  await assertAuthority(ctx, authority);
  let state = await getState(ctx, authority);
  if (!state) state = await createState(ctx, authority);
  state = requireSweepState(state);
  assertStateBinding(state, authority);
  state = await fenceNextLegacyRowBatch(ctx, state);
  return snapshot(state);
};

export const prepareMigrationSweepInternal = internalMutation({
  args: migrationControlArgs,
  returns: sweepSnapshotValidator,
  handler: async (ctx, args) =>
    await prepareSweep(ctx, { kind: "migration", args }),
});

export const preparePurgeSweepInternal = internalMutation({
  args: purgeControlArgs,
  returns: sweepSnapshotValidator,
  handler: async (ctx, args) =>
    await prepareSweep(ctx, { kind: "purge", args }),
});

/**
 * After the tracked backup drain has removed every row and escrow, upgrade the
 * purge receipt from "preserve referenced bytes" to a final owner-empty proof.
 * Immutable keys re-owned by an account link remain protected even when their
 * physical key still uses this owner's historical prefix. The receipt itself
 * is retained as the crash-safe completion record.
 */
export const upgradePurgeSweepToEmptyInternal = internalMutation({
  args: purgeControlArgs,
  returns: sweepSnapshotValidator,
  handler: async (ctx, args) => {
    const authority: SweepAuthority = { kind: "purge", args };
    await assertAuthority(ctx, authority);
    const state = requireSweepState(await getState(ctx, authority));
    assertStateBinding(state, authority);
    if (state.goal === "empty") return snapshot(state);
    if (state.phase !== "ready") {
      staleSweep("The reference-preserving raw-storage sweep is incomplete.");
    }
    const [object, manifest, reservation, escrow] = await Promise.all([
      ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .first(),
    ]);
    if (object || manifest || reservation || escrow) {
      repairRequired(
        "A purge attempted its final raw-storage proof before tracked backups were empty.",
      );
    }
    await ctx.db.patch(state._id, {
      revision: state.revision + 1,
      goal: "empty",
      phase: "verify",
      targetIndex: 0,
      startAfter: undefined,
      verifyDirty: false,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(state._id);
    return snapshot(requireSweepState(updated));
  },
});

const assertCursor = (
  state: Doc<"backup_legacy_r2_sweeps">,
  expected: {
    expectedRevision: number;
    expectedPhase: "cleanup" | "verify";
    expectedTargetIndex: number;
    expectedStartAfter?: string;
  },
) => {
  if (
    !state.legacyRowFenceComplete ||
    state.revision !== expected.expectedRevision ||
    state.phase !== expected.expectedPhase ||
    state.targetIndex !== expected.expectedTargetIndex ||
    state.startAfter !== expected.expectedStartAfter ||
    Date.now() < state.notBefore
  ) {
    staleSweep("The raw-storage sweep cursor is no longer current.");
  }
};

const expectedGenerations = (state: Doc<"backup_legacy_r2_sweeps">) =>
  new Map(
    ownersFor(state).map((owner) => [owner.ownerId, owner.ownerGeneration]),
  );

const assertLegacyReferenceSafe = async (
  ctx: MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  keyFingerprint: string | undefined,
) => {
  const escrows = keyFingerprint
    ? await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId_and_keyFingerprint", (q) =>
          q.eq("ownerId", ownerId).eq("keyFingerprint", keyFingerprint),
        )
        .take(2)
    : await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(2);
  const escrow = escrows[0];
  if (
    escrows.length !== 1 ||
    !escrow ||
    (escrow.ownerGeneration !== undefined &&
      escrow.ownerGeneration !== ownerGeneration) ||
    !sha256HexPattern.test(escrow.keyFingerprint) ||
    (keyFingerprint !== undefined && keyFingerprint !== escrow.keyFingerprint)
  ) {
    repairRequired(
      "A legacy backup locator has ambiguous encryption-key ownership.",
    );
  }
};

const assertForeignFinalizedReferenceSafe = async (
  ctx: MutationCtx,
  args: PurgeControlArgs,
  row: Doc<"backup_objects"> | Doc<"backup_manifests">,
) => {
  if (row.ownerGeneration && row.keyFingerprint) {
    const keyFingerprint = row.keyFingerprint;
    const escrows = await ctx.db
      .query("backup_key_escrows")
      .withIndex("by_ownerId_and_keyFingerprint", (q) =>
        q.eq("ownerId", row.ownerId).eq("keyFingerprint", keyFingerprint),
      )
      .take(2);
    if (
      escrows.length === 1 &&
      escrows[0]?.ownerGeneration === row.ownerGeneration &&
      sha256HexPattern.test(escrows[0].keyFingerprint)
    ) {
      return;
    }
  }

  // A bounded migration can move a finalized row before its escrow merge. It
  // is safe to retain that key without a destination escrow only in the exact
  // A-purge dependency created by an active B reset/delete; B's tracked drain
  // owns the row and will delete the key next. An independent A deletion must
  // block, otherwise removing A's escrow would strand B's restore metadata.
  const migrations = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
      q.eq("fromOwnerId", args.ownerId).eq("toOwnerId", row.ownerId),
    )
    .take(2);
  const migration = migrations[0];
  const dependency = migration?.sourcePurgeDependency;
  if (
    migrations.length !== 1 ||
    !migration ||
    !dependency ||
    dependency.sourceOperationId !== args.operationId ||
    dependency.sourceGeneration !== args.generation
  ) {
    repairRequired(
      "A foreign raw backup reference has no destination escrow or exact purge dependency.",
    );
  }
  const exactDependency = dependency!;
  const [destinationLifecycle, destinationJob] = await Promise.all([
    ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", row.ownerId))
      .unique(),
    ctx.db
      .query("cloud_owner_purge_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", row.ownerId))
      .unique(),
  ]);
  if (
    !destinationLifecycle ||
    destinationLifecycle.state === "open" ||
    destinationLifecycle.operationId !==
      exactDependency.destinationOperationId ||
    destinationLifecycle.generation !== exactDependency.destinationGeneration ||
    !destinationJob ||
    destinationJob.operationId !== exactDependency.destinationOperationId ||
    destinationJob.generation !== exactDependency.destinationGeneration ||
    destinationJob.stage === "complete"
  ) {
    repairRequired(
      "A foreign raw backup reference has a stale destination purge dependency.",
    );
  }
};

const classifyPage = async (
  ctx: MutationCtx,
  authority: SweepAuthority,
  expected: {
    expectedRevision: number;
    expectedPhase: "cleanup" | "verify";
    expectedTargetIndex: number;
    expectedStartAfter?: string;
    keys: string[];
  },
) => {
  await assertAuthority(ctx, authority);
  const state = requireSweepState(await getState(ctx, authority));
  assertStateBinding(state, authority);
  assertCursor(state, expected);
  if (expected.keys.length > MAX_PAGE_KEYS) {
    repairRequired("The raw-storage listing page exceeds its bounded size.");
  }
  const target = currentTarget(state);
  const prefix = legacyPrefix(target.ownerId, target.table);
  let previous = expected.expectedStartAfter;
  for (const key of expected.keys) {
    if (
      !key ||
      key.length > MAX_KEY_LENGTH ||
      !key.startsWith(prefix) ||
      (previous !== undefined && key <= previous)
    ) {
      repairRequired("The raw-storage listing returned an invalid key order.");
    }
    previous = key;
  }

  const generations = expectedGenerations(state);
  const legacyChecks = new Set<string>();
  const deletableKeys: string[] = [];
  let protectedCount = 0;
  for (const key of expected.keys) {
    const [objects, manifests, reservations] = await Promise.all([
      ctx.db
        .query("backup_objects")
        .withIndex("by_r2Key", (q) => q.eq("r2Key", key))
        .take(MAX_EXACT_REFERENCES + 1),
      ctx.db
        .query("backup_manifests")
        .withIndex("by_manifestR2Key", (q) => q.eq("manifestR2Key", key))
        .take(MAX_EXACT_REFERENCES + 1),
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_r2Key", (q) => q.eq("r2Key", key))
        .take(MAX_EXACT_REFERENCES + 1),
    ]);
    if (
      objects.length > 1 ||
      manifests.length > 1 ||
      reservations.length > 1 ||
      objects.length > MAX_EXACT_REFERENCES ||
      manifests.length > MAX_EXACT_REFERENCES ||
      reservations.length > MAX_EXACT_REFERENCES ||
      (objects.length > 0 && manifests.length > 0)
    ) {
      repairRequired("A raw backup locator has conflicting references.");
    }
    const finalizedRows: Array<
      Doc<"backup_objects"> | Doc<"backup_manifests">
    > = [...objects, ...manifests];
    for (const row of finalizedRows) {
      const expectedGeneration = generations.get(row.ownerId);
      if (authority.kind === "purge") {
        if (row.ownerId !== authority.args.ownerId) {
          await assertForeignFinalizedReferenceSafe(ctx, authority.args, row);
        }
        continue;
      }
      if (expectedGeneration === undefined) {
        throw new Error(
          "backup_migration_repair_required: A raw backup locator is referenced by another owner.",
        );
      }
      if (row.ownerGeneration === undefined) {
        const legacyCheck = `${row.ownerId}\u0000${row.keyFingerprint ?? ""}`;
        if (!legacyChecks.has(legacyCheck)) {
          await assertLegacyReferenceSafe(
            ctx,
            row.ownerId,
            expectedGeneration,
            row.keyFingerprint,
          );
          legacyChecks.add(legacyCheck);
        }
      } else if (row.ownerGeneration !== expectedGeneration) {
        repairRequired("A raw backup locator belongs to a stale generation.");
      }
    }
    for (const row of reservations) {
      const expectedGeneration = generations.get(row.ownerId);
      if (
        authority.kind === "purge" &&
        row.ownerId !== authority.args.ownerId
      ) {
        repairRequired(
          "A raw backup locator has an out-of-scope upload reservation.",
        );
      }
      if (
        expectedGeneration === undefined ||
        (authority.kind === "migration" &&
          row.ownerGeneration !== expectedGeneration)
      ) {
        repairRequired(
          "A raw backup locator has an out-of-scope upload reservation.",
        );
      }
    }
    const object = objects[0];
    const manifest = manifests[0];
    const reservation = reservations[0];
    if (
      reservation &&
      ((object &&
        (reservation.kind !== "object" ||
          reservation.ownerId !== object.ownerId ||
          reservation.objectId !== object.objectId ||
          (object.keyFingerprint !== undefined &&
            reservation.keyFingerprint !== object.keyFingerprint))) ||
        (manifest &&
          (reservation.kind !== "manifest" ||
            reservation.ownerId !== manifest.ownerId ||
            reservation.snapshotId !== manifest.snapshotId ||
            (manifest.keyFingerprint !== undefined &&
              reservation.keyFingerprint !== manifest.keyFingerprint))))
    ) {
      repairRequired(
        "A raw backup locator reservation conflicts with finalized authority.",
      );
    }
    if (objects.length + manifests.length + reservations.length > 0) {
      const hasPurgedOwnerReference = [
        ...objects,
        ...manifests,
        ...reservations,
      ].some((row) => row.ownerId === state.sourceOwnerId);
      if (state.goal === "empty" && hasPurgedOwnerReference) {
        repairRequired(
          "A purge-empty raw-storage sweep still has references owned by the purged account.",
        );
      }
      // Immutable legacy locators retain their original owner prefix during
      // account linking. A source purge must preserve an exact, generation-
      // validated destination reference; physical prefix emptiness would
      // destroy the migrated restore point. `empty` therefore proves there
      // are no source-owned or unreferenced bytes, not that the legacy prefix
      // contains no globally referenced object.
      protectedCount += 1;
    } else {
      deletableKeys.push(key);
    }
  }
  return { deletableKeys, protectedCount };
};

const classificationResultValidator = v.object({
  deletableKeys: v.array(v.string()),
  protectedCount: v.number(),
});

export const classifyMigrationSweepPageInternal = internalMutation({
  args: {
    ...migrationControlArgs,
    ...pageCursorArgs,
    keys: v.array(v.string()),
  },
  returns: classificationResultValidator,
  handler: async (ctx, args) =>
    await classifyPage(
      ctx,
      { kind: "migration", args },
      {
        expectedRevision: args.expectedRevision,
        expectedPhase: args.expectedPhase,
        expectedTargetIndex: args.expectedTargetIndex,
        expectedStartAfter: args.expectedStartAfter,
        keys: args.keys,
      },
    ),
});

export const classifyPurgeSweepPageInternal = internalMutation({
  args: {
    ...purgeControlArgs,
    ...pageCursorArgs,
    keys: v.array(v.string()),
  },
  returns: classificationResultValidator,
  handler: async (ctx, args) =>
    await classifyPage(
      ctx,
      { kind: "purge", args },
      {
        expectedRevision: args.expectedRevision,
        expectedPhase: args.expectedPhase,
        expectedTargetIndex: args.expectedTargetIndex,
        expectedStartAfter: args.expectedStartAfter,
        keys: args.keys,
      },
    ),
});

const armSweepDeletion = async (
  ctx: MutationCtx,
  authority: SweepAuthority,
  expected: {
    expectedRevision: number;
    expectedPhase: "cleanup" | "verify";
    expectedTargetIndex: number;
    expectedStartAfter?: string;
    keys: string[];
    deletableKeys: string[];
  },
) => {
  await assertAuthority(ctx, authority);
  const state = requireSweepState(await getState(ctx, authority));
  assertStateBinding(state, authority);
  assertCursor(state, expected);
  const classification = await classifyPage(ctx, authority, expected);
  if (
    classification.deletableKeys.length === 0 ||
    classification.deletableKeys.length !== expected.deletableKeys.length ||
    !classification.deletableKeys.every(
      (key, index) => key === expected.deletableKeys[index],
    )
  ) {
    repairRequired("The raw-storage deletion arm is malformed.");
  }
  if (state.phase === "verify" && !state.verifyDirty) {
    // This bit must become durable before any irreversible R2 call. It does
    // not advance the cursor revision: if DELETE + HEAD succeeds but the page
    // acknowledgement is lost, the same page can be replayed while the bit
    // forces a complete subsequent zero-deletion verification pass.
    await ctx.db.patch(state._id, {
      verifyDirty: true,
      updatedAt: Date.now(),
    });
  }
  return null;
};

const deletionArmArgs = {
  ...pageCursorArgs,
  keys: v.array(v.string()),
  deletableKeys: v.array(v.string()),
} as const;

export const armMigrationSweepDeletionInternal = internalMutation({
  args: { ...migrationControlArgs, ...deletionArmArgs },
  returns: v.null(),
  handler: async (ctx, args) =>
    await armSweepDeletion(
      ctx,
      { kind: "migration", args },
      {
        expectedRevision: args.expectedRevision,
        expectedPhase: args.expectedPhase,
        expectedTargetIndex: args.expectedTargetIndex,
        expectedStartAfter: args.expectedStartAfter,
        keys: args.keys,
        deletableKeys: args.deletableKeys,
      },
    ),
});

export const armPurgeSweepDeletionInternal = internalMutation({
  args: { ...purgeControlArgs, ...deletionArmArgs },
  returns: v.null(),
  handler: async (ctx, args) =>
    await armSweepDeletion(
      ctx,
      { kind: "purge", args },
      {
        expectedRevision: args.expectedRevision,
        expectedPhase: args.expectedPhase,
        expectedTargetIndex: args.expectedTargetIndex,
        expectedStartAfter: args.expectedStartAfter,
        keys: args.keys,
        deletableKeys: args.deletableKeys,
      },
    ),
});

const advanceArgs = {
  ...pageCursorArgs,
  keys: v.array(v.string()),
  confirmedDeletedKeys: v.array(v.string()),
  isTruncated: v.boolean(),
} as const;

const advanceSweep = async (
  ctx: MutationCtx,
  authority: SweepAuthority,
  args: {
    expectedRevision: number;
    expectedPhase: "cleanup" | "verify";
    expectedTargetIndex: number;
    expectedStartAfter?: string;
    keys: string[];
    confirmedDeletedKeys: string[];
    isTruncated: boolean;
  },
) => {
  await assertAuthority(ctx, authority);
  const state = requireSweepState(await getState(ctx, authority));
  assertStateBinding(state, authority);
  assertCursor(state, args);
  const classification = await classifyPage(ctx, authority, {
    expectedRevision: args.expectedRevision,
    expectedPhase: args.expectedPhase,
    expectedTargetIndex: args.expectedTargetIndex,
    expectedStartAfter: args.expectedStartAfter,
    keys: args.keys,
  });
  const confirmedDeletedKeysMatch =
    classification.deletableKeys.length === args.confirmedDeletedKeys.length &&
    classification.deletableKeys.every(
      (key, index) => key === args.confirmedDeletedKeys[index],
    );
  const expectedNextStartAfter = args.keys[args.keys.length - 1];
  if (
    !confirmedDeletedKeysMatch ||
    (args.isTruncated &&
      (!expectedNextStartAfter ||
        (args.expectedStartAfter !== undefined &&
          expectedNextStartAfter <= args.expectedStartAfter)))
  ) {
    repairRequired("The raw-storage page acknowledgement is malformed.");
  }

  const targets = sweepTargets(state);
  let phase = state.phase;
  let targetIndex = state.targetIndex;
  let startAfter = args.isTruncated ? expectedNextStartAfter : undefined;
  let verifyDirty =
    state.verifyDirty ||
    (phase === "verify" && args.confirmedDeletedKeys.length > 0);
  if (!args.isTruncated) {
    targetIndex += 1;
    startAfter = undefined;
    if (targetIndex >= targets.length) {
      if (phase === "cleanup") {
        phase = "verify";
        targetIndex = 0;
        verifyDirty = false;
      } else if (verifyDirty) {
        // A verification pass that discovered and deleted an orphan is not the
        // final absence proof. Restart from the first prefix and require one
        // complete zero-deletion verification pass.
        phase = "verify";
        targetIndex = 0;
        verifyDirty = false;
      } else {
        phase = "ready";
        targetIndex = targets.length;
      }
    }
  }
  await ctx.db.patch(state._id, {
    revision: state.revision + 1,
    phase,
    targetIndex,
    startAfter,
    verifyDirty,
    listedCount: state.listedCount + args.keys.length,
    deletedCount: state.deletedCount + args.confirmedDeletedKeys.length,
    protectedCount: state.protectedCount + classification.protectedCount,
    updatedAt: Date.now(),
  });
  const updated = await ctx.db.get(state._id);
  return snapshot(requireSweepState(updated));
};

export const advanceMigrationSweepInternal = internalMutation({
  args: { ...migrationControlArgs, ...advanceArgs },
  returns: sweepSnapshotValidator,
  handler: async (ctx, args) =>
    await advanceSweep(ctx, { kind: "migration", args }, args),
});

export const advancePurgeSweepInternal = internalMutation({
  args: { ...purgeControlArgs, ...advanceArgs },
  returns: sweepSnapshotValidator,
  handler: async (ctx, args) =>
    await advanceSweep(ctx, { kind: "purge", args }, args),
});

export const purgeOwnerAbandonedSweepReceiptsInternal = internalMutation({
  args: purgeControlArgs,
  returns: v.object({ hasMore: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertPurgeAuthority(ctx, args);
    const [asSource, asDestination] = await Promise.all([
      ctx.db
        .query("backup_legacy_r2_sweeps")
        .withIndex("by_sourceOwnerId", (q) =>
          q.eq("sourceOwnerId", args.ownerId),
        )
        .take(LEGACY_ROW_FENCE_BATCH + 1),
      ctx.db
        .query("backup_legacy_r2_sweeps")
        .withIndex("by_destinationOwnerId", (q) =>
          q.eq("destinationOwnerId", args.ownerId),
        )
        .take(LEGACY_ROW_FENCE_BATCH + 1),
    ]);
    const candidates = [
      ...new Map(
        [...asSource, ...asDestination]
          .filter(
            (row) =>
              !(row.kind === "purge" && row.operationId === args.operationId),
          )
          .map((row) => [String(row._id), row]),
      ).values(),
    ];
    let deleted = 0;
    for (const row of candidates.slice(0, LEGACY_ROW_FENCE_BATCH)) {
      if (row.kind === "migration") {
        const exact = await ctx.db.get(
          row.operationId as Id<"auth_owner_migrations">,
        );
        if (
          exact?.fromOwnerId === row.sourceOwnerId &&
          exact.toOwnerId === row.destinationOwnerId &&
          (exact.status === "pending" || exact.status === "running")
        ) {
          repairRequired(
            "An active ownership migration still owns a backup sweep receipt.",
          );
        }
      }
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return {
      deleted,
      hasMore:
        asSource.length > LEGACY_ROW_FENCE_BATCH ||
        asDestination.length > LEGACY_ROW_FENCE_BATCH ||
        candidates.length > LEGACY_ROW_FENCE_BATCH,
    };
  },
});
