"use node";

import { createHash, randomUUID } from "node:crypto";
import { uploadR2Object } from "../lib/r2_sigv4";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireConnectedUserIdAction } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { EXTERNAL_MEDIA_SERVER_WRITE_BARRIER_MS } from "../account_external_media_store";
import { getFalApiKey } from "../media_fal_webhooks";
import { createMediaProviderDispatch } from "../lib/media_provider_dispatch";
import {
  reserveDurableFalImageJob,
  waitForDurableFalImageUrl,
} from "../lib/durable_fal_image_job";
import { RATE_STANDARD, enforceActionRateLimit } from "../lib/rate_limits";
import { requireConfiguredRawR2MediaTarget } from "../lib/raw_r2_media_target";
import {
  assertPaidMediaTier,
  checkManagedUsageLimit,
} from "../lib/managed_billing";
import {
  emoji_pack_validator,
  emoji_pack_visibility_validator,
} from "../schema/emoji_packs";
import { requireBoundedString } from "../shared_validators";
import {
  EMOJI_SHEETS,
  EMOJI_SHEET_GRID_SIZE,
} from "./emoji_pack_grid_constants";
import { EMOJI_REFERENCE_SHEET_DATA_URLS } from "./emoji_pack_reference_images";

const DEFAULT_PREFIX = "emoji-packs";
const DEFAULT_STYLE = "playful party style";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const FAL_ENDPOINT_ID = "openai/gpt-image-2/edit";
const SHEET_SIZE = 768;
const CHROMA_BACKGROUND = "#ff00ff";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 6 * 60_000;
const MAX_PROMPT = 2_000;

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for emoji pack generation.`,
    });
  }
  return value;
};

const normalizePrefix = (value: string | undefined): string =>
  (value?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");

const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const buildPackId = (prompt: string): string => {
  const slug = slugify(prompt) || "emoji-pack";
  return `${slug}-${Date.now().toString(36).slice(-6)}`;
};

const buildReferenceSheetDataUrl = (sheetIndex: number): string => {
  const url = EMOJI_REFERENCE_SHEET_DATA_URLS[sheetIndex];
  if (!url) throw new Error(`Unknown sheet index ${sheetIndex}`);
  return url;
};

const buildSheetEditPrompt = (style: string): string => {
  const theme = style.trim() || DEFAULT_STYLE;
  return [
    `Edit the reference image into a custom emoji sheet styled entirely as: "${theme}".`,
    "Replace every reference emoji glyph with fully original artwork in that style. Keep the same meaning, cell position, relative scale, and row-major order shown in the reference image.",
    "The reference image is a positional and semantic guide only. Do not copy default Apple, Google, Microsoft, Samsung, Twemoji, or system emoji rendering.",
    `Theme reminder: "${theme}". Apply it to every cell: linework, palette, shading, mood, and character design must all read as that theme.`,
    "",
    "Layout:",
    `- Output a single square image as a ${EMOJI_SHEET_GRID_SIZE}x${EMOJI_SHEET_GRID_SIZE} layout of cells.`,
    "- Cells are perfectly uniform in size with consistent padding.",
    "- Each icon is fully contained inside its cell, centered, with breathing room.",
    "- Preserve the reference image's positions exactly: top-left stays top-left and bottom-right stays bottom-right.",
    "",
    "Background:",
    `- Preserve the reference image's existing ${CHROMA_BACKGROUND} background exactly wherever there is no icon.`,
    `- The gutters between cells must remain the same flat ${CHROMA_BACKGROUND} chroma key (true RGB, no gradient, no noise, no texture).`,
    "- Do not use magenta or magenta-adjacent colors inside any icon.",
    "",
    "Forbidden:",
    "- Default platform emoji rendering of any kind.",
    "- Borders, frame lines, grid lines, labels, captions, watermarks, signatures, or text anywhere on the canvas.",
    "- Decorative confetti, sparkles, particles, motion lines, or background props that do not belong to the icon itself.",
    "- Icons crossing into neighboring cells.",
  ].join("\n");
};

const buildSheetGenerationInput = (sheetIndex: number, style: string) => ({
  prompt: buildSheetEditPrompt(style),
  image_urls: [buildReferenceSheetDataUrl(sheetIndex)],
  image_size: { width: SHEET_SIZE, height: SHEET_SIZE },
  quality: "medium",
  output_format: "webp",
});

const reserveEmojiSheetGenerationJobForOwner = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    sheetIndex: number;
    prompt: string;
  },
) => {
  const generationInput = buildSheetGenerationInput(
    args.sheetIndex,
    args.prompt,
  );
  const requestInput = {
    ...generationInput,
    image_urls: [`[embedded emoji reference sheet ${args.sheetIndex}]`],
  };
  const clientRequestHash = sha256Hex(
    JSON.stringify({
      capability: "image_edit",
      profile: "default",
      input: generationInput,
    }),
  );
  const identityHash = sha256Hex(
    [
      "emoji-pack-sheet:v3",
      args.ownerId,
      args.ownerGeneration,
      args.uploadId,
      String(args.sheetIndex),
      clientRequestHash,
    ].join("\0"),
  );
  return await reserveDurableFalImageJob(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    jobId: `emoji_pack_generation_${identityHash.slice(0, 40)}`,
    clientRequestKey: `emoji-pack-sheet-v3-${identityHash}`,
    clientRequestHash,
    capability: "image_edit",
    profile: "default",
    endpointId: FAL_ENDPOINT_ID,
    prompt: generationInput.prompt,
    input: generationInput,
    requestInput,
  });
};

