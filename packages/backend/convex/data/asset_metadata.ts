"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { resolveManagedModelConfigs } from "../agent/model_resolver";
import { createManagedUsageDispatchGuard } from "../lib/managed_billing";
import {
  createManagedDispatchRequestFingerprint,
  estimateManagedModelFallbackCostMicroCents,
} from "../lib/managed_dispatch";
import { extractJsonBlock } from "../lib/json";
import {
  assistantText,
  completeManagedChat,
  runManagedDispatchAttempt,
  type ManagedModelBillingContext,
  type ManagedModelConfig,
} from "../runtime_ai/managed";
import { requireBoundedString } from "../shared_validators";
import { isBlockedContentTag } from "../lib/content_tags";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TAGS = 8;
const MAX_TAG = 32;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 500;

type GeneratedAssetMetadata = {
  displayName?: string;
  description?: string;
  tags: string[];
};

const ASSET_METADATA_SYSTEM_PROMPT = [
  "You name and categorize Stella visual assets.",
  "Study the attached generated image(s) and the creator's prompt/context.",
  "Return only JSON. No markdown.",
  "Prefer short, friendly names. Descriptions should be one card-length sentence.",
  "Tags should be lowercase, user-facing filter labels like cute, pixel, animal, cozy, fantasy, food, robot, spooky, pastel, neon, object, emoji.",
  "Never use nsfw as a tag or category.",
].join("\n");

const ASSET_METADATA_OUTPUT_INSTRUCTIONS = [
  "Return this JSON object:",
  "{",
  '  "displayName": "2-5 words, Title Case",',
  '  "description": "80-160 character description",',
  '  "tags": ["3-6 lowercase tags"]',
  "}",
].join("\n");

const normalizeOptionalText = (
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeTag = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG);
  return normalized.length > 0 ? normalized : null;
};

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tag = normalizeTag(raw);
    if (!tag || isBlockedContentTag(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
};

const parseMetadata = (text: string): GeneratedAssetMetadata => {
  const parsed = extractJsonBlock(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConvexError({
      code: "METADATA_GENERATION_FAILED",
      message: "The model did not return valid metadata JSON.",
    });
  }
  const record = parsed as Record<string, unknown>;
  return {
    displayName: normalizeOptionalText(
      record.displayName,
      "displayName",
      MAX_DISPLAY_NAME,
    ),
    description: normalizeOptionalText(
      record.description,
      "description",
      MAX_DESCRIPTION,
    ),
    tags: normalizeTags(record.tags),
  };
};

const buildSearchText = (args: {
  displayName: string;
  description?: string;
  prompt?: string;
  authorUsername?: string;
  tags: string[];
}): string =>
  [
    args.displayName,
    args.description ?? "",
    args.prompt ?? "",
    args.authorUsername ?? "",
    ...args.tags,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const fetchImage = async (
  url: string,
  signal: AbortSignal,
): Promise<{ mimeType: string; data: string }> => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConvexError({
      code: "METADATA_IMAGE_FETCH_FAILED",
      message: "Could not inspect the generated image.",
    });
  }
  const mimeType =
    response.headers.get("content-type")?.split(";")[0] ?? "image/webp";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ConvexError({
      code: "METADATA_IMAGE_TOO_LARGE",
      message: "Generated image is too large to inspect.",
    });
  }
  return {
    mimeType,
    data: Buffer.from(bytes).toString("base64"),
  };
};

const createAssetMetadataBilling = async (args: {
  ownerId: string;
  ownerGeneration: string;
  assetKind: "emoji_pack";
  userText: string;
  imageUrls: string[];
  images: Array<{ data: string }>;
  config: ManagedModelConfig;
  fallbackConfig?: ManagedModelConfig | null;
}): Promise<ManagedModelBillingContext> => {
  // Base64 image transport averages roughly four encoded characters per three
  // bytes. Counting every three encoded characters as one input token remains
  // deliberately conservative for a response-loss charge without admitting a
  // zero-cost unknown attempt.
  const inputTokens = Math.max(
    1,
    new TextEncoder().encode(
      `${ASSET_METADATA_SYSTEM_PROMPT}\n${args.userText}`,
    ).byteLength +
      args.images.reduce(
        (total, image) => total + Math.ceil(image.data.length / 3),
        0,
      ),
  );
  const estimate = (config: ManagedModelConfig) =>
    estimateManagedModelFallbackCostMicroCents({
      model: config.model,
      inputTokens,
      maxOutputTokens: config.maxOutputTokens ?? 4_096,
    });
  const primaryEstimate = estimate(args.config);
  const fallbackEstimate = args.fallbackConfig
    ? estimate(args.fallbackConfig)
    : undefined;
  return {
    requestFingerprint: await createManagedDispatchRequestFingerprint(
      "asset-metadata",
      [
        args.ownerId,
        args.ownerGeneration,
        args.assetKind,
        args.userText,
        ...args.imageUrls,
      ].join("\0"),
    ),
    agentType: "service:asset_metadata",
    fallbackCostMicroCents: Math.max(
      primaryEstimate,
      fallbackEstimate ?? primaryEstimate,
    ),
    fallbackCostMicroCentsByModel: {
      [args.config.model]: primaryEstimate,
      ...(args.fallbackConfig && fallbackEstimate
        ? { [args.fallbackConfig.model]: fallbackEstimate }
        : {}),
    },
  };
};

