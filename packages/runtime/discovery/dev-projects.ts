/**
 * Dev Projects Discovery
 *
 * Finds active development projects from real usage signals. The goal is not
 * to enumerate every repo on disk; it is to rank the projects the user is most
 * likely to mean when they say "open my project".
 *
 * Uses editor and assistant metadata plus shallow repository discovery.
 * Only directory names, paths, and activity timestamps leave this collector.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec, execFile } from "child_process";
import { pathToFileURL } from "node:url";
import { collectAssistantProjects } from "./assistant-projects.js";
import { Effect } from "effect";
import {
  runDiscovery,
  tryDiscovery,
  tryDiscoverySync,
} from "./effect-io.js";

import type { DevProject } from "./types.js";

const log = (...args: unknown[]) => console.error("[dev-projects]", ...args);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RECENCY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATE_PATHS = 120;
const MAX_VALIDATION_BATCH_SIZE = 8;
const MAX_RESULTS = 8;

const COMMON_DEV_ROOT_NAMES = [
  "projects",
  "Projects",
  "Developer",
  "dev",
  "src",
  "code",
  "work",
  "repos",
];

const DEV_ROOT_SCAN_MAX_DEPTH = 2;
const DEV_ROOT_SCAN_MAX_DIRS = 200;
const DEV_ROOT_SCAN_MAX_REPOS = 100;

type ProjectCandidate = {
  path: string;
  sources: Map<string, number>;
  editorLastAccessed?: number;
  recentSessionCount?: number;
};

type ResolvedProjectCandidate = {
  path: string;
  sources: Map<string, number>;
  editorLastAccessed?: number;
  recentSessionCount?: number;
};

type ScoredProject = DevProject & {
  score: number;
  sourceSummary: string[];
};

type EditorWorkspace = {
  path: string;
};

type EditorTrackedRepo = {
  path: string;
  lastAccessed?: number;
};

type SqliteDatabase = {
  query(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeCandidatePath = (candidatePath: string): string | null => {
  let normalized = candidatePath.trim();
  if (!normalized) return null;

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original path if decoding fails.
  }

  normalized = normalized
    .replace(/^file:\/\/\//, "/")
    .replace(/^file:\/\//, "")
    .replace(/^vscode-remote:\/\/[^/]+/, "");

  if (normalized.startsWith("~")) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }

  normalized = normalized.replace(/[\\/]+$/, "");
  if (!normalized || normalized.length > 4096 || /[\r\n\0]/.test(normalized)) return null;
  if (normalized.includes(`${path.sep}.vscode${path.sep}extensions`)) {
    return null;
  }
  if (normalized.includes("debugpy")) return null;

  return normalized;
};

const candidateKey = (candidatePath: string): string =>
  (process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath).replace(/[\\/]+$/, "");

const addCandidate = (
  candidates: Map<string, ProjectCandidate>,
  candidatePath: string | null | undefined,
  source: string,
  weight: number,
  metadata?: { editorLastAccessed?: number; recentSessionCount?: number },
): void => {
  if (!candidatePath) return;
  const normalized = normalizeCandidatePath(candidatePath);
  if (!normalized) return;

  const key = candidateKey(normalized);
  const existing = candidates.get(key) ?? {
    path: normalized,
    sources: new Map<string, number>(),
  };
  existing.sources.set(source, (existing.sources.get(source) ?? 0) + weight);

  if (
    metadata?.editorLastAccessed &&
    (!existing.editorLastAccessed ||
      metadata.editorLastAccessed > existing.editorLastAccessed)
  ) {
    existing.editorLastAccessed = metadata.editorLastAccessed;
  }

  existing.recentSessionCount = (existing.recentSessionCount ?? 0) + (metadata?.recentSessionCount ?? 0);
  candidates.set(key, existing);
};

const execAsync = (command: string, timeoutMs = 10000): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(
      command,
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const execFileAsync = (
  file: string,
  args: string[],
  timeoutMs = 3000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 128,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const statIfExists = async (filePath: string) =>
  fs.stat(filePath).catch(() => null);

const daysAgo = (timestamp: number): number =>
  Math.floor((Date.now() - timestamp) / DAY_MS);

const sourceList = (sources: Map<string, number>): string[] =>
  Array.from(sources.keys()).sort();

// ---------------------------------------------------------------------------
// Repository activity
// ---------------------------------------------------------------------------

const resolveGitRoot = async (
  candidatePath: string,
): Promise<string | null> => {
  try {
    const root = await execFileAsync(
      "git",
      ["-C", candidatePath, "rev-parse", "--show-toplevel"],
      3000,
    );
    return root || null;
  } catch {
    return null;
  }
};

const getGitRepoActivity = async (repoPath: string): Promise<number | null> => {
  let gitDir = path.join(repoPath, ".git");
  const gitEntry = await statIfExists(gitDir);
  if (!gitEntry) return (await statIfExists(repoPath))?.mtimeMs ?? null;
  // Worktrees store a pointer file instead of a .git directory.
  if (gitEntry.isFile()) {
    if (gitEntry.size > 4096) return null;
    const pointer = await fs.readFile(gitDir, "utf8").catch(() => "");
    if (!pointer.startsWith("gitdir: ")) return null;
    gitDir = path.resolve(repoPath, pointer.slice(8).trim());
  }
  const filesToCheck = [
    path.join(gitDir, "index"),
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "FETCH_HEAD"),
    path.join(gitDir, "logs", "HEAD"),
  ];

  const fileStats = await Promise.all(
    filesToCheck.map((file) => statIfExists(file)),
  );
  let mostRecent = 0;
  for (const fileStat of fileStats) {
    if (fileStat && fileStat.mtimeMs > mostRecent) {
      mostRecent = fileStat.mtimeMs;
    }
  }

  const gitStat = await statIfExists(gitDir);
  if (!mostRecent && gitStat) mostRecent = gitStat.mtimeMs;

  if (mostRecent > 0) return mostRecent;

  try {
    const commitTimestamp = await execFileAsync(
      "git",
      ["-C", repoPath, "log", "-1", "--format=%ct"],
      3000,
    );
    const seconds = Number(commitTimestamp);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Source 1: macOS Spotlight (mdfind)
// ---------------------------------------------------------------------------

const collectFromSpotlight = async (): Promise<string[]> => {
  if (process.platform !== "darwin") return [];

  try {
    const output = await execAsync(
      'mdfind "kMDItemFSName == .git && kMDItemContentType == public.folder" -onlyin ~',
      15000,
    );
    if (!output) return [];

    return output
      .split("\n")
      .filter((line) => line.endsWith("/.git"))
      .map((line) => path.dirname(line));
  } catch {
    log("Spotlight query failed, skipping");
    return [];
  }
};

// ---------------------------------------------------------------------------
// Source 2: GitHub Desktop repositories.json
// ---------------------------------------------------------------------------

type GHDesktopRepo = {
  path?: string;
  missing?: boolean;
};

const collectFromGitHubDesktop = async (): Promise<string[]> => {
  const home = os.homedir();
  const platform = process.platform;

  let reposPath: string;
  if (platform === "win32") {
    reposPath = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "GitHub Desktop",
      "repositories.json",
    );
  } else if (platform === "darwin") {
    reposPath = path.join(
      home,
      "Library",
      "Application Support",
      "GitHub Desktop",
      "repositories.json",
    );
  } else {
    reposPath = path.join(
      home,
      ".config",
      "GitHub Desktop",
      "repositories.json",
    );
  }

  try {
    if (!(await fileExists(reposPath))) return [];

    const content = await fs.readFile(reposPath, "utf-8");
    const repos: GHDesktopRepo[] = JSON.parse(content);

    return repos.filter((r) => r.path && !r.missing).map((r) => r.path!);
  } catch {
    log("GitHub Desktop repos not found, skipping");
    return [];
  }
};

// ---------------------------------------------------------------------------
// Source 3: JetBrains Recent Projects
// ---------------------------------------------------------------------------

const JETBRAINS_IDES = [
  "IntelliJIdea",
  "WebStorm",
  "PyCharm",
  "Rider",
  "GoLand",
  "CLion",
  "RubyMine",
  "PhpStorm",
  "DataGrip",
  "RustRover",
];

const collectFromJetBrains = async (): Promise<string[]> => {
  const home = os.homedir();
  const platform = process.platform;

  let configBase: string;
  if (platform === "win32") {
    configBase = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "JetBrains",
    );
  } else if (platform === "darwin") {
    configBase = path.join(home, "Library", "Application Support", "JetBrains");
  } else {
    configBase = path.join(home, ".config", "JetBrains");
  }

  if (!(await fileExists(configBase))) return [];

  const results: string[] = [];

  try {
    const entries = await fs.readdir(configBase, { withFileTypes: true });

    const ideDirs = entries.filter(
      (e) =>
        e.isDirectory() && JETBRAINS_IDES.some((ide) => e.name.startsWith(ide)),
    );

    for (const ideDir of ideDirs) {
      const recentPath = path.join(
        configBase,
        ideDir.name,
        "options",
        "recentProjects.xml",
      );

      try {
        if (!(await fileExists(recentPath))) continue;

        const content = await fs.readFile(recentPath, "utf-8");
        const pathMatches = content.matchAll(/key="([^"]+)"/g);
        for (const match of pathMatches) {
          let projectPath = match[1];
          projectPath = projectPath.replace(/\$USER_HOME\$/g, home);
          projectPath = projectPath.replace(/\//g, path.sep);

          if (projectPath && !projectPath.includes("$")) {
            results.push(projectPath);
          }
        }
      } catch {
        // Can't read this IDE's recent projects, skip.
      }
    }
  } catch {
    log("JetBrains config not found, skipping");
  }

  return results;
};

// ---------------------------------------------------------------------------
// Source 4: VS Code / Cursor state
// ---------------------------------------------------------------------------

const getEditorConfigs = (): { name: string; dbPath: string }[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    return [
      {
        name: "cursor",
        dbPath: path.join(
          home,
          "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
        ),
      },
      {
        name: "vscode",
        dbPath: path.join(
          home,
          "AppData/Roaming/Code/User/globalStorage/state.vscdb",
        ),
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        name: "cursor",
        dbPath: path.join(
          home,
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        ),
      },
      {
        name: "vscode",
        dbPath: path.join(
          home,
          "Library/Application Support/Code/User/globalStorage/state.vscdb",
        ),
      },
    ];
  }

  return [
    {
      name: "cursor",
      dbPath: path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    },
    {
      name: "vscode",
      dbPath: path.join(home, ".config/Code/User/globalStorage/state.vscdb"),
    },
  ];
};

const parseEditorRecentWorkspaces = (raw: string): EditorWorkspace[] => {
  try {
    const data = JSON.parse(raw);
    const entries: Array<{
      folderUri?: string;
      fileUri?: string;
    }> = data.entries ?? [];

    return entries
      .map((entry) => entry.folderUri || entry.fileUri)
      .filter((value): value is string => Boolean(value))
      .map((workspacePath) => ({ path: workspacePath }));
  } catch {
    return [];
  }
};

const parseEditorTrackedRepos = (raw: string): EditorTrackedRepo[] => {
  try {
    const data = JSON.parse(raw) as Record<
      string,
      { localPath?: string; lastAccessed?: number }
    >;

    return Object.values(data)
      .filter((value) => value.localPath)
      .map((value) => ({
        path: value.localPath!,
        lastAccessed: value.lastAccessed,
      }))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  } catch {
    return [];
  }
};

const collectFromEditorsEffect = (
  candidates: Map<string, ProjectCandidate>,
): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    let count = 0;
    const { Database } = yield* tryDiscovery(() => import("bun:sqlite"));

    for (const config of getEditorConfigs()) {
      if (!(yield* tryDiscovery(() => fileExists(config.dbPath)))) continue;

      yield* Effect.scoped(
        Effect.gen(function* () {
          // Read the live DB directly via an immutable URI: editors hold a WAL
          // lock on state.vscdb while running; immutable skips locking.
          const db = yield* Effect.acquireRelease(
            tryDiscoverySync(() => {
              const uri = `${pathToFileURL(config.dbPath).href}?immutable=1`;
              return new Database(uri, { readonly: true }) as SqliteDatabase;
            }),
            (openDb) => Effect.sync(() => openDb.close()),
          );

          yield* tryDiscoverySync(() => {
            const getKey = (key: string): string | null => {
              const row = db
                .query("SELECT value FROM ItemTable WHERE key = ?")
                .get(key) as { value: Buffer | string } | undefined;
              if (!row) return null;
              return typeof row.value === "string"
                ? row.value
                : Buffer.from(row.value).toString("utf-8");
            };

            const recentRaw = getKey("history.recentlyOpenedPathsList");
            const recentWorkspaces = recentRaw
              ? parseEditorRecentWorkspaces(recentRaw)
              : [];
            for (const workspace of recentWorkspaces) {
              addCandidate(candidates, workspace.path, `${config.name}-recent`, 6);
              count += 1;
            }

            const trackerRaw = getKey("repositoryTracker.paths");
            const trackedRepos = trackerRaw
              ? parseEditorTrackedRepos(trackerRaw)
              : [];
            for (const repo of trackedRepos) {
              const lastAccessed = repo.lastAccessed;
              const age = lastAccessed ? daysAgo(lastAccessed) : null;
              const weight = age === null ? 4 : age <= 7 ? 8 : age <= 30 ? 6 : 3;
              addCandidate(
                candidates,
                repo.path,
                `${config.name}-repo-tracker`,
                weight,
                lastAccessed ? { editorLastAccessed: lastAccessed } : undefined,
              );
              count += 1;
            }
          });
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log(`Failed to read ${config.name} editor state:`, error);
          }),
        ),
      );
    }

    return count;
  });

// ---------------------------------------------------------------------------
// Shallow project roots
// ---------------------------------------------------------------------------

const shouldSkipScanDir = (name: string): boolean =>
  name.startsWith(".") ||
  [
    "node_modules",
    "Library",
    "Applications",
    "Downloads",
    "Desktop",
    "Documents",
    "Pictures",
    "Movies",
    "Music",
  ].includes(name);

const collectFromCommonDevRoots = async (
  candidates: Map<string, ProjectCandidate>,
): Promise<number> => {
  const home = os.homedir();
  const roots = COMMON_DEV_ROOT_NAMES.map((name) => path.join(home, name));
  let visitedDirs = 0;
  let reposFound = 0;

  for (const root of roots) {
    if (!(await fileExists(root))) continue;

    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (visitedDirs >= DEV_ROOT_SCAN_MAX_DIRS) return reposFound;
      if (reposFound >= DEV_ROOT_SCAN_MAX_REPOS) return reposFound;

      const current = queue.shift()!;
      visitedDirs += 1;

      if (await fileExists(path.join(current.dir, ".git"))) {
        addCandidate(candidates, current.dir, "dev-root-scan", 2);
        reposFound += 1;
        continue;
      }

      if (current.depth >= DEV_ROOT_SCAN_MAX_DEPTH) continue;

      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipScanDir(entry.name)) continue;
        queue.push({
          dir: path.join(current.dir, entry.name),
          depth: current.depth + 1,
        });
      }
    }
  }

  return reposFound;
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const resolveCandidates = async (
  candidates: ProjectCandidate[],
): Promise<ResolvedProjectCandidate[]> => {
  const resolved = new Map<string, ResolvedProjectCandidate>();

  for (let i = 0; i < candidates.length; i += MAX_VALIDATION_BATCH_SIZE) {
    const batch = candidates.slice(i, i + MAX_VALIDATION_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => {
        const directory = await statIfExists(candidate.path);
        if (!directory?.isDirectory() || candidate.path === os.homedir() || !path.isAbsolute(candidate.path)) return null;
        const root = await resolveGitRoot(candidate.path) ?? await fs.realpath(candidate.path).catch(() => null);
        const canonical = root ? await fs.realpath(root).catch(() => null) : null;
        return canonical && canonical !== os.homedir() && canonical !== path.parse(canonical).root
          ? { candidate, root: canonical } : null;
      }),
    );

    for (const result of batchResults) {
      if (!result) continue;
      const key = candidateKey(result.root);
      const existing = resolved.get(key) ?? {
        path: result.root,
        sources: new Map<string, number>(),
      };

      for (const [source, weight] of result.candidate.sources.entries()) {
        existing.sources.set(
          source,
          (existing.sources.get(source) ?? 0) + weight,
        );
      }

      if (
        result.candidate.editorLastAccessed &&
        (!existing.editorLastAccessed ||
          result.candidate.editorLastAccessed > existing.editorLastAccessed)
      ) {
        existing.editorLastAccessed = result.candidate.editorLastAccessed;
      }

      existing.recentSessionCount = (existing.recentSessionCount ?? 0) + (result.candidate.recentSessionCount ?? 0);
      resolved.set(key, existing);
    }
  }

  return Array.from(resolved.values());
};

const scoreProject = async (
  project: ResolvedProjectCandidate,
): Promise<ScoredProject | null> => {
  const lastActivity = Math.max(
    (await getGitRepoActivity(project.path)) ?? 0,
    project.editorLastAccessed ?? 0,
  );
  if (lastActivity < Date.now() - RECENCY_DAYS * DAY_MS || lastActivity > Date.now()) return null;
  // Session counts are capped so one prolific tool cannot dominate forever.
  let score = Math.min(20, project.recentSessionCount ?? 0) * 4;
  for (const weight of project.sources.values()) score += Math.min(20, weight);
  return {
    name: path.basename(project.path), path: project.path, lastActivity,
    score, sourceSummary: sourceList(project.sources),
  };
};

const collectDevProjectsEffect: Effect.Effect<DevProject[], unknown> =
  Effect.gen(function* () {
    log("Starting dev projects discovery...");

    const candidates = new Map<string, ProjectCandidate>();

    const [
      spotlightPaths,
      ghDesktopPaths,
      jetbrainsPaths,
      editorCount,
      assistantProjects,
      devRootCount,
    ] = yield* Effect.all(
      [
        tryDiscovery(() => collectFromSpotlight()),
        tryDiscovery(() => collectFromGitHubDesktop()),
        tryDiscovery(() => collectFromJetBrains()),
        collectFromEditorsEffect(candidates).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log("Editor state collection failed:", error);
              return 0;
            }),
          ),
        ),
        tryDiscovery(() => collectAssistantProjects()),
        tryDiscovery(() =>
          collectFromCommonDevRoots(candidates).catch((error) => {
            log("Dev root scan failed:", error);
            return 0;
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );

  for (const project of assistantProjects) {
    addCandidate(candidates, project.path, project.source, project.activityCount,
      { editorLastAccessed: project.lastActivity, recentSessionCount: project.lastActivity ? project.activityCount : 0 });
  }
  for (const projectPath of spotlightPaths) {
    addCandidate(candidates, projectPath, "spotlight", 2);
  }
  for (const projectPath of ghDesktopPaths) {
    addCandidate(candidates, projectPath, "github-desktop", 4);
  }
  for (const projectPath of jetbrainsPaths) {
    addCandidate(candidates, projectPath, "jetbrains", 5);
  }

  log(
    [
      `Candidates: spotlight=${spotlightPaths.length}`,
      `github-desktop=${ghDesktopPaths.length}`,
      `jetbrains=${jetbrainsPaths.length}`,
      `editor=${editorCount}`,
      `assistant=${assistantProjects.length}`,
      `dev-root=${devRootCount}`,
    ].join(", "),
  );
  const candidateWeight = (candidate: ProjectCandidate): number => {
    let total = Math.min(20, candidate.recentSessionCount ?? 0) * 4;
    for (const weight of candidate.sources.values()) total += Math.min(20, weight);
    return total;
  };
  const candidatePaths = Array.from(candidates.values())
    .sort(
      (a, b) =>
        Number((b.editorLastAccessed ?? 0) >= Date.now() - RECENCY_DAYS * DAY_MS) -
          Number((a.editorLastAccessed ?? 0) >= Date.now() - RECENCY_DAYS * DAY_MS) ||
        candidateWeight(b) - candidateWeight(a) ||
        (b.editorLastAccessed ?? 0) - (a.editorLastAccessed ?? 0) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_CANDIDATE_PATHS);
  log(`${candidatePaths.length} unique candidate paths`);

  const resolved = yield* tryDiscovery(() => resolveCandidates(candidatePaths));
  log(`${resolved.length} project directories resolved from candidates`);

  const scored: ScoredProject[] = [];
  for (let i = 0; i < resolved.length; i += MAX_VALIDATION_BATCH_SIZE) {
    const batch = resolved.slice(i, i + MAX_VALIDATION_BATCH_SIZE);
    const batchResults = yield* Effect.forEach(
      batch,
      (project) => tryDiscovery(() => scoreProject(project)),
      { concurrency: "unbounded" },
    );
    for (const result of batchResults) {
      if (result) scored.push(result);
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.lastActivity - a.lastActivity ||
      a.path.localeCompare(b.path),
  );

  const limited = scored.slice(0, MAX_RESULTS).map(({ name, path, lastActivity }) => ({
    name, path, lastActivity,
  }));
  log(`Found ${limited.length} projects active in the last ${RECENCY_DAYS} days`);
  if (scored.length > 0) {
    log(
      "Top projects:",
      scored
        .slice(0, 8)
        .map(
          (project) =>
            `${project.name} score=${project.score} sources=${project.sourceSummary.join("+")}`,
        )
        .join("; "),
    );
  }

  return limited;
});

export const collectDevProjects = async (): Promise<DevProject[]> =>
  runDiscovery(collectDevProjectsEffect);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format dev projects for LLM synthesis.
 *
 * Projects are already sorted by confidence and activity from collection.
 * We cap at 8 for synthesis — enough to show active work, not so many that
 * stale projects dilute the signal.
 */
export const formatDevProjectsForSynthesis = (
  projects: DevProject[],
): string => {
  const recent = projects.filter((project) =>
    project.lastActivity >= Date.now() - RECENCY_DAYS * DAY_MS && project.lastActivity <= Date.now());
  if (recent.length === 0) return "";

  const sections: string[] = ["## Active Projects"];

  sections.push(
    "\n" +
      recent
        .slice(0, MAX_RESULTS)
        .map((p) => {
          const age = daysAgo(p.lastActivity);
          const recency =
            age === 0 ? "today" : age === 1 ? "yesterday" : `${age}d ago`;
          return `- ${p.name} (${p.path}) (${recency})`;
        })
        .join("\n"),
  );

  return sections.join("\n");
};
