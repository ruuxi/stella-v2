import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  BrowserType,
  DomainVisit,
  DomainDetail,
  BrowserData,
  PreferredBrowserProfile,
  BrowserProfile,
  ClusterKeyword,
  SearchQuery,
} from "@stella/contracts";

export type {
  BrowserType,
  DomainVisit,
  DomainDetail,
  BrowserData,
  PreferredBrowserProfile,
  BrowserProfile,
  ClusterKeyword,
  SearchQuery,
}

export type BrowserCollectionOptions = {
  selectedBrowser?: BrowserType | null;
  selectedProfile?: string | null;
};

export type BrowserActivityWindowRequest = {
  id: string;
  label: string;
  sinceMs: number;
};

export type BrowserActivityWindow = BrowserActivityWindowRequest & {
  data: BrowserData;
};

type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  const { Database } = await import("bun:sqlite");

  const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
  return new Database(uri, { readonly: true }) as SqliteDatabase;
};

const log = (...args: unknown[]) => console.error("[browser-data]", ...args);

type BrowserConfig = {
  type: BrowserType;

  paths: {
    win32: string[];
    darwin: string[];
    linux: string[];
  };
};

const PROFILE_VARIANTS = ["Default", "Profile 1", "Profile 2", "Profile 3"];

const generateProfilePaths = (basePath: string): string[] => {
  return PROFILE_VARIANTS.map((profile) =>
    basePath.replace("/Default/", `/${profile}/`)
  );
};

const BROWSER_CONFIGS: BrowserConfig[] = [
  {
    type: "chrome",
    paths: {
      win32: [

        ...generateProfilePaths("Google/Chrome/User Data/Default/History"),

        ...generateProfilePaths("Google/Chrome/User/Default/History"),

        ...generateProfilePaths("Google/Chrome Beta/User Data/Default/History"),

        ...generateProfilePaths("Google/Chrome SxS/User Data/Default/History"),
      ],
      darwin: [
        ...generateProfilePaths("Google/Chrome/Default/History"),
        ...generateProfilePaths("Google/Chrome Beta/Default/History"),
        ...generateProfilePaths("Google/Chrome Canary/Default/History"),
      ],
      linux: [
        ...generateProfilePaths(".config/google-chrome/Default/History"),
        ...generateProfilePaths(".config/google-chrome-beta/Default/History"),
        ...generateProfilePaths(".config/chromium/Default/History"),
      ],
    },
  },
  {
    type: "arc",
    paths: {
      win32: [

        ...generateProfilePaths("Arc/User Data/Default/History"),
      ],
      darwin: [

        ...generateProfilePaths("Arc/User Data/Default/History"),
      ],
      linux: [],
    },
  },
  {
    type: "edge",
    paths: {
      win32: [
        ...generateProfilePaths("Microsoft/Edge/User Data/Default/History"),
        ...generateProfilePaths("Microsoft/Edge/User/Default/History"),
        ...generateProfilePaths("Microsoft/Edge Beta/User Data/Default/History"),
        ...generateProfilePaths("Microsoft/Edge Dev/User Data/Default/History"),
      ],
      darwin: [
        ...generateProfilePaths("Microsoft Edge/Default/History"),
        ...generateProfilePaths("Microsoft Edge Beta/Default/History"),
      ],
      linux: [
        ...generateProfilePaths(".config/microsoft-edge/Default/History"),
        ...generateProfilePaths(".config/microsoft-edge-beta/Default/History"),
      ],
    },
  },
  {
    type: "brave",
    paths: {
      win32: [
        ...generateProfilePaths("BraveSoftware/Brave-Browser/User Data/Default/History"),
        ...generateProfilePaths("BraveSoftware/Brave-Browser/User/Default/History"),
      ],
      darwin: [
        ...generateProfilePaths("BraveSoftware/Brave-Browser/Default/History"),
      ],
      linux: [
        ...generateProfilePaths(".config/BraveSoftware/Brave-Browser/Default/History"),
      ],
    },
  },
  {
    type: "opera",
    paths: {
      win32: [
        "Opera Software/Opera Stable/History",
        "Opera Software/Opera GX Stable/History",
      ],
      darwin: [
        "com.operasoftware.Opera/History",
        "com.operasoftware.OperaGX/History",
      ],
      linux: [
        ".config/opera/History",
      ],
    },
  },
  {
    type: "vivaldi",
    paths: {
      win32: [
        ...generateProfilePaths("Vivaldi/User Data/Default/History"),
      ],
      darwin: [
        ...generateProfilePaths("Vivaldi/Default/History"),
      ],
      linux: [
        ...generateProfilePaths(".config/vivaldi/Default/History"),
      ],
    },
  },
];

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
};

const BROWSER_PROCESSES: Record<BrowserType, Record<string, string[]>> = {
  chrome: {
    win32: ["chrome.exe"],
    darwin: ["Google Chrome"],
    linux: ["chrome", "google-chrome", "chromium"],
  },
  edge: {
    win32: ["msedge.exe"],
    darwin: ["Microsoft Edge"],
    linux: ["msedge", "microsoft-edge"],
  },
  brave: {
    win32: ["brave.exe"],
    darwin: ["Brave Browser"],
    linux: ["brave", "brave-browser"],
  },
  arc: {
    win32: ["Arc.exe"],
    darwin: ["Arc"],
    linux: [],
  },
  opera: {
    win32: ["opera.exe"],
    darwin: ["Opera"],
    linux: ["opera"],
  },
  vivaldi: {
    win32: ["vivaldi.exe"],
    darwin: ["Vivaldi"],
    linux: ["vivaldi"],
  },
};

