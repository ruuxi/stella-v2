/**
 * Terminate a spawned process together with everything it started.
 *
 * POSIX: the root is expected to lead its own process group (spawned with
 * `detached: true`). The group is frozen and the process table read before
 * any termination signal, so descendants that left the group (setsid,
 * daemons) are still reached by their parent links. The group itself is
 * signalled and checked on its own: an exited root does not end cleanup
 * while group members survive.
 *
 * Windows: there are no process groups. While the root is alive,
 * `taskkill /T` walks its tree. Once the root has exited its children are
 * orphaned, so they are found by their recorded parent pid and killed as
 * their own trees.
 *
 * Promise-returning so both the Electron main process and the runtime tool
 * host can await it.
 */

import { execFile } from "node:child_process";
import { Effect } from "effect";

export type TerminateProcessTreeOptions = {
  /** Whether the root process itself is still running. */
  isRootRunning: () => boolean;
  graceSignal?: NodeJS.Signals;
  /** How long survivors get after the grace signal before SIGKILL. */
  forceAfterMs?: number;
};

type ProcessRow = { pid: number; ppid: number; pgid: number };

const POLL_INTERVAL_MS = 50;
const SIGKILL_CONFIRM_MS = 500;
const LIST_TIMEOUT_MS = 2_000;
const WINDOWS_LIST_TIMEOUT_MS = 4_000;
const TASKKILL_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => Effect.runPromise(Effect.sleep(ms));

const signalTarget = (target: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

const isPidAlive = (pid: number) => signalTarget(pid, 0);

const isGroupAlive = (pgid: number) =>
  process.platform !== "win32" && signalTarget(-pgid, 0);

const execText = (
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout ?? "") });
      },
    );
  });

const parseRows = (stdout: string, columns: number): number[][] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (fields) =>
        fields.length >= columns &&
        fields.slice(0, columns).every((value) => Number.isInteger(value)),
    );

const listPosixProcesses = async (): Promise<ProcessRow[] | null> => {
  const result = await execText(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
    LIST_TIMEOUT_MS,
  );
  if (!result.ok) return null;
  return parseRows(result.stdout, 3).map(([pid, ppid, pgid]) => ({
    pid: pid!,
    ppid: ppid!,
    pgid: pgid!,
  }));
};

const listWindowsProcesses = async (): Promise<ProcessRow[] | null> => {
  const result = await execText(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    WINDOWS_LIST_TIMEOUT_MS,
  );
  if (!result.ok) return null;
  return parseRows(result.stdout, 2).map(([pid, ppid]) => ({
    pid: pid!,
    ppid: ppid!,
    pgid: 0,
  }));
};

const childrenByParent = (rows: ProcessRow[]) => {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return children;
};

const collectDescendants = (rows: ProcessRow[], parents: number[]) => {
  const children = childrenByParent(rows);
  const found = new Set<number>();
  const queue = [...parents];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
};

const terminatePosixTree = async (
  rootPid: number,
  options: Required<TerminateProcessTreeOptions>,
) => {
  if (!options.isRootRunning() && !isGroupAlive(rootPid)) return;

  const targets = new Set<number>();
  const collectTargets = async () => {
    const rows = await listPosixProcesses();
    if (!rows) return;
    const parents = [...targets].filter(isPidAlive);
    if (options.isRootRunning()) parents.push(rootPid);
    for (const pid of collectDescendants(rows, parents)) targets.add(pid);
    const groups = new Set([rootPid, ...targets]);
    for (const row of rows) {
      if (groups.has(row.pgid)) targets.add(row.pid);
    }
    targets.delete(rootPid);
    targets.delete(process.pid);
  };

  const signalAll = (signal: NodeJS.Signals) => {
    signalTarget(-rootPid, signal);
    if (options.isRootRunning()) signalTarget(rootPid, signal);
    for (const pid of targets) {
      if (isPidAlive(pid)) signalTarget(pid, signal);
    }
  };
  const anyAlive = () =>
    options.isRootRunning() ||
    isGroupAlive(rootPid) ||
    [...targets].some(isPidAlive);

  const waitUntilGone = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (anyAlive()) {
      if (Date.now() >= deadline) return false;
      await sleep(POLL_INTERVAL_MS);
    }
    return true;
  };

  // Freeze the group before reading the process table, so nothing in it can
  // fork (and escape with setsid) between the snapshot and the signal.
  signalTarget(-rootPid, "SIGSTOP");
  await collectTargets();
  signalAll("SIGSTOP");

  if (options.graceSignal !== "SIGKILL") {
    signalAll(options.graceSignal);
    signalAll("SIGCONT");
    if (await waitUntilGone(options.forceAfterMs)) return;
    await collectTargets();
  }
  signalAll("SIGKILL");
  await waitUntilGone(SIGKILL_CONFIRM_MS);
};

const taskkillTree = async (pid: number, force: boolean) => {
  const args = ["/pid", String(pid), "/T"];
  if (force) args.push("/F");
  const result = await execText("taskkill", args, TASKKILL_TIMEOUT_MS);
  return result.ok;
};

const killWindowsOrphans = async (rootPid: number) => {
  const rows = await listWindowsProcesses();
  if (!rows) return;
  if (rows.some((row) => row.pid === rootPid)) return;
  const orphans = rows.filter((row) => row.ppid === rootPid);
  await Promise.all(orphans.map((row) => taskkillTree(row.pid, true)));
};

const terminateWindowsTree = async (
  rootPid: number,
  options: Required<TerminateProcessTreeOptions>,
) => {
  const waitForRootExit = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (options.isRootRunning()) {
      if (Date.now() >= deadline) return false;
      await sleep(POLL_INTERVAL_MS);
    }
    return true;
  };

  if (options.isRootRunning()) {
    if (options.graceSignal !== "SIGKILL") {
      const delivered = await taskkillTree(rootPid, false);
      if (delivered && (await waitForRootExit(options.forceAfterMs))) {
        await killWindowsOrphans(rootPid);
        return;
      }
    }
    if (options.isRootRunning()) {
      if (!(await taskkillTree(rootPid, true))) {
        signalTarget(rootPid, "SIGKILL");
      }
      if (await waitForRootExit(SIGKILL_CONFIRM_MS)) return;
    }
  }
  await killWindowsOrphans(rootPid);
};

export const terminateProcessTree = async (
  rootPid: number | undefined | null,
  options: TerminateProcessTreeOptions,
): Promise<void> => {
  if (!rootPid || rootPid <= 0 || rootPid === process.pid) return;
  const resolved: Required<TerminateProcessTreeOptions> = {
    graceSignal: options.graceSignal ?? "SIGTERM",
    forceAfterMs: options.forceAfterMs ?? 1_500,
    isRootRunning: options.isRootRunning,
  };
  try {
    if (process.platform === "win32") {
      await terminateWindowsTree(rootPid, resolved);
    } else {
      await terminatePosixTree(rootPid, resolved);
    }
  } catch {
    // Best-effort teardown; callers bound and log their own shutdown.
  }
};
