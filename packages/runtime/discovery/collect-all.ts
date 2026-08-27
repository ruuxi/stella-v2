import path from "path";
import {
  collectBrowserData,
  detectPreferredBrowserProfile,
  formatBrowserDataForSynthesis,
} from "./browser-data.js";
import {
  collectDevProjects,
  formatDevProjectsForSynthesis,
} from "./dev-projects.js";
import {
  analyzeShellHistory,
  formatShellAnalysisForSynthesis,
} from "./shell-history.js";
import {
  collectBrowserBookmarks,
  formatBrowserBookmarksForSynthesis,
} from "./browser-bookmarks.js";
import {
  collectSafariData,
  formatSafariDataForSynthesis,
} from "./safari-data.js";
import {
  filterLowSignalDomains,
  tierFormattedSignals,
} from "./signal-processing.js";
import {
  collectDevEnvironment,
  formatDevEnvironmentForSynthesis,
} from "./dev-environment.js";
import {
  collectSystemSignals,
  formatSystemSignalsForSynthesis,
} from "./system-signals.js";
import {
  collectMessagesNotes,
  formatMessagesNotesForSynthesis,
} from "./messages-notes.js";
import {
  collectFirefoxData,
  formatFirefoxDataForSynthesis,
} from "./firefox-data.js";
import {
  collectSteamLibrary,
  formatSteamLibraryForSynthesis,
} from "./steam-library.js";
import {
  collectMusicLibrary,
  formatMusicLibraryForSynthesis,
} from "./music-library.js";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "../kernel/home/private-fs.js";

import type { AllUserSignals, AllUserSignalsResult } from "./types.js";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type {
  BrowserBookmarks,
  SafariData,
  DevEnvironmentSignals,
  SystemSignals,
  MessagesNotesSignals,
} from "./discovery-types.js";
import type { FirefoxSignals } from "./firefox-data.js";
import type { SteamLibrarySignals } from "./steam-library.js";
import type { MusicLibrarySignals } from "./music-library.js";
import type { BrowserType } from "@stella/contracts";

const log = (...args: unknown[]) => console.error("[collect-all]", ...args);

const DEFAULT_CATEGORIES: DiscoveryCategory[] = [
  "browsing_bookmarks",
  "dev_environment",
  "apps_system",
];

const DISCOVERY_CATEGORIES_STATE_FILE = "discovery_categories.json";
const CHROMIUM_BROWSERS = new Set([
  "chrome",
  "edge",
  "brave",
  "arc",
  "opera",
  "vivaldi",
]);

type FormattedCategorySections = Partial<Record<DiscoveryCategory, string>>;

const joinSections = (sections: string[]): string =>
  sections.filter((s) => s && s.trim().length > 0).join("\n\n");

const persistSelectedCategories = async (
  stellaDataDir: string,
  categories: DiscoveryCategory[],
): Promise<void> => {
  try {
    const stateDir = stellaDataDir;
    const statePath = path.join(stateDir, DISCOVERY_CATEGORIES_STATE_FILE);
    await ensurePrivateDir(stateDir);
    await writePrivateFile(
      statePath,
      JSON.stringify({ categories, updatedAt: Date.now() }, null, 2),
    );
  } catch (error) {
    log("Failed to persist selected discovery categories:", error);
  }
};

type ExtendedUserSignals = AllUserSignals & {
  bookmarks?: BrowserBookmarks | null;
  safari?: SafariData | null;
  firefox?: FirefoxSignals | null;
  devEnvironment?: DevEnvironmentSignals;
  systemSignals?: SystemSignals;
  messagesNotes?: MessagesNotesSignals;
  steamLibrary?: SteamLibrarySignals | null;
  musicLibrary?: MusicLibrarySignals | null;
};

