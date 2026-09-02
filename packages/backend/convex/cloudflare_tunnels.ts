import { v, ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "./owner_lifecycle";

const CF_TUNNEL_DOMAIN = "stellatunnel.com";
const PROVISION_LEASE_MS = 3 * 60_000;
const TUNNEL_IDLE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TUNNEL_OWNER_LIMIT = 3;

type IdleTunnelRef = {
  id: Id<"cloudflare_tunnels">;
  ownerId: string;
  tunnelId: string;
  dnsRecordId?: string;
  tunnelName: string;
  hostname: string;
  lastUsedAt: number;
  idleCleanupStartedAt: number;
};

const claimIdleTunnelCleanupBatchRef = makeFunctionReference<
  "mutation",
  { now: number; limit?: number },
  IdleTunnelRef[]
>("cloudflare_tunnels:claimIdleTunnelCleanupBatch");

const deleteConfirmedIdleTunnelRef = makeFunctionReference<
  "mutation",
  IdleTunnelRef,
  boolean
>("cloudflare_tunnels:deleteConfirmedIdleTunnel");

const resolveIdentityLevelRef = makeFunctionReference<
  "query",
  { ownerId: string },
  0 | 1 | 2 | 3
>("lib/identity_level:resolveIdentityLevelInternal");

const requireCfAccountId = (): string => {
  const id = process.env.CF_ACCOUNT_ID?.trim();
  if (!id) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "CF_ACCOUNT_ID is not configured.",
    });
  }
  return id;
};

const requireCfZoneId = (): string => {
  const id = process.env.CF_ZONE_ID?.trim();
  if (!id) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "CF_ZONE_ID is not configured.",
    });
  }
  return id;
};

const requireCfApiToken = (): string => {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Missing CLOUDFLARE_API_TOKEN",
    });
  }
  return token;
};

const deleteCloudflareResource = async (
  url: string,
  apiToken: string,
): Promise<void> => {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 || response.status === 204) return;
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!response.ok || body?.success !== true) {
    throw new Error(
      body?.errors?.[0]?.message ??
        `Cloudflare resource deletion failed (${response.status}).`,
    );
  }
};

const listCloudflareResourceIds = async (
  url: string,
  apiToken: string,
): Promise<string[]> => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: Array<{ id?: string }>;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!response.ok || body?.success !== true || !Array.isArray(body.result)) {
    throw new Error(
      body?.errors?.[0]?.message ??
        `Cloudflare resource lookup failed (${response.status}).`,
    );
  }
  return body.result.flatMap((item) =>
    typeof item.id === "string" && item.id.length > 0 ? [item.id] : [],
  );
};

type TunnelExternalRef = {
  tunnelId: string;
  dnsRecordId?: string;
  tunnelName: string;
  hostname: string;
};

/** Deletes every exact/id-derived and name-derived remote resource. */
const deleteTunnelExternalRef = async (
  ref: TunnelExternalRef,
  credentials: { apiToken: string; accountId: string; zoneId: string },
): Promise<void> => {
  const { apiToken, accountId, zoneId } = credentials;
  const [foundDnsIds, foundTunnelIds] = await Promise.all([
    listCloudflareResourceIds(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(ref.hostname)}`,
      apiToken,
    ),
    listCloudflareResourceIds(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(ref.tunnelName)}`,
      apiToken,
    ),
  ]);
  const dnsIds = new Set([
    ...(ref.dnsRecordId ? [ref.dnsRecordId] : []),
    ...foundDnsIds,
  ]);
  const tunnelIds = new Set([
    ...(ref.tunnelId ? [ref.tunnelId] : []),
    ...foundTunnelIds,
  ]);
  const failures: unknown[] = [];
  const dnsResults = await Promise.allSettled(
    [...dnsIds].map((id) =>
      deleteCloudflareResource(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${encodeURIComponent(id)}`,
        apiToken,
      ),
    ),
  );
  failures.push(
    ...dnsResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  );
  // Attempt the tunnel even when DNS deletion failed, but do not acknowledge
  // the locator row until both resource classes were confirmed absent.
  const tunnelResults = await Promise.allSettled(
    [...tunnelIds].map((id) =>
      deleteCloudflareResource(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${encodeURIComponent(id)}`,
        apiToken,
      ),
    ),
  );
  failures.push(
    ...tunnelResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  );
  if (failures.length > 0) {
    const first = failures[0];
    throw first instanceof Error
      ? first
      : new Error(`Cloudflare resource deletion failed: ${String(first)}`);
  }
};

