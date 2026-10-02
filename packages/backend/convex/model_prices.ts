import { ConvexError, v, type Infer } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  buildManagedModelPriceEntries,
  listManagedModelPriceLookupCandidates,
  STATIC_MANAGED_MODEL_PRICE_OVERRIDES,
  type ManagedModelPriceEntry,
  type ModelsDevApi,
} from "./lib/models_dev";
import { listManagedModelIds } from "./agent/model";
import type { TokenPriceConfig } from "./lib/billing_money";

const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * Managed model prices, synced daily from models.dev. The model gateway
 * prices requests with them (`GET /api/gateway/config`) and Convex code that
 * still meters prices token usage with them. They move with the model
 * catalog.
 */

export const getManagedModelPriceRow = async (
  ctx: Pick<QueryCtx, "db">,
  model: string,
) => {
  for (const candidate of listManagedModelPriceLookupCandidates(model)) {
    const row = await ctx.db
      .query("billing_model_prices")
      .withIndex("by_model", (q) => q.eq("model", candidate))
      .unique();
    if (row) return row;
  }
  return null;
};

export const toTokenPriceConfig = (
  row: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd: number;
    cacheWritePerMillionUsd: number;
    reasoningPerMillionUsd: number;
  } | null,
): TokenPriceConfig | undefined =>
  row
    ? {
        inputPerMillionUsd: row.inputPerMillionUsd,
        outputPerMillionUsd: row.outputPerMillionUsd,
        cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
        cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
        reasoningPerMillionUsd: row.reasoningPerMillionUsd,
      }
    : undefined;

const gatewayModelPriceValidator = v.object({
  model: v.string(),
  inputPerMillionUsd: v.number(),
  outputPerMillionUsd: v.number(),
  cacheReadPerMillionUsd: v.number(),
  cacheWritePerMillionUsd: v.number(),
  reasoningPerMillionUsd: v.number(),
});

/**
 * Prices the gateway uses to estimate and settle managed requests: the synced
 * row when present, else the static fill-in, for every managed model id.
 * Models with neither are omitted (the gateway falls back to its default).
 */
export const listGatewayModelPricesInternal = internalQuery({
  args: {},
  returns: v.object({
    prices: v.array(gatewayModelPriceValidator),
    updatedAt: v.number(),
  }),
  handler: async (ctx) => {
    const modelIds = Array.from(
      new Set([
        ...listManagedModelIds(),
        ...Object.keys(STATIC_MANAGED_MODEL_PRICE_OVERRIDES),
      ]),
    ).sort();
    const prices: Infer<typeof gatewayModelPriceValidator>[] = [];
    let updatedAt = 0;
    for (const model of modelIds) {
      const row = await getManagedModelPriceRow(ctx, model);
      if (row) {
        prices.push({
          model,
          inputPerMillionUsd: row.inputPerMillionUsd,
          outputPerMillionUsd: row.outputPerMillionUsd,
          cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
          cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
          reasoningPerMillionUsd: row.reasoningPerMillionUsd,
        });
        updatedAt = Math.max(updatedAt, row.syncedAt);
        continue;
      }
      const staticPrice = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[model];
      if (!staticPrice) continue;
      prices.push({
        model,
        inputPerMillionUsd: staticPrice.inputPerMillionUsd,
        outputPerMillionUsd: staticPrice.outputPerMillionUsd,
        cacheReadPerMillionUsd: staticPrice.cacheReadPerMillionUsd ?? 0,
        cacheWritePerMillionUsd: staticPrice.cacheWritePerMillionUsd ?? 0,
        reasoningPerMillionUsd:
          staticPrice.reasoningPerMillionUsd ?? staticPrice.outputPerMillionUsd,
      });
    }
    return { prices, updatedAt };
  },
});

export const getManagedModelPrice = internalQuery({
  args: {
    model: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("billing_model_prices"),
      _creationTime: v.number(),
      model: v.string(),
      source: v.string(),
      sourceProvider: v.string(),
      sourceModelId: v.string(),
      inputPerMillionUsd: v.number(),
      outputPerMillionUsd: v.number(),
      cacheReadPerMillionUsd: v.number(),
      cacheWritePerMillionUsd: v.number(),
      reasoningPerMillionUsd: v.number(),
      modalitiesInput: v.optional(v.array(v.string())),
      modalitiesOutput: v.optional(v.array(v.string())),
      sourceUpdatedAt: v.string(),
      syncedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => await getManagedModelPriceRow(ctx, args.model),
});

export const upsertManagedModelPrices = internalMutation({
  args: {
    prices: v.array(
      v.object({
        model: v.string(),
        source: v.string(),
        sourceProvider: v.string(),
        sourceModelId: v.string(),
        inputPerMillionUsd: v.number(),
        outputPerMillionUsd: v.number(),
        cacheReadPerMillionUsd: v.number(),
        cacheWritePerMillionUsd: v.number(),
        reasoningPerMillionUsd: v.number(),
        modalitiesInput: v.array(v.string()),
        modalitiesOutput: v.array(v.string()),
        sourceUpdatedAt: v.string(),
        syncedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existingRows = await Promise.all(
      args.prices.map((price) =>
        ctx.db
          .query("billing_model_prices")
          .withIndex("by_model", (q) => q.eq("model", price.model))
          .unique(),
      ),
    );
    for (const [index, price] of args.prices.entries()) {
      const existing = existingRows[index];
      if (existing) {
        await ctx.db.patch(existing._id, price);
        continue;
      }
      await ctx.db.insert("billing_model_prices", price);
    }
    return { upserted: args.prices.length };
  },
});

export const syncManagedModelPricesFromModelsDev = internalAction({
  args: {},
  returns: v.object({
    syncedAt: v.number(),
    upserted: v.number(),
    source: v.string(),
  }),
  handler: async (
    ctx,
  ): Promise<{ syncedAt: number; upserted: number; source: string }> => {
    const response = await fetch(MODELS_DEV_API_URL, { method: "GET" });
    if (!response.ok) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_FAILED",
        message: `models.dev sync failed with status ${response.status}`,
      });
    }
    const data = (await response.json()) as ModelsDevApi;
    const syncedAt = Date.now();
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data,
      modelIds: listManagedModelIds(),
      syncedAt,
    });
    // Persist every resolved row before surfacing an incomplete catalog, so
    // one newly added model does not hold back every other price.
    const upserted: { upserted: number } =
      entries.length > 0
        ? await ctx.runMutation(internal.model_prices.upsertManagedModelPrices, {
            prices: entries as ManagedModelPriceEntry[] as never,
          })
        : { upserted: 0 };
    if (missingModels.length > 0) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_INCOMPLETE",
        message: `models.dev is missing prices for: ${missingModels.join(", ")}`,
      });
    }
    return { syncedAt, upserted: upserted.upserted, source: MODELS_DEV_API_URL };
  },
});
