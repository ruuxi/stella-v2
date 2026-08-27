"use node";

import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { deleteR2Object } from "./lib/r2_sigv4";
import { requireConfiguredRawR2MediaTarget } from "./lib/raw_r2_media_target";
import {
  C8_DESTRUCTIVE_CONFIRMATION,
  C8_DEV_DEPLOYMENT,
  assertC8CleanupDeployment,
} from "./lib/c8_retired_surface";

type RawPetObject = {
  role: "spritesheet" | "preview";
  bucket: string;
  r2Key: string;
  publicUrl: string;
  locatorId?: Id<"account_external_media_objects">;
};

type UserPetManifestResult = {
  manifest: {
    policy: "delete-exact-development-raw-r2-before-row";
    petRowId: Id<"user_pets">;
    ownerId: string;
    petId: string;
    updatedAt: number;
    objects: RawPetObject[];
  };
  manifestSha256: string;
} | null;

type UserPetOrphanManifestResult = {
  manifests: Array<{
    manifest: {
      policy: "delete-exact-development-raw-r2-before-locator";
      locatorId: Id<"account_external_media_objects">;
      ownerId: string;
      sourceId: string;
      role: "spritesheet" | "preview";
      bucket: string;
      r2Key: string;
      publicUrl: string;
      uploadExpiresAt: number;
      updatedAt: number;
    };
    manifestSha256: string;
  }>;
  isDone: boolean;
  continueCursor: string;
};

const getUserPetManifestRef = makeFunctionReference<
  "query",
  { deployment: typeof C8_DEV_DEPLOYMENT; petRowId: Id<"user_pets"> },
  UserPetManifestResult
>("dev_c8_cleanup:getUserPetManifestInternal");

const getUserPetOrphanManifestPageRef = makeFunctionReference<
  "query",
  {
    deployment: typeof C8_DEV_DEPLOYMENT;
    cursor: string | null;
    numItems: number;
  },
  UserPetOrphanManifestResult
>("dev_c8_cleanup:getUserPetOrphanManifestPageInternal");

const getCutoverStateRef = makeFunctionReference<
  "query",
  { deployment: typeof C8_DEV_DEPLOYMENT },
  { closed: boolean; barrierClosesAt: number }
>("dev_c8_cleanup:getDurableCutoverStateInternal");

const acknowledgeUserPetRef = makeFunctionReference<
  "mutation",
  {
    deployment: typeof C8_DEV_DEPLOYMENT;
    confirmation: typeof C8_DESTRUCTIVE_CONFIRMATION;
    petRowId: Id<"user_pets">;
    manifestSha256: string;
    manifestPersisted: true;
  },
  { petRowId: Id<"user_pets">; manifestSha256: string; deletedLocators: number }
>("dev_c8_cleanup:acknowledgeUserPetObjectsDeletedInternal");

const acknowledgeUserPetOrphanRef = makeFunctionReference<
  "mutation",
  {
    deployment: typeof C8_DEV_DEPLOYMENT;
    confirmation: typeof C8_DESTRUCTIVE_CONFIRMATION;
    locatorId: Id<"account_external_media_objects">;
    manifestSha256: string;
    manifestPersisted: true;
  },
  { locatorId: Id<"account_external_media_objects">; manifestSha256: string }
>("dev_c8_cleanup:acknowledgeUserPetOrphanDeletedInternal");

const rawR2Credentials = (bucket: string) => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new ConvexError({
      code: "C8_CLEANUP_RAW_R2_NOT_CONFIGURED",
      message: "Exact raw-R2 credentials are required for c8 user-pet cleanup.",
    });
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
};

const assertExternalDeleteAuthority = async (
  ctx: Pick<ActionCtx, "runQuery">,
) => {
  assertC8CleanupDeployment(process.env);
  const cutover = await ctx.runQuery(getCutoverStateRef, {
    deployment: C8_DEV_DEPLOYMENT,
  });
  if (!cutover.closed) {
    throw new ConvexError({
      code: "C8_CLEANUP_QUIET_BARRIER_OPEN",
      message: `The c8 quiet barrier remains open until ${cutover.barrierClosesAt}.`,
    });
  }
};

const deleteExactObjects = async (objects: RawPetObject[]): Promise<void> => {
  const { bucket } = requireConfiguredRawR2MediaTarget({
    bucketEnv: "R2_PETS_BUCKET",
    purpose: "c8 user-pet cleanup",
  });
  for (const object of objects) {
    if (object.bucket !== bucket) {
      throw new ConvexError({
        code: "C8_CLEANUP_RAW_R2_BUCKET_MISMATCH",
        message:
          "The manifested user-pet object is outside the exact development bucket.",
      });
    }
    await deleteR2Object({
      key: object.r2Key,
      r2: rawR2Credentials(bucket),
    });
  }
};

export const deleteManifestedUserPetInternal = internalAction({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    petRowId: v.id("user_pets"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    petRowId: v.id("user_pets"),
    manifestSha256: v.string(),
    deletedObjects: v.number(),
    deletedLocators: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertExternalDeleteAuthority(ctx);
    const current = await ctx.runQuery(getUserPetManifestRef, {
      deployment: C8_DEV_DEPLOYMENT,
      petRowId: args.petRowId,
    });
    if (!current || current.manifestSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The user-pet manifest changed before the external delete.",
      });
    }
    await deleteExactObjects(current.manifest.objects);
    const acknowledged = await ctx.runMutation(acknowledgeUserPetRef, args);
    return {
      ...acknowledged,
      deletedObjects: current.manifest.objects.length,
    };
  },
});

export const deleteManifestedUserPetOrphanInternal = internalAction({
  args: {
    deployment: v.literal(C8_DEV_DEPLOYMENT),
    confirmation: v.literal(C8_DESTRUCTIVE_CONFIRMATION),
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
    manifestPersisted: v.literal(true),
  },
  returns: v.object({
    locatorId: v.id("account_external_media_objects"),
    manifestSha256: v.string(),
    deletedObjects: v.literal(1),
  }),
  handler: async (ctx, args) => {
    await assertExternalDeleteAuthority(ctx);
    let cursor: string | null = null;
    let found: UserPetOrphanManifestResult["manifests"][number] | undefined;
    do {
      const page: UserPetOrphanManifestResult = await ctx.runQuery(
        getUserPetOrphanManifestPageRef,
        {
          deployment: C8_DEV_DEPLOYMENT,
          cursor,
          numItems: 32,
        },
      );
      found = page.manifests.find(
        (entry: UserPetOrphanManifestResult["manifests"][number]) =>
          entry.manifest.locatorId === args.locatorId,
      );
      cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone || found) break;
    } while (cursor !== null);
    if (!found || found.manifestSha256 !== args.manifestSha256) {
      throw new ConvexError({
        code: "C8_CLEANUP_STALE_MANIFEST",
        message: "The user-pet orphan manifest changed before deletion.",
      });
    }
    await deleteExactObjects([
      {
        role: found.manifest.role,
        bucket: found.manifest.bucket,
        r2Key: found.manifest.r2Key,
        publicUrl: found.manifest.publicUrl,
        locatorId: found.manifest.locatorId,
      },
    ]);
    const acknowledged = await ctx.runMutation(
      acknowledgeUserPetOrphanRef,
      args,
    );
    return { ...acknowledged, deletedObjects: 1 as const };
  },
});
