import { ConvexError, v } from "convex/values";
import {
  BUILDER_OWNER_SNAPSHOT_CHANGED_PATH,
  OWNER_SNAPSHOT_VERSION,
  type OwnerSnapshot,
  type OwnerSnapshotChangedRequest,
} from "@stella/contracts/turn-plane/owner-snapshot";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { hasOwnerMigrationWriteFence } from "./auth";
import { resolveCloudPlan, resolveOwnerExecutionInMutation } from "./cloud_apps";
import { CLOUD_ENGINE_PROVIDERS } from "./cloud_engines";
import type { OwnerModelAllowance } from "./gateway_capabilities";
import { resolveBuilderEndpoint } from "./lib/builder_turns";
import {
  cloudExecutionSelectionValidator,
  DEFAULT_CLOUD_EXECUTION,
  type CloudExecutionSelection,
} from "./lib/cloud_execution";
import { readOwnerDataAccessState } from "./owner_lifecycle";
import { executionCapabilityValidator } from "./schema/execution_placement";
import { managedModelAudienceValidator } from "./schema/gateway";

/**
 * The owner snapshot: the one control-plane read the cloud-builder's owner
 * gate performs (`@stella/contracts/turn-plane/owner-snapshot`). Everything a
 * turn admission needs to know about an owner — write fence and generation,
 * plan quotas, model allowance, default execution, execution devices and
 * their public keys, paired phones — in one document the gate caches for
 * `ttlMs` and Convex invalidates on change.
 */

export const OWNER_SNAPSHOT_TTL_MS = 300_000;
const MAX_PAIRED_DEVICES = 100;
/** Matches `MAX_EXECUTION_DEVICES` in execution_placement.ts. */
const MAX_EXECUTION_DEVICES = 64;

const laneQuotaValidator = v.object({
  burstStarts: v.number(),
  dailyTurns: v.number(),
  concurrent: v.number(),
});

const connectedEngineValidator = v.union(
  v.literal("anthropic"),
  v.literal("openai-codex"),
);

const pairedDeviceValidator = v.object({
  mobileDeviceId: v.string(),
  desktopDeviceId: v.string(),
  /**
   * The pairing proof's HMAC key (`sha256hex(pairSecret)`). The worker
   * verifies the phone's `X-Stella-Mobile-Pair-Proof` header with it instead
   * of calling back into Convex on every mobile submit.
   */
  mobilePublicKey: v.optional(v.string()),
});

const executionDeviceValidator = v.object({
  deviceId: v.string(),
  publicKey: v.string(),
  remoteExecutionEnabled: v.boolean(),
  label: v.optional(v.string()),
  capabilities: v.optional(v.array(executionCapabilityValidator)),
});

export const ownerSnapshotValidator = v.object({
  v: v.literal(1),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  writable: v.boolean(),
  plan: v.union(v.literal("free"), v.literal("go"), v.literal("pro")),
  unlimited: v.boolean(),
  quotas: v.object({ chat: laneQuotaValidator, agent: laneQuotaValidator }),
  allowance: v.object({
    audience: managedModelAudienceValidator,
    budgetMicroCents: v.number(),
    maxRequests: v.optional(v.number()),
  }),
  execution: cloudExecutionSelectionValidator,
  pairedDevices: v.optional(v.array(pairedDeviceValidator)),
  devices: v.optional(v.array(executionDeviceValidator)),
  connectedEngines: v.optional(v.array(connectedEngineValidator)),
  fetchedAt: v.number(),
  ttlMs: v.number(),
});

type OwnerSnapshotFields = {
  ownerId: string;
  ownerGeneration: string;
  writable: boolean;
  plan: OwnerSnapshot["plan"];
  unlimited: boolean;
  quotas: OwnerSnapshot["quotas"];
  execution: CloudExecutionSelection;
  pairedDevices: NonNullable<OwnerSnapshot["pairedDevices"]>;
  devices: NonNullable<OwnerSnapshot["devices"]>;
  connectedEngines: Array<"anthropic" | "openai-codex">;
};

const ownerSnapshotFieldsValidator = v.object({
  ownerId: v.string(),
  ownerGeneration: v.string(),
  writable: v.boolean(),
  plan: v.union(v.literal("free"), v.literal("go"), v.literal("pro")),
  unlimited: v.boolean(),
  quotas: v.object({ chat: laneQuotaValidator, agent: laneQuotaValidator }),
  execution: cloudExecutionSelectionValidator,
  pairedDevices: v.array(pairedDeviceValidator),
  devices: v.array(executionDeviceValidator),
  connectedEngines: v.array(connectedEngineValidator),
});