/** Durable reservation seam shared with recovery and focused race tests. */
export const reserveEmojiSheetGenerationJob = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    sheetIndex: v.number(),
    prompt: v.string(),
  },
  returns: v.union(v.null(), v.object({ jobId: v.string() })),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.sheetIndex) || args.sheetIndex < 0) {
      throw new Error("Emoji sheet index must be a non-negative integer.");
    }
    return await reserveEmojiSheetGenerationJobForOwner(ctx, args);
  },
});

const downloadImage = async (args: {
  ctx: Pick<ActionCtx, "runMutation">;
  ownerId: string;
  ownerGeneration: string;
  authorityId: string;
  url: string;
}): Promise<Buffer> => {
  const dispatch = createMediaProviderDispatch(args.ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    dispatchId: `media:fal_download:emoji_pack:${args.authorityId}`,
    kind: "fal_download",
  });
  try {
    const bytes = await dispatch.run(async (signal) => {
      const response = await fetch(args.url, { signal });
      if (!response.ok) {
        throw new Error(`Image download failed (${response.status})`);
      }
      return Buffer.from(await response.arrayBuffer());
    });
    await dispatch.settle();
    return bytes;
  } catch (error) {
    await dispatch.settle().catch(() => false);
    throw error;
  }
};

export const generatePack = action({
  args: {
    prompt: v.string(),
    visibility: emoji_pack_visibility_validator,
  },
  returns: emoji_pack_validator,
  handler: async (ctx, args): Promise<Doc<"emoji_packs">> => {
    const ownerId = await requireConnectedUserIdAction(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    // Emoji packs are fal image generations like any other, so they sit
    // behind the same capability as the media pipeline.
    await assertPaidMediaTier(ctx, ownerId, "image_generation");
    const usageLimit = await checkManagedUsageLimit(ctx, ownerId);
    if (!usageLimit.allowed) {
      throw new ConvexError({
        code: "USAGE_LIMIT_REACHED",
        message: usageLimit.message,
        retryAfterMs: usageLimit.retryAfterMs,
      });
    }
    await enforceActionRateLimit(
      ctx,
      "emojiPacks.generatePack",
      ownerId,
      RATE_STANDARD,
    );
    const prompt = args.prompt.trim();
    requireBoundedString(prompt, "prompt", MAX_PROMPT);
    if (!prompt) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Prompt is required.",
      });
    }
    if (!getFalApiKey()) {
      throw new ConvexError({
        code: "SERVER_MISCONFIGURED",
        message: "Media generation is not configured yet.",
      });
    }
    const { bucket, publicBase } = requireConfiguredRawR2MediaTarget(
      "Emoji pack generation",
    );
    const r2 = {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      endpoint: requireEnv("R2_ENDPOINT"),
      bucket,
    };
    const prefix = normalizePrefix(process.env.R2_EMOJI_PREFIX);
    const packId = buildPackId(prompt);
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const uploadId = randomUUID();
    const baseKey = `${prefix}/${ownerKey}/${packId}/${uploadId}`;

    const generateSheet = async (sheetIndex: number): Promise<Buffer> => {
      const reserved = await reserveEmojiSheetGenerationJobForOwner(ctx, {
        ownerId,
        ownerGeneration,
        uploadId,
        sheetIndex,
        prompt,
      });
      if (!reserved) {
        throw new Error(
          "Emoji sheet generation was canceled before provider dispatch.",
        );
      }
      const imageUrl = await waitForDurableFalImageUrl(ctx, {
        ownerId,
        ownerGeneration,
        jobId: reserved.jobId,
        deadlineAt: Date.now() + POLL_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      return await downloadImage({
        ctx,
        ownerId,
        ownerGeneration,
        authorityId: reserved.jobId,
        url: imageUrl,
      });
    };
    const sheetBuffers = await Promise.all(
      EMOJI_SHEETS.map((_, sheetIndex) => generateSheet(sheetIndex)),
    );
    const sheetUrls = sheetBuffers.map((_, index) => {
      const key = `${baseKey}/sheet-${index + 1}.webp`;
      return `${publicBase}/${key}`;
    });

    const now = Date.now();
    await ctx.runMutation(
      internal.account_external_media_store.reserveExternalMediaUploadInternal,
      {
        ownerId,
        ownerGeneration,
        uploadId,
        uploadExpiresAt: now + EXTERNAL_MEDIA_SERVER_WRITE_BARRIER_MS,
        objects: sheetBuffers.map((bytes, index) => ({
          objectRole: `sheet-${index + 1}`,
          storageKind: "raw-r2" as const,
          bucket: r2.bucket,
          r2Key: `${baseKey}/sheet-${index + 1}.webp`,
          payloadSha256: sha256Hex(bytes),
          publicUrl: sheetUrls[index]!,
        })),
        now,
      },
    );
    await ctx.runMutation(
      internal.account_external_media_store
        .assertExternalMediaUploadDispatchInternal,
      { ownerId, ownerGeneration, uploadId, now: Date.now() },
    );

    await Promise.all(
      sheetBuffers.map((bytes, index) =>
        uploadR2Object({
          key: `${baseKey}/sheet-${index + 1}.webp`,
          bytes,
          contentType: "image/webp",
          cacheControl: CACHE_CONTROL,
          r2,
        }),
      ),
    );

    return await ctx.runMutation(
      internal.data.emoji_packs.createGeneratedPack,
      {
        ownerId,
        uploadId,
        ownerGeneration,
        packId,
        displayName: "Stella emoji pack",
        description: prompt,
        prompt,
        coverEmoji: EMOJI_SHEETS[0]![0]!,
        sheetUrls,
        visibility: args.visibility,
      },
    );
  },
});
