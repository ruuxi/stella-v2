"use node";

import { createHash, randomUUID } from "node:crypto";
import { uploadR2Object } from "../lib/r2_sigv4";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
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
import {
  assertPaidMediaTier,
  checkManagedUsageLimit,
} from "../lib/managed_billing";
import { RATE_STANDARD, enforceActionRateLimit } from "../lib/rate_limits";
import { requireConfiguredRawR2MediaTarget } from "../lib/raw_r2_media_target";
import {
  user_pet_validator,
  user_pet_visibility_validator,
} from "../schema/user_pets";
import { requireBoundedString } from "../shared_validators";
import { assertC8RetiredSurfaceUnavailable } from "../lib/c8_retired_surface";

const DEFAULT_PREFIX = "user-pets";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const FAL_ENDPOINT_ID = "openai/gpt-image-2";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 6 * 60_000;
const MAX_PROMPT = 2_000;

const USER_PET_ATLAS = {
  width: 2560,
  height: 3240,
  columns: 8,
  rows: 9,
  cellWidth: 320,
  cellHeight: 360,
  chroma: "#00ff00",
} as const;

const PREVIEW_STRIP = {
  width: 640,
  height: 90,
} as const;

const PET_GENERATION_ROWS = [
  {
    state: "idle",
    intent:
      "ambient breathing loop spread across all eight cells. Subtle chest/head movement only; no walking or waving.",
  },
  {
    state: "running-right",
    intent:
      "facing right, scampering across all eight cells. Body and limbs in motion; no speed lines, dust, or shadows.",
  },
  {
    state: "running-left",
    intent:
      "facing left, scampering across all eight cells, mirrored from running-right when symmetric. No speed lines, dust, or shadows.",
  },
  {
    state: "waving",
    intent:
      "warm greeting paw wave spread across all eight cells. Convey through paw pose only; no wave marks, motion arcs, sparkles, or symbols.",
  },
  {
    state: "jumping",
    intent:
      "vertical hop arc spread across all eight cells. Convey through body position only; no shadows, dust, landing marks, or impact bursts.",
  },
  {
    state: "failed",
    intent:
      "dizzy, shocked, or shaken reaction across all eight cells. Attached opaque tears, stars, or smoke puffs may overlap the silhouette; no detached symbols.",
  },
  {
    state: "waiting",
    intent:
      "polite needs-input loop across all eight cells. Looking up, tapping, or glancing; no question marks or thought bubbles.",
  },
  {
    state: "success",
    intent:
      "happy celebratory loop across all eight cells. Use pose and face only; no confetti, sparkles, floating hearts, or detached props.",
  },
  {
    state: "review",
    intent:
      "focused review loop across all eight cells. Lean, blink, eye direction, head tilt, or paw position; no papers, code, UI, or punctuation.",
  },
] as const;

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for pet generation.`,
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

const buildPetId = (prompt: string): string => {
  const slug = slugify(prompt) || "pet";
  return `${slug}-${Date.now().toString(36).slice(-6)}`;
};

const buildAtlasPrompt = (description: string): string => {
  const rowsTable = PET_GENERATION_ROWS.map(
    (row, index) => `| ${index} | ${row.state.padEnd(13)} | ${row.intent}`,
  ).join("\n");
  return `# Stella pet sprite atlas - Custom Pet

Generate a single ${USER_PET_ATLAS.width} x ${USER_PET_ATLAS.height} sprite sheet of the same pet performing nine animation states.

## Layout

- The image is exactly ${USER_PET_ATLAS.width} x ${USER_PET_ATLAS.height} pixels.
- ${USER_PET_ATLAS.rows} rows x ${USER_PET_ATLAS.columns} columns of ${USER_PET_ATLAS.cellWidth} x ${USER_PET_ATLAS.cellHeight} cells.
- Every row contains exactly ${USER_PET_ATLAS.columns} frames. Frames within each row read left to right.
- Each pet silhouette fits fully inside its single cell with breathing room on all sides. No silhouette crosses into a neighboring cell.

## Rows

| row | state         | animation intent
| --- | ------------- | ----------------
${rowsTable}

## Pet identity

${description.trim() || "A friendly Stella mascot pet."}

Identity must stay consistent across every cell: same head shape, face, markings, palette, prop, outline weight, and body proportions.

