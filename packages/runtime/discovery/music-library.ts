import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "node:url";

const log = (...args: unknown[]) => console.error("[music-library]", ...args);

export type MusicArtist = {
  name: string;
  playCount: number;
};

export type MusicGenre = {
  name: string;
  trackCount: number;
};

export type MusicLibrarySignals = {
  source: "itunes" | "apple_music";
  totalTracks: number;
  topArtists: MusicArtist[];
  topGenres: MusicGenre[];
};

const ITUNES_XML_PATHS_WIN = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, "Music", "iTunes", "iTunes Music Library.xml"),
    path.join(home, "Music", "iTunes", "iTunes Library.xml"),
  ];
};

const ITUNES_XML_PATHS_MAC = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, "Music", "iTunes", "iTunes Music Library.xml"),
    path.join(home, "Music", "iTunes", "iTunes Library.xml"),
    path.join(home, "Music", "Music", "Music Library.xml"),
  ];
};

const findItunesXml = async (): Promise<string | null> => {
  const paths = process.platform === "darwin"
    ? ITUNES_XML_PATHS_MAC()
    : ITUNES_XML_PATHS_WIN();

  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {  }
  }
  return null;
};

const parseItunesXml = async (xmlPath: string): Promise<MusicLibrarySignals> => {
  const content = await fs.readFile(xmlPath, "utf-8");

  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  let totalTracks = 0;

  const tracksIdx = content.indexOf("<key>Tracks</key>");
  if (tracksIdx === -1) {
    return { source: "itunes", totalTracks: 0, topArtists: [], topGenres: [] };
  }

  const tracksSection = content.substring(tracksIdx);

  const trackPattern = /<key>Track ID<\/key>/g;
  let match;
  let prevIdx = 0;

  const trackBlocks: string[] = [];
  while ((match = trackPattern.exec(tracksSection)) !== null) {
    if (prevIdx > 0) {
      trackBlocks.push(tracksSection.substring(prevIdx, match.index));
    }
    prevIdx = match.index;
  }
  if (prevIdx > 0) {

    const endIdx = tracksSection.indexOf("</dict>", prevIdx + 1000);
    if (endIdx > 0) trackBlocks.push(tracksSection.substring(prevIdx, endIdx));
  }

  for (const block of trackBlocks) {

    const podcastMatch = block.match(/<key>Podcast<\/key>\s*<true\/>/);
    if (podcastMatch) continue;
    const kindMatch = block.match(/<key>Kind<\/key>\s*<string>([^<]+)<\/string>/);
    if (kindMatch && kindMatch[1].toLowerCase().includes("audiobook")) continue;

    totalTracks++;

    const artistMatch = block.match(/<key>Artist<\/key>\s*<string>([^<]+)<\/string>/);
    const artist = artistMatch?.[1];

    const genreMatch = block.match(/<key>Genre<\/key>\s*<string>([^<]+)<\/string>/);
    const genre = genreMatch?.[1];

    const playCountMatch = block.match(/<key>Play Count<\/key>\s*<integer>(\d+)<\/integer>/);
    const playCount = playCountMatch ? Number(playCountMatch[1]) : 0;

    if (artist) {
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + playCount);
    }
    if (genre) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }

  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, playCount]) => ({ name, playCount }));

  const topGenres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, trackCount]) => ({ name, trackCount }));

  return { source: "itunes", totalTracks, topArtists, topGenres };
};

type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

const APPLE_MUSIC_DB_PATHS = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, "Music", "Music", "Music Library.musiclibrary", "Library.musicdb"),
    path.join(home, "Music", "Music", "Music Library.musiclibrary", "Library.db"),
  ];
};

const findAppleMusicDb = async (): Promise<string | null> => {
  for (const p of APPLE_MUSIC_DB_PATHS()) {
    try {
      await fs.access(p);
      return p;
    } catch {  }
  }
  return null;
};

const SQLITE_HEADER = "SQLite format 3\0";

