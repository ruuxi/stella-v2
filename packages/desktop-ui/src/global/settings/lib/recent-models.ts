import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:recent-models";
const MAX_STORED = 8;

export const readRecentModels = (): string[] => {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  } catch {
    return [];
  }
};

const writeRecentModels = (next: string[]): void => {
  try {
    uiState.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {

  }
};

export const recordRecentModel = (modelId: string): string[] => {
  const trimmed = modelId.trim();
  if (!trimmed) return readRecentModels();
  const next = [
    trimmed,
    ...readRecentModels().filter((entry) => entry !== trimmed),
  ].slice(0, MAX_STORED);
  writeRecentModels(next);
  return next;
};

export const pruneRecentModels = (
  isKnownModelId: (modelId: string) => boolean,
): string[] => {
  const current = readRecentModels();
  const next = current.filter(isKnownModelId);
  if (next.length !== current.length) writeRecentModels(next);
  return next;
};

const OPEN_ENDED_ID_PREFIXES = [
  "openrouter/",
  "vercel-ai-gateway/",
  "local/",
] as const;

export const createKnownModelIdPredicate = (
  catalogModelIds: ReadonlySet<string>,
): ((modelId: string) => boolean) => {
  return (modelId: string): boolean => {
    if (catalogModelIds.size === 0) return true;
    if (
      modelId.startsWith("claude-code/") ||
      modelId.startsWith("codex-cli/")
    ) {
      return true;
    }
    if (OPEN_ENDED_ID_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
      return true;
    }
    return catalogModelIds.has(modelId);
  };
};

export interface RecentModelRow {
  id: string;

  unavailable?: boolean;
}

export const buildRecentModelRows = (args: {
  currentId: string;
  recentIds: readonly string[];
  excludeIds: ReadonlySet<string>;
  isKnownModelId: (modelId: string) => boolean;
  limit?: number;
}): RecentModelRow[] => {
  const { currentId, recentIds, excludeIds, isKnownModelId } = args;
  const limit = args.limit ?? 4;
  const rows: RecentModelRow[] = [];
  const seen = new Set<string>();
  const push = (id: string, unavailable: boolean) => {
    if (!id || excludeIds.has(id) || seen.has(id)) return;
    seen.add(id);
    rows.push(unavailable ? { id, unavailable } : { id });
  };
  if (currentId) push(currentId, !isKnownModelId(currentId));
  for (const id of recentIds) {
    if (rows.length >= limit) break;
    if (!isKnownModelId(id)) continue;
    push(id, false);
  }
  return rows.slice(0, limit);
};
