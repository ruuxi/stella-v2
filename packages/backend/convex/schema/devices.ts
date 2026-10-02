import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The anonymous trial allowance per device. The owner's own devices,
 * pairings, push tokens and tunnels live in the owner's object on
 * cloud-builder.
 */
export const devicesSchema = {
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
};
