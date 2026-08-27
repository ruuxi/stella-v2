"use node";

import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { deleteR2Object, type R2Credentials } from "./lib/r2_sigv4";

const MAX_PAGE_KEYS = 32;

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

type SweepSnapshot = {
  revision: number;
  notBefore: number;
  legacyRowFenceComplete: boolean;
  goal: "preserve_refs" | "empty";
  phase: "cleanup" | "verify" | "ready";
  targetIndex: number;
  startAfter?: string;
  targetPrefix?: string;
};

type PageClassification = {
  deletableKeys: string[];
  protectedCount: number;
};

type SweepResult = {
  ready: boolean;
  retryAfterMs?: number;
};

const prepareMigrationRef = makeFunctionReference<
  "mutation",
  MigrationControlArgs,
  SweepSnapshot
>("backup_legacy_r2_sweep_store:prepareMigrationSweepInternal");

const preparePurgeRef = makeFunctionReference<
  "mutation",
  PurgeControlArgs,
  SweepSnapshot
>("backup_legacy_r2_sweep_store:preparePurgeSweepInternal");

type PageCursor = {
  expectedRevision: number;
  expectedPhase: "cleanup" | "verify";
  expectedTargetIndex: number;
  expectedStartAfter?: string;
};

const classifyMigrationRef = makeFunctionReference<
  "mutation",
  MigrationControlArgs & PageCursor & { keys: string[] },
  PageClassification
>("backup_legacy_r2_sweep_store:classifyMigrationSweepPageInternal");

const classifyPurgeRef = makeFunctionReference<
  "mutation",
  PurgeControlArgs & PageCursor & { keys: string[] },
  PageClassification
>("backup_legacy_r2_sweep_store:classifyPurgeSweepPageInternal");

type DeletionArm = PageCursor & {
  keys: string[];
  deletableKeys: string[];
};

const armMigrationDeletionRef = makeFunctionReference<
  "mutation",
  MigrationControlArgs & DeletionArm,
  null
>("backup_legacy_r2_sweep_store:armMigrationSweepDeletionInternal");

const armPurgeDeletionRef = makeFunctionReference<
  "mutation",
  PurgeControlArgs & DeletionArm,
  null
>("backup_legacy_r2_sweep_store:armPurgeSweepDeletionInternal");

type PageAdvance = PageCursor & {
  keys: string[];
  confirmedDeletedKeys: string[];
  isTruncated: boolean;
};

const advanceMigrationRef = makeFunctionReference<
  "mutation",
  MigrationControlArgs & PageAdvance,
  SweepSnapshot
>("backup_legacy_r2_sweep_store:advanceMigrationSweepInternal");

const advancePurgeRef = makeFunctionReference<
  "mutation",
  PurgeControlArgs & PageAdvance,
  SweepSnapshot
>("backup_legacy_r2_sweep_store:advancePurgeSweepInternal");

const componentR2Credentials = (): R2Credentials => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error("Backup raw-storage credentials are unavailable.");
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
};

const createClient = (credentials: R2Credentials) =>
  new S3Client({
    region: "auto",
    endpoint: credentials.endpoint,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

const responseStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const metadata = "$metadata" in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== "object") return undefined;
  const status =
    "httpStatusCode" in metadata ? metadata.httpStatusCode : undefined;
  return typeof status === "number" ? status : undefined;
};

const confirmAbsent = async (
  client: S3Client,
  credentials: R2Credentials,
  key: string,
) => {
  try {
    await deleteR2Object({ key, r2: credentials });
    let stillPresent = true;
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: credentials.bucket, Key: key }),
      );
    } catch (error) {
      if (responseStatus(error) === 404) {
        stillPresent = false;
      } else {
        throw error;
      }
    }
    if (stillPresent) {
      throw new Error("R2 still reports the object as present.");
    }
  } catch {
    // Do not let raw object keys, credentials, or provider response bodies
    // escape this internal deletion boundary.
    throw new Error(
      "Backup raw-storage cleanup could not confirm physical absence.",
    );
  }
};

