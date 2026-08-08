/**
 * Reads and writes the paired desktop's local model preferences over the
 * bridge, mirroring the desktop's display-sidebar engine/model picker
 * (`EngineTabContent`). The desktop is the source of truth: every change here
 * lands in the desktop's `~/.stella/preferences.json` via the
 * `preferences:setLocalModelPreferences` IPC, exactly like the desktop UI.
 *
 * The per-message `mobileModelPreference` hint is intentionally NOT used —
 * the desktop only stored it as metadata and never applied it, so it could
 * not actually switch the model.
 */
import { getJson } from "./http";
import {
  invokeDesktopBridge,
  resolveDesktopBridge,
  type DesktopBridgeConnection,
} from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";

/* ── engine / reasoning ───────────────────────────────────────── */

export type AgentRuntimeEngine =
  | "default"
  | "codex_cli"
  | "claude_code_local";

export type RuntimeEngine = Exclude<AgentRuntimeEngine, "default">;

export const ENGINE_OPTIONS: ReadonlyArray<{
  id: AgentRuntimeEngine;
  label: string;
}> = [
  { id: "default", label: "Stella" },
  { id: "codex_cli", label: "Codex" },
  { id: "claude_code_local", label: "Claude Code" },
];

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

/* ── snapshot ─────────────────────────────────────────────────── */

/** The subset of the desktop `LocalModelPreferencesSnapshot` we read/write. */
export type DesktopModelSnapshot = {
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<string, ReasoningEffort>;
  assistantPropagatedAgents: string[];
  agentRuntimeEngine: AgentRuntimeEngine;
  codexModel: string;
  codexReasoningEffort: ReasoningEffort;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffort;
};

export type DesktopModelPrefsPatch = Partial<DesktopModelSnapshot>;

/* ── catalog / model options ──────────────────────────────────── */

export type StellaCatalogModel = {
  id: string;
  name: string;
  allowedForAudience: boolean;
};

export type RuntimeModelOption = {
  id: string;
  name: string;
  subtitle?: string;
  allowedForAudience: boolean;
};

export type StellaCatalog = {
  models: StellaCatalogModel[];
  /** Agent keys the desktop assigns models to (from catalog defaults). */
  agentKeys: string[];
};

export const STELLA_DEFAULT_MODEL = "stella/default";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CLAUDE_CODE_MODEL = "default";

const STELLA_PREFIX = "stella/";
const CODEX_PREFIX = "codex-cli/";
const CLAUDE_PREFIX = "claude-code/";
const CHRONICLE_AGENT_KEY = "chronicle";
const CONVERSATION_AGENT_KEYS: ReadonlySet<string> = new Set([
  "orchestrator",
  "general",
]);

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