const generateMetadata = async (
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  args: {
    ownerId: string;
    assetKind: "emoji_pack";
    prompt?: string;
    currentDisplayName?: string;
    currentDescription?: string;
    imageUrls: string[];
    ownerGeneration: string;
  },
): Promise<{
  metadata: GeneratedAssetMetadata;
  ownerGeneration: string;
}> => {
  const assertDispatch = async () => {
    await ctx.runMutation(
      internal.media_jobs.assertMediaProviderDispatchAllowed,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
      },
    );
  };
  await assertDispatch();
  const { access, config, fallbackConfig } = await resolveManagedModelConfigs(
    ctx,
    "asset_metadata",
    args.ownerId,
  );
  if (access.ownerGeneration !== args.ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message:
        "This asset metadata job started before the account data changed.",
    });
  }
  const images = await Promise.all(
    args.imageUrls.map(async (url) => {
      await assertDispatch();
      const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        beforeDispatch: assertDispatch,
      });
      return await runManagedDispatchAttempt({
        dispatchGuard,
        run: async (signal) => await fetchImage(url, signal),
      });
    }),
  );
  const userText = [
    ASSET_METADATA_OUTPUT_INSTRUCTIONS,
    "",
    `Asset kind: ${args.assetKind}`,
    args.currentDisplayName
      ? `Creator-provided name: ${args.currentDisplayName}`
      : "",
    args.currentDescription
      ? `Creator-provided description: ${args.currentDescription}`
      : "",
    args.prompt ? `Creator prompt/style notes: ${args.prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await assertDispatch();
  const message = await completeManagedChat({
    config,
    fallbackConfig,
    dispatchGuard: createManagedUsageDispatchGuard(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      beforeDispatch: assertDispatch,
    }),
    billing: await createAssetMetadataBilling({
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      assetKind: args.assetKind,
      userText,
      imageUrls: args.imageUrls,
      images,
      config,
      fallbackConfig,
    }),
    context: {
      systemPrompt: ASSET_METADATA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText,
            },
            ...images.map((image) => ({
              type: "image" as const,
              mimeType: image.mimeType,
              data: image.data,
            })),
          ],
          timestamp: Date.now(),
        },
      ],
    },
  });
  return {
    metadata: parseMetadata(assistantText(message)),
    ownerGeneration: args.ownerGeneration,
  };
};

export const enrichEmojiPack = internalAction({
  args: {
    packId: v.id("emoji_packs"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: Doc<"emoji_packs"> | null = await ctx.runQuery(
      internal.data.emoji_packs.getByIdInternal,
      { packId: args.packId },
    );
    if (!row || row.ownerId !== args.ownerId) return null;
    const generated = await generateMetadata(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      assetKind: "emoji_pack",
      currentDisplayName: row.displayName,
      currentDescription: row.description,
      prompt: row.prompt,
      imageUrls: [...(row.coverUrl ? [row.coverUrl] : []), ...row.sheetUrls],
    });
    const { metadata } = generated;
    const displayName = metadata.displayName ?? row.displayName;
    const description = metadata.description ?? row.description;
    await ctx.runMutation(internal.data.emoji_packs.patchGeneratedMetadata, {
      packId: args.packId,
      ownerId: args.ownerId,
      ownerGeneration: generated.ownerGeneration,
      metadata: {
        displayName,
        ...(description ? { description } : {}),
        tags: metadata.tags,
        searchText: buildSearchText({
          displayName,
          description,
          prompt: row.prompt,
          authorUsername: row.authorUsername,
          tags: metadata.tags,
        }),
        updatedAt: Date.now(),
      },
    });
    return null;
  },
});
