import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SUPPORTED_IN_APP_BROWSER_TYPES = [
  "chrome",
  "brave",
  "edge",
  "arc",
  "opera",
  "vivaldi",
] as const;

export type InAppBrowserType =
  (typeof SUPPORTED_IN_APP_BROWSER_TYPES)[number];

export type BrowserProfileSelection = {
  browserType?: InAppBrowserType;
  profileId?: string;
  profileName?: string;
  sourcePath?: string;
};

export type BrowserProfileImportResult = BrowserProfileSelection & {
  destinationPath: string;
  copied: boolean;
  skipped: boolean;
  copiedEntries: string[];
  failedEntries: string[];
};

export const readBrowserHistoryUrls = (
  profilePath: string,
  limit = 2_000,
): string[] => {
  const historyPath = path.join(profilePath, "History");
  if (!Number.isInteger(limit) || limit <= 0 || !existsSync(historyPath)) {
    return [];
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(historyPath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT url
         FROM urls
         WHERE url LIKE 'http://%' OR url LIKE 'https://%'
         ORDER BY last_visit_time DESC
         LIMIT ?`,
      )
      .all(Math.min(limit, 10_000)) as Array<{ url?: unknown }>;
    return rows
      .map((row) => (typeof row.url === "string" ? row.url : ""))
      .filter((url) => /^https?:\/\//i.test(url));
  } catch {
    return [];
  } finally {
    database?.close();
  }
};

const PROFILE_IMPORT_MARKER = ".stella-browser-profile-import-v1.json";

const PROFILE_STORAGE_ENTRIES = [
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Service Worker",
  "WebStorage",
  "Storage",
  "SharedStorage",
  "QuotaManager",
  "QuotaManager-journal",
  "History",
  "History-journal",
  "Favicons",
  "Favicons-journal",
] as const;

const browserRootRelatives: Record<
  InAppBrowserType,
  Partial<Record<NodeJS.Platform | "win32Alt", string>>
> = {
  chrome: {
    darwin: "Google/Chrome",
    win32: "Google/Chrome/User Data",
    win32Alt: "Google/Chrome/User",
    linux: ".config/google-chrome",
  },
  brave: {
    darwin: "BraveSoftware/Brave-Browser",
    win32: "BraveSoftware/Brave-Browser/User Data",
    win32Alt: "BraveSoftware/Brave-Browser/User",
    linux: ".config/BraveSoftware/Brave-Browser",
  },
  edge: {
    darwin: "Microsoft Edge",
    win32: "Microsoft/Edge/User Data",
    linux: ".config/microsoft-edge",
  },
  arc: {
    darwin: "Arc/User Data",
    win32: "Arc/User Data",
  },
  opera: {
    darwin: "com.operasoftware.Opera",
    win32: "Opera Software/Opera Stable",
    linux: ".config/opera",
  },
  vivaldi: {
    darwin: "Vivaldi",
    win32: "Vivaldi/User Data",
    linux: ".config/vivaldi",
  },
};

const basePathForPlatform = (platform: NodeJS.Platform) => {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (platform === "win32") {
    return (
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local")
    );
  }
  return os.homedir();
};

const rootsForBrowser = (
  browserType: InAppBrowserType,
  platform = process.platform,
) => {
  const config = browserRootRelatives[browserType];
  const relatives = [
    config[platform],
    platform === "win32" ? config.win32Alt : undefined,
  ].filter((value): value is string => Boolean(value));
  const basePath = basePathForPlatform(platform);
  return relatives.map((relative) => path.join(basePath, relative));
};

const isSafeProfileId = (value: string) =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("\0") &&
  !value.includes("/") &&
  !value.includes("\\");

const pathExists = async (candidate: string) => {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const readProfileMetadata = async (browserRoot: string) => {
  let lastUsed: string | undefined;
  const names = new Map<string, string>();
  try {
    const parsed = JSON.parse(
      await readFile(path.join(browserRoot, "Local State"), "utf8"),
    ) as {
      profile?: {
        last_used?: unknown;
        info_cache?: Record<string, { name?: unknown; gaia_name?: unknown }>;
      };
    };
    if (
      typeof parsed.profile?.last_used === "string" &&
      isSafeProfileId(parsed.profile.last_used)
    ) {
      lastUsed = parsed.profile.last_used;
    }
    for (const [id, info] of Object.entries(
      parsed.profile?.info_cache ?? {},
    )) {
      const name =
        typeof info.name === "string"
          ? info.name
          : typeof info.gaia_name === "string"
            ? info.gaia_name
            : id;
      names.set(id, name);
    }
  } catch {

  }
  return { lastUsed, names };
};

type ProfileCandidate = {
  browserType: InAppBrowserType;
  profileId: string;
  profileName: string;
  sourcePath: string;
  modifiedAt: number;
};

const listProfileCandidates = async (
  browserType: InAppBrowserType,
): Promise<ProfileCandidate[]> => {
  const candidates: ProfileCandidate[] = [];
  for (const browserRoot of rootsForBrowser(browserType)) {
    const metadata = await readProfileMetadata(browserRoot);
    let names: string[] = [];
    try {
      names = await readdir(browserRoot);
    } catch {
      continue;
    }

    const profileIds = names.filter(
      (name) => name === "Default" || /^Profile \d+$/.test(name),
    );
    if (await pathExists(path.join(browserRoot, "History"))) {
      profileIds.unshift("Default");
    }

    for (const profileId of new Set(profileIds)) {
      const nestedPath = path.join(browserRoot, profileId);
      const sourcePath = (await pathExists(nestedPath))
        ? nestedPath
        : browserRoot;
      try {
        const historyPath = path.join(sourcePath, "History");
        const sourceStat = await stat(
          (await pathExists(historyPath)) ? historyPath : sourcePath,
        );
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) continue;
        candidates.push({
          browserType,
          profileId,
          profileName: metadata.names.get(profileId) ?? profileId,
          sourcePath,
          modifiedAt: sourceStat.mtimeMs,
        });
      } catch {

      }
    }

    if (metadata.lastUsed && !candidates.some(
      (candidate) =>
        candidate.sourcePath === path.join(browserRoot, metadata.lastUsed!),
    )) {
      const sourcePath = path.join(browserRoot, metadata.lastUsed);
      if (await pathExists(sourcePath)) {
        const sourceStat = await stat(sourcePath).catch(() => null);
        candidates.push({
          browserType,
          profileId: metadata.lastUsed,
          profileName:
            metadata.names.get(metadata.lastUsed) ?? metadata.lastUsed,
          sourcePath,
          modifiedAt: sourceStat?.mtimeMs ?? 0,
        });
      }
    }
  }
  return candidates;
};

export const resolveBrowserProfileSelection = async (options: {
  browserType?: string;
  profileId?: string;
}): Promise<BrowserProfileSelection> => {
  const normalizedBrowserType = options.browserType?.trim().toLowerCase();
  if (
    normalizedBrowserType &&
    !SUPPORTED_IN_APP_BROWSER_TYPES.includes(
      normalizedBrowserType as InAppBrowserType,
    )
  ) {
    throw new Error(`Unsupported browser type: ${options.browserType}`);
  }
  if (options.profileId && !isSafeProfileId(options.profileId)) {
    throw new Error("Invalid browser profile identifier.");
  }

  const browserTypes = normalizedBrowserType
    ? [normalizedBrowserType as InAppBrowserType]
    : [...SUPPORTED_IN_APP_BROWSER_TYPES];
  const candidates = (
    await Promise.all(browserTypes.map(listProfileCandidates))
  ).flat();
  const matching = options.profileId
    ? candidates.filter((candidate) => candidate.profileId === options.profileId)
    : candidates;
  matching.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const selected = matching[0];
  if (!selected) {
    return {
      browserType: normalizedBrowserType as InAppBrowserType | undefined,
      profileId: options.profileId,
      profileName: options.profileId,
    };
  }
  return selected;
};

const copyWithoutSymlinks = async (source: string, destination: string) => {
  await cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: async (candidate) => {
      try {
        return !(await lstat(candidate)).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
};

export const importBrowserProfileSnapshot = async (options: {
  destinationPath: string;
  selection: BrowserProfileSelection;
}): Promise<BrowserProfileImportResult> => {
  const { destinationPath, selection } = options;
  await mkdir(destinationPath, { recursive: true });
  const markerPath = path.join(destinationPath, PROFILE_IMPORT_MARKER);
  if (await pathExists(markerPath)) {
    return {
      ...selection,
      destinationPath,
      copied: false,
      skipped: true,
      copiedEntries: [],
      failedEntries: [],
    };
  }

  const copiedEntries: string[] = [];
  const failedEntries: string[] = [];
  if (selection.sourcePath) {
    for (const entry of PROFILE_STORAGE_ENTRIES) {
      const source = path.join(selection.sourcePath, entry);
      if (!(await pathExists(source))) continue;
      try {
        await copyWithoutSymlinks(source, path.join(destinationPath, entry));
        copiedEntries.push(entry);
      } catch {
        failedEntries.push(entry);
      }
    }
  }

  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        importedAt: new Date().toISOString(),
        browserType: selection.browserType ?? null,
        profileId: selection.profileId ?? null,
        profileName: selection.profileName ?? null,
        sourcePath: selection.sourcePath ?? null,
        copiedEntries,
        failedEntries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ...selection,
    destinationPath,
    copied: copiedEntries.length > 0,
    skipped: false,
    copiedEntries,
    failedEntries,
  };
};
