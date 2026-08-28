import type { SettingsTab } from "@/global/settings/settings-tabs";

export type SettingsSearchTranslate = (key: string) => string;

export interface SettingsSearchEntryDef {
  tab: SettingsTab;

  titleKey: string;

  descriptionKey: string;

  cardTitleKey?: string;

  keywords: string[];
}

export interface ResolvedSettingsSearchEntry {
  tab: SettingsTab;
  title: string;
  description: string;
  cardTitle?: string;
  keywords: string[];
}

export const SETTINGS_SEARCH_ENTRY_DEFS: SettingsSearchEntryDef[] = [

  {
    tab: "general",
    titleKey: "settings.language.title",
    descriptionKey: "settings.language.description",
    keywords: [
      "locale",
      "translation",
      "english",
      "spanish",
      "french",
      "chinese",
      "japanese",
      "korean",
      "german",
      "italian",
      "arabic",
      "hebrew",
      "rtl",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.workingMode.title",
    descriptionKey: "settings.workingMode.orchestratedDescription",
    keywords: [
      "direct",
      "orchestrated",
      "orchestrator",
      "general agent",
      "subagent",
      "delegation",
      "working mode",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.memory.title",
    descriptionKey: "settings.memory.description",
    keywords: [
      "memory",
      "memories",
      "remember",
      "profile",
      "context",
      "personalization",
      "memory.md",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.developerPreviews.title",
    descriptionKey: "settings.developerPreviews.description",
    keywords: ["developer", "code", "diff", "file previews", "preview"],
  },
  {
    tab: "general",
    titleKey: "settings.developerMode.title",
    descriptionKey: "settings.developerMode.description",
    keywords: [
      "developer mode",
      "advanced",
      "model",
      "models",
      "engine",
      "engines",
      "provider",
      "providers",
      "byok",
      "api key",
      "bring your own key",
      "model picker",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.nativeFontSmoothing.title",
    descriptionKey: "settings.nativeFontSmoothing.description",
    keywords: [
      "font",
      "fonts",
      "antialias",
      "anti-aliasing",
      "anti aliasing",
      "smoothing",
      "grayscale",
      "subpixel",
      "rendering",
      "text",
      "macos",
      "mac",
      "appearance",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.motion.title",
    descriptionKey: "settings.motion.reduceMotion.description",
    keywords: [
      "reduce motion",
      "reduced motion",
      "animation",
      "animations",
      "motion",
      "accessibility",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.notifications.title",
    descriptionKey: "settings.notifications.description",
    keywords: [
      "alerts",
      "sound notifications",
      "agent done",
      "mute",
      "silence",
      "quiet",
      "ping",
      "chime",
      "bell",
      "do not disturb",
      "notifications",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.power.title",
    descriptionKey: "settings.power.description",
    keywords: [
      "prevent sleep",
      "keep awake",
      "battery",
      "screensaver",
      "energy",
      "idle",
      "power",
      "caffeinate",
      "no sleep",
      "stay on",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.lockedComputerUse.title",
    descriptionKey: "settings.lockedComputerUse.description",
    keywords: [
      "computer use",
      "lock screen",
      "locked use",
      "unlock",
      "authorization",
      "remote",
      "desktop automation",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.browserExtension.title",
    descriptionKey: "settings.browserExtension.description",
    keywords: [
      "chrome",
      "extension",
      "arc",
      "brave",
      "edge",
      "chromium",
      "plugin",
      "addon",
      "add-on",
      "browser extension",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.permissions.title",
    descriptionKey: "settings.search.descriptions.permissions",
    keywords: [
      "accessibility",
      "screen capture",
      "screen recording",
      "microphone permission",
      "macos permissions",
      "system settings",
      "tcc",
      "privacy",
      "security",
      "allow",
      "camera",
    ],
  },

  {
    tab: "shortcuts",
    titleKey: "settings.shortcuts.title",
    descriptionKey: "settings.search.descriptions.shortcuts",
    keywords: [
      "keybindings",
      "hotkeys",
      "keyboard shortcuts",
      "dictation",
      "voice",
      "option key",
      "bindings",
    ],
  },

  {
    tab: "backup",
    titleKey: "settings.backup.title",
    descriptionKey: "settings.search.descriptions.backup",
    keywords: [
      "restore",
      "snapshot",
      "automatic backup",
      "back up now",
      "saved backups",
      "encrypted backup",
      "remote backup",
      "recovery",
      "export",
      "import",
      "sync",
    ],
  },

  {
    tab: "account",
    titleKey: "settings.account.title",
    descriptionKey: "settings.search.descriptions.account",
    keywords: [
      "sign out",
      "log out",
      "logout",
      "signout",
      "delete data",
      "delete account",
      "erase data",
      "wipe",
      "profile",
      "user",
      "subscription",
    ],
  },
  {
    tab: "account",
    titleKey: "settings.account.legal.title",
    descriptionKey: "settings.search.descriptions.legal",
    keywords: ["terms of service", "tos", "privacy policy", "license"],
  },

  {
    tab: "audio",
    titleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.microphone",
    keywords: [
      "mic",
      "input device",
      "hey stella",
      "wake word",
      "super fast dictation",
      "dictation sounds",
      "enhance transcription",
      "on-device transcription",
      "parakeet",
      "inworld",
      "voice",
      "dictate",
      "speech to text",
      "stt",
      "mute",
      "silence",
    ],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.speaker.title",
    descriptionKey: "settings.search.descriptions.speaker",
    keywords: [
      "output device",
      "headphones",
      "audio output",
      "playback",
      "volume",
      "mute",
      "silence",
      "speakers",
      "sound output",
    ],
  },

  {
    tab: "audio",
    titleKey: "settings.audio.wakeWord.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.wakeWord",
    keywords: ["hey stella", "wake", "always listening", "voice trigger"],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.localDictation.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.onDeviceTranscription",
    keywords: ["parakeet", "local", "offline", "private", "stt"],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.dictationSounds.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.audio.dictationSounds.description",
    keywords: ["chime", "ping", "feedback", "mute dictation"],
  },
  {
    tab: "wallet",
    titleKey: "settings.wallet.title",
    descriptionKey: "settings.search.descriptions.wallet",
    keywords: ["link", "wallet", "spend", "card", "payment"],
  },
  {
    tab: "account",
    titleKey: "settings.account.signOut.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.signOut.description",
    keywords: ["log out", "logout", "signout"],
  },
  {
    tab: "account",
    titleKey: "settings.account.deleteAccount.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.deleteAccount.description",
    keywords: ["close account", "remove account", "cancel account"],
  },
  {
    tab: "account",
    titleKey: "settings.account.deleteData.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.deleteData.description",
    keywords: ["wipe", "clear", "erase", "reset"],
  },
  {
    tab: "backup",
    titleKey: "settings.backup.backupNow.label",
    cardTitleKey: "settings.backup.title",
    descriptionKey: "settings.backup.backupNow.description",
    keywords: ["manual backup", "snapshot", "save"],
  },
];

const SEARCH_SYNONYMS_RAW: Record<string, string[]> = {

  mute: ["sound", "audio", "volume", "silence", "quiet", "notification"],
  silence: ["mute", "quiet", "sound", "notification"],
  quiet: ["mute", "silence", "sound"],
  sound: ["audio", "notification", "volume"],
  audio: ["sound", "volume", "speaker", "microphone"],
  volume: ["sound", "audio", "loudness"],
  notification: ["alert", "sound", "ping"],
  alert: ["notification", "ping"],

  mic: ["microphone", "audio", "voice"],
  microphone: ["mic", "audio", "voice"],
  voice: ["microphone", "dictation", "speech"],
  dictation: ["voice", "transcription", "speech to text"],
  speech: ["voice", "dictation"],
  transcribe: ["dictation", "transcription"],

  speaker: ["audio", "output", "headphones", "sound"],
  speakers: ["speaker", "audio", "output", "headphones"],
  headphones: ["speaker", "audio", "output"],

  dark: ["theme", "appearance", "color"],
  light: ["theme", "appearance", "color"],
  theme: ["appearance", "color"],
  appearance: ["theme", "color", "display"],
  font: ["text", "typography"],

  login: ["sign in", "account"],
  logout: ["sign out", "account"],
  signin: ["sign in", "account"],
  signout: ["sign out", "account"],
  password: ["account", "security", "credentials"],
  user: ["account", "profile"],
  profile: ["account", "user"],

  privacy: ["permissions", "security", "private"],
  security: ["privacy", "permissions", "safety"],
  safety: ["privacy", "security"],
  allow: ["permissions", "grant", "enable"],

  history: ["memory", "log"],
  delete: ["erase", "remove", "wipe"],
  remove: ["delete", "erase", "wipe"],
  erase: ["delete", "wipe", "remove"],
  forget: ["erase", "delete", "memory"],

  save: ["backup", "snapshot"],
  recovery: ["backup", "restore"],
  restore: ["backup", "recovery"],
  sync: ["backup", "remote"],

  ai: ["model", "llm"],
  llm: ["model", "ai"],
  gpt: ["openai", "model"],
  claude: ["anthropic", "model"],
  chatbot: ["model", "ai"],

  sleep: ["power", "idle"],
  battery: ["power"],
  awake: ["power", "sleep"],
  energy: ["power", "battery"],

  plugin: ["extension", "addon"],
  addon: ["extension", "plugin"],
  browser: ["chrome", "extension"],

  hotkey: ["shortcut", "keybinding"],
  hotkeys: ["shortcut", "keybinding"],
  keybind: ["shortcut", "keybinding"],
  keyboard: ["shortcut", "keybinding"],

  camera: ["screen", "capture", "permissions"],
  caption: ["transcription"],
  captions: ["transcription"],
};

const SEARCH_SYNONYMS: Map<string, ReadonlySet<string>> = (() => {
  const graph = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)!.add(b);
  };
  for (const [key, values] of Object.entries(SEARCH_SYNONYMS_RAW)) {
    const a = normalizeSearchText(key);
    if (!a) continue;
    for (const value of values) {
      const b = normalizeSearchText(value);
      add(a, b);
      add(b, a);
    }
  }

  const frozen = new Map<string, ReadonlySet<string>>();
  for (const [key, set] of graph) {
    frozen.set(key, set);
  }
  return frozen;
})();

export function normalizeSearchText(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

export type TokenGroup = readonly string[];

export function expandTokens(tokens: string[]): TokenGroup[] {
  return tokens.map((token) => {
    if (token.length <= 1) return [token];
    const synonyms = SEARCH_SYNONYMS.get(token);
    if (!synonyms || synonyms.size === 0) return [token];

    const seen = new Set<string>([token]);
    const group: string[] = [token];
    for (const synonym of synonyms) {
      if (seen.has(synonym)) continue;
      seen.add(synonym);
      group.push(synonym);
    }
    return group;
  });
}

export function includesAsWordStart(text: string, term: string): boolean {
  if (!term) return false;
  const termLen = term.length;
  const textLen = text.length;
  if (termLen > textLen) return false;

  let from = 0;
  while (from <= textLen - termLen) {
    const idx = text.indexOf(term, from);
    if (idx === -1) return false;
    if (idx === 0) return true;
    const prev = text.charCodeAt(idx - 1);

    const isAlphanum =
      (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
    if (!isAlphanum) return true;
    from = idx + 1;
  }
  return false;
}

export function matchesAllTokenGroups(
  text: string,
  groups: TokenGroup[],
): boolean {
  if (groups.length === 0) return true;
  for (const group of groups) {
    let groupHit = false;
    for (const term of group) {
      if (includesAsWordStart(text, term)) {
        groupHit = true;
        break;
      }
    }
    if (!groupHit) return false;
  }
  return true;
}

interface NormalizedEntry {
  entry: ResolvedSettingsSearchEntry;
  titleText: string;
  descriptionText: string;

  searchText: string;
}

function resolveEntries(
  t: SettingsSearchTranslate,
): ResolvedSettingsSearchEntry[] {
  return SETTINGS_SEARCH_ENTRY_DEFS.map((def) => {
    const cardTitle = def.cardTitleKey ? t(def.cardTitleKey) : undefined;
    return {
      tab: def.tab,
      title: t(def.titleKey),
      description: t(def.descriptionKey),
      ...(cardTitle ? { cardTitle } : {}),
      keywords: def.keywords,
    };
  });
}

let normalizedCacheKey: SettingsSearchTranslate | null = null;
let normalizedCache: NormalizedEntry[] = [];

function getNormalizedEntries(t: SettingsSearchTranslate): NormalizedEntry[] {
  if (normalizedCacheKey === t) return normalizedCache;
  normalizedCache = resolveEntries(t).map((entry) => ({
    entry,
    titleText: normalizeSearchText(entry.title),
    descriptionText: normalizeSearchText(entry.description),
    searchText: normalizeSearchText(
      [entry.title, entry.description, ...entry.keywords, entry.tab].join(" "),
    ),
  }));
  normalizedCacheKey = t;
  return normalizedCache;
}

function scoreEntry(normalized: NormalizedEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const groups = expandTokens(tokens);
  const { titleText, descriptionText, searchText } = normalized;
  const fullQuery = tokens.join(" ");

  if (titleText === fullQuery) return 1000;
  if (titleText.startsWith(fullQuery)) return 500;

  const onlyLiteral = (text: string) => {
    for (const token of tokens) {
      if (!includesAsWordStart(text, token)) return false;
    }
    return true;
  };

  if (onlyLiteral(titleText)) {
    const firstTokenIndex = titleText.indexOf(tokens[0] ?? "");
    return 250 + Math.max(0, 50 - firstTokenIndex);
  }
  if (matchesAllTokenGroups(titleText, groups)) {

    return 200;
  }

  if (onlyLiteral(descriptionText)) return 100;
  if (matchesAllTokenGroups(descriptionText, groups)) return 80;

  if (onlyLiteral(searchText)) return 50;
  if (matchesAllTokenGroups(searchText, groups)) return 40;

  return -1;
}

export interface ScoredSettingsSearchEntry extends ResolvedSettingsSearchEntry {
  score: number;
}

export function searchSettings(
  query: string,
  t: SettingsSearchTranslate,
): ScoredSettingsSearchEntry[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const indexed: Array<{ scored: ScoredSettingsSearchEntry; order: number }> =
    [];
  getNormalizedEntries(t).forEach((normalized, order) => {
    const score = scoreEntry(normalized, tokens);
    if (score < 0) return;
    indexed.push({
      scored: { ...normalized.entry, score },
      order,
    });
  });

  indexed.sort((a, b) => {
    if (b.scored.score !== a.scored.score) {
      return b.scored.score - a.scored.score;
    }
    return a.order - b.order;
  });

  return indexed.map((item) => item.scored);
}

export function expandedMatchTerms(query: string): string[] {
  const groups = expandTokens(tokenizeQuery(query));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const term of group) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}