const isSqliteDatabaseFile = async (dbPath: string): Promise<boolean> => {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(dbPath, "r");
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString("utf8") === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const collectFromAppleMusicDb = async (dbPath: string): Promise<MusicLibrarySignals> => {
  const { Database } = await import("bun:sqlite");

  const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
  const db = new Database(uri, { readonly: true }) as SqliteDatabase;

  try {

    const countRow = db.prepare("SELECT COUNT(*) as c FROM ZTRACK WHERE ZISPODCAST = 0").all() as { c: number }[];
    const totalTracks = countRow[0]?.c ?? 0;

    const artistRows = db.prepare(`
      SELECT ZARTIST as name, SUM(ZPLAYCOUNT) as play_count
      FROM ZTRACK
      WHERE ZISPODCAST = 0 AND ZARTIST IS NOT NULL
      GROUP BY ZARTIST
      ORDER BY play_count DESC
      LIMIT 20
    `).all() as { name: string; play_count: number }[];

    const genreRows = db.prepare(`
      SELECT ZGENRE as name, COUNT(*) as track_count
      FROM ZTRACK
      WHERE ZISPODCAST = 0 AND ZGENRE IS NOT NULL
      GROUP BY ZGENRE
      ORDER BY track_count DESC
      LIMIT 10
    `).all() as { name: string; track_count: number }[];

    return {
      source: "apple_music",
      totalTracks,
      topArtists: artistRows.map((r) => ({ name: r.name, playCount: r.play_count })),
      topGenres: genreRows.map((r) => ({ name: r.name, trackCount: r.track_count })),
    };
  } finally {
    db.close();
  }
};

export const collectMusicLibrary = async (): Promise<MusicLibrarySignals | null> => {

  if (process.platform === "darwin") {
    const appleMusicDb = await findAppleMusicDb();
    if (appleMusicDb) {
      log(`Found Apple Music database at: ${appleMusicDb}`);
      if (!(await isSqliteDatabaseFile(appleMusicDb))) {
        log("Apple Music library exists but is not a SQLite database on this system");
      } else {
        try {
          const result = await collectFromAppleMusicDb(appleMusicDb);
          log(`Collected from Apple Music: ${result.totalTracks} tracks, ${result.topArtists.length} artists, ${result.topGenres.length} genres`);
          return result;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "SQLITE_NOTADB") {
            log("Apple Music database format is not readable on this system");
          } else {
            log("Failed to read Apple Music database:", error);
          }
        }
      }
    }
  }

  const itunesXml = await findItunesXml();
  if (itunesXml) {
    log(`Found iTunes library at: ${itunesXml}`);
    try {
      const result = await parseItunesXml(itunesXml);
      log(`Collected from iTunes: ${result.totalTracks} tracks, ${result.topArtists.length} artists, ${result.topGenres.length} genres`);
      return result;
    } catch (error) {
      log("Failed to parse iTunes library:", error);
    }
  }

  log("No music library found");
  return null;
};

export const formatMusicLibraryForSynthesis = (signals: MusicLibrarySignals): string => {
  if (signals.totalTracks === 0) return "";

  const source = signals.source === "apple_music" ? "Apple Music" : "iTunes";
  const sections: string[] = [`## Music Library (${source})`];
  sections.push(`${signals.totalTracks} tracks`);

  if (signals.topGenres.length > 0) {
    sections.push(
      "\nGenres: " +
        signals.topGenres
          .slice(0, 8)
          .map((g) => `${g.name} (${g.trackCount})`)
          .join(", "),
    );
  }

  if (signals.topArtists.length > 0) {
    sections.push("\n### Most Played Artists");
    sections.push(
      signals.topArtists
        .filter((a) => a.playCount > 0)
        .slice(0, 15)
        .map((a) => `- ${a.name} (${a.playCount} plays)`)
        .join("\n"),
    );
  }

  return sections.join("\n");
};