export async function fetchStellaCatalog(): Promise<StellaCatalog> {
  let parsed: CatalogApiResponse;
  try {
    parsed = (await getJson("/api/stella/models")) as CatalogApiResponse;
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

/* ── bridge IO ────────────────────────────────────────────────── */

const PREF_GET = "preferences:getLocalModelPreferences";
const PREF_SET = "preferences:setLocalModelPreferences";
const LIST_CODEX = "preferences:listCodexModels";
const LIST_CLAUDE = "preferences:listClaudeCodeModels";
const CREDENTIALS_LIST = "llmCredentials:list";
const CREDENTIALS_LIST_OAUTH = "llmCredentials:listOAuth";

export async function openDesktopBridge(
  access: StoredPhoneAccess,
): Promise<DesktopBridgeConnection> {
  return resolveDesktopBridge(access);
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const normalizeEffort = (value: unknown): ReasoningEffort => {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return "default";
  }
};

const normalizeEngine = (value: unknown): AgentRuntimeEngine => {
  if (value === "codex_cli" || value === "claude_code_local") return value;
  // Legacy cursor_sdk and anything else collapse to Stella for this picker.
  return "default";
};

const normalizeStringMap = (value: unknown): Record<string, string> => {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return out;
};

const normalizeEffortMap = (
  value: unknown,
): Record<string, ReasoningEffort> => {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, ReasoningEffort> = {};
  for (const [key, raw] of Object.entries(record)) {
    out[key] = normalizeEffort(raw);
  }
  return out;
};

const normalizeSnapshot = (raw: unknown): DesktopModelSnapshot => {
  const record = asRecord(raw);
  return {
    modelOverrides: normalizeStringMap(record?.modelOverrides),
    reasoningEfforts: normalizeEffortMap(record?.reasoningEfforts),
    assistantPropagatedAgents: Array.isArray(record?.assistantPropagatedAgents)
      ? (record!.assistantPropagatedAgents as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    agentRuntimeEngine: normalizeEngine(record?.agentRuntimeEngine),
    codexModel: asString(record?.codexModel) || DEFAULT_CODEX_MODEL,
    codexReasoningEffort: normalizeEffort(record?.codexReasoningEffort),
    claudeCodeModel:
      asString(record?.claudeCodeModel) || DEFAULT_CLAUDE_CODE_MODEL,
    claudeCodeReasoningEffort: normalizeEffort(record?.claudeCodeReasoningEffort),
  };
};

export async function getDesktopModelPrefs(
  bridge: DesktopBridgeConnection,
): Promise<DesktopModelSnapshot> {
  const raw = await invokeDesktopBridge(bridge, PREF_GET);
  return normalizeSnapshot(raw);
}

export async function setDesktopModelPrefs(
  bridge: DesktopBridgeConnection,
  patch: DesktopModelPrefsPatch,
): Promise<DesktopModelSnapshot> {
  const raw = await invokeDesktopBridge(bridge, PREF_SET, [patch]);
  return normalizeSnapshot(raw);
}

const mapRuntimeModels = (raw: unknown): RuntimeModelOption[] => {
  const record = asRecord(raw);
  const rows = Array.isArray(record?.models) ? record!.models : [];
  const out: RuntimeModelOption[] = [];
  for (const row of rows as unknown[]) {
    const model = asRecord(row);
    if (!model) continue;
    const id = asString(model.id).trim();
    if (!id || model.hidden === true) continue;
    const name = asString(model.displayName).trim() || id;
    const upstream = asString(model.model).trim();
    const option: RuntimeModelOption = { id, name, allowedForAudience: true };
    if (upstream && upstream !== name) option.subtitle = upstream;
    out.push(option);
  }
  return out;
};

export async function listDesktopRuntimeModels(
  bridge: DesktopBridgeConnection,
  engine: RuntimeEngine,
): Promise<RuntimeModelOption[]> {
  const channel = engine === "codex_cli" ? LIST_CODEX : LIST_CLAUDE;
  const raw = await invokeDesktopBridge(bridge, channel);
  return mapRuntimeModels(raw);
}

/* ── selection helpers ────────────────────────────────────────── */

export const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith(STELLA_PREFIX);

const toRuntimeOverrideId = (engine: RuntimeEngine, modelId: string): string => {
  const prefix = engine === "codex_cli" ? CODEX_PREFIX : CLAUDE_PREFIX;
  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
};

const batchAssignableAgents = (agentKeys: string[]): string[] =>
  agentKeys.filter((key) => key !== CHRONICLE_AGENT_KEY);

/** The Stella model the desktop assistant currently uses ("" = default). */
export const stellaSelectedModelId = (snapshot: DesktopModelSnapshot): string =>
  snapshot.modelOverrides.general ??
  snapshot.modelOverrides.orchestrator ??
  "";

export const stellaSelectedEffort = (
  snapshot: DesktopModelSnapshot,
): ReasoningEffort =>
  snapshot.reasoningEfforts.general ??
  snapshot.reasoningEfforts.orchestrator ??
  "default";

export const runtimeSelectedModelId = (
  snapshot: DesktopModelSnapshot,
  engine: RuntimeEngine,
): string =>
  engine === "codex_cli" ? snapshot.codexModel : snapshot.claudeCodeModel;

export const runtimeSelectedEffort = (
  snapshot: DesktopModelSnapshot,
  engine: RuntimeEngine,
): ReasoningEffort =>
  engine === "codex_cli"
    ? snapshot.codexReasoningEffort
    : snapshot.claudeCodeReasoningEffort;

/* ── patch builders (mirror EngineTabContent) ─────────────────── */

/**
 * Assign a Stella (or any non-runtime) model across the batch-assignable
 * agent set at the chosen effort. Mirrors `assignTo` for the Stella path.
 */
export function buildStellaAssignPatch(
  snapshot: DesktopModelSnapshot,
  agentKeys: string[],
  modelId: string,
  effort: ReasoningEffort,
): DesktopModelPrefsPatch {
  const targets = batchAssignableAgents(agentKeys);
  const nextOverrides = { ...snapshot.modelOverrides };
  const nextReasoning = { ...snapshot.reasoningEfforts };
  const nextPropagated = new Set(snapshot.assistantPropagatedAgents);
  const nonStella = !isStellaModelId(modelId);
  for (const key of targets) {
    nextOverrides[key] = modelId;
    if (effort === "default") delete nextReasoning[key];
    else nextReasoning[key] = effort;
    if (nonStella && !CONVERSATION_AGENT_KEYS.has(key)) nextPropagated.add(key);
    else nextPropagated.delete(key);
  }
  return {
    modelOverrides: nextOverrides,
    reasoningEfforts: nextReasoning,
    assistantPropagatedAgents: Array.from(nextPropagated),
  };
}

/** Clear every batch agent's Stella override (back to Stella default). */
export function buildStellaClearPatch(
  snapshot: DesktopModelSnapshot,
  agentKeys: string[],
): DesktopModelPrefsPatch {
  const targets = batchAssignableAgents(agentKeys);
  const nextOverrides = { ...snapshot.modelOverrides };
  const nextReasoning = { ...snapshot.reasoningEfforts };
  const nextPropagated = new Set(snapshot.assistantPropagatedAgents);
  for (const key of targets) {
    delete nextOverrides[key];
    delete nextReasoning[key];
    nextPropagated.delete(key);
  }
  return {
    modelOverrides: nextOverrides,
    reasoningEfforts: nextReasoning,
    assistantPropagatedAgents: Array.from(nextPropagated),
  };
}

/**
 * Set the Stella reasoning effort across the batch agents without touching the
 * model overrides. Reasoning is keyed independently of the model, so a pure
 * effort change never needs to rewrite the selected model.
 */
export function buildStellaSetEffortPatch(
  snapshot: DesktopModelSnapshot,
  agentKeys: string[],
  effort: ReasoningEffort,
): DesktopModelPrefsPatch {
  const targets = batchAssignableAgents(agentKeys);
  const nextReasoning = { ...snapshot.reasoningEfforts };
  for (const key of targets) {
    if (effort === "default") delete nextReasoning[key];
    else nextReasoning[key] = effort;
  }
  return { reasoningEfforts: nextReasoning };
}

/** Set the engine-global Codex / Claude Code effort. */
export function buildRuntimeSetEffortPatch(
  engine: RuntimeEngine,
  effort: ReasoningEffort,
): DesktopModelPrefsPatch {
  return engine === "codex_cli"
    ? { codexReasoningEffort: effort }
    : { claudeCodeReasoningEffort: effort };
}

/**
 * Assign a Codex / Claude Code model AND set the engine-global effort. The
 * runtime engines carry one effort (not per-agent), so this both applies the
 * model and the effort in one patch. Mirrors `selectRuntimeReasoning`.
 */
export function buildRuntimeAssignPatch(
  snapshot: DesktopModelSnapshot,
  engine: RuntimeEngine,
  agentKeys: string[],
  modelId: string,
  effort: ReasoningEffort,
): DesktopModelPrefsPatch {
  const targets = batchAssignableAgents(agentKeys);
  const normalizedId = toRuntimeOverrideId(engine, modelId);
  const nextOverrides = { ...snapshot.modelOverrides };
  const nextReasoning = { ...snapshot.reasoningEfforts };
  const nextPropagated = new Set(snapshot.assistantPropagatedAgents);
  for (const key of targets) {
    nextOverrides[key] = normalizedId;
    // Runtime engines use the engine-global effort, not per-agent.
    delete nextReasoning[key];
    if (CONVERSATION_AGENT_KEYS.has(key)) nextPropagated.delete(key);
    else nextPropagated.add(key);
  }
  const patch: DesktopModelPrefsPatch = {
    modelOverrides: nextOverrides,
    reasoningEfforts: nextReasoning,
    assistantPropagatedAgents: Array.from(nextPropagated),
  };
  if (engine === "codex_cli") {
    patch.codexModel = modelId;
    patch.codexReasoningEffort = effort;
  } else {
    patch.claudeCodeModel = modelId;
    patch.claudeCodeReasoningEffort = effort;
  }
  return patch;
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

/* ── providers (Stella + connected BYOK) ──────────────────────── */

export type ProviderModelGroup = {
  key: string;
  name: string;
  models: RuntimeModelOption[];
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  cerebras: "Cerebras",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  moonshotai: "Moonshot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  stella: "Stella",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "Z.AI",
};

export const getProviderDisplayName = (provider: string): string => {
  const mapped = PROVIDER_DISPLAY_NAMES[provider];
  if (mapped) return mapped;
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
};

// Mirrors the desktop's direct-provider set: the providers whose models we can
// surface from the public models.dev catalog for BYOK users.
const MODELS_DEV_DIRECT_PROVIDER_KEYS = new Set([
  "anthropic",
  "cerebras",
  "google",
  "groq",
  "mistral",
  "moonshotai",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

const MODELS_DEV_API_URL = "https://models.dev/api.json";

type ModelsDevApi = Record<
  string,
  {
    models?: Record<
      string,
      {
        id?: string;
        name?: string;
        modalities?: { input?: string[]; output?: string[] };
      }
    >;
  }
>;

let directModelsCache: Promise<Record<string, RuntimeModelOption[]>> | null =
  null;

/**
 * Fetch the public models.dev catalog (no auth) and group the direct-provider
 * models by provider, keyed exactly like the desktop. Cached for the session.
 */
export function fetchDirectProviderModels(): Promise<
  Record<string, RuntimeModelOption[]>
> {
  if (directModelsCache) return directModelsCache;
  directModelsCache = (async () => {
    let data: ModelsDevApi;
    try {
      const res = await fetch(MODELS_DEV_API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as ModelsDevApi;
    } catch {
      directModelsCache = null;
      return {};
    }
    const out: Record<string, RuntimeModelOption[]> = {};
    for (const [provider, entry] of Object.entries(data)) {
      if (!MODELS_DEV_DIRECT_PROVIDER_KEYS.has(provider)) continue;
      const models: RuntimeModelOption[] = [];
      for (const [modelId, model] of Object.entries(entry.models ?? {})) {
        const id = (model.id ?? modelId).trim();
        if (!id) continue;
        const input = model.modalities?.input ?? ["text"];
        const output = model.modalities?.output ?? ["text"];
        if (!input.includes("text") || !output.includes("text")) continue;
        models.push({
          id: `${provider}/${id}`,
          name: model.name?.trim() || id,
          allowedForAudience: true,
        });
      }
      if (models.length > 0) {
        models.sort((a, b) => a.name.localeCompare(b.name));
        out[provider] = models;
      }
    }
    return out;
  })();
  return directModelsCache;
}

const normalizeProviderList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const row of raw) {
    const record = asRecord(row);
    const provider = asString(record?.provider).trim().toLowerCase();
    if (provider) out.push(provider);
  }
  return out;
};

/** Providers the user has connected on the desktop (API key + OAuth). */
export async function listDesktopConnectedProviders(
  bridge: DesktopBridgeConnection,
): Promise<string[]> {
  const [apiKeys, oauth] = await Promise.all([
    invokeDesktopBridge(bridge, CREDENTIALS_LIST).catch(() => []),
    invokeDesktopBridge(bridge, CREDENTIALS_LIST_OAUTH).catch(() => []),
  ]);
  return Array.from(
    new Set([...normalizeProviderList(apiKeys), ...normalizeProviderList(oauth)]),
  );
}

/**
 * Build the Stella-engine model groups: the Stella provider always, then each
 * connected BYOK provider that has models available, in display-name order.
 */
export function buildStellaProviderGroups(
  catalog: StellaCatalog,
  connectedProviders: string[],
  directModels: Record<string, RuntimeModelOption[]>,
): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [
    {
      key: "stella",
      name: "Stella",
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        allowedForAudience: model.allowedForAudience,
      })),
    },
  ];
  const byok = connectedProviders
    .filter((provider) => provider !== "stella" && directModels[provider])
    .map((provider) => ({
      key: provider,
      name: getProviderDisplayName(provider),
      models: directModels[provider] ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...groups, ...byok];
}
