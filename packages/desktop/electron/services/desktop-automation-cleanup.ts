import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { resolveStatePath } from "@stella/runtime/kernel/cli/shared";
import { resolveAutomationSocketPath } from "@stella/runtime/kernel/computer-use/automation-socket-paths";
import { resolveNativeHelperPath } from "../native-helper-path.js";

const stellaComputerStateRoot = () =>
  path.join(resolveStatePath(), "stella-computer");

const sessionsDir = (root: string) => path.join(root, "sessions");

const legacySocketsDir = (root: string) => path.join(root, "daemon-sockets");

const readPidFile = (filePath: string): number | null => {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {

      return true;
    }
    return false;
  }
};

const trySignal = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const parsePsRows = (
  output: string,
): Array<{
  pid: number;
  ppid: number;
  command: string;
}> =>
  output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1]!, 10),
        ppid: Number.parseInt(match[2]!, 10),
        command: match[3]!,
      };
    })
    .filter((row): row is { pid: number; ppid: number; command: string } =>
      Boolean(row && Number.isFinite(row.pid) && Number.isFinite(row.ppid)),
    );

const findOrphanedDesktopAutomationPids = (): number[] => {
  if (process.platform === "win32") return [];
  const helperPath = resolveNativeHelperPath("desktop_automation");
  if (!helperPath) return [];

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsRows(output)
      .filter(
        (row) =>
          row.pid !== process.pid &&
          row.ppid === 1 &&
          row.command.includes(helperPath) &&
          /\bdaemon\b/.test(row.command),
      )
      .map((row) => row.pid);
  } catch {
    return [];
  }
};

export const stopAllDesktopAutomationDaemons = async (): Promise<void> => {
  const root = stellaComputerStateRoot();
  const sessions = sessionsDir(root);

  const targetedPids = new Set<number>(findOrphanedDesktopAutomationPids());
  const pidFiles: string[] = [];
  const sessionNames: string[] = [];

  if (existsSync(sessions)) {
    let entries: string[];
    try {
      entries = readdirSync(sessions);
    } catch {
      entries = [];
    }

    for (const name of entries) {
      const sessionPath = path.join(sessions, name);
      let isDir = false;
      try {
        isDir = statSync(sessionPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      sessionNames.push(name);

      const sessionPidFiles = [
        path.join(sessionPath, "automation.pid"),
        path.join(sessionPath, "windows-daemon", "helper.pid"),
      ];
      for (const pidFile of sessionPidFiles) {
        const pid = readPidFile(pidFile);
        if (pid !== null && isProcessAlive(pid)) {
          targetedPids.add(pid);
        }
        if (existsSync(pidFile)) {
          pidFiles.push(pidFile);
        }
      }
    }
  }

  for (const pid of targetedPids) {
    trySignal(pid, "SIGTERM");
  }
  if (targetedPids.size > 0) {
    await sleep(150);
    for (const pid of targetedPids) {
      if (isProcessAlive(pid)) {
        trySignal(pid, "SIGKILL");
      }
    }
  }

  for (const pidFile of pidFiles) {
    rmSync(pidFile, { force: true });
    if (path.basename(path.dirname(pidFile)) === "windows-daemon") {
      rmSync(path.dirname(pidFile), { recursive: true, force: true });
    }
  }

  for (const name of sessionNames) {
    rmSync(resolveAutomationSocketPath(root, name), { force: true });
  }
  const legacySockets = legacySocketsDir(root);
  if (existsSync(legacySockets)) {
    let socketEntries: string[];
    try {
      socketEntries = readdirSync(legacySockets);
    } catch {
      return;
    }
    for (const entry of socketEntries) {
      if (!entry.endsWith(".sock")) continue;
      rmSync(path.join(legacySockets, entry), { force: true });
    }
  }
};
