import type { GatewayModelPrice } from "@stella/contracts/gateway/usage";
import { listManagedModelIds } from "@stella/model-catalog/model";
import { STATIC_MANAGED_MODEL_PRICE_OVERRIDES } from "@stella/model-catalog/pricing";

/**
 * Managed model prices in D1 (`model_prices`, migration 0002), synced daily
 * from models.dev by the Cron Trigger. The model gateway prices requests with
 * them (`BillingControl.gatewayConfig()`) and the public catalog shows them.
 */

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 30_000;
/** Prices change daily at most; a warm isolate rereads D1 this often. */
const PRICES_CACHE_MS = 5 * 60_000;

type ModelsDevModelEntry = {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number };
  modalities?: { input?: string[]; output?: string[] };
  last_updated?: string;
};

type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevModelEntry> }>;

type PriceRow = {
  model: string;
  source: "models.dev" | "static";
  sourceProvider: string;
  sourceModelId: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
  reasoningPerMillionUsd: number;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  sourceUpdatedAt: string;
  syncedAt: number;
};

const MODELS_DEV_ALIASES: Record<string, string[]> = {
  "google/gemini-3.6-flash": ["vercel/google/gemini-3.6-flash"],
  "anthropic/claude-sonnet-4.6": ["vercel/anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4-6"],
  "anthropic/claude-opus-5": ["vercel/anthropic/claude-opus-5"],
  "anthropic/claude-opus-4.6": ["vercel/anthropic/claude-opus-4.6", "anthropic/claude-opus-4-6"],
  "anthropic/claude-opus-4.5": ["vercel/anthropic/claude-opus-4.5", "anthropic/claude-opus-4-5"],
  // Stella routes xAI as `x-ai`; models.dev's namespace is `xai`.
  "x-ai/grok-4.5": ["xai/grok-4.5", "vercel/xai/grok-4.5"],
};

// Slugs that name the vendor, not the serving provider: prefer the serving
// provider's row so billing matches what Stella pays.
const MODELS_DEV_PREFERRED_ALIASES: Record<string, string[]> = {
  "google/gemini-3.7-flash": ["openrouter/google/gemini-3.7-flash"],
  "meta/muse-spark-1.3-contributor": ["openrouter/meta/muse-spark-1.3-contributor"],
};

const stripSnapshotSuffix = (model: string): string | null => {
  const withoutIsoDate = model.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  if (withoutIsoDate !== model) return withoutIsoDate;
  // MMDD snapshots (DeepSeek V4 Flash 0731) price on the undated family id.
  const withoutMonthDay = model.replace(/-\d{4}$/u, "");
  return withoutMonthDay !== model ? withoutMonthDay : null;
};

/** Exact id first, then the undated family id of a dated snapshot. */
const lookupCandidates = (model: string): string[] => {
  const normalized = model.trim();
  if (!normalized) return [];
  const base = stripSnapshotSuffix(normalized);
  return base ? [normalized, base] : [normalized];
};

const splitPath = (value: string) => {
  const slash = value.indexOf("/");
  return slash < 0 ? null : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
};

const resolveModelsDevModel = (data: ModelsDevApi, model: string) => {
  const candidates: string[] = [];
  for (const lookup of lookupCandidates(model)) {
    const direct = splitPath(lookup);
    candidates.push(
      ...(MODELS_DEV_PREFERRED_ALIASES[lookup] ?? []),
      `vercel/${lookup}`,
      lookup,
      ...(MODELS_DEV_ALIASES[lookup] ?? []),
    );
    // models.dev keys Fireworks routers under "fireworks-ai" with full ids.
    if (lookup.startsWith("accounts/fireworks/")) candidates.push(`fireworks-ai/${lookup}`);
    if (direct) {
      candidates.push(`${direct.provider}/${direct.modelId.replace(/\./g, "-")}`);
      if (direct.provider === "accounts" && direct.modelId.startsWith("fireworks/models/")) {
        candidates.push(`fireworks/${direct.modelId.slice("fireworks/models/".length)}`);
      }
    }
  }
  for (const candidate of new Set(candidates)) {
    const parsed = splitPath(candidate);
    const entry = parsed ? data[parsed.provider]?.models?.[parsed.modelId] : undefined;
    if (parsed && entry) return { sourceProvider: parsed.provider, sourceModelId: parsed.modelId, entry };
  }
  return null;
};

const database = (env: Pick<Cloudflare.Env, "DB">): D1Database => {
  if (!env.DB) throw new Error("The DB binding is missing.");
  return env.DB;
};

const toNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const modalityList = (modalities?: string[]): string[] => {
  if (!Array.isArray(modalities)) return ["text"];
  const list = modalities.filter(
    (item): item is string => typeof item === "string" && item.length > 0 && item.length < 32,
  );
  return list.length > 0 ? list : ["text"];
};