## Style

Small pixel-art-adjacent mascot. Chunky readable silhouette. Thick dark 1-2 px outline. Visible stepped pixel edges. Limited palette. Flat cel shading. Simple expressive face. Tiny limbs.

## Background

Background everywhere outside the pet silhouette is a single flat ${USER_PET_ATLAS.chroma} (true RGB, no gradient, no noise, no other green tones in the pet). The same ${USER_PET_ATLAS.chroma} fills the gutters between cells.

## Forbidden

- No detached effects, shadows, labels, frame numbers, captions, speech bubbles, thought bubbles, UI, code, punctuation marks, watermarks, or grid guidelines.
- No chroma-key-adjacent colors inside the pet, prop, or any allowed attached effect.
- No silhouette crossing into a neighboring cell. Scale the silhouette down when needed.`;
};

const buildPetGenerationInput = (prompt: string) => ({
  prompt: buildAtlasPrompt(prompt),
  image_size: {
    width: USER_PET_ATLAS.width,
    height: USER_PET_ATLAS.height,
  },
  quality: "medium",
  output_format: "png",
});

const reservePetGenerationJobForOwner = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    uploadId: string;
    prompt: string;
  },
) => {
  const generationInput = buildPetGenerationInput(args.prompt);
  const clientRequestHash = sha256Hex(
    JSON.stringify({
      capability: "text_to_image",
      profile: "best",
      input: generationInput,
    }),
  );
  const identityHash = sha256Hex(
    [
      "user-pet:v3",
      args.ownerId,
      args.ownerGeneration,
      args.uploadId,
      clientRequestHash,
    ].join("\0"),
  );
  return await reserveDurableFalImageJob(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    jobId: `user_pet_generation_${identityHash.slice(0, 40)}`,
    clientRequestKey: `user-pet-v3-${identityHash}`,
    clientRequestHash,
    capability: "text_to_image",
    profile: "best",
    endpointId: FAL_ENDPOINT_ID,
    prompt: generationInput.prompt,
    input: generationInput,
  });
};

/** Durable reservation seam shared with recovery and focused race tests. */
export const reservePetGenerationJob = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    prompt: v.string(),
  },
  returns: v.union(v.null(), v.object({ jobId: v.string() })),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Custom pet generation");
    return await reservePetGenerationJobForOwner(ctx, args);
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
    dispatchId: `media:fal_download:user_pet:${args.authorityId}`,
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

const resizeNearest = (source: PNG, width: number, height: number): PNG => {
  if (source.width === width && source.height === height) return source;
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(
      source.height - 1,
      Math.floor((y * source.height) / height),
    );
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(
        source.width - 1,
        Math.floor((x * source.width) / width),
      );
      const sourceIndex = (sy * source.width + sx) * 4;
      const targetIndex = (y * width + x) * 4;
      source.data.copy(target.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return target;
};

const keyChromaToAlpha = (png: PNG): void => {
  const pixels = png.data;
  const key = { r: 0, g: 255, b: 0 };
  for (let i = 0; i < pixels.length; i += 4) {
    const dr = pixels[i]! - key.r;
    const dg = pixels[i + 1]! - key.g;
    const db = pixels[i + 2]! - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= 80) {
      pixels[i + 3] = 0;
    } else if (dist <= 130) {
      pixels[i + 3] = Math.round(255 * ((dist - 80) / 50));
    }
  }
};

const buildIdlePreviewStrip = (atlas: PNG): PNG => {
  const preview = new PNG({
    width: PREVIEW_STRIP.width,
    height: PREVIEW_STRIP.height,
  });
  const sourceWidth = USER_PET_ATLAS.cellWidth * USER_PET_ATLAS.columns;
  const sourceHeight = USER_PET_ATLAS.cellHeight;
  for (let y = 0; y < PREVIEW_STRIP.height; y += 1) {
    const sy = Math.min(
      sourceHeight - 1,
      Math.floor((y * sourceHeight) / PREVIEW_STRIP.height),
    );
    for (let x = 0; x < PREVIEW_STRIP.width; x += 1) {
      const sx = Math.min(
        sourceWidth - 1,
        Math.floor((x * sourceWidth) / PREVIEW_STRIP.width),
      );
      const sourceIndex = (sy * atlas.width + sx) * 4;
      const targetIndex = (y * preview.width + x) * 4;
      atlas.data.copy(preview.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return preview;
};

const processPetAtlas = (
  bytes: Buffer,
): {
  spritesheet: Buffer;
  preview: Buffer;
} => {
  const decoded = PNG.sync.read(bytes);
  const atlas = resizeNearest(
    decoded,
    USER_PET_ATLAS.width,
    USER_PET_ATLAS.height,
  );
  keyChromaToAlpha(atlas);
  return {
    spritesheet: PNG.sync.write(atlas),
    preview: PNG.sync.write(buildIdlePreviewStrip(atlas)),
  };
};

export const generatePet = action({
  args: {
    prompt: v.string(),
    visibility: user_pet_visibility_validator,
  },
  returns: user_pet_validator,
  handler: async (ctx, args): Promise<Doc<"user_pets">> => {
    assertC8RetiredSurfaceUnavailable("Custom pet generation");
    const ownerId = await requireConnectedUserIdAction(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    // Pet sprite sheets are fal image generations like any other, so they sit
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
      "userPets.generatePet",
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

    const { bucket, publicBase } = requireConfiguredRawR2MediaTarget({
      bucketEnv: "R2_PETS_BUCKET",
      purpose: "Pet generation",
    });
    const r2 = {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      endpoint: requireEnv("R2_ENDPOINT"),
      bucket,
    };
    const prefix = normalizePrefix(process.env.R2_PETS_PREFIX);
    const petId = buildPetId(prompt);
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const uploadId = randomUUID();
    const baseKey = `${prefix}/${ownerKey}/${petId}/${uploadId}`;
    const reserved = await reservePetGenerationJobForOwner(ctx, {
      ownerId,
      ownerGeneration,
      uploadId,
      prompt,
    });
    if (!reserved) {
      throw new Error("Pet generation was canceled before provider dispatch.");
    }
    const imageUrl = await waitForDurableFalImageUrl(ctx, {
      ownerId,
      ownerGeneration,
      jobId: reserved.jobId,
      deadlineAt: Date.now() + POLL_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const generated = await downloadImage({
      ctx,
      ownerId,
      ownerGeneration,
      authorityId: reserved.jobId,
      url: imageUrl,
    });
    const processed = processPetAtlas(generated);
    const spritesheetKey = `${baseKey}/spritesheet.png`;
    const previewKey = `${baseKey}/preview.png`;
    const spritesheetUrl = `${publicBase}/${spritesheetKey}`;
    const previewUrl = `${publicBase}/${previewKey}`;
    const now = Date.now();
    await ctx.runMutation(
      internal.account_external_media_store.reserveExternalMediaUploadInternal,
      {
        ownerId,
        ownerGeneration,
        uploadId,
        uploadExpiresAt: now + EXTERNAL_MEDIA_SERVER_WRITE_BARRIER_MS,
        objects: [
          {
            objectRole: "spritesheet",
            storageKind: "raw-r2",
            bucket: r2.bucket,
            r2Key: spritesheetKey,
            payloadSha256: sha256Hex(processed.spritesheet),
            publicUrl: spritesheetUrl,
          },
          {
            objectRole: "preview",
            storageKind: "raw-r2",
            bucket: r2.bucket,
            r2Key: previewKey,
            payloadSha256: sha256Hex(processed.preview),
            publicUrl: previewUrl,
          },
        ],
        now,
      },
    );
    await ctx.runMutation(
      internal.account_external_media_store
        .assertExternalMediaUploadDispatchInternal,
      { ownerId, ownerGeneration, uploadId, now: Date.now() },
    );
    await Promise.all([
      uploadR2Object({
        key: spritesheetKey,
        bytes: processed.spritesheet,
        contentType: "image/png",
        cacheControl: CACHE_CONTROL,
        r2,
      }),
      uploadR2Object({
        key: previewKey,
        bytes: processed.preview,
        contentType: "image/png",
        cacheControl: CACHE_CONTROL,
        r2,
      }),
    ]);

    return await ctx.runMutation(internal.data.user_pets.createGeneratedPet, {
      ownerId,
      uploadId,
      ownerGeneration,
      petId,
      displayName: "Stella pet",
      description: prompt,
      prompt,
      spritesheetUrl,
      previewUrl,
      visibility: args.visibility,
    });
  },
});
