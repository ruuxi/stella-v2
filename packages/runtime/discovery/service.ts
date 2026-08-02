/**
 * DiscoveryService — the Effect-native orchestrator for the user-signal
 * sweep. Owns the collector fan-out (an `Effect.forEach` with an explicit
 * concurrency cap and an optional per-collector timeout) and the synthesis
 * formatting pipeline.
 *
 * Parity notes (do not change without measuring the old sweep):
 * - The pre-Effect sweep ran collectors strictly sequentially (a for-loop of
 *   awaits) with no per-collector timeout. Those are the defaults here —
 *   `concurrency: 1`, no timeout — so collection completeness and timing are
 *   unchanged unless a caller opts into different budgets.
 * - Per-collector failure isolation is byte-identical: the same `.catch`
 *   fallbacks guard the same collectors (bookmarks/firefox/safari/devEnv/
 *   system/steam/music/messagesNotes degrade to the same partial shapes),
 *   and the unguarded collectors (browser/devProjects/shell) still fail the
 *   sweep, which `collectAllSignals` converts to the same `{ data: null,
 *   error }` result.
 *
 * The plain-Promise facade with the historical export names lives in
 * `collect-all.ts`.
 */

import path from "path";
import { Cause, Context, Effect, Layer } from "effect";
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
import { tryDiscovery } from "./effect-io.js";

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