const detectRunningBrowsers = async (): Promise<BrowserType[]> => {
  const platform = process.platform;
  const running: BrowserType[] = [];

  try {
    let processList: string;

    if (platform === "win32") {

      processList = await execAsync("tasklist /FO CSV /NH");
    } else if (platform === "darwin") {

      processList = await execAsync("ps -eo comm");
    } else {

      processList = await execAsync("ps -eo comm");
    }

    const processListLower = processList.toLowerCase();

    const browserOrder: BrowserType[] = ["chrome", "arc", "edge", "brave", "opera", "vivaldi"];

    for (const browser of browserOrder) {
      const processNames = BROWSER_PROCESSES[browser]?.[platform] || [];

      for (const processName of processNames) {
        if (processListLower.includes(processName.toLowerCase())) {
          running.push(browser);
          break;
        }
      }
    }

    if (running.length > 0) {
      log("Running browsers detected:", running);
    }
  } catch (error) {
    log("Failed to detect running browsers:", error);
  }

  return running;
};

const detectDefaultBrowserWindows = async (): Promise<BrowserType | null> => {
  try {

    const output = await execAsync(
      'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId'
    );

    const progId = output.toLowerCase();
    log("Registry ProgId output:", progId);

    if (progId.includes("chromehtm") || progId.includes("chromehtml")) return "chrome";
    if (progId.includes("msedge") || progId.includes("edgehtm")) return "edge";
    if (progId.includes("bravehtm") || progId.includes("bravehtml")) return "brave";
    if (progId.includes("archtml") || progId.includes("archtm")) return "arc";
    if (progId.includes("operahtml") || progId.includes("operahtm")) return "opera";
    if (progId.includes("vivaldi")) return "vivaldi";

    log("Could not match ProgId to a supported browser");
    return null;
  } catch (error) {
    log("Failed to detect default browser on Windows:", error);
    return null;
  }
};

const detectDefaultBrowserMac = async (): Promise<BrowserType | null> => {
  try {

    const output = await execAsync(
      "defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -A2 'LSHandlerURLScheme = http;' | grep LSHandlerRoleAll | head -1"
    );

    const bundleId = output.toLowerCase();

    if (bundleId.includes("chrome")) return "chrome";
    if (bundleId.includes("edge")) return "edge";
    if (bundleId.includes("brave")) return "brave";
    if (bundleId.includes("arc")) return "arc";
    if (bundleId.includes("opera")) return "opera";
    if (bundleId.includes("vivaldi")) return "vivaldi";

    log("Default browser bundle ID:", bundleId);
    return null;
  } catch {

    try {
      const output = await execAsync(
        "perl -MMac::InternetConfig -le 'print +(GetICHelper \"http\")[1]' 2>/dev/null || true"
      );
      const app = output.toLowerCase();
      if (app.includes("chrome")) return "chrome";
      if (app.includes("safari")) return null;
    } catch {

    }
    return null;
  }
};

const detectDefaultBrowserLinux = async (): Promise<BrowserType | null> => {
  try {
    const output = await execAsync("xdg-settings get default-web-browser 2>/dev/null");
    const desktop = output.toLowerCase();

    if (desktop.includes("chrome") || desktop.includes("chromium")) return "chrome";
    if (desktop.includes("edge")) return "edge";
    if (desktop.includes("brave")) return "brave";
    if (desktop.includes("opera")) return "opera";
    if (desktop.includes("vivaldi")) return "vivaldi";

    log("Default browser desktop file:", desktop);
    return null;
  } catch {
    return null;
  }
};

const detectDefaultBrowser = async (): Promise<BrowserType | null> => {
  const platform = process.platform;

  switch (platform) {
    case "win32":
      return detectDefaultBrowserWindows();
    case "darwin":
      return detectDefaultBrowserMac();
    case "linux":
      return detectDefaultBrowserLinux();
    default:
      return null;
  }
};

const BROWSER_BASE_DIRS: Record<BrowserType, Record<string, string>> = {
  chrome: {
    win32: "Google/Chrome/User Data",
    win32Alt: "Google/Chrome/User",
    darwin: "Google/Chrome",
    linux: ".config/google-chrome",
  },
  edge: {
    win32: "Microsoft/Edge/User Data",
    darwin: "Microsoft Edge",
    linux: ".config/microsoft-edge",
  },
  brave: {
    win32: "BraveSoftware/Brave-Browser/User Data",
    darwin: "BraveSoftware/Brave-Browser",
    linux: ".config/BraveSoftware/Brave-Browser",
  },
  arc: {
    win32: "Arc/User Data",
    darwin: "Arc/User Data",
    linux: "",
  },
  opera: {
    win32: "Opera Software/Opera Stable",
    darwin: "com.operasoftware.Opera",
    linux: ".config/opera",
  },
  vivaldi: {
    win32: "Vivaldi/User Data",
    darwin: "Vivaldi",
    linux: ".config/vivaldi",
  },
};