export const collectAllUserSignals = async (
  StellaDataDir: string,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
): Promise<ExtendedUserSignals> => {
  log("Starting sequential collection for categories:", categories);
  if (selectedBrowser) log("Selected browser:", selectedBrowser);
  if (selectedProfile) log("Selected browser profile:", selectedProfile);
  const start = Date.now();

  const tasks: Record<string, () => Promise<unknown>> = {};

  if (categories.includes("browsing_bookmarks")) {
    const shouldCollectChromium =
      !selectedBrowser || CHROMIUM_BROWSERS.has(selectedBrowser);
    const preferredChromiumSelection =
      !selectedBrowser && shouldCollectChromium
        ? await detectPreferredBrowserProfile()
        : null;
    const selectedChromiumBrowser = selectedBrowser
      ? (selectedBrowser as BrowserType | undefined)
      : (preferredChromiumSelection?.browser ?? undefined);
    const selectedChromiumProfile = selectedBrowser
      ? selectedProfile
      : (preferredChromiumSelection?.profile ?? undefined);

    if (shouldCollectChromium && selectedChromiumBrowser) {
      tasks.browser = () =>
        collectBrowserData(StellaDataDir, {
          selectedBrowser: selectedChromiumBrowser,
          selectedProfile: selectedChromiumProfile,
        });
      tasks.bookmarks = () =>
        collectBrowserBookmarks({
          selectedBrowser: selectedChromiumBrowser,
          selectedProfile: selectedChromiumProfile,
        }).catch((e) => {
          log("Bookmark collection failed:", e);
          return null;
        });
    }

    if (!selectedBrowser || selectedBrowser === "firefox") {
      tasks.firefox = () =>
        collectFirefoxData().catch((e) => {
          log("Firefox collection failed:", e);
          return null;
        });
    }
    if (!selectedBrowser || selectedBrowser === "safari") {
      tasks.safari = () =>
        collectSafariData().catch((e) => {
          log("Safari collection failed:", e);
          return null;
        });
    }
  }

  if (categories.includes("dev_environment")) {
    tasks.devProjects = () => collectDevProjects();
    tasks.shell = () => analyzeShellHistory();
    tasks.devEnv = () =>
      collectDevEnvironment().catch((e) => {
        log("Dev environment collection failed:", e);
        return {
          gitConfig: null,
          dotfiles: [],
          runtimes: [],
          packageManagers: [],
          wslDetected: false,
        };
      });
  }

  if (categories.includes("apps_system")) {
    tasks.system = () =>
      collectSystemSignals().catch((e) => {
        log("System signals collection failed:", e);
        return {
          userIdentity: null,
          dockPins: [],
          appUsage: [],
          device: null,
        };
      });
    tasks.steam = () =>
      collectSteamLibrary().catch((e) => {
        log("Steam library collection failed:", e);
        return null;
      });
    tasks.music = () =>
      collectMusicLibrary().catch((e) => {
        log("Music library collection failed:", e);
        return null;
      });
  }

  if (categories.includes("messages_notes")) {
    tasks.messagesNotes = () =>
      collectMessagesNotes().catch((e) => {
        log("Messages/notes collection failed:", e);
        return { contacts: [], groupChats: [], noteFolders: [], calendars: [] };
      });
  }

  const keys = Object.keys(tasks);
  const results: Record<string, unknown> = {};
  for (const key of keys) {
    results[key] = await tasks[key]();
  }

  const elapsed = Date.now() - start;
  log(`Collection complete in ${elapsed}ms`);

  return {

    browser: (results.browser as AllUserSignals["browser"]) ?? {
      browser: null,
      clusterDomains: [],
      recentDomains: [],
      allTimeDomains: [],
      domainDetails: {},
    },
    devProjects: (results.devProjects as AllUserSignals["devProjects"]) ?? [],
    shell: (results.shell as AllUserSignals["shell"]) ?? {
      topCommands: [],
      projectPaths: [],
      toolsUsed: [],
    },

    bookmarks: results.bookmarks as BrowserBookmarks | null | undefined,
    safari: results.safari as SafariData | null | undefined,
    firefox: results.firefox as FirefoxSignals | null | undefined,
    devEnvironment: results.devEnv as DevEnvironmentSignals | undefined,
    systemSignals: results.system as SystemSignals | undefined,
    messagesNotes: results.messagesNotes as MessagesNotesSignals | undefined,
    steamLibrary: results.steam as SteamLibrarySignals | null | undefined,
    musicLibrary: results.music as MusicLibrarySignals | null | undefined,
  };
};

