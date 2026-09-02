import { defineTable } from "convex/server";
import { v } from "convex/values";
import { executionCapabilityValidator } from "./execution_placement";

export const devicesSchema = {
  // Stable per-device profile data. Runtime liveness is intentionally scoped
  // to the feature that needs it (for example, mobile bridge registrations).
  devices: defineTable({
    ownerId: v.string(),
    /** Exact owner-data generation in which this device registration was admitted. */
    ownerGeneration: v.optional(v.string()),
    deviceId: v.string(),
    deviceName: v.optional(v.string()),
    devicePublicKey: v.optional(v.string()),
    platform: v.optional(v.string()),
    remoteExecutionEnabled: v.optional(v.boolean()),
    /**
     * What this desktop last told Convex it can run. Live availability is
     * advertised on the owner gate's presence socket; this copy exists so the
     * owner snapshot and the settings UI can describe a device that is offline.
     */
    executionCapabilities: v.optional(v.array(executionCapabilityValidator)),
    /** Last registration of the execution key, for display and staleness. */
    executionRegisteredAt: v.optional(v.number()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"]),

  // Maps a retired desktop device id to the identity that replaced it.
  //
  // A desktop mints a new `deviceId` whenever its local keypair stops being
  // readable. Without a successor
  // record every paired phone is stranded on the retired id: it keeps polling a
  // device that will never register a bridge again, so the desktop reads as
  // permanently offline and only re-pairing recovers it. Phones resolve through
  // this table and adopt the current id.
  device_identity_successors: defineTable({
    ownerId: v.string(),
    previousDeviceId: v.string(),
    deviceId: v.string(),
    rotatedAt: v.number(),
  })
    .index("by_ownerId_and_previousDeviceId", ["ownerId", "previousDeviceId"])
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"]),

  anon_device_usage: defineTable({
    deviceId: v.string(),
    /** The anonymous trial allowance. This count is what gates access. */
    requestCount: v.number(),
    firstRequestAt: v.number(),
    lastRequestAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"])
    // Lets the retention cron range-scan the oldest rows without a full
    // table scan. Rows past the retention window are equivalent to absent
    // ones (a returning device/IP just starts a fresh count), so deleting
    // them is purely a storage reclaim.
    .index("by_lastRequestAt", ["lastRequestAt"]),

  mobile_bridge_registrations: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    baseUrls: v.array(v.string()),
    updatedAt: v.number(),
    platform: v.optional(v.string()),
    desktopPublicKey: v.optional(v.string()),
  })
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  // Dedicated fixed-window state for the public one-call bridge registration
  // mutation. Keeping this in the app transaction avoids a second billed
  // function invocation through the shared rate-limiter component.
  mobile_bridge_registration_limits: defineTable({
    ownerId: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  mobile_bridge_sessions: defineTable({
    ownerId: v.string(),
    /** Generation that authorized this short-lived bridge handshake. */
    ownerGeneration: v.optional(v.string()),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    sessionId: v.string(),
    sessionSecretHash: v.string(),
    desktopChallenge: v.string(),
    desktopPublicKey: v.string(),
    mobilePublicKey: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", [
      "ownerId",
      "desktopDeviceId",
      "mobileDeviceId",
    ]),

  paired_mobile_devices: defineTable({
    ownerId: v.string(),
    /** Last owner-data generation that authenticated this pairing. */
    ownerGeneration: v.optional(v.string()),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    pairSecretHash: v.string(),
    displayName: v.optional(v.string()),
    platform: v.optional(v.string()),
    approvedAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_desktopDeviceId", ["ownerId", "desktopDeviceId"])
    .index("by_ownerId_and_mobileDeviceId", ["ownerId", "mobileDeviceId"])
    .index("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", [
      "ownerId",
      "desktopDeviceId",
      "mobileDeviceId",
    ]),

  mobile_pairing_sessions: defineTable({
    ownerId: v.string(),
    /** Exact owner-data generation in which the pairing code was minted. */
    ownerGeneration: v.optional(v.string()),
    desktopDeviceId: v.string(),
    pairingCode: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_pairingCode", ["pairingCode"])
    .index("by_ownerId_and_desktopDeviceId", ["ownerId", "desktopDeviceId"]),

  mobile_connect_intents: defineTable({
    ownerId: v.string(),
    /** Exact owner-data generation in which this intent was admitted. */
    ownerGeneration: v.optional(v.string()),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_desktopDeviceId_and_expiresAt", [
      "ownerId",
      "desktopDeviceId",
      "expiresAt",
    ])
    .index("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", [
      "ownerId",
      "desktopDeviceId",
      "mobileDeviceId",
    ]),

  mobile_push_tokens: defineTable({
    ownerId: v.string(),
    /** Last owner-data generation that authenticated this token binding. */
    ownerGeneration: v.optional(v.string()),
    mobileDeviceId: v.string(),
    expoPushToken: v.string(),
    platform: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_mobileDeviceId", ["ownerId", "mobileDeviceId"])
    .index("by_expoPushToken", ["expoPushToken"]),

  cloudflare_tunnels: defineTable({
    ownerId: v.string(),
    /** Desktop machine id (matches `devices.deviceId` / mobile bridge device). Omitted until claimed for older one-row-per-owner tunnel records. */
    deviceId: v.optional(v.string()),
    tunnelId: v.string(),
    tunnelName: v.string(),
    tunnelToken: v.string(),
    hostname: v.string(),
    dnsRecordId: v.optional(v.string()),
    /**
     * Provisioning rows are reserved before the first Cloudflare POST. They
     * are durable cleanup locators and are never returned as usable tunnels.
     * Undefined is a legacy/ready row.
     */
    provisionState: v.optional(
      v.union(v.literal("provisioning"), v.literal("ready")),
    ),
    provisionGeneration: v.optional(v.string()),
    provisionLeaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"]),
};
