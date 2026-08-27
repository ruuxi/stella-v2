import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "node:url";

const log = (...args: unknown[]) => console.error("[firefox-data]", ...args);

export type FirefoxDomainVisit = {
  domain: string;
  visits: number;
  frecency: number;
  lastVisit: number;
};

export type FirefoxBookmark = {
  title: string;
  url: string;
  folder?: string;
};

export type FirefoxSignals = {
  domains: FirefoxDomainVisit[];
  bookmarks: FirefoxBookmark[];
};

const getFirefoxProfilesDir = (): string => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Mozilla", "Firefox", "Profiles",
    );
  } else if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Firefox", "Profiles");
  } else {
    return path.join(home, ".mozilla", "firefox");
  }
};

const findActiveProfile = async (): Promise<string | null> => {
  const profilesDir = getFirefoxProfilesDir();

  try {
    const entries = await fs.readdir(profilesDir);

    const preferred = entries.find((e) => e.endsWith(".default-release"))
      ?? entries.find((e) => e.endsWith(".default"))
      ?? entries.find((e) => e.includes("default"));

    if (preferred) {
      const profilePath = path.join(profilesDir, preferred);
      const placesPath = path.join(profilePath, "places.sqlite");
      try {
        await fs.access(placesPath);
        return profilePath;
      } catch {

      }
    }

    for (const entry of entries) {
      const placesPath = path.join(profilesDir, entry, "places.sqlite");
      try {
        await fs.access(placesPath);
        return path.join(profilesDir, entry);
      } catch {

      }
    }
  } catch {

  }

  return null;
};

type SqliteDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  const { Database } = await import("bun:sqlite");

  const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
  return new Database(uri, { readonly: true }) as SqliteDatabase;
};

const DOMAINS_QUERY = `
SELECT
  o.host as domain,
  SUM(p.visit_count) as visits,
  MAX(p.frecency) as frecency,
  MAX(p.last_visit_date) as last_visit
FROM moz_places p
JOIN moz_origins o ON p.origin_id = o.id
WHERE p.visit_count > 0
  AND o.host != ''
  AND o.host NOT LIKE '%.localhost'
  AND p.hidden = 0
GROUP BY o.host
ORDER BY frecency DESC
LIMIT 100
`;

const BOOKMARKS_QUERY = `
SELECT
  b.title as bookmark_title,
  p.url,
  parent_b.title as folder_title
FROM moz_bookmarks b
JOIN moz_places p ON b.fk = p.id
LEFT JOIN moz_bookmarks parent_b ON b.parent = parent_b.id
WHERE b.type = 1
  AND p.url NOT LIKE 'place:%'
  AND b.title IS NOT NULL
  AND b.title != ''
ORDER BY b.lastModified DESC
LIMIT 100
`;

export const collectFirefoxData = async (): Promise<FirefoxSignals | null> => {
  const profilePath = await findActiveProfile();
  if (!profilePath) {
    log("No Firefox profile found");
    return null;
  }

  log(`Found Firefox profile at: ${profilePath}`);

  const sourcePath = path.join(profilePath, "places.sqlite");

  let db: SqliteDatabase | null = null;
  try {
    db = await openDatabase(sourcePath);

    const domainRows = db.prepare(DOMAINS_QUERY).all() as {
      domain: string;
      visits: number;
      frecency: number;
      last_visit: number | null;
    }[];

    const domains: FirefoxDomainVisit[] = domainRows.map((r) => ({
      domain: r.domain,
      visits: r.visits,
      frecency: r.frecency,

      lastVisit: r.last_visit ? Math.floor(r.last_visit / 1000) : 0,
    }));

    const bookmarkRows = db.prepare(BOOKMARKS_QUERY).all() as {
      bookmark_title: string;
      url: string;
      folder_title: string | null;
    }[];

    const bookmarks: FirefoxBookmark[] = bookmarkRows.map((r) => ({
      title: r.bookmark_title,
      url: r.url,
      folder: r.folder_title ?? undefined,
    }));

    log(`Collected ${domains.length} domains, ${bookmarks.length} bookmarks from Firefox`);

    return { domains, bookmarks };
  } catch (error) {
    log("Failed to read Firefox data:", error);
    return null;
  } finally {
    db?.close?.();
  }
};

export const formatFirefoxDataForSynthesis = (signals: FirefoxSignals): string => {
  const sections: string[] = ["## Firefox"];

  if (signals.domains.length > 0) {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = signals.domains.filter((d) => d.lastVisit >= thirtyDaysAgo);
    const toShow = recent.length > 5 ? recent : signals.domains;

    sections.push("\n### Top Sites");
    sections.push(
      toShow
        .slice(0, 25)
        .map((d) => `- ${d.domain} (${d.visits} visits)`)
        .join("\n"),
    );
  }

  if (signals.bookmarks.length > 0) {

    const foldered = signals.bookmarks.filter((b) => b.folder);
    const unfoldered = signals.bookmarks.filter((b) => !b.folder);

    if (foldered.length > 0 || unfoldered.length > 0) {
      sections.push("\n### Bookmarks");

      const folders = [...new Set(foldered.map((b) => b.folder!))];
      if (folders.length > 0) {
        sections.push("Folders: " + folders.slice(0, 15).join(", "));
      }

      const topBookmarks = signals.bookmarks.slice(0, 15);
      sections.push(
        topBookmarks
          .map((b) => {
            const folder = b.folder ? ` [${b.folder}]` : "";
            return `- ${b.title}${folder}`;
          })
          .join("\n"),
      );
    }
  }

  return sections.join("\n");
};
