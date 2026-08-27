import { uiState } from "@/platform/ui-state";

export const CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY =
  "stella.conversationModelSelections.v1";

const MAX_PERSISTED_SELECTIONS = 100;

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

export function pickModelSelection(preferences) {
  if (!preferences || typeof preferences !== "object") return null;
  const selection = {};
  for (const key of MODEL_SELECTION_KEYS) {
    if (preferences[key] !== undefined) selection[key] = preferences[key];
  }
  return selection;
}

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

export function modelSelectionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
}

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