const getMostRecentlyUsedProfile = async (browserType: BrowserType): Promise<string> => {
  const platform = process.platform;
  const basePath = getBasePath(platform);

  const browserDirs = [
    BROWSER_BASE_DIRS[browserType]?.[platform as string],
    platform === "win32" ? BROWSER_BASE_DIRS[browserType]?.win32Alt : null,
  ].filter(Boolean) as string[];

  if (browserDirs.length === 0) return "Default";

  const profilePatterns = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5"];

  const profileChecks = browserDirs.flatMap((browserDir) => {
    const userDataPath = path.join(basePath, browserDir);
    return profilePatterns.map(async (profile) => {
      const profilePath = path.join(userDataPath, profile);
      try {
        const stat = await fs.stat(profilePath);
        if (!stat.isDirectory()) return null;
        const historyPath = path.join(profilePath, "History");
        try {
          const historyStat = await fs.stat(historyPath);
          return { profile, mtime: historyStat.mtimeMs };
        } catch {
          return { profile, mtime: stat.mtimeMs };
        }
      } catch {
        return null;
      }
    });
  });

  const profileResults = await Promise.all(profileChecks);
  let mostRecentProfile = "Default";
  let mostRecentTime = 0;
  for (const result of profileResults) {
    if (result && result.mtime > mostRecentTime) {
      mostRecentTime = result.mtime;
      mostRecentProfile = result.profile;
    }
  }

  if (mostRecentTime > 0) {
    const lastModified = new Date(mostRecentTime).toISOString();
    log(`Most recent profile for ${browserType}: ${mostRecentProfile} (last modified: ${lastModified})`);
  }

  return mostRecentProfile;
};

const getHistoryPathForBrowserProfile = async (
  browserType: BrowserType,
  profile: string
): Promise<string | null> => {
  const platform = process.platform;
  const basePath = getBasePath(platform);

  const browserDir = BROWSER_BASE_DIRS[browserType]?.[platform as string];
  if (!browserDir) return null;

  const historyPath = path.join(basePath, browserDir, profile, "History");
  try {
    await fs.access(historyPath);
    return historyPath;
  } catch {

    if (platform === "win32" && BROWSER_BASE_DIRS[browserType]?.win32Alt) {
      const altDir = BROWSER_BASE_DIRS[browserType].win32Alt;
      const altHistoryPath = path.join(basePath, altDir, profile, "History");
      try {
        await fs.access(altHistoryPath);
        return altHistoryPath;
      } catch {

      }
    }
  }

  return null;
};

const getBasePath = (platform: NodeJS.Platform): string => {
  const home = os.homedir();
  switch (platform) {
    case "win32":
      return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    case "darwin":
      return path.join(home, "Library", "Application Support");
    default:
      return home;
  }
};

const getBrowserHistoryPaths = (
  browserType: BrowserType,
  platform: NodeJS.Platform
): string[] => {
  const config = BROWSER_CONFIGS.find((c) => c.type === browserType);
  if (!config) return [];

  const basePath = getBasePath(platform);
  const relativePaths = config.paths[platform as keyof typeof config.paths];
  if (!relativePaths || relativePaths.length === 0) return [];

  return relativePaths.map((rel) => path.join(basePath, rel));
};

const parseProfileFromHistoryPath = (historyPath: string): string | null => {
  const segments = historyPath.split(/[\\/]+/).filter(Boolean);
  const profile = segments.find((segment) =>
    segment === "Default" || /^Profile \d+$/i.test(segment)
  );
  return profile ?? null;
};

const CHROME_EPOCH_OFFSET = 11644473600000;

const toChromeTime = (date: Date): number => {
  return (date.getTime() + CHROME_EPOCH_OFFSET) * 1000;
};

const NOISE_TITLE_PATTERNS = [

  /^just a moment\.{0,3}$/i,
  /^loading\.{0,3}$/i,
  /^please wait\.{0,3}$/i,
  /^redirecting\.{0,3}$/i,

  /^access denied/i,
  /^403 forbidden/i,
  /^404 not found/i,
  /^500 /i,
  /^error$/i,

  /^untitled$/i,
  /^new tab$/i,

  /^https?:\/\//i,
  /^\w+\.\w+\/[\w/-]+$/,
];

const AUTH_DOMAINS = [
  "accounts.google.com",
  "login.",
  "auth.",
  "oauth.",
  "signin.",
  "sso.",
  "id.",
];

const normalizeDomain = (domain: string): string => {
  let normalized = domain.toLowerCase().trim();

  const prefixes = ["www.", "mobile.", "m."];
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  return normalized;
};

const filterAndAggregateDomains = (
  rows: Array<{ domain: string; visits: number }>
): DomainVisit[] => {
  const aggregated = new Map<string, number>();

  for (const { domain, visits } of rows) {
    if (!domain || domain.length === 0) continue;
    const normalized = normalizeDomain(domain);
    aggregated.set(normalized, (aggregated.get(normalized) || 0) + visits);
  }

  return Array.from(aggregated.entries())
    .map(([domain, visits]) => ({ domain, visits }))
    .sort((a, b) => b.visits - a.visits);
};

const CLUSTER_QUERY = `
SELECT label, COUNT(*) as sessions
FROM clusters
WHERE label != ''
  AND label NOT LIKE '%localhost%'
  AND label NOT LIKE '%127.0.0.1%'
GROUP BY label
ORDER BY sessions DESC
LIMIT 40
`;

