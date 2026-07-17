import { execFile } from "node:child_process";
import { Effect, Schedule } from "effect";

/**
 * SIGTERM→grace→SIGKILL kill ladder, expressed as one effect per pid with
 * the pid-liveness polls as explicit Schedules (50ms spacing bounded by the
 * grace budget). Result shape and timing are identical to the old
 * hand-rolled ladder: `stopped` is only true once the pid is confirmed
 * dead, and `escalatedToSigkill` feeds restart-grace instrumentation.
 */

const ALIVE_POLL_INTERVAL_MS = 50;
const SIGKILL_CONFIRM_BUDGET_MS = 1_000;

export type KillResult = { stopped: boolean; escalatedToSigkill: boolean };

class StillAliveError {
  readonly _tag = "StillAliveError";
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until the pid is gone; fails StillAliveError when the budget ends. */
const waitForPidExit = (
  pid: number,
  budgetMs: number,
): Effect.Effect<boolean> =>
  Effect.suspend(() =>
    pidIsAlive(pid)
      ? Effect.fail(new StillAliveError())
      : Effect.succeed(true),
  ).pipe(
    Effect.retry({
      while: (error) => error instanceof StillAliveError,
      schedule: Schedule.both(
        Schedule.spaced(ALIVE_POLL_INTERVAL_MS),
        Schedule.during(budgetMs),
      ),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * SIGTERM a worker pid, poll up to `graceMs` for a clean exit, then SIGKILL
 * and confirm the pid is actually dead before returning. The single shared
 * implementation behind both `stopPids` (orphan reaping) and
 * `stopRunningWorker` (restart/teardown) — callers differ only in their
 * grace budget.
 */
export const killWorkerProcess = (
  pid: number,
  graceMs: number,
): Effect.Effect<KillResult> =>
  Effect.gen(function* () {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // SIGTERM failed: the pid is already gone (or not ours).
      return { stopped: false, escalatedToSigkill: false };
    }
    if (yield* waitForPidExit(pid, graceMs)) {
      return { stopped: true, escalatedToSigkill: false };
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return { stopped: true, escalatedToSigkill: true };
    }
    if (yield* waitForPidExit(pid, SIGKILL_CONFIRM_BUDGET_MS)) {
      return { stopped: true, escalatedToSigkill: true };
    }
    // SIGKILL was sent but the pid never confirmed dead within the budget.
    // Report stopped:false so `worker.kill-latency` doesn't misreport a
    // failed kill as a clean stop.
    return { stopped: false, escalatedToSigkill: true };
  });

/**
 * Each pid runs its own SIGTERM→grace→SIGKILL concurrently, so the batch
 * wall-clock is the slowest single exit rather than the sum.
 */
export const stopPids = (
  pids: number[],
  graceMs = 750,
): Effect.Effect<void> =>
  pids.length === 0
    ? Effect.void
    : Effect.forEach(pids, (pid) => killWorkerProcess(pid, graceMs), {
        concurrency: "unbounded",
        discard: true,
      });

/**
 * Enumerate live worker pids whose command line matches this exact worker
 * entry AND stella root — the guard against reaping an unrelated process
 * that recycled a stale pidfile's pid. Plain process-table scan (ps /
 * PowerShell CIM), resolving [] on any scan failure.
 */
export const findSameRootWorkerPids = async (
  workerEntryPath: string,
  stellaAppDir: string,
): Promise<number[]> => {
  if (process.platform === "win32") {
    const powerShellLiteral = (value: string) =>
      `'${value.replace(/'/g, "''")}'`;
    const uniquePathVariants = (value: string) =>
      [value, value.replace(/\//g, "\\"), value.replace(/\\/g, "/")].filter(
        (entry, index, list) => entry && list.indexOf(entry) === index,
      );
    const powerShellArray = (values: string[]) =>
      `@(${values.map(powerShellLiteral).join(",")})`;
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$entries = ${powerShellArray(uniquePathVariants(workerEntryPath))}`,
      `$roots = ${powerShellArray(uniquePathVariants(stellaAppDir))}`,
      `$currentPid = ${process.pid}`,
      "$stellaPids = @()",
      "$processes = Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--stella-root%'\"",
      "foreach ($proc in $processes) {",
      "  $line = [string]$proc.CommandLine",
      "  if (-not $line -or [int]$proc.ProcessId -eq $currentPid) { continue }",
      "  $entryMatch = $false",
      "  foreach ($entry in $entries) { if ($line.Contains($entry)) { $entryMatch = $true; break } }",
      "  if (-not $entryMatch) { continue }",
      "  $rootMatch = $false",
      "  foreach ($root in $roots) { if ($line.Contains('--stella-root') -and $line.Contains($root)) { $rootMatch = $true; break } }",
      "  if ($rootMatch) { $stellaPids += [int]$proc.ProcessId }",
      "}",
      "$stellaPids | ConvertTo-Json -Compress",
    ].join("; ");
    const output = await new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          resolve(error ? "" : stdout);
        },
      );
    });
    const raw = output.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values
        .map((value) =>
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN,
        )
        .filter(
          (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
        );
    } catch {
      return [];
    }
  }
  const psOutput = await new Promise<string>((resolve) => {
    execFile("ps", ["-axo", "pid=,args="], (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const args = match[2] ?? "";
    if (
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      args.includes(workerEntryPath) &&
      (args.includes(`--stella-root ${stellaAppDir}`) ||
        args.includes(`--stella-root=${stellaAppDir}`))
    ) {
      pids.push(pid);
    }
  }
  return pids;
};