const tunnelNameForDevice = (ownerId: string, deviceId: string) => {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  const safeDev = deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  const base = `t-${safeOwner}-${safeDev || "dev"}`;
  return base.slice(0, 63);
};

/** Tunnel rows may omit `deviceId` until a desktop claims the row (older one-row-per-owner data). */
const tunnelRowMissingDeviceId = (row: { deviceId?: string }) =>
  row.deviceId === undefined || row.deviceId === "";

const tunnelDocumentValidator = v.object({
  _id: v.id("cloudflare_tunnels"),
  _creationTime: v.number(),
  ownerId: v.string(),
  deviceId: v.optional(v.string()),
  tunnelId: v.string(),
  tunnelName: v.string(),
  tunnelToken: v.string(),
  hostname: v.string(),
  dnsRecordId: v.optional(v.string()),
  provisionState: v.optional(
    v.union(v.literal("provisioning"), v.literal("ready")),
  ),
  provisionGeneration: v.optional(v.string()),
  provisionLeaseExpiresAt: v.optional(v.number()),
  idleCleanupStartedAt: v.optional(v.number()),
  createdAt: v.number(),
  lastUsedAt: v.number(),
  updatedAt: v.number(),
});

export const getTunnelForOwnerDevice = internalQuery({
  args: { ownerId: v.string(), deviceId: v.string() },
  returns: v.union(tunnelDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const specific = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (specific) {
      return specific;
    }
    // One tunnel per owner with no deviceId yet; first desktop to request a token claims it.
    // Owners typically have <10 tunnel rows; cap the scan to stay bounded.
    const forOwner = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(50);
    return forOwner.find((r) => tunnelRowMissingDeviceId(r)) ?? null;
  },
});

export const reserveTunnelProvision = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.string(),
    tunnelName: v.string(),
    hostname: v.string(),
    now: v.number(),
    leaseExpiresAt: v.number(),
  },
  returns: v.id("cloudflare_tunnels"),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const existing = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "A tunnel already exists or is being provisioned.",
      });
    }
    const ownerRows = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(TUNNEL_OWNER_LIMIT);
    if (ownerRows.length >= TUNNEL_OWNER_LIMIT) {
      throw new ConvexError({
        code: "TUNNEL_LIMIT",
        message: "This account already has the maximum number of tunnels.",
      });
    }
    return await ctx.db.insert("cloudflare_tunnels", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      tunnelId: "",
      tunnelName: args.tunnelName,
      tunnelToken: "",
      hostname: args.hostname,
      provisionState: "provisioning",
      provisionGeneration: args.ownerGeneration,
      provisionLeaseExpiresAt: args.leaseExpiresAt,
      createdAt: args.now,
      lastUsedAt: args.now,
      updatedAt: args.now,
    });
  },
});

/** Records cleanup locators even after deletion closes ordinary writes. */
export const recordTunnelProvisionExternalRefs = internalMutation({
  args: {
    id: v.id("cloudflare_tunnels"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    tunnelId: v.optional(v.string()),
    dnsRecordId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.provisionState !== "provisioning" ||
      row.provisionGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      ...(args.tunnelId !== undefined ? { tunnelId: args.tunnelId } : {}),
      ...(args.dnsRecordId !== undefined
        ? { dnsRecordId: args.dnsRecordId }
        : {}),
      updatedAt: args.now,
    });
    return true;
  },
});