/** Everything except the allowance, which needs a mutation (usage windows). */
export const getOwnerSnapshotFieldsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: ownerSnapshotFieldsValidator,
  handler: async (ctx, args): Promise<OwnerSnapshotFields> => {
    const ownerId = args.ownerId;
    const access = await readOwnerDataAccessState(ctx, ownerId);
    const migrationFenced = await hasOwnerMigrationWriteFence(ctx, ownerId);
    const writable = access.allowed && !migrationFenced;
    const { plan, quota, unlimited } = await resolveCloudPlan(ctx, ownerId);
    const lane = {
      burstStarts: quota.burstStarts,
      dailyTurns: quota.dailyTurns,
      concurrent: quota.concurrentTurns,
    };
    let execution: CloudExecutionSelection;
    try {
      execution = await resolveOwnerExecutionInMutation(ctx, ownerId);
    } catch (error) {
      // The selected engine's credential is gone: the gate must still admit
      // turns, on the managed engine, exactly as `disconnectEngine` falls back.
      if (!(error instanceof ConvexError)) throw error;
      execution = DEFAULT_CLOUD_EXECUTION;
    }
    const credentials = await Promise.all(
      CLOUD_ENGINE_PROVIDERS.map(async (provider) => ({
        provider,
        row: await ctx.db
          .query("cloud_llm_credentials")
          .withIndex("by_ownerId_and_provider_and_importedFromOwnerId", (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("provider", provider)
              .eq("importedFromOwnerId", undefined),
          )
          .unique(),
      })),
    );
    const paired = await ctx.db
      .query("paired_mobile_devices")
      .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
        q.eq("ownerId", ownerId),
      )
      .take(MAX_PAIRED_DEVICES);
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(MAX_EXECUTION_DEVICES);
    return {
      ownerId,
      ownerGeneration: access.generation,
      writable,
      plan,
      unlimited,
      quotas: { chat: lane, agent: lane },
      execution,
      pairedDevices: paired
        .filter((device) => device.revokedAt === undefined)
        .map((device) => ({
          mobileDeviceId: device.mobileDeviceId,
          desktopDeviceId: device.desktopDeviceId,
          mobilePublicKey: device.pairSecretHash,
        })),
      // Only a device that registered an execution key can present itself on
      // the gate's presence socket; the rest are bridge/tunnel rows.
      devices: devices.flatMap((device) =>
        device.devicePublicKey
          ? [
              {
                deviceId: device.deviceId,
                publicKey: device.devicePublicKey,
                remoteExecutionEnabled: device.remoteExecutionEnabled !== false,
                ...(device.deviceName?.trim()
                  ? { label: device.deviceName.trim() }
                  : {}),
                ...(device.executionCapabilities?.length
                  ? { capabilities: device.executionCapabilities }
                  : {}),
              },
            ]
          : [],
      ),
      connectedEngines: credentials.flatMap(({ provider, row }) =>
        row ? [provider] : [],
      ),
    };
  },
});

/**
 * Assembles the snapshot. Not one transaction by design: the allowance read
 * normalizes usage windows (a mutation) while the rest is a query, and a
 * snapshot that is a few milliseconds internally skewed is exactly what a
 * five-minute cache tolerates.
 */
export const getOwnerSnapshotInternal = internalAction({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
    deviceId: v.optional(v.string()),
  },
  returns: ownerSnapshotValidator,
  handler: async (ctx, args): Promise<OwnerSnapshot> => {
    const fields: OwnerSnapshotFields = await ctx.runQuery(
      internal.owner_snapshot.getOwnerSnapshotFieldsInternal,
      { ownerId: args.ownerId },
    );
    let allowance: OwnerSnapshot["allowance"];
    if (fields.writable) {
      const resolved: OwnerModelAllowance = await ctx.runMutation(
        internal.gateway_capabilities.getOwnerModelAllowanceInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: fields.ownerGeneration,
          isAnonymous: args.isAnonymous,
          ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        },
      );
      allowance = {
        audience: resolved.audience,
        budgetMicroCents: resolved.budgetMicroCents,
        ...(resolved.maxRequests !== undefined
          ? { maxRequests: resolved.maxRequests }
          : {}),
      };
    } else {
      // A fenced owner admits nothing; the allowance is moot but the shape
      // must stay total so the gate never has to special-case it.
      allowance = {
        audience: args.isAnonymous ? "anonymous" : "free",
        budgetMicroCents: 0,
        maxRequests: 0,
      };
    }
    return {
      v: OWNER_SNAPSHOT_VERSION,
      ...fields,
      // Convex validates engine === provider at runtime; the wire shape is the
      // contract's discriminated union.
      execution: fields.execution as OwnerSnapshot["execution"],
      allowance,
      fetchedAt: Date.now(),
      ttlMs: OWNER_SNAPSHOT_TTL_MS,
    };
  },
});

const changeReasonValidator = v.union(
  v.literal("billing"),
  v.literal("generation"),
  v.literal("engine"),
  v.literal("pairing"),
  v.literal("device"),
  v.literal("manual"),
);

/**
 * Best-effort push invalidation: `POST {builder}/internal/owners/snapshot-changed`.
 * Failures are logged, never thrown — the gate re-pulls on its TTL anyway.
 * Schedule it with `scheduleOwnerSnapshotChanged` from the mutation that made
 * the change, so the push cannot outrun the write it announces.
 */
export const notifyOwnerSnapshotChanged = internalAction({
  args: { ownerId: v.string(), reason: changeReasonValidator },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const endpoint = resolveBuilderEndpoint();
    if (!endpoint) return null;
    const body: OwnerSnapshotChangedRequest = {
      ownerId: args.ownerId,
      reason: args.reason,
    };
    try {
      const response = await fetch(
        `${endpoint.url}${BUILDER_OWNER_SNAPSHOT_CHANGED_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            service: "convex-owner-snapshot",
            event: "snapshot_changed_rejected",
            reason: args.reason,
            status: response.status,
          }),
        );
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          service: "convex-owner-snapshot",
          event: "snapshot_changed_failed",
          reason: args.reason,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  },
});