const RECENT_DOMAINS_QUERY = `
SELECT
  SUBSTR(
    SUBSTR(u.url, INSTR(u.url, '://') + 3),
    1,
    CASE
      WHEN INSTR(SUBSTR(u.url, INSTR(u.url, '://') + 3), '/') = 0
      THEN LENGTH(SUBSTR(u.url, INSTR(u.url, '://') + 3))
      ELSE INSTR(SUBSTR(u.url, INSTR(u.url, '://') + 3), '/') - 1
    END
  ) as domain,
  COUNT(*) as visits
FROM urls u
JOIN visits v ON u.id = v.url
WHERE v.visit_time > ?
  AND u.url NOT LIKE '%localhost%'
  AND u.url NOT LIKE '%127.0.0.1%'
  AND u.url NOT LIKE '%file://%'
  AND u.url NOT LIKE '%chrome://%'
  AND u.url NOT LIKE '%edge://%'
  AND u.url NOT LIKE '%brave://%'
GROUP BY domain
ORDER BY visits DESC
LIMIT 30
`;

const DOMAIN_TITLES_QUERY = `
SELECT title, url, visit_count
FROM urls
WHERE url LIKE ?
  AND title != ''
ORDER BY visit_count DESC
LIMIT 25
`;

const ALL_TIME_DOMAINS_QUERY = `
SELECT
  SUBSTR(
    SUBSTR(url, INSTR(url, '://') + 3),
    1,
    CASE
      WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') = 0
      THEN LENGTH(SUBSTR(url, INSTR(url, '://') + 3))
      ELSE INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
    END
  ) as domain,
  SUM(visit_count) as visits
FROM urls
WHERE url NOT LIKE '%localhost%'
  AND url NOT LIKE '%127.0.0.1%'
  AND url NOT LIKE '%file://%'
  AND url NOT LIKE '%chrome://%'
  AND url NOT LIKE '%edge://%'
  AND url NOT LIKE '%brave://%'
GROUP BY domain
ORDER BY visits DESC
LIMIT 50
`;

const CLUSTER_KEYWORDS_QUERY = `
SELECT ck.keyword, ck.score,
       MAX(v.visit_time) as latest_visit
FROM cluster_keywords ck
JOIN clusters c ON c.cluster_id = ck.cluster_id
JOIN clusters_and_visits cv ON cv.cluster_id = c.cluster_id
JOIN visits v ON v.id = cv.visit_id
WHERE v.visit_time > ?
  AND LENGTH(ck.keyword) > 1
GROUP BY ck.keyword
ORDER BY latest_visit DESC
LIMIT 40
`;

