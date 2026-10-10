/**
 * Per-conversation (per-tab) model-selection memory.
 *
 * The engine/provider + underlying model + reasoning-effort selection lives in
 * the GLOBAL local model preferences (`~/.stella/preferences.json`), which both
 * the model pickers and the send-time runtime routing read. That makes the
 * selection global by default: the last pick applies to every tab.
 *
 * This store records the selection subset per conversation id so the multi-tab
 * chat experience can mirror the global preferences to whichever conversation
 * is active. It persists through `uiState` — the same durable key/value store
 * the conversation tabs themselves use — so selections survive tab switches,
 * history replacing a tab, and app restarts.
 *
 * Snapshots are keyed by conversation id, not by open-tab lifetime. Closing a
 * tab (or replacing it from history) must not forget that conversation's pick;
 * reopening it later restores the same engine/model/reasoning. Only an explicit
 * delete, or the bounded LRU, drops a snapshot.
 *
 * Only the model-routing subset is captured. Everything else in local
 * preferences (agent concurrency, image/voice providers, memory,
 * backend catalog defaults, native-runtime toggles) stays global and is never
 * scoped per tab.
 */
import { uiState } from "@/platform/ui-state";

export const CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY =
  "stella.conversationModelSelections.v1";

const MAX_PERSISTED_SELECTIONS = 100;

/**
 * The local-preferences fields that make up a chat's model selection: the
 * runtime engine, the underlying Stella/Codex/Claude Code model, the reasoning
 * effort, and the routing mirrors the pickers keep in lockstep. This is exactly
 * the set of keys `setLocalModelPreferences` accepts for a selection change, so
 * a captured snapshot can be replayed verbatim to restore a tab's pick.
 */
export const MODEL_SELECTION_KEYS = [
  "agentRuntimeEngine",
  "modelOverrides",
  "assistantPropagatedAgents",
  "reasoningEfforts",
  "stellaConversationModelOverrides",
  "stellaConversationReasoningEfforts",
  "codexModel",
  "codexModelExplicit",
  "codexReasoningEffort",
  "codexServiceTier",
  "claudeCodeModel",
  "claudeCodeReasoningEffort",
];

/**
 * Extract the per-tab selection subset from a full local-preferences object.
 * Returns null for anything that isn't a preferences-shaped object.
 */
export function pickModelSelection(preferences) {
  if (!preferences || typeof preferences !== "object") return null;
  const selection = {};
  for (const key of MODEL_SELECTION_KEYS) {
    if (preferences[key] !== undefined) selection[key] = preferences[key];
  }
  return selection;
}

/** Deterministic serialization (sorted keys) for structural comparison. */
const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
};

/** Structural equality for two selection snapshots (order-insensitive). */
export function modelSelectionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
}

/** @type {Map<string, Record<string, unknown>>} */
const memory = new Map();
let loaded = false;

const load = () => {
  if (loaded) return;
  loaded = true;
  const raw = uiState.getItem(CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.selections !== "object" ||
      parsed.selections === null
    ) {
      return;
    }
    for (const [conversationId, selection] of Object.entries(
      parsed.selections,
    )) {
      if (typeof conversationId !== "string") continue;
      const normalized = pickModelSelection(selection);
      if (normalized && Object.keys(normalized).length > 0) {
        memory.set(conversationId, normalized);
      }
    }
  } catch {
    // Corrupt payload — start clean rather than failing the surface.
  }
};

const persist = () => {
  const selections = {};
  let count = 0;
  for (const [conversationId, selection] of memory) {
    selections[conversationId] = selection;
    if (++count >= MAX_PERSISTED_SELECTIONS) break;
  }
  uiState.setItem(
    CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY,
    JSON.stringify({ version: 1, selections }),
  );
};

export const conversationModelSelections = {
  /** @returns {Record<string, unknown> | null} */
  get(conversationId) {
    load();
    return memory.get(conversationId) ?? null;
  },
  has(conversationId) {
    load();
    return memory.has(conversationId);
  },
  set(conversationId, selection) {
    if (!conversationId || !selection) return;
    load();
    // Re-insert at the tail so the bounded map evicts least-recently-touched
    // conversations first.
    memory.delete(conversationId);
    memory.set(conversationId, selection);
    while (memory.size > MAX_PERSISTED_SELECTIONS) {
      const oldest = memory.keys().next().value;
      if (typeof oldest !== "string") break;
      memory.delete(oldest);
    }
    persist();
  },
  delete(conversationId) {
    load();
    if (memory.delete(conversationId)) persist();
  },
  /**
   * Drop snapshots for conversations that no longer have an open tab.
   * Kept for callers that want a strict open-tab cache; the live hook no
   * longer prunes on close so history can restore a conversation's pick.
   */
  pruneToOpenConversations(openConversationIds) {
    load();
    let changed = false;
    for (const conversationId of [...memory.keys()]) {
      if (!openConversationIds.has(conversationId)) {
        memory.delete(conversationId);
        changed = true;
      }
    }
    if (changed) persist();
  },
  reset() {
    memory.clear();
    loaded = false;
    uiState.removeItem(CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY);
  },
};