export const finishTunnelProvision = internalMutation({
  args: {
    id: v.id("cloudflare_tunnels"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    tunnelId: v.string(),
    tunnelToken: v.string(),
    dnsRecordId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.provisionState !== "provisioning" ||
      row.provisionGeneration !== args.ownerGeneration ||
      row.tunnelId !== args.tunnelId ||
      row.dnsRecordId !== args.dnsRecordId
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      tunnelToken: args.tunnelToken,
      provisionState: "ready",
      provisionGeneration: undefined,
      provisionLeaseExpiresAt: undefined,
      lastUsedAt: args.now,
      updatedAt: args.now,
    });
    return true;
  },
});

/** Exact cleanup acknowledgement for a failed/stale provisioning row. */
export const deleteConfirmedTunnelProvision = internalMutation({
  args: {
    id: v.id("cloudflare_tunnels"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    tunnelName: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.provisionState !== "provisioning" ||
      row.provisionGeneration !== args.ownerGeneration ||
      row.tunnelName !== args.tunnelName
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

export const attachDeviceIdToTunnel = internalMutation({
  args: {
    tunnelDocumentId: v.id("cloudflare_tunnels"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const row = await ctx.db.get(args.tunnelDocumentId);
    if (!row || row.ownerId !== args.ownerId) {
      return null;
    }
    if (!tunnelRowMissingDeviceId(row)) {
      return null;
    }
    await ctx.db.patch(args.tunnelDocumentId, {
      deviceId: args.deviceId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const touchTunnelLastUsed = internalMutation({
  args: {
    id: v.id("cloudflare_tunnels"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.provisionState === "provisioning" ||
      row.idleCleanupStartedAt !== undefined
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      lastUsedAt: args.now,
      updatedAt: args.now,
    });
    return true;
  },
});

export const upsertTunnel = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    deviceId: v.string(),
    tunnelId: v.string(),
    tunnelName: v.string(),
    tunnelToken: v.string(),
    hostname: v.string(),
    dnsRecordId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    const existing = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tunnelId: args.tunnelId,
        tunnelName: args.tunnelName,
        tunnelToken: args.tunnelToken,
        hostname: args.hostname,
        dnsRecordId: args.dnsRecordId,
        lastUsedAt: args.updatedAt,
        updatedAt: args.updatedAt,
      });
      return null;
    }

    await ctx.db.insert("cloudflare_tunnels", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      tunnelId: args.tunnelId,
      tunnelName: args.tunnelName,
      tunnelToken: args.tunnelToken,
      hostname: args.hostname,
      dnsRecordId: args.dnsRecordId,
      createdAt: args.createdAt,
      lastUsedAt: args.updatedAt,
      updatedAt: args.updatedAt,
    });
    return null;
  },
});

const tunnelPurgeRef = v.object({
  id: v.id("cloudflare_tunnels"),
  tunnelId: v.string(),
  dnsRecordId: v.optional(v.string()),
  tunnelName: v.string(),
  hostname: v.string(),
  provisionState: v.optional(
    v.union(v.literal("provisioning"), v.literal("ready")),
  ),
  provisionLeaseExpiresAt: v.optional(v.number()),
});

export const listOwnerTunnelPurgeBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(tunnelPurgeRef),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(50);
    return rows.map((row) => ({
      id: row._id,
      tunnelId: row.tunnelId,
      ...(row.dnsRecordId ? { dnsRecordId: row.dnsRecordId } : {}),
      tunnelName: row.tunnelName,
      hostname: row.hostname,
      ...(row.provisionState ? { provisionState: row.provisionState } : {}),
      ...(row.provisionLeaseExpiresAt !== undefined
        ? { provisionLeaseExpiresAt: row.provisionLeaseExpiresAt }
        : {}),
    }));
  },
});