const findMostRecentlyModifiedBrowser = async (): Promise<{
  type: BrowserType;
  historyPath: string;
  mtime: number;
} | null> => {

  const candidateResults = await Promise.all(
    BROWSER_CONFIGS.map(async (config) => {
      const recentProfile = await getMostRecentlyUsedProfile(config.type);
      const historyPath = await getHistoryPathForBrowserProfile(config.type, recentProfile);
      if (!historyPath) return null;
      try {
        const stat = await fs.stat(historyPath);
        return { type: config.type, historyPath, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const candidates = candidateResults.filter(
    (c): c is { type: BrowserType; historyPath: string; mtime: number } => c !== null
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  const winner = candidates[0];
  log(`Most recently modified browser: ${winner.type} (modified ${new Date(winner.mtime).toISOString()})`);

  return winner;
};

const resolveSelectedBrowser = async (
  options: BrowserCollectionOptions,
): Promise<{
  type: BrowserType;
  historyPath: string;
  profile: string | null;
} | null> => {
  const { selectedBrowser, selectedProfile } = options;
  if (!selectedBrowser) return null;

  if (selectedProfile) {
    const historyPath = await getHistoryPathForBrowserProfile(
      selectedBrowser,
      selectedProfile,
    );
    if (historyPath) {
      log(
        `Using selected browser/profile: ${selectedBrowser} (${selectedProfile}) at ${historyPath}`,
      );
      return {
        type: selectedBrowser,
        historyPath,
        profile: selectedProfile,
      };
    }

    log(
      `Selected browser/profile not accessible, falling back to another profile in ${selectedBrowser}: ${selectedProfile}`,
    );
  }

  const lastProfile = await getMostRecentlyUsedProfile(selectedBrowser);
  const historyPath = await getHistoryPathForBrowserProfile(
    selectedBrowser,
    lastProfile,
  );
  if (historyPath) {
    log(
      `Using selected browser: ${selectedBrowser} (${lastProfile} profile) at ${historyPath}`,
    );
    return {
      type: selectedBrowser,
      historyPath,
      profile: lastProfile,
    };
  }

  if (lastProfile !== "Default") {
    const defaultHistoryPath = await getHistoryPathForBrowserProfile(
      selectedBrowser,
      "Default",
    );
    if (defaultHistoryPath) {
      log(
        `Using selected browser default profile: ${selectedBrowser} (Default) at ${defaultHistoryPath}`,
      );
      return {
        type: selectedBrowser,
        historyPath: defaultHistoryPath,
        profile: "Default",
      };
    }
  }

  const platform = process.platform;
  const historyPaths = getBrowserHistoryPaths(selectedBrowser, platform);
  for (const fallbackHistoryPath of historyPaths) {
    try {
      await fs.access(fallbackHistoryPath);
      const fallbackProfile = parseProfileFromHistoryPath(fallbackHistoryPath);
      log(
        `Using selected browser fallback path: ${selectedBrowser} (${fallbackProfile ?? "unknown profile"}) at ${fallbackHistoryPath}`,
      );
      return {
        type: selectedBrowser,
        historyPath: fallbackHistoryPath,
        profile: fallbackProfile,
      };
    } catch {
      continue;
    }
  }

  log(`Selected browser ${selectedBrowser} has no accessible history`);
  return null;
};

const findBrowserWithOptions = async (
  options: BrowserCollectionOptions = {},
): Promise<{
  type: BrowserType;
  historyPath: string;
  profile: string | null;
} | null> => {
  if (options.selectedBrowser) {
    return resolveSelectedBrowser(options);
  }

  const platform = process.platform;

  log("Detecting running browsers and OS default browser...");
  const [runningBrowsers, defaultBrowser] = await Promise.all([
    detectRunningBrowsers(),
    detectDefaultBrowser(),
  ]);

  if (runningBrowsers.length > 0) {
    for (const browser of runningBrowsers) {
      const lastProfile = await getMostRecentlyUsedProfile(browser);
      const historyPath = await getHistoryPathForBrowserProfile(browser, lastProfile);

      if (historyPath) {
        log(`Found ${browser} history (currently running, ${lastProfile} profile) at: ${historyPath}`);
        return { type: browser, historyPath, profile: lastProfile };
      }
    }
    log("Running browsers detected but history not accessible, continuing...");
  }

  if (defaultBrowser) {
    log(`OS default browser: ${defaultBrowser}`);

    const lastProfile = await getMostRecentlyUsedProfile(defaultBrowser);
    const historyPath = await getHistoryPathForBrowserProfile(defaultBrowser, lastProfile);

    if (historyPath) {
      log(`Found ${defaultBrowser} history (OS default, ${lastProfile} profile) at: ${historyPath}`);
      return { type: defaultBrowser, historyPath, profile: lastProfile };
    }

    if (lastProfile !== "Default") {
      const defaultHistoryPath = await getHistoryPathForBrowserProfile(defaultBrowser, "Default");
      if (defaultHistoryPath) {
        log(`Found ${defaultBrowser} history (OS default, Default profile) at: ${defaultHistoryPath}`);
        return { type: defaultBrowser, historyPath: defaultHistoryPath, profile: "Default" };
      }
    }

    log(`OS default browser ${defaultBrowser} detected but history not accessible, falling back...`);
  } else {
    log("Could not detect OS default browser, trying most recently modified...");
  }

  log("Finding most recently modified browser...");
  const mostRecent = await findMostRecentlyModifiedBrowser();

  if (mostRecent) {
    log(`Using most recently modified: ${mostRecent.type} at ${mostRecent.historyPath}`);
    return {
      type: mostRecent.type,
      historyPath: mostRecent.historyPath,
      profile: parseProfileFromHistoryPath(mostRecent.historyPath),
    };
  }

  log("Most recent detection failed, checking all browsers in priority order...");
  for (const config of BROWSER_CONFIGS) {
    const historyPaths = getBrowserHistoryPaths(config.type, platform);
    for (const historyPath of historyPaths) {
      try {
        await fs.access(historyPath);
        log(`Found ${config.type} history at: ${historyPath}`);
        return {
          type: config.type,
          historyPath,
          profile: parseProfileFromHistoryPath(historyPath),
        };
      } catch {
        continue;
      }
    }
  }

  log("No browser history found");
  return null;
};

const queryClusterDomains = (db: SqliteDatabase): string[] => {
  try {
    const rows = db.prepare(CLUSTER_QUERY).all() as Array<{
      label: string;
      sessions: number;
    }>;
    return rows.map((r) => r.label);
  } catch {

    log("Clusters table not available");
    return [];
  }
};

const FALLBACK_DOMAINS_QUERY = `
SELECT
  SUBSTR(
    SUBSTR(url, INSTR(url, '://') + 3),
    1,
    CASE
      WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') = 0
      THEN LENGTH(SUBSTR(url, INSTR(url, '://') + 3))
      ELSE INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
    END
  ) as domain,
  SUM(visit_count) as visits
FROM urls
WHERE url NOT LIKE '%localhost%'
  AND url NOT LIKE '%127.0.0.1%'
  AND url NOT LIKE '%file://%'
  AND url NOT LIKE '%chrome://%'
  AND url NOT LIKE '%edge://%'
  AND url NOT LIKE '%brave://%'
  AND visit_count > 0
GROUP BY domain
ORDER BY visits DESC
LIMIT 30
`;

type DomainRow = { domain: string; visits: number };

const SEARCH_QUERIES_LIMIT = 15;

const SEARCH_QUERY_URL_FILTER = `
SELECT url, visit_count
FROM urls
WHERE visit_count > 0
  AND (
    url LIKE '%/search?%q=%'
    OR url LIKE '%/results?%search_query=%'
    OR url LIKE '%duckduckgo.com/?%q=%'
  )
ORDER BY visit_count DESC
LIMIT 800
`;

const SEARCH_HOST_PARAMS: { match: (host: string) => boolean; param: string }[] =
  [
    { match: (h) => h.includes("google."), param: "q" },
    { match: (h) => h.endsWith("bing.com"), param: "q" },
    { match: (h) => h.endsWith("duckduckgo.com"), param: "q" },
    { match: (h) => h.endsWith("brave.com"), param: "q" },
    { match: (h) => h.endsWith("youtube.com"), param: "search_query" },
    { match: (h) => h.includes("search.yahoo."), param: "p" },
    { match: (h) => h.endsWith("ecosia.org"), param: "q" },
    { match: (h) => h.endsWith("startpage.com"), param: "query" },
  ];

const querySearchQueries = (db: SqliteDatabase): SearchQuery[] => {
  let rows: { url: string; visit_count: number }[];
  try {
    rows = db.prepare(SEARCH_QUERY_URL_FILTER).all() as {
      url: string;
      visit_count: number;
    }[];
  } catch (error) {
    log("Search query extraction failed:", error);
    return [];
  }

  const counts = new Map<string, { display: string; count: number }>();
  for (const row of rows) {
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    const spec = SEARCH_HOST_PARAMS.find((s) => s.match(host));
    if (!spec) continue;
    const raw = parsed.searchParams.get(spec.param)?.trim();

    if (!raw || raw.length < 2 || raw.length > 80) continue;
    const key = raw.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += row.visit_count || 1;
    else counts.set(key, { display: raw, count: row.visit_count || 1 });
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, SEARCH_QUERIES_LIMIT)
    .map((entry) => ({ query: entry.display, count: entry.count }));
};

const queryRecentDomains = (
  db: SqliteDatabase,
  sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000,
  options: { allowFallback?: boolean } = {},
): DomainVisit[] => {
  try {
    const rows = db.prepare(RECENT_DOMAINS_QUERY).all(toChromeTime(new Date(sinceMs))) as DomainRow[];
    return filterAndAggregateDomains(rows);
  } catch (error) {
    log("Recent domains query failed, trying fallback:", error);
  }

  if (options.allowFallback === false) {
    return [];
  }

  try {
    const rows = db.prepare(FALLBACK_DOMAINS_QUERY).all() as DomainRow[];
    return filterAndAggregateDomains(rows);
  } catch (fallbackError) {
    log("Fallback domains query failed:", fallbackError);
    return [];
  }
};

const isNoiseTitle = (title: string): boolean => {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
};

const isAuthDomain = (domain: string): boolean => {
  const lower = domain.toLowerCase();
  return AUTH_DOMAINS.some((auth) => lower.includes(auth));
};

const getTopDomainsForDetails = (
  domains: DomainVisit[],
  limit: number = 15
): string[] => {
  return domains
    .filter((d) => !isAuthDomain(d.domain))
    .slice(0, limit)
    .map((d) => d.domain);
};

const queryDomainDetails = (
  db: SqliteDatabase,
  topDomains: string[]
): Record<string, DomainDetail[]> => {
  const details: Record<string, DomainDetail[]> = {};

  for (const domain of topDomains) {
    try {
      const rows = db.prepare(DOMAIN_TITLES_QUERY).all(`%${domain}%`) as Array<{
        title: string;
        url: string;
        visit_count: number;
      }>;

      const titleMap = new Map<string, DomainDetail>();
      for (const row of rows) {
        if (isNoiseTitle(row.title)) continue;

        const key = row.title.trim().toLowerCase();
        const existing = titleMap.get(key);
        if (existing) {
          existing.visitCount += row.visit_count;
        } else {
          titleMap.set(key, {
            title: row.title,
            url: row.url,
            visitCount: row.visit_count,
          });
        }
      }

      if (titleMap.size > 0) {

        details[domain] = Array.from(titleMap.values())
          .sort((a, b) => b.visitCount - a.visitCount)
          .slice(0, 15);
      }
    } catch {

    }
  }

  return details;
};

const queryAllTimeDomains = (db: SqliteDatabase): DomainVisit[] => {
  try {
    const rows = db.prepare(ALL_TIME_DOMAINS_QUERY).all() as DomainRow[];
    return filterAndAggregateDomains(rows);
  } catch (error) {
    log("All-time domains query failed:", error);
    return [];
  }
};

const queryClusterKeywords = (db: SqliteDatabase, sinceChromeTime: number): ClusterKeyword[] => {
  try {
    const rows = db.prepare(CLUSTER_KEYWORDS_QUERY).all(sinceChromeTime) as Array<{
      keyword: string;
      score: number;
      latest_visit: number | bigint;
    }>;

    const CHROME_TO_UNIX_MS = 11644473600000n;
    return rows.map((r) => ({
      keyword: r.keyword,
      score: r.score,
      lastVisit: Number(BigInt(r.latest_visit) / 1000n - CHROME_TO_UNIX_MS),
    }));
  } catch {
    log("Cluster keywords table not available");
    return [];
  }
};

const emptyBrowserData = (browser: BrowserType | null = null): BrowserData => ({
  browser,
  clusterDomains: [],
  recentDomains: [],
  allTimeDomains: [],
  domainDetails: {},
  clusterKeywords: [],
});

const buildBrowserDataWindow = (
  db: SqliteDatabase,
  browserType: BrowserType,
  sinceMs: number,
): BrowserData => {
  const recentDomains = queryRecentDomains(db, sinceMs, { allowFallback: false });
  const clusterKeywords = queryClusterKeywords(db, toChromeTime(new Date(sinceMs)));
  const domainDetails = queryDomainDetails(
    db,
    getTopDomainsForDetails(recentDomains, 15),
  );
  return {
    browser: browserType,
    clusterDomains: [],
    recentDomains,
    allTimeDomains: [],
    domainDetails,
    clusterKeywords,
  };
};

export const collectBrowserData = async (
  StellaDataDir: string,
  options: BrowserCollectionOptions = {},
): Promise<BrowserData> => {
  log("Starting browser data collection...");

  const browser = await findBrowserWithOptions(options);
  if (!browser) {
    return emptyBrowserData(options.selectedBrowser ?? null);
  }

  let db: SqliteDatabase | null = null;

  try {
    db = await openDatabase(browser.historyPath);

    const clusterDomains = queryClusterDomains(db);
    const recentDomains = queryRecentDomains(db);
    const rawAllTimeDomains = queryAllTimeDomains(db);
    const thirtyDaysAgo = toChromeTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const clusterKeywords = queryClusterKeywords(db, thirtyDaysAgo);
    const searchQueries = querySearchQueries(db);

    const recentDomainSet = new Set(recentDomains.map((d) => d.domain.toLowerCase()));
    const allTimeDomains = rawAllTimeDomains
      .filter((d) => !recentDomainSet.has(d.domain.toLowerCase()))
      .slice(0, 20);

    const combinedDomains = [
      ...new Set([
        ...getTopDomainsForDetails(recentDomains, 15),
        ...getTopDomainsForDetails(allTimeDomains, 10),
      ]),
    ];
    const domainDetails = queryDomainDetails(db, combinedDomains);

    log("Collection complete:", {
      browser: browser.type,
      clusterDomains: clusterDomains.length,
      recentDomains: recentDomains.length,
      allTimeDomains: allTimeDomains.length,
      domainDetails: Object.keys(domainDetails).length,
      clusterKeywords: clusterKeywords.length,
    });

    return {
      browser: browser.type,
      clusterDomains,
      recentDomains,
      allTimeDomains,
      domainDetails,
      clusterKeywords,
      searchQueries,
    };
  } catch (error) {
    log("Error collecting browser data:", error);
    return emptyBrowserData(browser.type);
  } finally {
    db?.close?.();
  }
};

export const collectBrowserActivityWindows = async (
  StellaDataDir: string,
  windows: BrowserActivityWindowRequest[],
  options: BrowserCollectionOptions = {},
): Promise<BrowserActivityWindow[]> => {
  const browser = await findBrowserWithOptions(options);
  if (!browser) {
    return windows.map((window) => ({
      ...window,
      data: emptyBrowserData(options.selectedBrowser ?? null),
    }));
  }

  let db: SqliteDatabase | null = null;

  try {
    db = await openDatabase(browser.historyPath);
    return windows.map((window) => ({
      ...window,
      data: buildBrowserDataWindow(db!, browser.type, window.sinceMs),
    }));
  } catch (error) {
    log("Error collecting browser activity windows:", error);
    return windows.map((window) => ({
      ...window,
      data: emptyBrowserData(browser.type),
    }));
  } finally {
    db?.close?.();
  }
};

export const coreMemoryExists = async (StellaDataDir: string): Promise<boolean> => {
  const candidatePaths = [
    path.join(StellaDataDir, "core-memory.md"),
    path.join(StellaDataDir, "CORE_MEMORY.MD"),
  ];
  for (const coreMemoryPath of candidatePaths) {
    try {
      await fs.access(coreMemoryPath);
      return true;
    } catch {
      continue;
    }
  }
  return false;
};

type LocationProvider = {
  url: string;
  extract: (body: Record<string, unknown>) => {
    city?: unknown;
    region?: unknown;
    postal?: unknown;
    country?: unknown;
  };
};

const LOCATION_PROVIDERS: LocationProvider[] = [
  {
    url: "https://ipwho.is/",
    extract: (b) => ({
      city: b.city,
      region: b.region,
      postal: b.postal,
      country: b.country,
    }),
  },
  {

    url: "https://get.geojs.io/v1/ip/geo.json",
    extract: (b) => ({
      city: b.city,
      region: b.region,
      postal: undefined,
      country: b.country,
    }),
  },
];

const jsonRecordSchema = z.record(z.string(), z.unknown());

const profileInfoSchema = z.looseObject({
  name: z.string().optional(),
  gaia_name: z.string().optional(),
});

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  jsonRecordSchema.safeParse(value).success;

const asTrimmed = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchLocationFromProvider = async (
  provider: LocationProvider,
  deadline: number,
): Promise<string | null> => {
  const budget = deadline - Date.now();
  if (budget <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(budget, 5_000));
  try {
    const response = await fetch(provider.url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      log(`Location lookup ${provider.url} HTTP ${response.status}`);
      return null;
    }
    const parsed = (await response.json()) as unknown;
    if (!isJsonRecord(parsed)) return null;
    const body = parsed;

    if (body.success === false || body.error === true) return null;
    const fields = provider.extract(body);
    const city = asTrimmed(fields.city);
    const region = asTrimmed(fields.region);
    const postal = asTrimmed(fields.postal);
    const country = asTrimmed(fields.country);
    if (!city || !country) return null;

    const cityRegion = region ? `${city}, ${region}` : city;
    const cityRegionPostal = postal ? `${cityRegion} ${postal}` : cityRegion;
    return `${cityRegionPostal}, ${country}`;
  } catch (error) {
    log(`Location lookup ${provider.url} failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fetchUserLocationLine = async (): Promise<string | null> => {
  const deadline = Date.now() + 12_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    for (const provider of LOCATION_PROVIDERS) {
      if (Date.now() >= deadline) break;
      const line = await fetchLocationFromProvider(provider, deadline);
      if (line) return line;
    }
    attempt += 1;
    if (Date.now() < deadline) await sleep(Math.min(500 * attempt, 1_500));
  }
  log("Location lookup exhausted retries");
  return null;
};

export const writeCoreMemory = async (
  StellaDataDir: string,
  content: string,
  options?: { includeLocation?: boolean }
): Promise<void> => {
  const statePath = StellaDataDir;
  await fs.mkdir(statePath, { recursive: true });
  const coreMemoryPath = path.join(statePath, "core-memory.md");
  const location = options?.includeLocation
    ? await fetchUserLocationLine()
    : null;
  const finalContent = location
    ? `${content.trimEnd()}\n\n## Location\n${location}\n`
    : content;
  await fs.writeFile(coreMemoryPath, finalContent, "utf-8");
  log(`Wrote ~/.stella/core-memory.md${location ? " (with location)" : ""}`);
};

const formatDomainList = (domains: DomainVisit[]): string =>
  domains.map((d) => `${d.domain} (${d.visits})`).join("\n");

export const formatBrowserDataForSynthesis = (data: BrowserData): string => {
  if (!data.browser) return "No browser data available.";

  const sections: string[] = [`## Browser Data (${data.browser})`];

  if (data.recentDomains.length > 0) {
    sections.push("\n### Most Active (Last 7 Days)");
    sections.push(formatDomainList(data.recentDomains));
  }

  if (data.allTimeDomains.length > 0) {
    sections.push("\n### Long-term Interests (All-time, excluding recent)");
    sections.push(formatDomainList(data.allTimeDomains));
  }

  if (Object.keys(data.domainDetails).length > 0) {
    sections.push("\n### Content Details");
    for (const [domain, titles] of Object.entries(data.domainDetails)) {
      sections.push(`\n**${domain}**`);
      sections.push(titles.map((t) => `- ${t.title} (${t.visitCount})`).join("\n"));
    }
  }

  if (data.searchQueries && data.searchQueries.length > 0) {
    sections.push("\n### Recent Searches");
    sections.push(data.searchQueries.map((s) => `- ${s.query}`).join("\n"));
  }

  if (data.clusterKeywords?.length > 0) {
    sections.push("\n### Research Topics (Last 30 Days)");
    sections.push(
      data.clusterKeywords
        .map((k) => {
          const daysAgo = Math.floor((Date.now() - k.lastVisit) / (24 * 60 * 60 * 1000));
          const recency = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
          return `- ${k.keyword} (${recency})`;
        })
        .join("\n")
    );
  }

  return sections.join("\n");
};

export const detectPreferredBrowserProfile = async (): Promise<PreferredBrowserProfile> => {
  const browser = await findBrowserWithOptions();
  if (!browser) {
    return { browser: null, profile: null };
  }
  return {
    browser: browser.type,
    profile: browser.profile,
  };
};

export const listBrowserProfiles = async (browserType: BrowserType): Promise<BrowserProfile[]> => {
  const platform = process.platform;
  const basePath = getBasePath(platform);

  const browserDirs = [
    BROWSER_BASE_DIRS[browserType]?.[platform as string],
    platform === "win32" ? BROWSER_BASE_DIRS[browserType]?.win32Alt : null,
  ].filter(Boolean) as string[];

  if (browserDirs.length === 0) return [];

  const displayNames = new Map<string, string>();
  for (const browserDir of browserDirs) {
    const localStatePath = path.join(basePath, browserDir, "Local State");
    try {
      const raw = await fs.readFile(localStatePath, "utf-8");
      const localState = JSON.parse(raw);
      const infoCache = localState?.profile?.info_cache;
      if (infoCache && typeof infoCache === "object") {
        for (const [profileId, info] of Object.entries(infoCache)) {
          const profileInfo = profileInfoSchema.safeParse(info);
          const name = profileInfo.success
            ? (profileInfo.data.name ?? profileInfo.data.gaia_name ?? profileId)
            : profileId;
          displayNames.set(profileId, name);
        }
      }
    } catch {

    }
  }

  const profilePatterns = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5",
    "Profile 6", "Profile 7", "Profile 8", "Profile 9", "Profile 10"];

  const checks = browserDirs.flatMap((browserDir) => {
    const userDataPath = path.join(basePath, browserDir);
    return profilePatterns.map(async (profile): Promise<BrowserProfile | null> => {
      const profilePath = path.join(userDataPath, profile);
      try {
        const stat = await fs.stat(profilePath);
        if (!stat.isDirectory()) return null;

        await fs.access(path.join(profilePath, "History"));
        return {
          id: profile,
          name: displayNames.get(profile) ?? profile,
        };
      } catch {
        return null;
      }
    });
  });

  const results = await Promise.all(checks);
  const seen = new Set<string>();
  const profiles: BrowserProfile[] = [];
  for (const r of results) {
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      profiles.push(r);
    }
  }

  log(`Found ${profiles.length} profile(s) for ${browserType}:`, profiles.map(p => `${p.id} (${p.name})`));
  return profiles;
};