const buildPriceRows = (data: ModelsDevApi, modelIds: string[], syncedAt: number) => {
  const rows: PriceRow[] = [];
  const missing: string[] = [];
  for (const model of modelIds) {
    const resolved = resolveModelsDevModel(data, model);
    if (resolved) {
      const cost = resolved.entry.cost;
      rows.push({
        model,
        source: "models.dev",
        sourceProvider: resolved.sourceProvider,
        sourceModelId: resolved.sourceModelId,
        inputPerMillionUsd: toNumber(cost?.input),
        outputPerMillionUsd: toNumber(cost?.output),
        cacheReadPerMillionUsd: toNumber(cost?.cache_read),
        cacheWritePerMillionUsd: toNumber(cost?.cache_write),
        // models.dev publishes `cost.reasoning` for few models; bill the rest
        // at the output rate rather than zero.
        reasoningPerMillionUsd: toNumber(cost?.reasoning) || toNumber(cost?.output),
        modalitiesInput: modalityList(resolved.entry.modalities?.input),
        modalitiesOutput: modalityList(resolved.entry.modalities?.output),
        sourceUpdatedAt: resolved.entry.last_updated?.trim() ?? "",
        syncedAt,
      });
      continue;
    }
    const fill = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[model];
    if (!fill) {
      missing.push(model);
      continue;
    }
    rows.push({
      model,
      source: "static",
      sourceProvider: fill.sourceProvider,
      sourceModelId: fill.sourceModelId,
      inputPerMillionUsd: fill.inputPerMillionUsd,
      outputPerMillionUsd: fill.outputPerMillionUsd,
      cacheReadPerMillionUsd: fill.cacheReadPerMillionUsd ?? 0,
      cacheWritePerMillionUsd: fill.cacheWritePerMillionUsd ?? 0,
      reasoningPerMillionUsd: fill.reasoningPerMillionUsd ?? fill.outputPerMillionUsd,
      modalitiesInput: modalityList(fill.modalitiesInput),
      modalitiesOutput: modalityList(fill.modalitiesOutput),
      sourceUpdatedAt: "",
      syncedAt,
    });
  }
  return { rows, missing };
};

/**
 * The daily sync. Every resolved row is written before an incomplete catalog
 * is reported, so one newly added model never holds back every other price.
 */
export async function syncModelPrices(env: Pick<Cloudflare.Env, "DB">): Promise<{ upserted: number }> {
  const db = database(env);
  const response = await fetch(MODELS_DEV_API_URL, { signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`models.dev sync failed with status ${response.status}`);
  const data = (await response.json()) as ModelsDevApi;
  const { rows, missing } = buildPriceRows(data, listManagedModelIds(), Date.now());
  if (rows.length > 0) {
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO model_prices (model, source, source_provider, source_model_id,
         input_per_million_usd, output_per_million_usd, cache_read_per_million_usd,
         cache_write_per_million_usd, reasoning_per_million_usd, modalities_input,
         modalities_output, source_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await db.batch(
      rows.map((row) =>
        upsert.bind(
          row.model,
          row.source,
          row.sourceProvider,
          row.sourceModelId,
          row.inputPerMillionUsd,
          row.outputPerMillionUsd,
          row.cacheReadPerMillionUsd,
          row.cacheWritePerMillionUsd,
          row.reasoningPerMillionUsd,
          JSON.stringify(row.modalitiesInput),
          JSON.stringify(row.modalitiesOutput),
          row.sourceUpdatedAt,
          row.syncedAt,
        ),
      ),
    );
  }
  pricesCache = null;
  console.info(JSON.stringify({ event: "model_prices_synced", upserted: rows.length, missing }));
  if (missing.length > 0) throw new Error(`models.dev is missing prices for: ${missing.join(", ")}`);
  return { upserted: rows.length };
}

export type ManagedModelPrices = { prices: GatewayModelPrice[]; updatedAt: number };

type StoredPrice = {
  model: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  cache_read_per_million_usd: number;
  cache_write_per_million_usd: number;
  reasoning_per_million_usd: number;
  synced_at: number;
};

let pricesCache: { at: number; value: ManagedModelPrices } | null = null;

/**
 * The price of every managed model id: its synced row (or its undated family
 * row), else the static fill-in. Models with neither are left out; the
 * gateway prices those at its default.
 */
export async function readManagedModelPrices(env: Pick<Cloudflare.Env, "DB">): Promise<ManagedModelPrices> {
  const now = Date.now();
  if (pricesCache && now - pricesCache.at < PRICES_CACHE_MS) return pricesCache.value;
  const { results } = await database(env).prepare(
    `SELECT model, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd,
       cache_write_per_million_usd, reasoning_per_million_usd, synced_at FROM model_prices`,
  ).all<StoredPrice>();
  const stored = new Map(results.map((row) => [row.model, row]));
  const prices: GatewayModelPrice[] = [];
  let updatedAt = 0;
  const modelIds = [...new Set([...listManagedModelIds(), ...Object.keys(STATIC_MANAGED_MODEL_PRICE_OVERRIDES)])].sort();
  for (const model of modelIds) {
    const row = lookupCandidates(model).map((candidate) => stored.get(candidate)).find(Boolean);
    if (row) {
      prices.push({
        model,
        inputPerMillionUsd: row.input_per_million_usd,
        outputPerMillionUsd: row.output_per_million_usd,
        cacheReadPerMillionUsd: row.cache_read_per_million_usd,
        cacheWritePerMillionUsd: row.cache_write_per_million_usd,
        reasoningPerMillionUsd: row.reasoning_per_million_usd,
      });
      updatedAt = Math.max(updatedAt, row.synced_at);
      continue;
    }
    const fill = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[model];
    if (!fill) continue;
    prices.push({
      model,
      inputPerMillionUsd: fill.inputPerMillionUsd,
      outputPerMillionUsd: fill.outputPerMillionUsd,
      cacheReadPerMillionUsd: fill.cacheReadPerMillionUsd ?? 0,
      cacheWritePerMillionUsd: fill.cacheWritePerMillionUsd ?? 0,
      reasoningPerMillionUsd: fill.reasoningPerMillionUsd ?? fill.outputPerMillionUsd,
    });
  }
  const value = { prices, updatedAt };
  pricesCache = { at: now, value };
  return value;
}
