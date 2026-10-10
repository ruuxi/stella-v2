import fs from "node:fs";
import path from "node:path";
import { resolveStatePath } from "../cli/shared.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";
import { getComputerExecutionEnv } from "./execution-context.js";

// Session state, pid bookkeeping, and argv helpers shared by the macOS
// (stella-computer-executor.ts) and Windows (cli/stella-computer-windows.ts)
// computer-use executors. Both keep per-session state under
// <state dir>/stella-computer/sessions/<session>/.

export const DEFAULT_COMPUTER_SESSION_ID = "manual";

const sessionPruneIntervalMs = 24 * 60 * 60 * 1000;
const sessionRetentionMs = 24 * 60 * 60 * 1000;

// Daemon pid files (relative to a session dir) that mark a session as live.
// macOS writes automation.pid; Windows writes windows-daemon/helper.pid.
const liveSessionPidFiles = [
  "automation.pid",
  path.join("windows-daemon", "helper.pid"),
];

export const computerStateDir = () =>
  path.join(resolveStatePath(getComputerExecutionEnv()), "stella-computer");

export const computerSessionsDir = () =>
  path.join(computerStateDir(), "sessions");

const pruneStatePath = () => path.join(computerStateDir(), "last-prune.json");

export const resolveComputerSessionId = (sessionOverride?: string | null) =>
  sanitizeStellaComputerSessionId(sessionOverride) ??
  sanitizeStellaComputerSessionId(
    getComputerExecutionEnv().STELLA_COMPUTER_SESSION,
  ) ??
  DEFAULT_COMPUTER_SESSION_ID;

export const readPidFile = (pidPath: string): number | null => {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const pidIsRunning = (pid: number | null | undefined) => {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * macOS kill hook: the desktop_automation daemon is spawned detached, so
 * SIGKILL its whole process group, falling back to the pid itself.
 */
export const killProcessGroup = (pid: number | null | undefined) => {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGKILL");
      return;
    }
  } catch {
    // fall through to direct pid kill
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore kill failures
  }
};

/** Windows kill hook: no process groups, SIGKILL the helper pid only. */
export const killProcess = (pid: number | null | undefined) => {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore stale pid files
  }
};

/** True when the native helper binary was rebuilt after the daemon started. */
export const helperNewerThanDaemon = (helperPath: string, pidPath: string) => {
  try {
    return fs.statSync(helperPath).mtimeMs > fs.statSync(pidPath).mtimeMs + 500;
  } catch {
    return false;
  }
};

const safeDirectoryEntries = (directory: string) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const latestMtimeMs = (targetPath: string): number => {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch {
    return 0;
  }
  let newest = stats.mtimeMs;
  if (stats.isDirectory()) {
    for (const entry of safeDirectoryEntries(targetPath)) {
      newest = Math.max(
        newest,
        latestMtimeMs(path.join(targetPath, entry.name)),
      );
    }
  }
  return newest;
};

export const readJsonFile = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

export const writeJsonAtomic = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
};

const pruneStaleEntries = (directory: string, nowMs: number) => {
  for (const entry of safeDirectoryEntries(directory)) {
    const entryPath = path.join(directory, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(entryPath).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs > sessionRetentionMs) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }
};

/**
 * At most once per day, remove sessions (other than the active one) that have
 * no live daemon and have not been touched within the retention window, then
 * sweep stale entries out of `generatedDirectories`.
 */
export const pruneComputerSessions = (
  activeSessionId: string,
  generatedDirectories: readonly string[] = [],
) => {
  const nowMs = Date.now();
  const previous = readJsonFile<{ prunedAtMs?: unknown }>(pruneStatePath());
  const lastPrunedAtMs =
    typeof previous?.prunedAtMs === "number" &&
    Number.isFinite(previous.prunedAtMs)
      ? previous.prunedAtMs
      : 0;
  if (nowMs - lastPrunedAtMs < sessionPruneIntervalMs) return;
  try {
    writeJsonAtomic(pruneStatePath(), { prunedAtMs: nowMs });
  } catch {
    // Without the marker every command would rescan; skip until it persists.
    return;
  }

  const sessionsDir = computerSessionsDir();
  for (const entry of safeDirectoryEntries(sessionsDir)) {
    if (!entry.isDirectory() || entry.name === activeSessionId) continue;
    const sessionPath = path.join(sessionsDir, entry.name);
    if (
      liveSessionPidFiles.some((pidFile) =>
        pidIsRunning(readPidFile(path.join(sessionPath, pidFile))),
      )
    ) {
      continue;
    }
    const newestMtime = latestMtimeMs(sessionPath);
    if (newestMtime > 0 && nowMs - newestMtime > sessionRetentionMs) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  for (const directory of generatedDirectories) {
    pruneStaleEntries(directory, nowMs);
  }
};

export const isTruthyEnv = (
  value: string | undefined,
  options: { acceptOn?: boolean } = {},
) =>
  typeof value === "string" &&
  (options.acceptOn ? /^(1|true|yes|on)$/i : /^(1|true|yes)$/i).test(
    value.trim(),
  );

/**
 * Remove `flag VALUE` / `flag=VALUE` from args. A bare flag followed by
 * nothing or another `--option` reports `missingValue`.
 */
export const stripOptionValue = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let value: string | null = null;
  let missingValue = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (current === flag) {
      const nextValue = args[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        missingValue = true;
      } else {
        value = nextValue;
        index += 1;
      }
      continue;
    }
    if (current.startsWith(`${flag}=`)) {
      value = current.slice(flag.length + 1);
      continue;
    }
    nextArgs.push(current);
  }

  return { value, args: nextArgs, missingValue };
};

/** Read `flag VALUE` / `flag=VALUE`; a following `--option` is not a value. */
export const getOptionValue = (args: string[], flag: string) => {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (current === flag) {
      const value = args[index + 1];
      return value && !value.startsWith("--") ? value : null;
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1);
    }
  }
  return null;
};

export const hasOption = (args: string[], flag: string) =>
  args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));

export const normalizeTargetKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

export const targetStatePathForKey = (targetsDir: string, key: string) =>
  path.join(targetsDir, key, "last-snapshot.json");

// Emit a "[stella-attach-image]" marker line that the runtime layer can
// detect when reading shell output to auto-attach the image as a vision
// content block to the next assistant turn. The line is also human-readable
// so it does no harm if the host doesn't auto-detect it. We include the
// width/height so callers can pre-budget vision token cost without a follow-
// up `Read` step.
export const formatScreenshotMarker = (input: {
  path?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  byteCount?: number | null;
  inline: boolean;
}) => {
  if (!input.path && !input.inline) return "";
  const dims =
    input.widthPx && input.heightPx
      ? ` ${input.widthPx}x${input.heightPx}`
      : "";
  const sizeKb = input.byteCount
    ? ` ${(input.byteCount / 1024).toFixed(0)}KB`
    : "";
  const inline = input.inline ? " inline=image/png" : "";
  if (input.path) {
    return `[stella-attach-image]${dims}${sizeKb}${inline} path=${JSON.stringify(input.path)}\n`;
  }
  return `[stella-attach-image]${dims}${sizeKb}${inline}\n`;
};
