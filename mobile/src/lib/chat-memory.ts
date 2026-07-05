import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistent memory for the offline (cloud) chat — the mobile analog of the
 * desktop's Remember tool + always-loaded `memories/profile.md`. The model
 * calls the `remember` / `forget` tools (see `chat-tools.ts`) to store durable
 * facts about the user (name, home city, stable preferences, ongoing
 * situation); those facts are persisted here and re-injected into the chat's
 * context on every turn so the assistant "remembers" across app sessions.
 *
 * Deliberately lightweight: the mobile chat is a single continuous thread with
 * no agents or sub-threads, so memory is a flat, globally-scoped list of
 * key -> value facts rather than the desktop's multi-doc memory tree. Backed by
 * AsyncStorage (the store the rest of the offline chat already uses); no native
 * SQLite is introduced so the feature ships over-the-air like the rest of the
 * chat.
 */

const MEMORY_KEY = "stella-mobile-chat-memory-v1";

/** Guardrails so a runaway tool call can't bloat every future request. */
const MAX_FACTS = 200;
const MAX_KEY_CHARS = 120;
const MAX_VALUE_CHARS = 600;

export type MemoryFact = {
  /** Short label for the fact, e.g. "home city". Unique (case-insensitive). */
  key: string;
  /** The remembered value, e.g. "Austin, TX". */
  value: string;
  /** Last write time (ms epoch); newest facts surface first in context. */
  updatedAt: number;
};

/** Fold a key to its identity form so "Home City" and "home city" collide. */
export const normalizeMemoryKey = (key: string): string =>
  key.trim().toLowerCase().replace(/\s+/g, " ");

const clamp = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max).trimEnd() : value;

const parseFacts = (raw: string | null): MemoryFact[] => {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: MemoryFact[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    const value = typeof record.value === "string" ? record.value.trim() : "";
    if (!key || !value) continue;
    const identity = normalizeMemoryKey(key);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      key: clamp(key, MAX_KEY_CHARS),
      value: clamp(value, MAX_VALUE_CHARS),
      updatedAt:
        typeof record.updatedAt === "number" &&
        Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0,
    });
  }
  return out;
};

export async function loadMemoryFacts(): Promise<MemoryFact[]> {
  try {
    return parseFacts(await AsyncStorage.getItem(MEMORY_KEY));
  } catch {
    return [];
  }
}

async function saveMemoryFacts(facts: MemoryFact[]): Promise<void> {
  // Newest first, capped — the same "recent facts win" bias the desktop
  // profile has when a memory doc is trimmed.
  const trimmed = [...facts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FACTS);
  await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(trimmed));
}

/**
 * Add a durable fact, replacing any existing fact with the same
 * (case-insensitive) key. Returns the updated list.
 */
export async function rememberFact(
  key: string,
  value: string,
): Promise<MemoryFact[]> {
  const cleanKey = clamp(key.trim(), MAX_KEY_CHARS);
  const cleanValue = clamp(value.trim(), MAX_VALUE_CHARS);
  if (!cleanKey || !cleanValue) return loadMemoryFacts();
  const identity = normalizeMemoryKey(cleanKey);
  const existing = await loadMemoryFacts();
  const next = existing.filter(
    (fact) => normalizeMemoryKey(fact.key) !== identity,
  );
  next.push({ key: cleanKey, value: cleanValue, updatedAt: Date.now() });
  await saveMemoryFacts(next);
  return next;
}

/** Remove the fact whose key matches (case-insensitive). */
export async function forgetFact(key: string): Promise<MemoryFact[]> {
  const identity = normalizeMemoryKey(key);
  if (!identity) return loadMemoryFacts();
  const existing = await loadMemoryFacts();
  const next = existing.filter(
    (fact) => normalizeMemoryKey(fact.key) !== identity,
  );
  await saveMemoryFacts(next);
  return next;
}

export async function clearMemory(): Promise<void> {
  await AsyncStorage.removeItem(MEMORY_KEY);
}

/**
 * Render the remembered facts as the "what I already know about you" block
 * injected into the model's context every turn. Empty string when nothing is
 * stored so callers can omit the section entirely.
 */
export function formatMemoryForContext(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  const lines = [...facts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((fact) => `- ${fact.key}: ${fact.value}`);
  return [
    "What you already know about this user (durable memory - persists across sessions):",
    ...lines,
  ].join("\n");
}
