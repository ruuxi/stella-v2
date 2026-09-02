import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  assertOwnerMigrationWriteAllowed,
  hasOwnerMigrationSourceFence,
  isAnonymousIdentity,
  requireSensitiveUserIdentity,
} from "./auth";
import { resolveCurrentDeviceId } from "./device_identity";
import { resolveBuilderEndpoint } from "./lib/builder_turns";
import { scheduleOwnerSnapshotChanged } from "./lib/owner_snapshot_notify";
import {
  executionCapabilityValidator,
  executionDispatchStateValidator,
  executionIngressValidator,
  executionPlacementValidator,
  executionRequestKindValidator,
  executionSubjectValidator,
  executionTargetModeValidator,
  type ExecutionCapability,
} from "./schema/execution_placement";

/**
 * Execution devices, from Convex's side.
 *
 * Placement itself — presence sockets, offers, claims, the cloud fallback —
 * lives in the cloud-builder's owner gate Durable Object
 * (`@stella/contracts/turn-plane/placement`). Convex keeps only what a
 * control plane must own: which desktops the owner has registered for remote
 * execution and the public key that authenticates their presence socket
 * (served to the gate in the owner snapshot), plus a read-only projection of
 * the gate's dispatch rows for the activity list.
 *
 * There is deliberately no lease here. A device row says "this key may
 * present itself as this device"; whether that device is *online* is the
 * gate's socket, and Convex never answers that question.
 */

const MAX_DEVICE_ID_LENGTH = 256;
const MAX_DEVICE_NAME_LENGTH = 96;
const MAX_PLATFORM_LENGTH = 32;
const MAX_DEVICE_PUBLIC_KEY_LENGTH = 512;
const MAX_EXECUTION_CAPABILITIES = 8;
const MAX_ACTIVITY_ROWS = 100;
/** Bounded so a corrupted owner can never make this query unbounded. */
export const MAX_EXECUTION_DEVICES = 64;

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

function forbidden(message: string): never {
  throw new ConvexError({ code: "FORBIDDEN", message });
}

const boundedTrimmed = (value: string, field: string, max: number): string => {
  const trimmed = value.trim();
  if (!trimmed) invalid(`${field} is required.`);
  if (trimmed.length > max) invalid(`${field} exceeds its maximum length.`);
  return trimmed;
};

const normalizeCapabilities = (
  capabilities: readonly ExecutionCapability[],
): ExecutionCapability[] => {
  const unique = [...new Set(capabilities)];
  if (unique.length > MAX_EXECUTION_CAPABILITIES) {
    invalid("Execution capabilities exceed the supported set.");
  }
  return unique.sort();
};

const requirePlacementOwner = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    forbidden("Sign in with an account to use execution placement.");
  }
  if (await hasOwnerMigrationSourceFence(ctx, identity.tokenIdentifier)) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATED",
      message:
        "This session was linked to another account. Refresh authentication and retry.",
    });
  }
  return identity.tokenIdentifier;
};

const loadDevice = (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deviceId: string,
) =>
  ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();

// ---------------------------------------------------------------------------
// Identity + device registration
// ---------------------------------------------------------------------------

/**
 * What a desktop needs before it can open its presence socket: who it is to
 * the control plane, the generation its writes are fenced on, the device id
 * that survived any identity succession, and the origin of the owner gate.
 */