const listPage = async (
  client: S3Client,
  credentials: R2Credentials,
  snapshot: SweepSnapshot,
) => {
  if (!snapshot.targetPrefix) {
    throw new Error("Backup raw-storage sweep target is unavailable.");
  }
  let response;
  try {
    response = await client.send(
      new ListObjectsV2Command({
        Bucket: credentials.bucket,
        Prefix: snapshot.targetPrefix,
        MaxKeys: MAX_PAGE_KEYS,
        ...(snapshot.startAfter ? { StartAfter: snapshot.startAfter } : {}),
      }),
    );
  } catch {
    throw new Error("Backup raw-storage listing failed.");
  }
  const contents = response.Contents ?? [];
  if (contents.length > MAX_PAGE_KEYS) {
    throw new Error("Backup raw-storage listing exceeded its bounded page.");
  }
  const keys: string[] = [];
  for (const item of contents) {
    if (item.Key === undefined) {
      throw new Error("Backup raw-storage listing returned a malformed page.");
    }
    keys.push(item.Key);
  }
  if (response.IsTruncated === true && keys.length === 0) {
    throw new Error("Backup raw-storage listing made no cursor progress.");
  }
  return {
    keys: keys as string[],
    targetComplete: response.IsTruncated !== true,
    nextStartAfter:
      response.IsTruncated === true ? keys[keys.length - 1] : undefined,
  };
};

const retryFor = (snapshot: SweepSnapshot): SweepResult => ({
  ready: false,
  retryAfterMs: snapshot.legacyRowFenceComplete
    ? Math.max(1_000, snapshot.notBefore - Date.now())
    : 1_000,
});

const advanceOnePage = async (
  ctx: ActionCtx,
  authority:
    | { kind: "migration"; args: MigrationControlArgs }
    | { kind: "purge"; args: PurgeControlArgs },
): Promise<SweepResult> => {
  const snapshot =
    authority.kind === "migration"
      ? await ctx.runMutation(prepareMigrationRef, authority.args)
      : await ctx.runMutation(preparePurgeRef, authority.args);
  if (snapshot.phase === "ready") return { ready: true };
  if (!snapshot.legacyRowFenceComplete || Date.now() < snapshot.notBefore) {
    return retryFor(snapshot);
  }
  const cursor: PageCursor = {
    expectedRevision: snapshot.revision,
    expectedPhase: snapshot.phase,
    expectedTargetIndex: snapshot.targetIndex,
    ...(snapshot.startAfter ? { expectedStartAfter: snapshot.startAfter } : {}),
  };
  const credentials = componentR2Credentials();
  const client = createClient(credentials);
  const page = await listPage(client, credentials, snapshot);
  const classification =
    authority.kind === "migration"
      ? await ctx.runMutation(classifyMigrationRef, {
          ...authority.args,
          ...cursor,
          keys: page.keys,
        })
      : await ctx.runMutation(classifyPurgeRef, {
          ...authority.args,
          ...cursor,
          keys: page.keys,
        });

  if (classification.deletableKeys.length > 0) {
    if (authority.kind === "migration") {
      await ctx.runMutation(armMigrationDeletionRef, {
        ...authority.args,
        ...cursor,
        keys: page.keys,
        deletableKeys: classification.deletableKeys,
      });
    } else {
      await ctx.runMutation(armPurgeDeletionRef, {
        ...authority.args,
        ...cursor,
        keys: page.keys,
        deletableKeys: classification.deletableKeys,
      });
    }
    for (const key of classification.deletableKeys) {
      await confirmAbsent(client, credentials, key);
    }
  }

  const advance: PageAdvance = {
    ...cursor,
    keys: page.keys,
    confirmedDeletedKeys: classification.deletableKeys,
    isTruncated: !page.targetComplete,
  };
  const updated =
    authority.kind === "migration"
      ? await ctx.runMutation(advanceMigrationRef, {
          ...authority.args,
          ...advance,
        })
      : await ctx.runMutation(advancePurgeRef, {
          ...authority.args,
          ...advance,
        });
  return updated.phase === "ready" ? { ready: true } : retryFor(updated);
};

const resultValidator = v.object({
  ready: v.boolean(),
  retryAfterMs: v.optional(v.number()),
});

export const advanceMigrationLegacyR2SweepInternal = internalAction({
  args: migrationControlArgs,
  returns: resultValidator,
  handler: async (ctx, args) =>
    await advanceOnePage(ctx, { kind: "migration", args }),
});

export const advancePurgeLegacyR2SweepInternal = internalAction({
  args: purgeControlArgs,
  returns: resultValidator,
  handler: async (ctx, args) =>
    await advanceOnePage(ctx, { kind: "purge", args }),
});
