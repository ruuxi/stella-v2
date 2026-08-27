"use node";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { deleteR2Object } from "./lib/r2_sigv4";
import { r2 } from "./r2_files";

const MAX_DELETE_OBJECTS = 100;
const MAX_LOCATOR_ID_LENGTH = 1_024;
const MAX_R2_KEY_LENGTH = 1_024;

const componentR2Credentials = () => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error("Component R2 deletion credentials are unavailable.");
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
};

/**
 * Delete bytes first, then synchronously remove component metadata. A direct
 * DELETE that loses its response leaves the caller's locator intact; replay is
 * safe because Cloudflare R2 DELETE is strongly consistent and 404 is treated
 * as confirmed absence. The component's duplicate scheduled delete is
 * idempotent and no longer carries the privacy guarantee.
 */
export const deleteComponentR2Object = async (
  ctx: ActionCtx,
  r2Key: string,
): Promise<void> => {
  await deleteR2Object({ key: r2Key, r2: componentR2Credentials() });
  await r2.deleteObject(ctx, r2Key);
};

export const deleteComponentR2ObjectsInternal = internalAction({
  args: {
    objects: v.array(v.object({ locatorId: v.string(), r2Key: v.string() })),
  },
  returns: v.object({
    confirmedLocatorIds: v.array(v.string()),
    failedLocatorIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (args.objects.length < 1 || args.objects.length > MAX_DELETE_OBJECTS) {
      throw new Error("Component R2 delete batch size is invalid.");
    }
    const locatorIds = new Set<string>();
    for (const object of args.objects) {
      if (
        !object.locatorId ||
        object.locatorId.length > MAX_LOCATOR_ID_LENGTH ||
        locatorIds.has(object.locatorId) ||
        !object.r2Key ||
        object.r2Key.length > MAX_R2_KEY_LENGTH
      ) {
        throw new Error("Component R2 delete locator is invalid.");
      }
      locatorIds.add(object.locatorId);
    }

    const settled = await Promise.allSettled(
      args.objects.map(async (object) => {
        await deleteComponentR2Object(ctx, object.r2Key);
        return object.locatorId;
      }),
    );
    const confirmedLocatorIds: string[] = [];
    const failedLocatorIds: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        confirmedLocatorIds.push(result.value);
      } else {
        // Only the caller-owned opaque locator is returned. Raw bucket keys,
        // credentials and provider responses never cross this action boundary.
        failedLocatorIds.push(args.objects[index]!.locatorId);
      }
    });
    return { confirmedLocatorIds, failedLocatorIds };
  },
});
