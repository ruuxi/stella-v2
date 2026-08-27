import AsyncStorage from "@react-native-async-storage/async-storage";

const MEMORY_KEY = "stella-mobile-chat-memory-v1";

const MAX_FACTS = 200;
const MAX_KEY_CHARS = 120;
const MAX_VALUE_CHARS = 600;

export type MemoryFact = {

  key: string;

  value: string;

  updatedAt: number;
};

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

  const trimmed = [...facts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FACTS);
  await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(trimmed));
}

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
