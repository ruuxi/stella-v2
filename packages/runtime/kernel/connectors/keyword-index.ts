import type { NativeConnectorCatalogEntry } from "./native-integrations.js";
import {
  buildMergedConnectorCatalog,
  readCachedServerCatalog,
} from "./catalog-cache.js";

export type ConnectorKeywordIndex = {

  keywords: Map<string, Set<string>>;
  entriesById: Map<string, NativeConnectorCatalogEntry>;
};

export const CONNECTOR_KEYWORD_SYNONYMS: Record<string, readonly string[]> = {
  mail: ["gmail", "outlook"],
  email: ["gmail", "outlook"],
  emails: ["gmail", "outlook"],
  inbox: ["gmail", "outlook"],
  calendar: ["googlecalendar", "outlook"],
  appointment: ["googlecalendar"],
  appointments: ["googlecalendar"],
  meeting: ["googlecalendar"],
  meetings: ["googlecalendar"],
  spreadsheet: ["googlesheets"],
  spreadsheets: ["googlesheets"],
  sheet: ["googlesheets"],
  sheets: ["googlesheets"],
  doc: ["googledocs"],
  docs: ["googledocs"],
  slides: ["googleslides"],
  presentation: ["googleslides"],
  deck: ["googleslides"],
  drive: ["googledrive"],
  tweet: ["twitter", "x"],
  tweets: ["twitter", "x"],
  twitter: ["twitter", "x"],
  repo: ["github"],
  repos: ["github"],
  "pull request": ["github"],
  "pull requests": ["github"],
  playlist: ["spotify"],
  song: ["spotify"],
  music: ["spotify"],
  crm: ["salesforce", "hubspot"],
  ticket: ["jira", "linear"],
  tickets: ["jira", "linear"],
  standup: ["slack"],
  channel: ["slack", "discord"],
  invoice: ["stripe", "quickbooks"],
  invoices: ["stripe", "quickbooks"],
  todo: ["googletasks", "todoist"],
  todos: ["googletasks", "todoist"],
};

const GENERIC_KEYWORD_STOPLIST = new Set([
  "mail",
  "email",
  "calendar",
  "docs",
  "documents",
  "document",
  "drive",
  "sheets",
  "slides",
  "tasks",
  "task",
  "notes",
  "note",
  "chat",
  "meet",
  "maps",
  "map",
  "news",
  "search",
  "weather",
  "photos",
  "photo",
  "music",
  "video",
  "videos",
  "cloud",
  "web",
  "app",
  "apps",
  "api",
  "data",
  "ai",
  "one",
  "super",
  "team",
  "teams",
  "work",
  "workspace",
  "the",
  "and",
  "for",
  "with",
  "read",
  "send",
  "text",
  "code",
  "time",
  "today",
  "day",
  "go",
  "x",
]);

const MIN_KEYWORD_LENGTH = 4;
const MAX_MATCHES = 3;

export const normalizeKeywordText = (value: string): string =>
  ` ${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()} `;

const addKeyword = (
  index: ConnectorKeywordIndex,
  keyword: string,
  id: string,
) => {
  const normalized = normalizeKeywordText(keyword).trim();
  if (!normalized) return;
  const existing = index.keywords.get(normalized);
  if (existing) {
    existing.add(id);
    return;
  }
  index.keywords.set(normalized, new Set([id]));
};

export const buildConnectorKeywordIndex = (
  catalog: readonly NativeConnectorCatalogEntry[],
): ConnectorKeywordIndex => {
  const index: ConnectorKeywordIndex = {
    keywords: new Map(),
    entriesById: new Map(),
  };
  for (const entry of catalog) {
    index.entriesById.set(entry.id, entry);

    if (
      entry.id.length >= MIN_KEYWORD_LENGTH &&
      !GENERIC_KEYWORD_STOPLIST.has(entry.id)
    ) {
      addKeyword(index, entry.id, entry.id);
    }

    const namePhrase = normalizeKeywordText(entry.name).trim();
    if (
      namePhrase.length >= MIN_KEYWORD_LENGTH &&
      !GENERIC_KEYWORD_STOPLIST.has(namePhrase)
    ) {
      addKeyword(index, namePhrase, entry.id);
    }
  }

  for (const [keyword, ids] of Object.entries(CONNECTOR_KEYWORD_SYNONYMS)) {
    for (const id of ids) {
      if (!index.entriesById.has(id)) continue;
      addKeyword(index, keyword, id);
    }
  }
  return index;
};

export const matchConnectorsInMessage = (
  index: ConnectorKeywordIndex,
  message: string,
): NativeConnectorCatalogEntry[] => {
  const normalized = normalizeKeywordText(message);
  if (normalized.trim().length === 0) return [];
  const hits: Array<{ keyword: string; id: string }> = [];
  for (const [keyword, ids] of index.keywords) {
    if (!normalized.includes(` ${keyword} `)) continue;
    for (const id of ids) hits.push({ keyword, id });
  }
  hits.sort((left, right) => {
    if (right.keyword.length !== left.keyword.length) {
      return right.keyword.length - left.keyword.length;
    }
    return left.id.localeCompare(right.id);
  });
  const seen = new Set<string>();
  const matches: NativeConnectorCatalogEntry[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    const entry = index.entriesById.get(hit.id);
    if (!entry) continue;
    matches.push(entry);
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
};

type CachedIndexState = {
  stellaDataDir: string;
  fetchedAt: number;
  index: ConnectorKeywordIndex;
};

let cachedIndex: CachedIndexState | null = null;

export const resetConnectorKeywordIndexCache = () => {
  cachedIndex = null;
};

export const getConnectorKeywordIndex = async (
  stellaDataDir: string,
): Promise<ConnectorKeywordIndex> => {
  const cached = await readCachedServerCatalog(stellaDataDir);
  const fetchedAt = cached?.fetchedAt ?? 0;
  if (
    cachedIndex &&
    cachedIndex.stellaDataDir === stellaDataDir &&
    cachedIndex.fetchedAt === fetchedAt
  ) {
    return cachedIndex.index;
  }
  const catalog = buildMergedConnectorCatalog(cached?.entries ?? undefined);
  const index = buildConnectorKeywordIndex(catalog);
  cachedIndex = { stellaDataDir, fetchedAt, index };
  return index;
};