const formatSignalsForSynthesisWithSections = async (
  data: ExtendedUserSignals,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
): Promise<{
  formatted: string;
  formattedSections: FormattedCategorySections;
}> => {
  const formattedSections: FormattedCategorySections = {};

  if (categories.includes("browsing_bookmarks")) {
    const categorySections: string[] = [];

    const browserSection = formatBrowserDataForSynthesis(data.browser);
    if (browserSection && browserSection !== "No browser data available.") {
      categorySections.push(browserSection);
    }

    if (data.bookmarks) {
      const bookmarksSection = formatBrowserBookmarksForSynthesis(
        data.bookmarks,
      );
      if (bookmarksSection) categorySections.push(bookmarksSection);
    }

    if (data.safari) {
      const safariSection = formatSafariDataForSynthesis(data.safari);
      if (safariSection) categorySections.push(safariSection);
    }

    if (data.firefox) {
      const firefoxSection = formatFirefoxDataForSynthesis(data.firefox);
      if (firefoxSection) categorySections.push(firefoxSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.browsing_bookmarks = categoryFormatted;
    }
  }

  if (categories.includes("dev_environment")) {
    const categorySections: string[] = [];

    const projectsSection = formatDevProjectsForSynthesis(data.devProjects);
    if (projectsSection) categorySections.push(projectsSection);

    const shellSection = formatShellAnalysisForSynthesis(data.shell);
    if (shellSection) categorySections.push(shellSection);

    if (data.devEnvironment) {
      const devEnvSection = formatDevEnvironmentForSynthesis(
        data.devEnvironment,
      );
      if (devEnvSection) categorySections.push(devEnvSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.dev_environment = categoryFormatted;
    }
  }

  if (categories.includes("apps_system")) {
    const categorySections: string[] = [];

    if (data.systemSignals) {
      const systemSection = formatSystemSignalsForSynthesis(data.systemSignals);
      if (systemSection) categorySections.push(systemSection);
    }

    if (data.steamLibrary) {
      const steamSection = formatSteamLibraryForSynthesis(data.steamLibrary);
      if (steamSection) categorySections.push(steamSection);
    }

    if (data.musicLibrary) {
      const musicSection = formatMusicLibraryForSynthesis(data.musicLibrary);
      if (musicSection) categorySections.push(musicSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.apps_system = categoryFormatted;
    }
  }

  if (categories.includes("messages_notes") && data.messagesNotes) {
    const messagesSection = formatMessagesNotesForSynthesis(data.messagesNotes);
    if (messagesSection) {
      formattedSections.messages_notes = messagesSection;
    }
  }

  const orderedSections = categories
    .map((category) => formattedSections[category])
    .filter((section): section is string =>
      Boolean(section && section.trim().length > 0),
    );

  let formatted = orderedSections.join("\n\n");
  formatted = filterLowSignalDomains(formatted);
  formatted = tierFormattedSignals(formatted);

  return {
    formatted,
    formattedSections,
  };
};

export const collectAllSignals = async (
  StellaDataDir: string,
  categories?: DiscoveryCategory[],
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
): Promise<AllUserSignalsResult> => {
  try {
    const cats = categories ?? DEFAULT_CATEGORIES;
    await persistSelectedCategories(StellaDataDir, cats);
    const data = await collectAllUserSignals(
      StellaDataDir,
      cats,
      selectedBrowser,
      selectedProfile,
    );
    const { formatted, formattedSections } =
      await formatSignalsForSynthesisWithSections(data, cats);

    return {
      data,
      formatted,
      formattedSections,
    };
  } catch (error) {
    log("Error collecting signals:", error);
    return {
      data: null,
      formatted: null,
      formattedSections: null,
      error: (error as Error).message,
    };
  }
};
