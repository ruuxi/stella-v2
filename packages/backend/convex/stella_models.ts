import { query } from "./_generated/server";
import { v } from "convex/values";
import { STELLA_MODEL_CATALOG_UPDATED_AT } from "@stella/model-catalog/aliases";

export * from "@stella/model-catalog/aliases";

export const getModelCatalogUpdatedAt = query({
  args: {},
  returns: v.number(),
  handler: async () => STELLA_MODEL_CATALOG_UPDATED_AT,
});
