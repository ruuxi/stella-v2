/** Stella's managed model catalog, fetched over HTTP from the backend. */
import { getJson } from "./http";

export type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const REASONING_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  label: string;
}> = [
  { id: "default", label: "Auto" },
  { id: "minimal", label: "Min" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Max" },
];

export type StellaCatalogModel = {
  id: string;
  name: string;
  allowedForAudience: boolean;
};

export type StellaCatalog = {
  models: StellaCatalogModel[];
  /** Agent keys the backend assigns models to (from catalog defaults). */
  agentKeys: string[];
};

export const STELLA_DEFAULT_MODEL = "stella/default";

// Used when the catalog can't be fetched so a pick still touches the
// assistant agents rather than silently doing nothing.
const FALLBACK_AGENT_KEYS = ["orchestrator", "general"];

// When the catalog can't be fetched, the only thing we can safely offer is
// the opaque default — the concrete pinnable models are tier-dependent and
// only known from the live catalog.
const FALLBACK_STELLA_MODELS: StellaCatalogModel[] = [
  {
    id: STELLA_DEFAULT_MODEL,
    name: "Stella Recommended",
    allowedForAudience: true,
  },
];

/* ── catalog fetch (HTTP, no bridge) ──────────────────────────── */

type CatalogApiResponse = {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    provider?: unknown;
    allowedForAudience?: unknown;
  }>;
  defaults?: Array<{ agentType?: unknown }>;
};

export async function fetchStellaCatalog(
  options?: { headers?: Record<string, string> },
): Promise<StellaCatalog> {
  let parsed: CatalogApiResponse;
  try {
    parsed = (await getJson("/api/stella/models", options)) as CatalogApiResponse;
  } catch {
    return { models: FALLBACK_STELLA_MODELS, agentKeys: FALLBACK_AGENT_KEYS };
  }
  const models = (parsed.data ?? [])
    .filter((model) => model.provider === "stella")
    .map((model) => ({
      id: typeof model.id === "string" ? model.id : "",
      name: typeof model.name === "string" ? model.name : "",
      allowedForAudience: model.allowedForAudience !== false,
    }))
    .filter((model) => model.id && model.name);
  const agentKeys = Array.from(
    new Set(
      (parsed.defaults ?? [])
        .map((entry) =>
          typeof entry.agentType === "string" ? entry.agentType.trim() : "",
        )
        .filter((key) => key.length > 0),
    ),
  );
  return {
    models: models.length > 0 ? models : FALLBACK_STELLA_MODELS,
    agentKeys: agentKeys.length > 0 ? agentKeys : FALLBACK_AGENT_KEYS,
  };
}

export const stellaModelLabel = (
  catalog: StellaCatalog,
  modelId: string,
): string => {
  if (!modelId || modelId === STELLA_DEFAULT_MODEL) {
    return (
      catalog.models.find((model) => model.id === STELLA_DEFAULT_MODEL)?.name ??
      "Stella"
    );
  }
  const match = catalog.models.find((model) => model.id === modelId);
  if (match) return match.name;
  // BYOK model id like "anthropic/claude-..." — show the bare model name.
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
};
