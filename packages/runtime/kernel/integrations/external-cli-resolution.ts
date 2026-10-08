import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExternalCli = "claude";

type ExternalCliConfig = {
  displayName: string;
  overrideEnvNames: readonly [string, string];
  toolDirectories: readonly string[];
};

const CLI_CONFIG: Record<ExternalCli, ExternalCliConfig> = {
  claude: {
    displayName: "Claude Code CLI",
    overrideEnvNames: ["STELLA_CLAUDE_CLI_PATH", "CLAUDE_CLI_PATH"],
    toolDirectories: [".claude/local", ".claude/bin"],
  },
};

export type ResolveExternalCliOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  /** Replaces the default well-known install directories (tests). */
  wellKnownDirectories?: readonly string[];
  /**
   * Reports a candidate executable's version string (`"2.1.293"`), or null
   * when it cannot be determined. Defaults to running `<cli> --version`.
   */
  probeVersion?: (executablePath: string) => string | null;
};

const resolveHomeDir = (
  env: NodeJS.ProcessEnv,
  configuredHome?: string,
): string | undefined => {
  const home =
    configuredHome?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    os.homedir().trim();
  return home ? path.resolve(home) : undefined;
};

const executableExtensions = (env: NodeJS.ProcessEnv): string[] => {
  if (process.platform !== "win32") return [""];
  const extensions = (env.PATHEXT ?? env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return ["", ...extensions];
};

const executableCandidates = (
  basePath: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (process.platform !== "win32" || path.extname(basePath)) {
    return [basePath];
  }
  return executableExtensions(env).map((extension) =>
    extension ? `${basePath}${extension}` : basePath,
  );
};

const isExecutableFile = (candidate: string): boolean => {
  try {
    fs.accessSync(
      candidate,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const firstExecutable = (
  basePath: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  for (const candidate of executableCandidates(basePath, env)) {
    const absoluteCandidate = path.resolve(candidate);
    if (isExecutableFile(absoluteCandidate)) return absoluteCandidate;
  }
  return null;
};

const pathValue = (env: NodeJS.ProcessEnv): string => {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? (env[pathKey] ?? "") : "";
};

const findAllOnPath = (
  cli: ExternalCli,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] => {
  const found: string[] = [];
  for (const entry of pathValue(env).split(path.delimiter)) {
    if (!entry) continue;
    const directory = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    const executable = firstExecutable(path.join(directory, cli), env);
    if (executable) found.push(executable);
  }
  return found;
};

const defaultWellKnownDirectories = (
  cli: ExternalCli,
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): string[] => {
  const directories: string[] = [];
  const add = (directory: string | undefined) => {
    if (directory) directories.push(path.resolve(directory));
  };

  if (homeDir) {
    // The CLI's own install locations come first, then its vendor
    // installer's directory (~/.local/bin for Claude Code), and only then
    // package-manager global bins such as ~/.bun/bin, whose copies are
    // installed once and rarely updated.
    for (const relativeDirectory of CLI_CONFIG[cli].toolDirectories) {
      add(path.join(homeDir, relativeDirectory));
    }
    add(path.join(homeDir, ".local", "bin"));
    add(path.join(homeDir, ".bun", "bin"));
    add(path.join(homeDir, ".npm-global", "bin"));
    add(path.join(homeDir, ".npm", "bin"));
    add(path.join(homeDir, ".yarn", "bin"));
    add(path.join(homeDir, ".volta", "bin"));
    add(path.join(homeDir, ".local", "share", "pnpm"));
    add(path.join(homeDir, "Library", "pnpm"));
    if (process.platform === "win32") {
      add(path.join(homeDir, "scoop", "shims"));
    }
  }

  if (process.platform === "win32") {
    add(env.APPDATA ? path.join(env.APPDATA, "npm") : undefined);
    add(
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
        : undefined,
    );
  } else {
    if (process.platform === "darwin") add("/opt/homebrew/bin");
    add("/usr/local/bin");
    add("/home/linuxbrew/.linuxbrew/bin");
  }

  return [...new Set(directories)];
};

const expandConfiguredPath = (
  configuredPath: string,
  homeDir: string | undefined,
  cwd: string,
): string => {
  const expanded = homeDir
    ? configuredPath === "~"
      ? homeDir
      : /^~[\\/]/.test(configuredPath)
        ? path.join(homeDir, configuredPath.slice(2))
        : configuredPath
    : configuredPath;
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd, expanded);
};

type ParsedVersion = readonly [number, number, number];

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

const parseVersion = (
  value: string | null | undefined,
): ParsedVersion | null => {
  if (!value) return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareVersions = (left: ParsedVersion, right: ParsedVersion): number => {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Runs `<executable> --version` and returns the first semver-looking match. */
const probeExecutableVersion = (executablePath: string): string | null => {
  try {
    const result = spawnSync(executablePath, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.error) return null;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = VERSION_PATTERN.exec(output);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};

type VersionCacheEntry = {
  version: string | null;
  mtimeMs: number;
  size: number;
};

/**
 * Probing spawns the CLI, so remember each executable's answer keyed by its
 * real path and invalidate only when the file itself changes (an upgrade
 * rewrites it, which moves mtime/size).
 */
const versionCache = new Map<string, VersionCacheEntry>();

export const resetExternalCliResolutionCache = (): void => {
  versionCache.clear();
};

const realPathOf = (executablePath: string): string => {
  try {
    return fs.realpathSync(executablePath);
  } catch {
    return path.resolve(executablePath);
  }
};

const cachedVersion = (
  realPath: string,
  probe: (executablePath: string) => string | null,
): string | null => {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(realPath);
  } catch {
    stat = null;
  }
  const cached = versionCache.get(realPath);
  if (
    cached &&
    stat &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.version;
  }
  const version = probe(realPath);
  if (stat) {
    versionCache.set(realPath, {
      version,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  return version;
};

type ExecutableCandidate = {
  executable: string;
  realPath: string;
};

/**
 * Among every installed copy of the CLI, prefer the newest version. A copy
 * installed once by a package manager (bun, npm) and never updated must not
 * shadow the vendor installer's self-updating copy merely because of PATH
 * order; the discovery order only breaks ties.
 */
const pickNewestCandidate = (
  candidates: readonly ExecutableCandidate[],
  probe: (executablePath: string) => string | null,
): string => {
  if (candidates.length === 1) return candidates[0]!.executable;
  let best: { candidate: ExecutableCandidate; version: ParsedVersion | null } =
    { candidate: candidates[0]!, version: null };
  let first = true;
  for (const candidate of candidates) {
    const version = parseVersion(cachedVersion(candidate.realPath, probe));
    if (first) {
      best = { candidate, version };
      first = false;
      continue;
    }
    if (!version) continue;
    if (!best.version || compareVersions(version, best.version) > 0) {
      best = { candidate, version };
    }
  }
  return best.candidate.executable;
};

export const resolveExternalCliPath = (
  cli: ExternalCli,
  options: ResolveExternalCliOptions = {},
): string => {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDir = resolveHomeDir(env, options.homeDir);
  const config = CLI_CONFIG[cli];
  const probe = options.probeVersion ?? probeExecutableVersion;

  for (const envName of config.overrideEnvNames) {
    const configuredPath = env[envName]?.trim();
    if (!configuredPath) continue;
    const expandedPath = expandConfiguredPath(configuredPath, homeDir, cwd);
    const executable = firstExecutable(expandedPath, env);
    if (executable) return executable;
    throw new Error(
      `${config.displayName} path from ${envName} is not an executable file: ` +
        `"${expandedPath}". Update or unset ${envName}.`,
    );
  }

  const wellKnownDirectories = options.wellKnownDirectories
    ? options.wellKnownDirectories.map((directory) => path.resolve(directory))
    : defaultWellKnownDirectories(cli, env, homeDir);
  const pathHits = findAllOnPath(cli, env, cwd);
  // A PATH hit outside every known install directory is a deliberate
  // choice (a wrapper, a pinned build, a test double) and is honored as is.
  // Only when PATH lands in one of the package-manager/installer directories
  // is the choice an accident of PATH order worth second-guessing by version.
  const wellKnownSet = new Set(wellKnownDirectories);
  const firstPathHit = pathHits[0];
  if (firstPathHit && !wellKnownSet.has(path.dirname(firstPathHit))) {
    return firstPathHit;
  }
  const discovered = [
    ...pathHits,
    ...wellKnownDirectories.flatMap((directory) => {
      const executable = firstExecutable(path.join(directory, cli), env);
      return executable ? [executable] : [];
    }),
  ];
  const seenRealPaths = new Set<string>();
  const candidates: ExecutableCandidate[] = [];
  for (const executable of discovered) {
    const realPath = realPathOf(executable);
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);
    candidates.push({ executable, realPath });
  }
  if (candidates.length > 0) return pickNewestCandidate(candidates, probe);

  const [stellaOverride, genericOverride] = config.overrideEnvNames;
  const searched = wellKnownDirectories.map((directory) =>
    path.join(directory, cli),
  );
  throw new Error(
    `${config.displayName} executable was not found on PATH or in well-known ` +
      `install locations${searched.length ? ` (${searched.join(", ")})` : ""}. ` +
      `Install ${cli}, add it to PATH, or set ${stellaOverride} ` +
      `(or ${genericOverride}) to its absolute executable path.`,
  );
};

export const buildExternalCliChildEnv = (
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { cliBridgeSocketPath?: string },
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.STELLA_CLI_BRIDGE_SOCK;
  delete childEnv.STELLA_SITE_AUTH_TOKEN;
  delete childEnv.STELLA_NATIVE_OAUTH_BACKEND_AUTH_TOKEN;
  delete childEnv.STELLA_LLM_PROXY_TOKEN;
  delete childEnv.STELLA_AUTH_TOKEN;
  if (options?.cliBridgeSocketPath) {
    childEnv.STELLA_CLI_BRIDGE_SOCK = options.cliBridgeSocketPath;
  }
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const homeDir = resolveHomeDir(env);
  // The CLI's own directory leads so the child finds its siblings; the
  // user's PATH keeps its order; ~/.bun/bin is appended (not prepended) so
  // bun-installed CLIs stay reachable from a GUI launch without a stale
  // bun-installed copy shadowing anything the user put on PATH.
  const entries = [
    path.dirname(path.resolve(executablePath)),
    ...pathValue(env).split(path.delimiter).filter(Boolean),
    ...(homeDir ? [path.join(homeDir, ".bun", "bin")] : []),
  ];
  const seen = new Set<string>();
  const uniqueEntries = entries.filter((entry) => {
    const normalized =
      process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  childEnv[pathKey] = uniqueEntries.join(path.delimiter);
  if (process.platform !== "win32") {
    // CLIs find their config under HOME, and Claude Code on macOS names its
    // keychain item's account after USER: an app launched without them
    // would read the user's own CLI login as signed out.
    try {
      const user = os.userInfo();
      childEnv.HOME ||= user.homedir;
      // Bun reports "unknown" without a USER in its own environment.
      const username =
        user.username && user.username !== "unknown"
          ? user.username
          : path.basename(user.homedir || "");
      if (username) childEnv.USER ||= username;
    } catch {
      // No passwd entry: leave the environment as it is.
    }
  }
  return childEnv;
};
