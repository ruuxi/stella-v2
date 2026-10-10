import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveStatePath } from "../../cli/shared.js";
import {
  resolveNativeHelperPath,
  runNativeHelper,
} from "../../cli/native-helper.js";
import {
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../preferences/local-preferences.js";
import { forkCancelableTimeout } from "../effect-runtime.js";
import {
  abortableComputerDelay,
  getComputerExecutionEnv,
  writeComputerStderr,
  writeComputerStdout,
} from "../execution-context.js";
import {
  computerStateDir,
  getOptionValue,
  hasOption,
  isTruthyEnv,
  killProcessGroup,
  normalizeTargetKey,
} from "../session-fs.js";
import type { SnapshotDocument } from "./ax-format.js";
import {
  parseJson,
  runAutomationDaemonCommand,
  type AutomationHelperResult,
} from "./daemon.js";
import {
  locksDir,
  readSnapshotDocument,
  type SessionPaths,
} from "./session-paths.js";

// Cross-process serialization for argv commands (directory locks keyed by
// target app, the global HID, and the session), plus locked-screen computer
// use: the native authorization plug-in installer and the per-action unlock
// lease opened through the daemon.

type LockedUsePayload = {
  ok: boolean;
  enabled: boolean;
  installed?: boolean | null;
  active: boolean;
  locked: boolean;
  suppressedUntilManualUnlock: boolean;
  message: string;
  warnings: string[];
};

const defaultLockTimeoutMs = 30_000;
const staleLockTimeoutMs = 90_000;
const lockPollIntervalMs = 125;

const lockedUseLeaseDurationMs = 30_000;
const lockedUseInstallerTimeoutMs = 120_000;

const resolveStellaDataDir = () => resolveStatePath(getComputerExecutionEnv());

const fallbackStateLockKey = (statePath: string) => {
  const relative = path.relative(computerStateDir(), path.resolve(statePath));
  return `state-${normalizeTargetKey(relative || path.basename(statePath)) || "default"}`;
};

const snapshotLockKeys = (
  snapshot: SnapshotDocument | null,
  statePath: string,
) => {
  const keys: string[] = [];
  if (snapshot?.appName) {
    keys.push(`app-${normalizeTargetKey(snapshot.appName)}`);
  }
  if (snapshot?.bundleId) {
    keys.push(`bundle-${normalizeTargetKey(snapshot.bundleId)}`);
  }
  if (typeof snapshot?.pid === "number" && Number.isFinite(snapshot.pid)) {
    keys.push(`pid-${snapshot.pid}`);
  }
  return keys.length > 0 ? keys : [fallbackStateLockKey(statePath)];
};

export const resolveLockKeys = (
  command: string,
  args: string[],
  sessionPaths: SessionPaths,
) => {
  if (command === "list-apps") {
    return [];
  }

  const keys = new Set<string>();

  if (command === "snapshot") {
    const pidValue = getOptionValue(args, "--pid");
    const bundleId = getOptionValue(args, "--bundle-id");
    const appName = getOptionValue(args, "--app");

    if (pidValue) {
      keys.add(`pid-${pidValue}`);
    }
    if (bundleId) {
      keys.add(`bundle-${normalizeTargetKey(bundleId)}`);
    }
    if (appName) {
      keys.add(`app-${normalizeTargetKey(appName)}`);
    }
    if (keys.size === 0) {
      keys.add("frontmost-app");
    }
  } else {
    const statePath = getOptionValue(args, "--state") ?? sessionPaths.statePath;
    for (const key of snapshotLockKeys(
      readSnapshotDocument(statePath),
      statePath,
    )) {
      keys.add(key);
    }
  }

  if (
    command === "drag" ||
    command === "drag-element" ||
    command === "click-point" ||
    command === "type" ||
    command === "press" ||
    (command === "click" && hasOption(args, "--coordinate-fallback"))
  ) {
    keys.add("global-hid");
  }

  keys.add(`session-${sessionPaths.sessionId}`);

  return [...keys].sort();
};

const getLockTimeoutMs = () => {
  const parsed = Number(
    getComputerExecutionEnv().STELLA_COMPUTER_LOCK_TIMEOUT_MS,
  );
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return defaultLockTimeoutMs;
};

const sleep = abortableComputerDelay;

const acquireLock = async (key: string, sessionId: string) => {
  const lockPath = path.join(locksDir(), normalizeTargetKey(key) || "lock");
  const deadlineAt = Date.now() + getLockTimeoutMs();

  while (Date.now() <= deadlineAt) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,
            key,
            sessionId,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return () => {
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = fs.statSync(lockPath);
        if (Date.now() - stats.mtimeMs > staleLockTimeoutMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      await sleep(lockPollIntervalMs);
    }
  }

  throw new Error(`Timed out waiting for desktop automation lock: ${key}`);
};

export const acquireLocks = async (keys: string[], sessionId: string) => {
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      releases.push(await acquireLock(key, sessionId));
    }
    return () => {
      while (releases.length > 0) {
        const release = releases.pop();
        release?.();
      }
    };
  } catch (error) {
    while (releases.length > 0) {
      const release = releases.pop();
      release?.();
    }
    throw error;
  }
};