export const deleteConfirmedOwnerTunnelRows = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
    refs: v.array(tunnelPurgeRef),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, { ...args, stage: "core" });
    let deleted = 0;
    for (const ref of args.refs) {
      const row = await ctx.db.get(ref.id);
      if (
        row?.ownerId === args.ownerId &&
        row.tunnelId === ref.tunnelId &&
        row.dnsRecordId === ref.dnsRecordId &&
        row.tunnelName === ref.tunnelName &&
        row.hostname === ref.hostname &&
        row.provisionState === ref.provisionState
      ) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

/** Cloudflare DNS and tunnel first; exact locator row last. */
export const purgeOwnerTunnels = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (ctx: ActionCtx, args) => {
    while (true) {
      const refs: Array<{
        id: Id<"cloudflare_tunnels">;
        tunnelId: string;
        dnsRecordId?: string;
        tunnelName: string;
        hostname: string;
        provisionState?: "provisioning" | "ready";
        provisionLeaseExpiresAt?: number;
      }> = await ctx.runQuery(
        internal.cloudflare_tunnels.listOwnerTunnelPurgeBatch,
        { ownerId: args.ownerId },
      );
      if (refs.length === 0) return null;
      const apiToken = requireCfApiToken();
      const accountId = requireCfAccountId();
      const zoneId = requireCfZoneId();
      const now = Date.now();
      const active = refs.filter(
        (ref) =>
          ref.provisionState === "provisioning" &&
          (ref.provisionLeaseExpiresAt ?? 0) > now,
      );
      const eligible = refs.filter(
        (ref) => !active.some((item) => item.id === ref.id),
      );
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        { ...args, stage: "core", now: Date.now() },
      );
      const settled = await Promise.allSettled(
        eligible.map((ref) =>
          deleteTunnelExternalRef(ref, { apiToken, accountId, zoneId }),
        ),
      );
      const confirmed = eligible.filter(
        (_, index) => settled[index]?.status === "fulfilled",
      );
      await ctx.runMutation(
        internal.cloudflare_tunnels.deleteConfirmedOwnerTunnelRows,
        { ...args, refs: confirmed },
      );
      if (active.length > 0 || confirmed.length !== eligible.length) {
        throw new Error(
          "Owner data purge is waiting for Cloudflare tunnel provisioning/deletion; locator rows were retained for retry.",
        );
      }
    }
  },
});

const idleTunnelRefValidator = v.object({
  id: v.id("cloudflare_tunnels"),
  ownerId: v.string(),
  tunnelId: v.string(),
  dnsRecordId: v.optional(v.string()),
  tunnelName: v.string(),
  hostname: v.string(),
  lastUsedAt: v.number(),
  idleCleanupStartedAt: v.number(),
});

export const claimIdleTunnelCleanupBatch = internalMutation({
  args: { now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(idleTunnelRefValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 50)));
    const rows = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_lastUsedAt", (q) =>
        q.lt("lastUsedAt", args.now - TUNNEL_IDLE_RETENTION_MS),
      )
      .take(limit);
    const claimed = [];
    for (const row of rows) {
      if (
        row.provisionState === "provisioning" &&
        (row.provisionLeaseExpiresAt ?? 0) > args.now
      ) {
        continue;
      }
      const idleCleanupStartedAt = row.idleCleanupStartedAt ?? args.now;
      if (row.idleCleanupStartedAt === undefined) {
        await ctx.db.patch(row._id, { idleCleanupStartedAt });
      }
      claimed.push({
        id: row._id,
        ownerId: row.ownerId,
        tunnelId: row.tunnelId,
        ...(row.dnsRecordId ? { dnsRecordId: row.dnsRecordId } : {}),
        tunnelName: row.tunnelName,
        hostname: row.hostname,
        lastUsedAt: row.lastUsedAt,
        idleCleanupStartedAt,
      });
    }
    return claimed;
  },
});

