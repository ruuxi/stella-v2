"use node";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireConnectedUserIdAction } from "../auth";
import {
  fetchFalResultPayload,
  getFalApiKey,
  submitFalRequest,
} from "../media_fal_webhooks";
import { checkManagedUsageLimit } from "../lib/managed_billing";
import {
  RATE_STANDARD,
  enforceActionRateLimit,
} from "../lib/rate_limits";
import {
  user_pet_validator,
  user_pet_visibility_validator,
} from "../schema/user_pets";
import { requireBoundedString } from "../shared_validators";

const DEFAULT_BUCKET = "stella-emotes";
const DEFAULT_PREFIX = "user-pets";
const DEFAULT_PUBLIC_BASE =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
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

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const extractFirstImageUrl = (output: unknown): string | null => {
  if (!output || typeof output !== "object") return null;
  const images = (output as { images?: Array<{ url?: unknown }> }).images;
  if (!Array.isArray(images)) return null;
  for (const entry of images) {
    if (entry && typeof entry.url === "string" && entry.url.length > 0) {
      return entry.url;
    }
  }
  return null;
};

const pollFalImageUrl = async (args: {
  apiKey: string;
  responseUrl: string;
}): Promise<string> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const output = await fetchFalResultPayload({
        apiKey: args.apiKey,
        url: args.responseUrl,
      });
      const imageUrl = extractFirstImageUrl(output);
      if (imageUrl) return imageUrl;
      lastError = "Fal result did not include an image URL.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Fal result was not ready.";
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(lastError || "Timed out waiting for pet generation.");
};

const submitPetAtlas = async (args: {
  apiKey: string;
  webhookUrl: string;
  prompt: string;
}): Promise<string> => {
  const submitted = await submitFalRequest({
    apiKey: args.apiKey,
    endpointId: FAL_ENDPOINT_ID,
    webhookUrl: args.webhookUrl,
    input: {
      prompt: buildAtlasPrompt(args.prompt),
      image_size: {
        width: USER_PET_ATLAS.width,
        height: USER_PET_ATLAS.height,
      },
      quality: "medium",
      output_format: "png",
    },
  });
  const responseUrl =
    submitted.responseUrl ??
    `https://queue.fal.run/${FAL_ENDPOINT_ID}/requests/${submitted.requestId}`;
  return await pollFalImageUrl({ apiKey: args.apiKey, responseUrl });
};

const downloadImage = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const resizeNearest = (source: PNG, width: number, height: number): PNG => {
  if (source.width === width && source.height === height) return source;
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / width));
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
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / PREVIEW_STRIP.height));
    for (let x = 0; x < PREVIEW_STRIP.width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / PREVIEW_STRIP.width));
      const sourceIndex = (sy * atlas.width + sx) * 4;
      const targetIndex = (y * preview.width + x) * 4;
      atlas.data.copy(preview.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return preview;
};

const processPetAtlas = (bytes: Buffer): {
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

const signR2Put = (args: {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  key: string;
  payloadHash: string;
  contentType: string;
  cacheControl: string;
}): { putUrl: string; headers: Record<string, string> } => {
  const endpoint = new URL(args.endpoint);
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = `${dateStamp}T${now
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, "")}Z`;
  const host = endpoint.host;
  const url = new URL(
    `${endpoint.protocol}//${host}/${args.bucket}/${args.key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  const headersToSign: Record<string, string> = {
    "content-type": args.contentType,
    "cache-control": args.cacheControl,
    host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headersToSign).sort().join(";");
  const canonicalHeaders = Object.keys(headersToSign)
    .sort()
    .map((key) => `${key}:${headersToSign[key]}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${args.secretAccessKey}`, dateStamp), "auto"), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  return {
    putUrl: url.toString(),
    headers: {
      ...headersToSign,
      authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

const uploadR2Object = async (args: {
  key: string;
  bytes: Buffer;
  r2: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
  };
}): Promise<void> => {
  const signed = signR2Put({
    accessKeyId: args.r2.accessKeyId,
    secretAccessKey: args.r2.secretAccessKey,
    endpoint: args.r2.endpoint,
    bucket: args.r2.bucket,
    key: args.key,
    payloadHash: sha256Hex(args.bytes),
    contentType: "image/png",
    cacheControl: CACHE_CONTROL,
  });
  const response = await fetch(signed.putUrl, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(args.bytes),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`R2 upload failed (${response.status})${text ? `: ${text}` : ""}`);
  }
};

export const generatePet = action({
  args: {
    prompt: v.string(),
    visibility: user_pet_visibility_validator,
  },
  returns: user_pet_validator,
  handler: async (ctx, args): Promise<Doc<"user_pets">> => {
    const ownerId = await requireConnectedUserIdAction(ctx);
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
    const apiKey = getFalApiKey();
    if (!apiKey) {
      throw new ConvexError({
        code: "SERVER_MISCONFIGURED",
        message: "Media generation is not configured yet.",
      });
    }

    const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/+$/, "");
    const webhookUrl = `${siteUrl}/api/media/v1/webhooks/fal?jobId=${encodeURIComponent(`user-pet-${randomUUID()}`)}`;
    const r2 = {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      endpoint: requireEnv("R2_ENDPOINT"),
      bucket:
        process.env.R2_PETS_BUCKET?.trim() ||
        process.env.R2_EMOJI_BUCKET?.trim() ||
        DEFAULT_BUCKET,
    };
    const prefix = normalizePrefix(process.env.R2_PETS_PREFIX);
    const publicBase = (
      process.env.R2_PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE
    ).replace(/\/+$/, "");
    const petId = buildPetId(prompt);
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const uploadId = randomUUID();
    const baseKey = `${prefix}/${ownerKey}/${petId}/${uploadId}`;

    const imageUrl = await submitPetAtlas({ apiKey, webhookUrl, prompt });
    const generated = await downloadImage(imageUrl);
    const processed = processPetAtlas(generated);
    const spritesheetKey = `${baseKey}/spritesheet.png`;
    const previewKey = `${baseKey}/preview.png`;
    await Promise.all([
      uploadR2Object({ key: spritesheetKey, bytes: processed.spritesheet, r2 }),
      uploadR2Object({ key: previewKey, bytes: processed.preview, r2 }),
    ]);

    return await ctx.runMutation(internal.data.user_pets.createGeneratedPet, {
      ownerId,
      petId,
      displayName: "Stella pet",
      description: prompt,
      prompt,
      spritesheetUrl: `${publicBase}/${spritesheetKey}`,
      previewUrl: `${publicBase}/${previewKey}`,
      visibility: args.visibility,
    });
  },
});
