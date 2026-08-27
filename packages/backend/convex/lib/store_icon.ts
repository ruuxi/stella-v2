import { Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import { encryptSecret } from "../data/secrets_crypto";
import { dollarsToMicroCents } from "./billing_money";
import { hashSha256Hex } from "./crypto_utils";
import { checkManagedUsageLimit } from "./managed_billing";
import { resolveMediaProfile } from "../media_catalog";
import { getFalApiKey } from "../media_fal_webhooks";
import {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
} from "../media_jobs";
import { store_package_category_validator } from "../schema/store";
import { isRecord } from "../shared_validators";

const ICON_CAPABILITY_ID = "icon";
const ICON_PROFILE_ID = "default";
const ICON_TIMEOUT_MS = 30_000;
const ICON_POLL_INTERVAL_MS = 1_500;
const MAX_ICON_URL_LENGTH = 2_048;
const MEDIA_FAL_WEBHOOK_PATH = "/api/media/v1/webhooks/fal";
const ICON_MINIMUM_REMAINING_MICRO_CENTS = dollarsToMicroCents(0.003146);

type StoreCategory = Infer<typeof store_package_category_validator>;

type StoreIconRequest = {
  ownerId: string;
  ownerGeneration: string;
  packageId: string;
  displayName: string;
  description: string;
  category: StoreCategory;
};

const storeIconRequestValidator = {
  ownerId: v.string(),
  ownerGeneration: v.string(),
  packageId: v.string(),
  displayName: v.string(),
  description: v.string(),
  category: store_package_category_validator,
};

const reservedStoreIconValidator = v.object({ jobId: v.string() });
const generatedStoreIconValidator = v.object({
  jobId: v.string(),
  iconUrl: v.optional(v.string()),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildIconPrompt = (args: {
  displayName: string;
  description: string;
  category: StoreCategory;
}): string => {
  const role = (() => {
    switch (args.category) {
      case "apps-games":
        return "a Stella app or game";
      case "productivity":
        return "a productivity feature";
      case "customization":
        return "a customization or theme";
      case "skills-agents":
        return "an AI skill or agent";
      case "integrations":
        return "an integration or connector";
      case "other":
      default:
        return "a Stella add-on";
    }
  })();
  return [
    `App-store style icon for ${role} called "${args.displayName.trim()}".`,
    `Concept: ${args.description.trim()}.`,
    "Style: minimal flat vector, single subject centered, soft glow,",
    "vibrant saturated solid background, gentle gradient, rounded forms,",
    "Apple-like clarity, no text, no letters, no UI chrome, no borders.",
    "Square 1024x1024, plenty of padding around the subject.",
  ].join(" ");
};

const normalizeIconUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ICON_URL_LENGTH) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const extractFirstImageUrl = (output: unknown): string | undefined => {
  if (!isRecord(output) || !Array.isArray(output.images)) return undefined;
  for (const entry of output.images) {
    const candidate =
      typeof entry === "string"
        ? entry
        : isRecord(entry)
          ? entry.url
          : undefined;
    const normalized = normalizeIconUrl(candidate);
    if (normalized) return normalized;
  }
  return undefined;
};

const webhookUrlForJob = (args: {
  jobId: string;
  ownerGeneration: string;
}): string | null => {
  const siteUrl = process.env.CONVEX_SITE_URL?.trim();
  if (!siteUrl) return null;
  try {
    const webhook = new URL(MEDIA_FAL_WEBHOOK_PATH, siteUrl);
    webhook.searchParams.set("jobId", args.jobId);
    webhook.searchParams.set("ownerGeneration", args.ownerGeneration);
    return webhook.toString();
  } catch {
    return null;
  }
};

const prepareStoreIconIdentity = async (args: StoreIconRequest) => {
  const resolved = resolveMediaProfile(ICON_CAPABILITY_ID, ICON_PROFILE_ID);
  if (!resolved || resolved.profile.provider !== "fal") return null;
  const prompt = buildIconPrompt(args);
  const input = {
    prompt,
    image_size: { width: 1024, height: 1024 },
    num_images: 1,
    output_format: "png",
  };
  const clientRequestHash = await hashSha256Hex(
    JSON.stringify({
      capability: ICON_CAPABILITY_ID,
      profile: ICON_PROFILE_ID,
      input,
    }),
  );
  const identityHash = await hashSha256Hex(
    [
      "store-icon:v2",
      args.ownerId,
      args.ownerGeneration,
      args.packageId,
      clientRequestHash,
    ].join("\0"),
  );
  return {
    resolved,
    prompt,
    input,
    clientRequestHash,
    clientRequestKey: `store-icon-v2-${identityHash}`,
    jobId: `store_icon_${identityHash.slice(0, 40)}`,
  };
};

/**
 * Reserve Store auto-icon generation through the durable media submission
 * outbox. The reservation, encrypted payload, provider locator, webhook,
 * cancellation, purge, watchdog, and billing receipt are therefore identical
 * to managed image_gen rather than a second best-effort Fal workflow.
 */
const reserveStoreIconJobForOwner = async (
  ctx: ActionCtx,
  args: StoreIconRequest,
): Promise<{ jobId: string } | null> => {
  const prepared = await prepareStoreIconIdentity(args);
  if (!prepared) return null;

  // Reattachment never allocates new provider work, so it intentionally
  // precedes fresh quota admission just like the public media endpoint.
  const existing = await ctx.runQuery(
    internal.media_jobs.getByOwnerClientRequestKey,
    {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      clientRequestKey: prepared.clientRequestKey,
    },
  );
  if (existing) {
    if (
      existing.clientRequestHash &&
      existing.clientRequestHash !== prepared.clientRequestHash
    ) {
      throw new Error(
        "Store icon media identity was reused with another input.",
      );
    }
    return { jobId: existing.jobId };
  }

  if (!getFalApiKey()) return null;

  const admission = await checkManagedUsageLimit(ctx, args.ownerId, {
    minimumRemainingMicroCents: ICON_MINIMUM_REMAINING_MICRO_CENTS,
  });
  if (!admission.allowed) return null;

  const webhookUrl = webhookUrlForJob({
    jobId: prepared.jobId,
    ownerGeneration: args.ownerGeneration,
  });
  if (!webhookUrl) return null;

  const encrypted = JSON.stringify(
    await encryptSecret(JSON.stringify({ input: prepared.input, webhookUrl })),
  );
  if (
    encrypted.length < 1 ||
    encrypted.length > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS
  ) {
    throw new Error("Encrypted Store icon submission exceeds safe limits.");
  }
  const chunks = Array.from(
    {
      length: Math.ceil(encrypted.length / PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS),
    },
    (_, index) =>
      encrypted.slice(
        index * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
        (index + 1) * PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
      ),
  );
  // Each concurrent preparer gets a separate encrypted manifest because the
  // encryption nonce differs. reserveIdempotentJob atomically adopts one and
  // sends every losing manifest to cleanup; ciphertext can never be mixed.
  const manifestId = `store_icon_payload_${prepared.jobId}_${crypto.randomUUID()}`;
  let reservationFinished = false;
  try {
    const manifest = await ctx.runMutation(
      internal.media_jobs.createPrivatePayloadManifest,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        manifestId,
        jobId: prepared.jobId,
        clientRequestKey: prepared.clientRequestKey,
        expectedChunks: chunks.length,
        totalChars: encrypted.length,
        createdAt: Date.now(),
      },
    );
    if (manifest === "owner_purged") {
      await ctx.runMutation(
        internal.media_jobs.makePrivatePayloadManifestDeletable,
        { manifestId },
      );
      return null;
    }
    if (manifest !== "created") {
      throw new Error("Store icon private payload identity was not unique.");
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const appended = await ctx.runMutation(
        internal.media_jobs.appendPrivatePayloadChunk,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          manifestId,
          index,
          data: chunks[index]!,
          writtenAt: Date.now(),
        },
      );
      if (appended === "owner_purged") {
        await ctx.runMutation(
          internal.media_jobs.makePrivatePayloadManifestDeletable,
          { manifestId },
        );
        return null;
      }
    }
    const finalized = await ctx.runMutation(
      internal.media_jobs.finalizePrivatePayloadManifest,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        manifestId,
        finalizedAt: Date.now(),
      },
    );
    if (finalized === "owner_purged") {
      await ctx.runMutation(
        internal.media_jobs.makePrivatePayloadManifestDeletable,
        { manifestId },
      );
      return null;
    }

    const reservation = await ctx.runMutation(
      internal.media_jobs.reserveIdempotentJob,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: prepared.jobId,
        clientRequestKey: prepared.clientRequestKey,
        clientRequestHash: prepared.clientRequestHash,
        capability: ICON_CAPABILITY_ID,
        profile: ICON_PROFILE_ID,
        provider: "fal",
        endpointId: prepared.resolved.profile.endpointId,
        request: { prompt: prepared.prompt, input: prepared.input },
        submissionPayloadManifestId: manifestId,
      },
    );
    reservationFinished = true;
    switch (reservation.state) {
      case "created":
      case "existing":
        return { jobId: reservation.jobId };
      case "owner_purged":
      case "canceled":
        return null;
      case "conflict":
        throw new Error("Store icon media reservation conflicted.");
    }
  } catch (error) {
    if (!reservationFinished) {
      await ctx
        .runMutation(internal.media_jobs.makePrivatePayloadManifestDeletable, {
          manifestId,
        })
        .catch(() => undefined);
    }
    throw error;
  }
};