export const deleteConfirmedIdleTunnel = internalMutation({
  args: idleTunnelRefValidator.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.tunnelId !== args.tunnelId ||
      row.dnsRecordId !== args.dnsRecordId ||
      row.tunnelName !== args.tunnelName ||
      row.hostname !== args.hostname ||
      row.lastUsedAt !== args.lastUsedAt ||
      row.idleCleanupStartedAt !== args.idleCleanupStartedAt
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

export const purgeIdleTunnelsInternal = internalAction({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number(), deleted: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ attempted: number; deleted: number }> => {
    const now = args.now ?? Date.now();
    const refs = await ctx.runMutation(claimIdleTunnelCleanupBatchRef, {
      now,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    if (refs.length === 0) return { attempted: 0, deleted: 0 };
    const credentials = {
      apiToken: requireCfApiToken(),
      accountId: requireCfAccountId(),
      zoneId: requireCfZoneId(),
    };
    let deleted = 0;
    for (const ref of refs) {
      try {
        await deleteTunnelExternalRef(ref, credentials);
        if (await ctx.runMutation(deleteConfirmedIdleTunnelRef, ref)) {
          deleted += 1;
        }
      } catch (error) {
        console.error(
          `[cloudflare_tunnels] Idle cleanup failed for ${ref.tunnelName}:`,
          error,
        );
      }
    }
    return { attempted: refs.length, deleted };
  },
});

export const getOrProvisionTunnel = internalAction({
  args: { ownerId: v.string(), deviceId: v.string() },
  returns: v.object({ tunnelToken: v.string(), hostname: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ tunnelToken: string; hostname: string }> => {
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      args.ownerId,
    );
    const identityLevel = await ctx.runQuery(resolveIdentityLevelRef, {
      ownerId: args.ownerId,
    });
    if (identityLevel < 2) {
      throw new ConvexError({
        code: "SIGN_IN_REQUIRED",
        message: "A Google or Apple account is required for tunnels.",
      });
    }
    let existing = await ctx.runQuery(
      internal.cloudflare_tunnels.getTunnelForOwnerDevice,
      { ownerId: args.ownerId, deviceId: args.deviceId },
    );
    if (existing && existing.provisionState !== "provisioning") {
      if (existing.idleCleanupStartedAt !== undefined) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Tunnel cleanup is in progress.",
        });
      }
      if (tunnelRowMissingDeviceId(existing)) {
        await ctx.runMutation(
          internal.cloudflare_tunnels.attachDeviceIdToTunnel,
          {
            tunnelDocumentId: existing._id,
            ownerId: args.ownerId,
            ownerGeneration,
            deviceId: args.deviceId,
          },
        );
      }
      const touched = await ctx.runMutation(
        internal.cloudflare_tunnels.touchTunnelLastUsed,
        {
          id: existing._id,
          ownerId: args.ownerId,
          ownerGeneration,
          now: Date.now(),
        },
      );
      if (!touched) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Tunnel state changed; retry.",
        });
      }
      return { tunnelToken: existing.tunnelToken, hostname: existing.hostname };
    }

    const apiToken = requireCfApiToken();
    const cfAccountId = requireCfAccountId();
    const cfZoneId = requireCfZoneId();
    const tunnelName = tunnelNameForDevice(args.ownerId, args.deviceId);
    const hostname = `${tunnelName}.${CF_TUNNEL_DOMAIN}`;
    const externalCredentials = {
      apiToken,
      accountId: cfAccountId,
      zoneId: cfZoneId,
    };

    // A crashed attempt retains its deterministic name and any IDs it learned.
    // Never overwrite that debt: after its bounded lease, reconcile/delete the
    // remote resources first and only then retire the exact reservation.
    if (existing?.provisionState === "provisioning") {
      if ((existing.provisionLeaseExpiresAt ?? 0) > Date.now()) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Tunnel provisioning is already in progress.",
        });
      }
      const provisionGeneration = existing.provisionGeneration;
      if (!provisionGeneration) {
        throw new Error("Tunnel provisioning locator has no generation.");
      }
      await deleteTunnelExternalRef(existing, externalCredentials);
      const deleted: boolean = await ctx.runMutation(
        internal.cloudflare_tunnels.deleteConfirmedTunnelProvision,
        {
          id: existing._id,
          ownerId: args.ownerId,
          ownerGeneration: provisionGeneration,
          tunnelName: existing.tunnelName,
        },
      );
      if (!deleted) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Tunnel provisioning state changed; retry.",
        });
      }
      existing = null;
    }

    const startedAt = Date.now();
    const provisionId = await ctx.runMutation(
      internal.cloudflare_tunnels.reserveTunnelProvision,
      {
        ownerId: args.ownerId,
        ownerGeneration,
        deviceId: args.deviceId,
        tunnelName,
        hostname,
        now: startedAt,
        leaseExpiresAt: startedAt + PROVISION_LEASE_MS,
      },
    );
    const tunnelSecret = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    let tunnelId = "";
    let tunnelToken = "";
    let dnsRecordId: string | undefined;
    let unlocatedDispatch = false;

    try {
      await ctx.runMutation(
        internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
        { ownerId: args.ownerId, ownerGeneration },
      );

      unlocatedDispatch = true;
      const createTunnelRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/cfd_tunnel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: tunnelName,
            tunnel_secret: tunnelSecret,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const createTunnelBody = (await createTunnelRes
        .json()
        .catch(() => null)) as {
        success?: boolean;
        result?: { id: string; token: string };
        errors?: { message: string }[];
      } | null;
      if (!createTunnelRes.ok || !createTunnelBody?.result) {
        const msg =
          createTunnelBody?.errors?.[0]?.message ?? "Failed to create tunnel";
        throw new ConvexError({ code: "INTERNAL_ERROR", message: msg });
      }

      tunnelId = createTunnelBody.result.id;
      tunnelToken = createTunnelBody.result.token;
      unlocatedDispatch = false;
      const recordedTunnel: boolean = await ctx.runMutation(
        internal.cloudflare_tunnels.recordTunnelProvisionExternalRefs,
        {
          id: provisionId,
          ownerId: args.ownerId,
          ownerGeneration,
          tunnelId,
          now: Date.now(),
        },
      );
      if (!recordedTunnel) {
        throw new Error("Tunnel provisioning reservation changed.");
      }

      await ctx.runMutation(
        internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
        { ownerId: args.ownerId, ownerGeneration },
      );
      unlocatedDispatch = true;
      const createDnsRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "CNAME",
            name: tunnelName,
            content: `${tunnelId}.cfargotunnel.com`,
            proxied: true,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const createDnsBody = (await createDnsRes.json().catch(() => null)) as {
        success?: boolean;
        result?: { id: string };
        errors?: { message: string }[];
      } | null;
      if (!createDnsRes.ok || !createDnsBody?.result) {
        const msg =
          createDnsBody?.errors?.[0]?.message ?? "Failed to create DNS record";
        throw new ConvexError({ code: "INTERNAL_ERROR", message: msg });
      }

      dnsRecordId = createDnsBody.result.id;
      unlocatedDispatch = false;
      const recordedDns: boolean = await ctx.runMutation(
        internal.cloudflare_tunnels.recordTunnelProvisionExternalRefs,
        {
          id: provisionId,
          ownerId: args.ownerId,
          ownerGeneration,
          tunnelId,
          dnsRecordId,
          now: Date.now(),
        },
      );
      if (!recordedDns) {
        throw new Error("Tunnel provisioning reservation changed.");
      }

      const ready: boolean = await ctx.runMutation(
        internal.cloudflare_tunnels.finishTunnelProvision,
        {
          id: provisionId,
          ownerId: args.ownerId,
          ownerGeneration,
          tunnelId,
          tunnelToken,
          dnsRecordId,
          now: Date.now(),
        },
      );
      if (!ready) {
        throw new Error("Tunnel provisioning reservation changed.");
      }
      return { tunnelToken, hostname };
    } catch (error) {
      try {
        await deleteTunnelExternalRef(
          { tunnelId, dnsRecordId, tunnelName, hostname },
          externalCredentials,
        );
        // A request that timed out before yielding an external ID can still
        // materialize after the immediate name lookup. Keep the deterministic
        // locator until its lease expires so the durable purge reconciles the
        // name again after the provider's consistency window.
        if (!unlocatedDispatch) {
          await ctx.runMutation(
            internal.cloudflare_tunnels.deleteConfirmedTunnelProvision,
            {
              id: provisionId,
              ownerId: args.ownerId,
              ownerGeneration,
              tunnelName,
            },
          );
        }
      } catch (cleanupError) {
        console.error(
          `[cloudflare_tunnels] Failed to clean provision ${tunnelName}:`,
          cleanupError,
        );
      }
      throw error;
    }
  },
});
