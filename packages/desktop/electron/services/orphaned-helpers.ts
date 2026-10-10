import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { terminateProcessTree } from "@stella/runtime/kernel/shared/process-tree";
import { nativeHelperDirectories } from "../native-helper-path.js";
import { getMainLogger } from "../observability/main-logger.js";

/**
 * Helpers a previous Stella left running when it was killed without a chance
 * to stop them (a crash, a force quit). Quit stops them; this is the sweep
 * for everything else, run once at launch.
 *
 * An orphan is a helper whose parent is gone: on macOS and Linux it has been
 * handed to init (pid 1) or, on Linux, a session subreaper such as
 * `systemd --user`; on Windows its recorded parent no longer runs. A helper
 * whose parent still runs belongs to a live Stella (this one, or another
 * instance) and is left alone.
 */

const execFileAsync = promisify(execFile);

type ProcessRow = { pid: number; ppid: number; command: string };

const LIST_TIMEOUT_MS = 3_000;
const SUBREAPER_COMMAND = /(^|\/)systemd(\s|$)/;

const listPosixProcesses = async (): Promise<ProcessRow[]> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: LIST_TIMEOUT_MS,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]!,
    });
  }
  return rows;
};

const isOrphanedPosix = (row: ProcessRow, byPid: Map<number, ProcessRow>) => {
  if (row.ppid === 1) return true;
  if (process.platform !== "linux") return false;
  const parent = byPid.get(row.ppid);
  return !parent || SUBREAPER_COMMAND.test(parent.command);
};

const startsWithDirectory = (command: string, directory: string) =>
  command.startsWith(`${directory}${path.sep}`);

const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Orphaned processes whose executable lives in one of `directories`. */
export const findOrphanedProcessesIn = async (
  directories: readonly string[],
): Promise<number[]> => {
  const roots = [...new Set(directories.map((directory) => path.resolve(directory)))].filter(
    (directory) => existsSync(directory),
  );
  if (roots.length === 0) return [];
  try {
    if (process.platform === "win32") {
      const query = [
        `$roots = @(${roots.map(quotePowerShell).join(", ")})`,
        [
          "Get-CimInstance Win32_Process",
          "| Where-Object { $path = $_.ExecutablePath; $path -and $_.ProcessId -ne $PID -and ($roots | Where-Object { $path.StartsWith($_ + '\\', [System.StringComparison]::OrdinalIgnoreCase) }) }",
          "| Where-Object { $_.CommandLine -notlike '*chrome-extension://*' }",
          "| Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }",
          "| Select-Object -ExpandProperty ProcessId -Unique",
        ].join(" "),
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", query],
        { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      return stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    }
    const rows = await listPosixProcesses();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    return rows
      .filter(
        (row) =>
          row.pid !== process.pid &&
          roots.some((root) => startsWithDirectory(row.command, root)) &&
          isOrphanedPosix(row, byPid),
      )
      .map((row) => row.pid);
  } catch {
    return [];
  }
};

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

/** End each process and everything it started, TERM before KILL. */
export const terminateOrphans = async (pids: readonly number[]) => {
  await Promise.all(
    pids.map((pid) =>
      terminateProcessTree(pid, { isRootRunning: () => isPidAlive(pid) }),
    ),
  );
};

const parseElapsedSeconds = (value: string): number | null => {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
};

/**
 * Electron's crash reporter starts a `chrome_crashpad_handler` per launch
 * that does not exit with the app on macOS, so one piles up per run. Only
 * the handler this process started is live: any handler writing to this
 * app's crash database that started before this process is stale.
 */
const findStaleCrashpadHandlers = async (): Promise<number[]> => {
  if (process.platform === "win32") return [];
  let database: string;
  try {
    database = app.getPath("crashDumps");
  } catch {
    return [];
  }
  const fold = (value: string) =>
    process.platform === "darwin" ? value.toLowerCase() : value;
  const flag = fold(`--database=${database}`);
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,etime=,command="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: LIST_TIMEOUT_MS,
    });
    const ownAgeSeconds = process.uptime();
    const stale: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const command = fold(match[3]!);
      if (!command.includes("chrome_crashpad_handler")) continue;
      const at = command.indexOf(flag);
      if (at < 0) continue;
      const next = command.charAt(at + flag.length);
      if (next !== "" && next !== " ") continue;
      const age = parseElapsedSeconds(match[2]!);
      if (age === null || age <= ownAgeSeconds + 2) continue;
      stale.push(Number(match[1]));
    }
    return stale;
  } catch {
    return [];
  }
};

/**
 * Stop what a killed Stella left behind: orphaned native helpers (computer
 * use, meeting capture, wakeword, window queries), orphaned browser service
 * daemons, and stale crash-reporter handlers. Best effort and bounded by the
 * process-tree terminator's own deadlines.
 */
export const sweepOrphanedHelpers = async (options: {
  browserBinaryDirectories: readonly string[];
}) => {
  const [helpers, crashpad] = await Promise.all([
    findOrphanedProcessesIn([
      ...nativeHelperDirectories(),
      ...options.browserBinaryDirectories,
    ]),
    findStaleCrashpadHandlers(),
  ]);
  const pids = [...new Set([...helpers, ...crashpad])];
  if (pids.length === 0) return;
  await terminateOrphans(pids);
  getMainLogger()?.process("startup.orphaned-helpers-stopped", {
    helpers: helpers.length,
    crashpadHandlers: crashpad.length,
  });
};
