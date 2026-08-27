import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

const TERM_GRACE_MS = 150;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const readPidFile = (filePath: string): number | null => {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {

    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const pidMatchesHelperBinary = (
  pid: number,
  helperBinaryPath: string,
  expectedCommandFragments: readonly string[] = [],
): boolean => {
  if (!Number.isFinite(pid) || pid <= 0 || !helperBinaryPath) {
    return false;
  }
  const baseName = path.basename(helperBinaryPath);
  if (!baseName) {
    return false;
  }

  const stem = baseName.replace(/\.[^.]+$/, "");
  const requiredFragments = expectedCommandFragments.filter(Boolean);

  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "tasklist.exe",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 2000 },
      );

      const row = output
        .split(/\r?\n/)
        .find((line) => line.startsWith('"'));
      const imageName = row ? /^"([^"]*)"/.exec(row)?.[1] : undefined;
      if (!imageName) {
        return false;
      }
      const imageStem = imageName.replace(/\.[^.]+$/, "");
      return imageStem.toLowerCase() === stem.toLowerCase();
    }

    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 4000,
    });
    const command = output.trim();
    if (!command) {
      return false;
    }
    return (
      command.includes(helperBinaryPath) &&
      requiredFragments.every((fragment) => command.includes(fragment))
    );
  } catch {

    return false;
  }
};

export async function reapPidfileDaemon(
  pidFile: string,
  helperBinaryPath: string | null,
  expectedCommandFragments: readonly string[],
): Promise<void> {
  const pid = readPidFile(pidFile);
  if (
    pid !== null &&
    isProcessAlive(pid) &&
    helperBinaryPath !== null &&
    pidMatchesHelperBinary(pid, helperBinaryPath, expectedCommandFragments)
  ) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {

    }
    await sleep(TERM_GRACE_MS);
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {

      }
    }
  }
  try {
    await fs.rm(pidFile, { force: true });
  } catch {

  }
}