// Default categories (Category 4 is opt-in)
export const DEFAULT_CATEGORIES: DiscoveryCategory[] = [
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

// ---------------------------------------------------------------------------
// Extended Signals Type
// ---------------------------------------------------------------------------

export type ExtendedUserSignals = AllUserSignals & {
  bookmarks?: BrowserBookmarks | null;
  safari?: SafariData | null;
  firefox?: FirefoxSignals | null;
  devEnvironment?: DevEnvironmentSignals;
  systemSignals?: SystemSignals;
  messagesNotes?: MessagesNotesSignals;
  steamLibrary?: SteamLibrarySignals | null;
  musicLibrary?: MusicLibrarySignals | null;
};

// ---------------------------------------------------------------------------
// Fan-out Options
// ---------------------------------------------------------------------------

/**
 * Budgets for the collector fan-out. The defaults reproduce the pre-Effect
 * sweep's observable behavior exactly; both knobs exist so callers can opt
 * into bounded sweeps without another rewrite.
 */
export type DiscoveryCollectionOptions = {
  /**
   * Maximum collectors in flight. Default `1` — the pre-Effect sweep awaited
   * each collector before starting the next.
   */
  readonly concurrency?: number | "unbounded";
  /**
   * Per-collector timeout in milliseconds. Default: none — the pre-Effect
   * sweep never timed a collector out. When set, a lapsed collector fails
   * with `TimeoutException`, which propagates exactly like a collector
   * rejection (guarded collectors keep their fallback shapes via their own
   * `.catch`; unguarded ones fail the sweep).
   */
  readonly collectorTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

const collectAllUserSignalsEffect = (
  StellaDataDir: string,
  categories: DiscoveryCategory[],
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
  options?: DiscoveryCollectionOptions,
): Effect.Effect<ExtendedUserSignals, unknown> =>
  Effect.gen(function* () {
    log("Starting sequential collection for categories:", categories);
    if (selectedBrowser) log("Selected browser:", selectedBrowser);
    if (selectedProfile) log("Selected browser profile:", selectedProfile);
    const start = Date.now();

    // Build lazy tasks so selecting multiple categories does not launch every
    // local database, filesystem, and browser collector at once during
    // onboarding. Each task keeps the exact `.catch` isolation the pre-Effect
    // sweep gave it.
    const tasks: Record<string, () => Promise<unknown>> = {};

    if (categories.includes("browsing_bookmarks")) {
      const shouldCollectChromium =
        !selectedBrowser || CHROMIUM_BROWSERS.has(selectedBrowser);
      const preferredChromiumSelection =
        !selectedBrowser && shouldCollectChromium
          ? yield* tryDiscovery(() => detectPreferredBrowserProfile())
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

      // Only run Firefox/Safari if no specific browser selected, or if that browser is selected
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

    // Fan-out: explicit concurrency cap (default 1 = the old sequential
    // for-loop, preserving order and fail-fast) and optional per-collector
    // timeout (default none). With the default cap a failing unguarded
    // collector stops the sweep before later collectors start — exactly the
    // pre-Effect behavior.
    const keys = Object.keys(tasks);
    const results: Record<string, unknown> = {};
    const collectorTimeoutMs = options?.collectorTimeoutMs;
    yield* Effect.forEach(
      keys,
      (key) =>
        Effect.suspend(() => {
          const collect = tryDiscovery(tasks[key]);
          const timed =
            collectorTimeoutMs === undefined
              ? collect
              : collect.pipe(Effect.timeout(collectorTimeoutMs));
          return Effect.map(timed, (value) => {
            results[key] = value;
          });
        }),
      { concurrency: options?.concurrency ?? 1, discard: true },
    );

    const elapsed = Date.now() - start;
    log(`Collection complete in ${elapsed}ms`);

    return {
      // Existing signals (may be undefined if category not selected)
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
      // New signals
      bookmarks: results.bookmarks as BrowserBookmarks | null | undefined,
      safari: results.safari as SafariData | null | undefined,
      firefox: results.firefox as FirefoxSignals | null | undefined,
      devEnvironment: results.devEnv as DevEnvironmentSignals | undefined,
      systemSignals: results.system as SystemSignals | undefined,
      messagesNotes: results.messagesNotes as MessagesNotesSignals | undefined,
      steamLibrary: results.steam as SteamLibrarySignals | null | undefined,
      musicLibrary: results.music as MusicLibrarySignals | null | undefined,
    };
  });

// ---------------------------------------------------------------------------
// Formatting for LLM Synthesis
// ---------------------------------------------------------------------------

const formatSignalsForSynthesisWithSections = async (
  data: ExtendedUserSignals,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
): Promise<{
  formatted: string;
  formattedSections: FormattedCategorySections;
}> => {
  const formattedSections: FormattedCategorySections = {};

  // --- Category 1: Browsing & Bookmarks ---
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

  // --- Category 2: Development Environment ---
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

  // --- Category 3: Apps & System ---
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

  // --- Category 4: Messages & Notes ---
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

  // Post-process: filter low-signal domains, then tier for synthesis priority
  let formatted = orderedSections.join("\n\n");
  formatted = filterLowSignalDomains(formatted);
  formatted = tierFormattedSignals(formatted);

  return {
    formatted,
    formattedSections,
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Collect all user signals, filtered by selected categories. Fails with
   * the first unguarded collector error, exactly like the pre-Effect sweep.
   */
  readonly collectAllUserSignals: (
    stellaDataDir: string,
    categories?: DiscoveryCategory[],
    selectedBrowser?: string | null,
    selectedProfile?: string | null,
    options?: DiscoveryCollectionOptions,
  ) => Effect.Effect<ExtendedUserSignals, unknown>;
  /**
   * Collect and format all signals. Never fails: any sweep error (including
   * defects) degrades to `{ data: null, formatted: null, formattedSections:
   * null, error }` with the original error message.
   */
  readonly collectAllSignals: (
    stellaDataDir: string,
    categories?: DiscoveryCategory[],
    selectedBrowser?: string | null,
    selectedProfile?: string | null,
    options?: DiscoveryCollectionOptions,
  ) => Effect.Effect<AllUserSignalsResult>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/discovery/DiscoveryService",
) {}

export const make = (): Interface => ({
  collectAllUserSignals: (
    stellaDataDir,
    categories = DEFAULT_CATEGORIES,
    selectedBrowser,
    selectedProfile,
    options,
  ) =>
    collectAllUserSignalsEffect(
      stellaDataDir,
      categories,
      selectedBrowser,
      selectedProfile,
      options,
    ),

  collectAllSignals: (
    stellaDataDir,
    categories,
    selectedBrowser,
    selectedProfile,
    options,
  ) =>
    Effect.gen(function* () {
      const cats = categories ?? DEFAULT_CATEGORIES;
      yield* tryDiscovery(() =>
        persistSelectedCategories(stellaDataDir, cats),
      );
      const data = yield* collectAllUserSignalsEffect(
        stellaDataDir,
        cats,
        selectedBrowser,
        selectedProfile,
        options,
      );
      const { formatted, formattedSections } = yield* tryDiscovery(() =>
        formatSignalsForSynthesisWithSections(data, cats),
      );

      return {
        data,
        formatted,
        formattedSections,
      } satisfies AllUserSignalsResult;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause);
          log("Error collecting signals:", error);
          return {
            data: null,
            formatted: null,
            formattedSections: null,
            error: (error as Error).message,
          } satisfies AllUserSignalsResult;
        }),
      ),
    ),
});

export const layer = Layer.succeed(Service, make());
