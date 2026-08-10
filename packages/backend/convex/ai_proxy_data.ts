/**
 * Data access for AI proxy rate limiting (anon_device_usage table).
 */

import { ConvexError, v } from 'convex/values'
import { internalMutation, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import { hashSha256Hex } from './lib/crypto_utils'
import { clampIntToRange } from './lib/number_utils'
import { ANON_DEVICE_USAGE_RETENTION_MS } from './lib/anonymous_usage'

const anonBucketValidator = v.union(v.literal('device'), v.literal('ip'))

const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/

const normalizeClientAddressKey = (value: string | undefined) => {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLIENT_ADDRESS_KEY_LENGTH ||
    !CLIENT_ADDRESS_KEY_PATTERN.test(normalized)
  ) {
    return undefined
  }
  return normalized
}

async function hashDeviceId(
  deviceId: string,
  clientAddressKey?: string,
): Promise<string> {
  const salt = process.env.ANON_DEVICE_ID_HASH_SALT?.trim()
  if (!salt) {
    throw new ConvexError('Missing ANON_DEVICE_ID_HASH_SALT')
  }
  const normalizedAddressKey = normalizeClientAddressKey(clientAddressKey)
  const materialBase = normalizedAddressKey
    ? `${deviceId}|addr:${normalizedAddressKey}`
    : deviceId
  const material = `${salt}:${materialBase}`
  const hashHex = await hashSha256Hex(material)
  return `sha256:${hashHex}`
}

/**
 * Retention sweep for `anon_device_usage`. Rows whose `lastRequestAt` is older
 * than the retention window are already treated as stale (the count resets on
 * the next request), so deleting them only reclaims storage and never changes
 * rate-limiting behavior. Batched + index-scanned; the cron re-runs until the
 * backlog is drained.
 */
export const purgeStaleDeviceUsage = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = clampIntToRange(args.batchSize ?? 500, 1, 1000)
    const cutoff = Date.now() - ANON_DEVICE_USAGE_RETENTION_MS
    const stale = await ctx.db
      .query('anon_device_usage')
      .withIndex('by_lastRequestAt', (q) => q.lt('lastRequestAt', cutoff))
      .take(batchSize)
    await Promise.all(stale.map((row) => ctx.db.delete(row._id)))
    const hasMore = stale.length === batchSize
    if (hasMore) {
      // The cron only fires once per interval; reschedule ourselves so a
      // backlog larger than one batch still drains within the same sweep.
      await ctx.scheduler.runAfter(0, internal.ai_proxy_data.purgeStaleDeviceUsage, {
        batchSize: args.batchSize,
      })
    }
    return { deleted: stale.length, hasMore }
  },
})

const toNonNegativeMicroCents = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0

/**
 * Atomically checks and consumes one anonymous request allowance.
 *
 * The gate is the request count. `usageMicroCents` rides along purely as
 * measurement — it records what those requests actually cost Stella, which is
 * how the owner can tell whether the request cap is set at a sane number —
 * but it never blocks.
 */
export const consumeDeviceAllowance = internalMutation({
  args: {
    deviceId: v.string(),
    maxRequests: v.number(),
    bucket: v.optional(anonBucketValidator),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const maxRequests = clampIntToRange(
      args.maxRequests,
      1,
      Number.MAX_SAFE_INTEGER,
    )
    const bucket = args.bucket ?? 'device'
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
    const existing = await ctx.db
      .query('anon_device_usage')
      .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
      .unique()

    const now = Date.now()
    let requestCount = 1
    let firstRequestAt = now
    let usageMicroCents = 0

    if (existing) {
      const stale = now - existing.lastRequestAt > ANON_DEVICE_USAGE_RETENTION_MS
      requestCount = stale ? 1 : existing.requestCount + 1
      firstRequestAt = stale ? now : existing.firstRequestAt
      usageMicroCents = stale
        ? 0
        : toNonNegativeMicroCents(existing.usageMicroCents)
      await ctx.db.patch(existing._id, {
        requestCount,
        usageMicroCents,
        bucket,
        firstRequestAt,
        lastRequestAt: now,
      })
    } else {
      await ctx.db.insert('anon_device_usage', {
        deviceId: deviceHash,
        requestCount,
        usageMicroCents,
        bucket,
        firstRequestAt,
        lastRequestAt: now,
      })
    }

    return {
      allowed: requestCount <= maxRequests,
      requestCount,
      remaining: Math.max(0, maxRequests - requestCount),
      // Reported for measurement; not part of the allowance decision.
      usageMicroCents,
      firstRequestAt,
      lastRequestAt: now,
    }
  },
})

/**
 * Adds measured managed-model cost to an anonymous bucket. Called after the
 * relay has parsed real token usage, so the recorded cost reflects what
 * Stella actually paid rather than a pre-flight estimate.
 *
 * Exported as a plain helper (not only as a mutation) so `billing.ts` can
 * attribute cost inside the same transaction that meters the request.
 */
export const addDeviceUsageCost = async (
  ctx: MutationCtx,
  args: {
    deviceId: string
    costMicroCents: number
    bucket?: 'device' | 'ip'
    clientAddressKey?: string
  },
): Promise<void> => {
  const costMicroCents = toNonNegativeMicroCents(args.costMicroCents)
  if (costMicroCents <= 0) return

  const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
  const existing = await ctx.db
    .query('anon_device_usage')
    .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
    .unique()
  const now = Date.now()

  if (!existing) {
    // The allowance check normally creates the row first; only a retention
    // sweep racing the relay can land us here.
    await ctx.db.insert('anon_device_usage', {
      deviceId: deviceHash,
      requestCount: 1,
      usageMicroCents: costMicroCents,
      bucket: args.bucket ?? 'device',
      firstRequestAt: now,
      lastRequestAt: now,
    })
    return
  }

  await ctx.db.patch(existing._id, {
    usageMicroCents:
      toNonNegativeMicroCents(existing.usageMicroCents) + costMicroCents,
    lastRequestAt: now,
  })
}

export const recordDeviceUsageCost = internalMutation({
  args: {
    deviceId: v.string(),
    costMicroCents: v.number(),
    bucket: v.optional(anonBucketValidator),
    clientAddressKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await addDeviceUsageCost(ctx, {
      deviceId: args.deviceId,
      costMicroCents: args.costMicroCents,
      ...(args.bucket ? { bucket: args.bucket } : {}),
      ...(args.clientAddressKey
        ? { clientAddressKey: args.clientAddressKey }
        : {}),
    })
    return null
  },
})