const readLockedUseEnabled = () => {
  if (isTruthyEnv(getComputerExecutionEnv().STELLA_COMPUTER_LOCKED_USE)) {
    return true;
  }
  try {
    return loadLocalPreferences(resolveStellaDataDir())
      .lockedComputerUseEnabled;
  } catch {
    return false;
  }
};

const writeLockedUseEnabled = (enabled: boolean) => {
  const stellaDataDir = resolveStellaDataDir();
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, {
    ...prefs,
    lockedComputerUseEnabled: enabled,
  });
};

const runProcessCapture = async (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<AutomationHelperResult> =>
  await new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const settle = (result: AutomationHelperResult) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      resolve(result);
    };
    // The capture deadline is a forked timeout fiber interrupted by settle
    // (the clearTimeout analogue); duration and kill path unchanged.
    const cancelTimer = forkCancelableTimeout(timeoutMs, () => {
      killProcessGroup(child.pid);
      settle({
        status: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr:
          Buffer.concat(stderrChunks).toString("utf8").trim() ||
          `${command} timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    });
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      settle({
        status: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: error.message,
        error,
      });
    });
    child.once("exit", (status) => {
      settle({
        status: status ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
      });
    });
  });

const lockedUseInstallerPaths = () => {
  const installerPath = resolveNativeHelperPath("locked_use_installer");
  if (!installerPath) {
    throw new Error(
      'Native helper "locked_use_installer" was not found. Build desktop/native first.',
    );
  }
  return {
    installerPath,
    resourceDir: path.dirname(installerPath),
  };
};

const lockedUseAuthorizerPath = () => {
  const helperPath = resolveNativeHelperPath(
    "Stella.app/Contents/MacOS/Stella",
  );
  if (!helperPath) {
    throw new Error(
      'Native helper "Stella.app" was not found. Build desktop/native first.',
    );
  }
  return helperPath;
};

const runLockedUseInstaller = async (
  action: "install" | "uninstall" | "status",
  options: { admin?: boolean } = {},
) => {
  const { installerPath, resourceDir } = lockedUseInstallerPaths();
  if (
    options.admin &&
    process.platform === "darwin" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    return await runProcessCapture(
      lockedUseAuthorizerPath(),
      [action, resourceDir],
      lockedUseInstallerTimeoutMs,
    );
  }
  return await runNativeHelper({
    helperName: "locked_use_installer",
    helperArgs: [action, resourceDir],
    timeoutMs: lockedUseInstallerTimeoutMs,
  });
};

const lockedUseStatus = async () => {
  let installed = false;
  let statusText = "";
  try {
    const status = await runLockedUseInstaller("status");
    statusText = [status.stdout, status.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    installed =
      /\binstalled\b/.test(statusText) && !/\bnot-installed\b/.test(statusText);
  } catch (error) {
    statusText = error instanceof Error ? error.message : String(error);
  }
  return {
    enabled: readLockedUseEnabled(),
    installed,
    statusText,
  };
};

export const runLockedUseManagementCommand = async (
  action: string | undefined,
  jsonMode: boolean,
) => {
  const requested = action ?? "status";
  if (
    !["status", "enable", "disable", "install", "uninstall"].includes(requested)
  ) {
    writeComputerStderr(`Unknown locked-use action: ${requested}\n`);
    return 1;
  }

  if (requested === "status") {
    const status = await lockedUseStatus();
    const payload = {
      ok: true,
      enabled: status.enabled,
      installed: status.installed,
      active: false,
      locked: false,
      suppressedUntilManualUnlock: false,
      message: status.statusText || "Locked computer use status unavailable.",
      warnings: [],
    } satisfies LockedUsePayload;
    if (jsonMode) {
      writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      writeComputerStdout(
        `Locked computer use: ${status.enabled ? "enabled" : "disabled"} (${status.installed ? "installed" : "not installed"})\n`,
      );
      if (status.statusText) writeComputerStdout(`${status.statusText}\n`);
    }
    return 0;
  }

  if (requested === "disable") {
    writeLockedUseEnabled(false);
    const status = await lockedUseStatus();
    const payload = {
      ok: true,
      enabled: status.enabled,
      installed: status.installed,
      active: false,
      locked: false,
      suppressedUntilManualUnlock: false,
      message: status.statusText || "OK",
      warnings: [],
    } satisfies LockedUsePayload;
    if (jsonMode) {
      writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      writeComputerStdout(`${status.statusText || "OK"}\n`);
    }
    return 0;
  }

  const shouldInstall = requested === "enable" || requested === "install";
  const currentStatus = await lockedUseStatus();
  if (shouldInstall && currentStatus.installed) {
    writeLockedUseEnabled(true);
    const status = await lockedUseStatus();
    const payload = {
      ok: true,
      enabled: status.enabled,
      installed: status.installed,
      active: false,
      locked: false,
      suppressedUntilManualUnlock: false,
      message: status.statusText || "OK",
      warnings: [],
    } satisfies LockedUsePayload;
    if (jsonMode) {
      writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      writeComputerStdout(`${status.statusText || "OK"}\n`);
    }
    return 0;
  }
  if (requested === "uninstall" && !currentStatus.installed) {
    writeLockedUseEnabled(false);
    const status = await lockedUseStatus();
    const payload = {
      ok: true,
      enabled: status.enabled,
      installed: status.installed,
      active: false,
      locked: false,
      suppressedUntilManualUnlock: false,
      message: status.statusText || "OK",
      warnings: [],
    } satisfies LockedUsePayload;
    if (jsonMode) {
      writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      writeComputerStdout(`${status.statusText || "OK"}\n`);
    }
    return 0;
  }

  const installerResult = await runLockedUseInstaller(
    shouldInstall ? "install" : "uninstall",
    { admin: true },
  );
  if (installerResult.status !== 0) {
    const message =
      installerResult.stderr ||
      installerResult.stdout ||
      `locked-use ${requested} failed`;
    if (jsonMode) {
      writeComputerStdout(
        `${JSON.stringify(
          {
            ok: false,
            enabled: readLockedUseEnabled(),
            installed: false,
            active: false,
            locked: false,
            suppressedUntilManualUnlock: false,
            message,
            warnings: [],
          } satisfies LockedUsePayload,
          null,
          2,
        )}\n`,
      );
    } else {
      writeComputerStderr(`${message}\n`);
    }
    return 1;
  }

  const status = await lockedUseStatus();
  const installIncomplete = shouldInstall && !status.installed;
  const uninstallIncomplete = requested === "uninstall" && status.installed;
  if (installIncomplete || uninstallIncomplete) {
    const message =
      installerResult.stderr ||
      installerResult.stdout ||
      `locked-use ${requested} did not complete`;
    if (jsonMode) {
      writeComputerStdout(
        `${JSON.stringify(
          {
            ok: false,
            enabled: readLockedUseEnabled(),
            installed: status.installed,
            active: false,
            locked: false,
            suppressedUntilManualUnlock: false,
            message,
            warnings: [],
          } satisfies LockedUsePayload,
          null,
          2,
        )}\n`,
      );
    } else {
      writeComputerStderr(`${message}\n`);
    }
    return 1;
  }

  writeLockedUseEnabled(shouldInstall);
  if (jsonMode) {
    writeComputerStdout(
      `${JSON.stringify(
        {
          ok: true,
          enabled: status.enabled,
          installed: status.installed,
          active: false,
          locked: false,
          suppressedUntilManualUnlock: false,
          message: installerResult.stdout || installerResult.stderr || "OK",
          warnings: [],
        } satisfies LockedUsePayload,
        null,
        2,
      )}\n`,
    );
  } else {
    writeComputerStdout(
      `${installerResult.stdout || installerResult.stderr || "OK"}\n`,
    );
  }
  return 0;
};

export const maybeBeginLockedUseLease = async (sessionPaths: SessionPaths) => {
  if (process.platform !== "darwin" || !readLockedUseEnabled()) {
    return false;
  }
  const result = await runAutomationDaemonCommand(
    sessionPaths,
    ["locked-use-begin", "--duration-ms", String(lockedUseLeaseDurationMs)],
    7_500,
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      result.stderr || "Failed to open locked computer use lease.",
    );
  }
  const payload = parseJson<LockedUsePayload>(result.stdout);
  if (!payload.ok) {
    throw new Error(payload.message || "Locked computer use lease was denied.");
  }
  return true;
};

export const endLockedUseLease = async (sessionPaths: SessionPaths) => {
  if (process.platform !== "darwin" || !readLockedUseEnabled()) {
    return;
  }
  await runAutomationDaemonCommand(
    sessionPaths,
    ["locked-use-end"],
    5_000,
  ).catch(() => {
    // Best-effort cleanup; command result handling should not be masked by a
    // failed lease close.
  });
};