export const getMyExecutionPlacementIdentity = query({
  args: { deviceId: v.optional(v.string()) },
  returns: v.object({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.optional(v.string()),
    builderOrigin: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const requested = args.deviceId?.trim();
    const deviceId = requested
      ? await resolveCurrentDeviceId(ctx, ownerId, requested)
      : undefined;
    const builderOrigin = process.env.CLOUD_BUILDER_URL?.trim().replace(
      /\/+$/,
      "",
    );
    return {
      ownerId,
      ownerGeneration: lifecycle.generation,
      ...(deviceId ? { deviceId } : {}),
      ...(builderOrigin ? { builderOrigin } : {}),
    };
  },
});

/**
 * Binds (or rotates) the Ed25519 key a desktop signs its presence-socket
 * proof with, and records the label and capabilities the owner snapshot
 * carries to the gate. The caller already holds an authenticated account
 * session, so a rotation is the owner replacing their own key — the gate
 * fails the next `proof` frame from a stale key rather than this mutation.
 */
export const registerMyExecutionDevice = mutation({
  args: {
    deviceId: v.string(),
    devicePublicKey: v.string(),
    deviceName: v.optional(v.string()),
    platform: v.optional(v.string()),
    capabilities: v.optional(v.array(executionCapabilityValidator)),
  },
  returns: v.object({
    deviceId: v.string(),
    ownerGeneration: v.string(),
    remoteExecutionEnabled: v.boolean(),
    rotated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    const lifecycle = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const deviceId = boundedTrimmed(
      args.deviceId,
      "deviceId",
      MAX_DEVICE_ID_LENGTH,
    );
    const devicePublicKey = boundedTrimmed(
      args.devicePublicKey,
      "devicePublicKey",
      MAX_DEVICE_PUBLIC_KEY_LENGTH,
    );
    const deviceName = args.deviceName?.trim()
      ? boundedTrimmed(args.deviceName, "deviceName", MAX_DEVICE_NAME_LENGTH)
      : undefined;
    const platform = args.platform?.trim()
      ? boundedTrimmed(args.platform, "platform", MAX_PLATFORM_LENGTH)
      : undefined;
    const capabilities = normalizeCapabilities(args.capabilities ?? []);
    const now = Date.now();
    const device = await loadDevice(ctx, ownerId, deviceId);
    if (!device) {
      const existing = await ctx.db
        .query("devices")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(MAX_EXECUTION_DEVICES + 1);
      if (existing.length > MAX_EXECUTION_DEVICES) {
        throw new ConvexError({
          code: "RESOURCE_EXHAUSTED",
          message: "This account has registered too many devices.",
        });
      }
      await ctx.db.insert("devices", {
        ownerId,
        ownerGeneration: lifecycle.generation,
        deviceId,
        devicePublicKey,
        ...(deviceName ? { deviceName } : {}),
        ...(platform ? { platform } : {}),
        executionCapabilities: capabilities,
        executionRegisteredAt: now,
      });
      await scheduleOwnerSnapshotChanged(ctx, ownerId, "device");
      return {
        deviceId,
        ownerGeneration: lifecycle.generation,
        remoteExecutionEnabled: true,
        rotated: false,
      };
    }
    const rotated = Boolean(
      device.devicePublicKey && device.devicePublicKey !== devicePublicKey,
    );
    await ctx.db.patch(device._id, {
      ownerGeneration: lifecycle.generation,
      devicePublicKey,
      ...(deviceName ? { deviceName } : {}),
      ...(platform ? { platform } : {}),
      executionCapabilities: capabilities,
      executionRegisteredAt: now,
    });
    // The snapshot carries the key, the label and the enabled flag; a re-
    // registration that changed none of them costs the gate nothing to skip.
    if (
      rotated ||
      device.devicePublicKey !== devicePublicKey ||
      (deviceName !== undefined && device.deviceName !== deviceName)
    ) {
      await scheduleOwnerSnapshotChanged(ctx, ownerId, "device");
    }
    return {
      deviceId,
      ownerGeneration: lifecycle.generation,
      remoteExecutionEnabled: device.remoteExecutionEnabled !== false,
      rotated,
    };
  },
});

/** Owner control: stop offering this desktop as an execution destination. */
export const setMyExecutionDeviceRemoteEnabled = mutation({
  args: { deviceId: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const deviceId = boundedTrimmed(
      args.deviceId,
      "deviceId",
      MAX_DEVICE_ID_LENGTH,
    );
    const device = await loadDevice(ctx, ownerId, deviceId);
    if (!device) forbidden("Execution device not found.");
    if (device.remoteExecutionEnabled === args.enabled) return null;
    await ctx.db.patch(device._id, { remoteExecutionEnabled: args.enabled });
    await scheduleOwnerSnapshotChanged(ctx, ownerId, "device");
    return null;
  },
});

/** Forget a desktop entirely: its key stops authenticating a presence socket. */
export const removeMyExecutionDevice = mutation({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    const deviceId = boundedTrimmed(
      args.deviceId,
      "deviceId",
      MAX_DEVICE_ID_LENGTH,
    );
    const device = await loadDevice(ctx, ownerId, deviceId);
    if (!device) return null;
    await ctx.db.delete(device._id);
    await scheduleOwnerSnapshotChanged(ctx, ownerId, "device");
    return null;
  },
});

// ---------------------------------------------------------------------------
// Dispatch activity (projection of the owner gate's rows)
// ---------------------------------------------------------------------------

const dispatchSummaryValidator = v.object({
  dispatchId: v.string(),
  idempotencyKey: v.string(),
  kind: executionRequestKindValidator,
  ingress: executionIngressValidator,
  subject: executionSubjectValidator,
  requestedTargetMode: v.optional(executionTargetModeValidator),
  requestedExecutorDeviceId: v.optional(v.string()),
  conversationId: v.string(),
  parentTurnId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  state: executionDispatchStateValidator,
  placement: v.optional(executionPlacementValidator),
  executorDeviceId: v.optional(v.string()),
  executorPresenceSessionId: v.optional(v.string()),
  revision: v.number(),
  fallbackReason: v.optional(v.string()),
  cancelRequestId: v.optional(v.string()),
  cancelReason: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  cloudTurnId: v.optional(v.string()),
  cloudThreadId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const executionActivityValidator = v.object({
  dispatch: dispatchSummaryValidator,
  placementLabel: v.union(
    v.literal("routing"),
    v.literal("computer"),
    v.literal("cloud"),
  ),
});

export const projectDispatchRow = (row: Doc<"cloud_dispatches">) => ({
  dispatchId: row.dispatchId,
  idempotencyKey: row.idempotencyKey,
  kind: row.kind,
  ingress: row.ingress,
  subject: row.subject,
  ...(row.requestedTargetMode !== undefined
    ? { requestedTargetMode: row.requestedTargetMode }
    : {}),
  ...(row.requestedExecutorDeviceId !== undefined
    ? { requestedExecutorDeviceId: row.requestedExecutorDeviceId }
    : {}),
  conversationId: row.conversationId,
  ...(row.parentTurnId !== undefined ? { parentTurnId: row.parentTurnId } : {}),
  ...(row.threadId !== undefined ? { threadId: row.threadId } : {}),
  state: row.state,
  ...(row.placement !== undefined ? { placement: row.placement } : {}),
  ...(row.executorDeviceId !== undefined
    ? { executorDeviceId: row.executorDeviceId }
    : {}),
  ...(row.executorPresenceSessionId !== undefined
    ? { executorPresenceSessionId: row.executorPresenceSessionId }
    : {}),
  revision: row.revision,
  ...(row.fallbackReason !== undefined
    ? { fallbackReason: row.fallbackReason }
    : {}),
  ...(row.cancelRequestId !== undefined
    ? { cancelRequestId: row.cancelRequestId }
    : {}),
  ...(row.cancelReason !== undefined ? { cancelReason: row.cancelReason } : {}),
  ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
  ...(row.errorMessage !== undefined ? { errorMessage: row.errorMessage } : {}),
  ...(row.cloudTurnId !== undefined ? { cloudTurnId: row.cloudTurnId } : {}),
  ...(row.cloudThreadId !== undefined
    ? { cloudThreadId: row.cloudThreadId }
    : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const listMyExecutionActivity = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(executionActivityValidator),
  handler: async (ctx, args) => {
    const ownerId = await requirePlacementOwner(ctx);
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 50), 1),
      MAX_ACTIVITY_ROWS,
    );
    const rows = await ctx.db
      .query("cloud_dispatches")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(limit);
    return rows.map((row) => ({
      dispatch: projectDispatchRow(row),
      placementLabel: (row.placement ?? "routing") as
        | "routing"
        | "computer"
        | "cloud",
    }));
  },
});
