/**
 * Data access for anonymous trial counters (anon_device_usage table).
 */

import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { internal } from './_generated/api'
import { hashSha256Hex } from './lib/crypto_utils'
import { clampIntToRange } from './lib/number_utils'
import { ANON_DEVICE_USAGE_RETENTION_MS } from './lib/anonymous_usage'

const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/

/**
 * Constant `deviceId` prefix for the per-network counter. Keyed on the
 * gateway's IP hash, it has no resettable per-install component, so it is the
 * durable ceiling that survives a local-data wipe (which mints a fresh
 * anonymous identity and therefore a fresh per-device counter).
 */
export const ANON_IP_BUCKET_DEVICE_ID = 'anon-ip'

/** An anonymous owner is its own trial device unless the caller names one. */
export const anonymousTrialDeviceId = (ownerId: string): string =>
  `anon-jwt:${ownerId}`

export const anonymousIpBucketDeviceId = (ipHash: string): string =>
  `${ANON_IP_BUCKET_DEVICE_ID}:${ipHash}`

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

export type DeviceAllowanceArgs = {
  deviceId: string
  maxRequests: number
  clientAddressKey?: string
}

export type DeviceAllowanceResult = {
  allowed: boolean
  requestCount: number
  remaining: number
  firstRequestAt: number
  lastRequestAt: number
}

/** Current count for a device without consuming an allowance. */
export const readDeviceAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: DeviceAllowanceArgs,
): Promise<{ requestCount: number; remaining: number }> => {
  const maxRequests = clampIntToRange(
    args.maxRequests,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
  const existing = await ctx.db
    .query('anon_device_usage')
    .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
    .unique()
  const now = Date.now()
  const requestCount =
    existing && now - existing.lastRequestAt <= ANON_DEVICE_USAGE_RETENTION_MS
      ? existing.requestCount
      : 0
  return { requestCount, remaining: Math.max(0, maxRequests - requestCount) }
}

/**
 * Atomically checks and consumes one anonymous request allowance. The caller
 * must already hold owner/generation authority for the write.
 */
export const consumeDeviceAllowanceAuthorized = async (
  ctx: MutationCtx,
  args: DeviceAllowanceArgs,
): Promise<DeviceAllowanceResult> => {
  const maxRequests = clampIntToRange(
    args.maxRequests,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey)
  const existing = await ctx.db
    .query('anon_device_usage')
    .withIndex('by_deviceId', (q) => q.eq('deviceId', deviceHash))
    .unique()

  const now = Date.now()
  let requestCount = 1
  let firstRequestAt = now

  if (existing) {
    const stale = now - existing.lastRequestAt > ANON_DEVICE_USAGE_RETENTION_MS
    requestCount = stale ? 1 : existing.requestCount + 1
    firstRequestAt = stale ? now : existing.firstRequestAt
    await ctx.db.patch(existing._id, {
      requestCount,
      firstRequestAt,
      lastRequestAt: now,
    })
  } else {
    await ctx.db.insert('anon_device_usage', {
      deviceId: deviceHash,
      requestCount,
      firstRequestAt,
      lastRequestAt: now,
    })
  }

  return {
    allowed: requestCount <= maxRequests,
    requestCount,
    remaining: Math.max(0, maxRequests - requestCount),
    firstRequestAt,
    lastRequestAt: now,
  }
}

export const consumeDeviceAllowance = internalMutation({
  args: {
    deviceId: v.string(),
    maxRequests: v.number(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    await consumeDeviceAllowanceAuthorized(ctx, args),
})