const waitForStoreIcon = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    jobId: string;
    deadlineAt: number;
  },
): Promise<string | undefined> => {
  for (;;) {
    const job = await ctx.runQuery(internal.media_jobs.getByOwnerJobId, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.jobId,
    });
    if (!job) return undefined;
    if (job.status === "succeeded") return extractFirstImageUrl(job.output);
    if (["failed", "canceled", "unknown"].includes(job.status)) {
      return undefined;
    }
    const remaining = args.deadlineAt - Date.now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(ICON_POLL_INTERVAL_MS, remaining));
  }
};

/** Testable reservation seam; production publication calls generateStoreIcon. */
export const reserveStoreIconJob = internalAction({
  args: storeIconRequestValidator,
  returns: v.union(v.null(), reservedStoreIconValidator),
  handler: async (ctx, args) => await reserveStoreIconJobForOwner(ctx, args),
});

/**
 * Preserve the current synchronous auto-icon UX for fast completions while
 * leaving the media job durable after the 30-second UI wait expires.
 */
export const generateStoreIcon = internalAction({
  args: storeIconRequestValidator,
  returns: v.union(v.null(), generatedStoreIconValidator),
  handler: async (ctx, args) => {
    const deadlineAt = Date.now() + ICON_TIMEOUT_MS;
    const reserved = await reserveStoreIconJobForOwner(ctx, args);
    if (!reserved) return null;
    const iconUrl = await waitForStoreIcon(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: reserved.jobId,
      deadlineAt,
    });
    return { jobId: reserved.jobId, ...(iconUrl ? { iconUrl } : {}) };
  },
});
