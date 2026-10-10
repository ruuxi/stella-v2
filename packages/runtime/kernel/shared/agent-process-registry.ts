import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { terminateProcessTree } from "./process-tree.js";

/**
 * Agent CLIs (Claude Code) run as children of the runtime worker. When the
 * worker dies they must die too: an orphaned CLI keeps working, editing
 * files, with nobody reading its output. Two lanes guarantee it.
 *
 * - The worker kills every tracked CLI's process group as it exits.
 * - Each live CLI is recorded on disk with its start-time identity, so a
 *   worker that died without running exit handlers (SIGKILL, OOM, a native
 *   crash) has its leftovers reaped by the next worker before it serves.
 */

export type AgentProcessRecord = {
  pid: number;
  label: string;
  command: string;
  startedAt: number;
  /** Kernel start time (Linux) or `ps lstart` (macOS); guards pid reuse. */
  identity: string | null;
  /** The CLI leads its own process group, so its tools die with it. */
  processGroup: boolean;
};

const live = new Map<number, AgentProcessRecord>();
let registryFile: string | null = null;

const readProcessIdentity = (pid: number): string | null => {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    }
    if (process.platform === "win32") return null;
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started || null;
  } catch {
    return null;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

const persist = () => {
  if (!registryFile) return;
  try {
    if (live.size === 0) {
      rmSync(registryFile, { force: true });
      return;
    }
    mkdirSync(path.dirname(registryFile), { recursive: true });
    const temp = `${registryFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify([...live.values()]), { mode: 0o600 });
    renameSync(temp, registryFile);
  } catch {
    // The exit lane still covers this process; only the restart lane is lost.
  }
};

/** Where this worker records its agent CLIs. Call once, after reaping. */
export const configureAgentProcessRegistry = (file: string): void => {
  registryFile = file;
  persist();
};

export const trackAgentProcess = (
  child: ChildProcess,
  label: string,
  options: { processGroup: boolean },
): void => {
  const pid = child.pid;
  if (!pid) return;
  const record: AgentProcessRecord = {
    pid,
    label,
    command: child.spawnfile,
    startedAt: Date.now(),
    identity: readProcessIdentity(pid),
    processGroup: options.processGroup && process.platform !== "win32",
  };
  live.set(pid, record);
  persist();
  child.once("exit", () => {
    if (live.get(pid) !== record) return;
    live.delete(pid);
    persist();
  });
};

/** The tracked CLIs, for crash and warning context. */
export const describeAgentProcesses = (): Array<{
  pid: number;
  label: string;
  alive: boolean;
}> =>
  [...live.values()].map((record) => ({
    pid: record.pid,
    label: record.label,
    alive: isAlive(record.pid),
  }));

/**
 * Synchronous so it can run from `process.on("exit")`: signal every tracked
 * CLI (its whole group when it leads one) and forget it.
 */
export const killAgentProcessesSync = (
  signal: NodeJS.Signals = "SIGKILL",
): number => {
  let signalled = 0;
  for (const record of live.values()) {
    try {
      process.kill(record.processGroup ? -record.pid : record.pid, signal);
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  live.clear();
  persist();
  return signalled;
};

/**
 * Read and clear what a previous worker left in `file`. Only processes still
 * alive with the same start-time identity are returned, so a recycled pid is
 * never touched.
 */
export const takeOrphanedAgentProcesses = (
  file: string,
): AgentProcessRecord[] => {
  let records: AgentProcessRecord[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) records = parsed as AgentProcessRecord[];
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  return records.filter(
    (record) =>
      Number.isInteger(record?.pid) &&
      record.pid > 1 &&
      record.pid !== process.pid &&
      typeof record.identity === "string" &&
      isAlive(record.pid) &&
      readProcessIdentity(record.pid) === record.identity,
  );
};

export const reapAgentProcesses = async (
  records: readonly AgentProcessRecord[],
): Promise<void> => {
  await Promise.all(
    records.map((record) =>
      record.processGroup
        ? terminateProcessTree(record.pid, {
            isRootRunning: () => isAlive(record.pid),
          })
        : Promise.resolve().then(() => {
            try {
              process.kill(record.pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }),
    ),
  );
};
