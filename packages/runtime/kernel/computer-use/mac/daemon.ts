import fs from "node:fs";
import { spawn, type StdioOptions } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  automationSocketsRootDir,
  maxAutomationSocketPathBytes,
  resolveAutomationSocketPath,
} from "../automation-socket-paths.js";
import {
  resolveNativeHelperPath,
  runNativeHelper,
} from "../../cli/native-helper.js";
import {
  requestAutomationDaemonSpawnFromBridge,
  requestDesktopPermissionFromBridge,
  type DesktopPermissionRequestResult,
} from "../../connectors/cli-broker-client.js";
import { forkCancelableTimeout } from "../effect-runtime.js";
import {
  abortableComputerDelay,
  getComputerExecutionEnv,
  getComputerExecutionSignal,
  getComputerExecutionTimeoutMs,
} from "../execution-context.js";
import type { JsonObject } from "../contract.js";
import { ComputerUseResourceStaleError } from "../resource-arbiter.js";
import {
  computerStateDir,
  helperNewerThanDaemon,
  killProcessGroup,
  pidIsRunning,
  readPidFile,
} from "../session-fs.js";
import type { Rect } from "./ax-format.js";
import type { SessionPaths } from "./session-paths.js";

// Lifecycle of the per-session desktop_automation daemon (spawn, readiness,
// recovery) and the two request channels it serves: legacy argv requests and
// typed operations.

type AutomationDaemonRequestPayload = {
  seq: number;
  argv: string[];
  env: Record<string, string>;
};

type AutomationDaemonResponsePayload = {
  seq: number;
  status: number;
  stdout: string;
  stderr: string;
};

export type TypedAutomationTarget = {
  pid?: number;
  appName?: string;
  bundleId?: string;
};

export type TypedAutomationState = {
  path: string;
  sessionId: string;
  screenshotPath?: string;
  screenshotPolicy?: "auto" | "always" | "never";
  inlineScreenshot?: boolean;
};

export type TypedAutomationAction = {
  kind: string;
  ref?: string;
  text?: string;
  name?: string;
  key?: string;
  direction?: string;
  selection?: string;
  prefix?: string;
  suffix?: string;
  mouseButton?: string;
  clickCount?: number;
  pages?: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  options?: {
    allowHid?: boolean;
    coordinateFallback?: boolean;
    raise?: boolean;
    showOverlay?: boolean;
    deferObservation?: boolean;
  };
};

export type TypedAutomationObservationPrecondition = {
  observedStateId: string;
  observedVisualStateId?: string;
  targetPid: number;
  targetBundleId?: string;
  windowId?: number;
  windowTitle?: string;
  windowFrame?: Rect;
  observerRevision?: number;
  materializedRevision?: number;
  visualTreeRevision?: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
};

export type TypedAutomationOperation = {
  type: string;
  target?: TypedAutomationTarget;
  state?: TypedAutomationState;
  action?: TypedAutomationAction;
  precondition?: TypedAutomationObservationPrecondition;
  operations?: TypedAutomationOperation[];
  durationMs?: number;
};

type TypedAutomationDaemonResponsePayload = {
  schemaVersion: number;
  protocolVersion: number;
  seq: number;
  ok: boolean;
  status: number;
  result?: unknown;
  error?: { code: string; message: string; details?: JsonObject };
};

const TYPED_AUTOMATION_SCHEMA_VERSION = 2;
const TYPED_AUTOMATION_PROTOCOL_VERSION = 2;

export type AutomationHelperResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
};

type AccessibilityPermissionPayload = {
  ok: boolean;
  granted: boolean;
  message: string;
  warnings: string[];
};

type AutomationDaemonReadyResult = { ok: true } | { ok: false; error: string };

const automationDaemonStartupBudgetMs = 7_500;
const parseNonNegativeIntegerEnv = (
  value: string | undefined,
  fallback: number,
) => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
};
const automationAccessibilityWaitMs = () =>
  parseNonNegativeIntegerEnv(
    getComputerExecutionEnv().STELLA_COMPUTER_ACCESSIBILITY_WAIT_MS,
    30_000,
  );
const automationAccessibilityPollIntervalMs = 500;
// 30s covers heavy AppKit apps (Mail with thousands of messages, Notes with
// large note bodies, Music with full library indexed) where the AX walk
// reaches the maxNodes cap of 1500 before the daemon can return. Lighter
// apps (Spotify, Notes empty) finish in 1–3s.
export const automationDaemonRequestTimeoutMs = 30_000;

const delayMs = abortableComputerDelay;

// Sockets live under a short home-anchored directory (not the state dir) so
// the path stays inside the 104-byte macOS sockaddr_un cap; see
// automation-socket-paths.ts for the layout and collision rationale.
export const automationSocketsDir = () => automationSocketsRootDir();

export const automationSocketPath = (sessionPaths: SessionPaths) =>
  resolveAutomationSocketPath(computerStateDir(), sessionPaths.sessionId);

export const automationPidPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "automation.pid");

/** Daemon stdout/stderr sink; read back to surface startup failures. */
const automationLogPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "automation-daemon.log");

/**
 * Pid of the Electron host that spawned the current daemon. macOS TCC
 * attribution follows the responsible process recorded at spawn time, so a
 * daemon spawned by a host that has since exited loses its "Stella"
 * Accessibility attribution — it must be restarted by the current live host.
 */
export const automationHostPidPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "automation.host-pid");

const resetAutomationDaemonFiles = (sessionPaths: SessionPaths) => {
  fs.rmSync(automationPidPath(sessionPaths), { force: true });
  fs.rmSync(automationSocketPath(sessionPaths), { force: true });
  fs.rmSync(automationHostPidPath(sessionPaths), { force: true });
};

export const recoverAutomationDaemon = (sessionPaths: SessionPaths) => {
  const pid = readPidFile(automationPidPath(sessionPaths));
  killProcessGroup(pid);
  resetAutomationDaemonFiles(sessionPaths);
  return pid;
};

/** Stop the session's daemon if it is running; true when a pid was recorded. */
export const stopAutomationDaemon = (sessionPaths: SessionPaths) => {
  const pid = readPidFile(automationPidPath(sessionPaths));
  if (pid && pidIsRunning(pid)) killProcessGroup(pid);
  resetAutomationDaemonFiles(sessionPaths);
  return pid !== null;
};

const writeAutomationHostPid = (sessionPaths: SessionPaths, pid: number) => {
  try {
    fs.writeFileSync(automationHostPidPath(sessionPaths), String(pid), "utf8");
  } catch {
    // Best-effort bookkeeping; worst case the staleness check is skipped.
  }
};

const automationDaemonSpawnedByDeadHost = (sessionPaths: SessionPaths) => {
  const hostPid = readPidFile(automationHostPidPath(sessionPaths));
  return hostPid !== null && !pidIsRunning(hostPid);
};

const automationLogTail = (sessionPaths: SessionPaths, maxChars = 700) => {
  try {
    const raw = fs.readFileSync(automationLogPath(sessionPaths), "utf8").trim();
    if (!raw) return "";
    return raw.length > maxChars ? `…${raw.slice(-maxChars)}` : raw;
  } catch {
    return "";
  }
};

const truncateAutomationLog = (sessionPaths: SessionPaths) => {
  try {
    fs.mkdirSync(sessionPaths.sessionDir, { recursive: true });
    fs.writeFileSync(automationLogPath(sessionPaths), "", "utf8");
  } catch {
    // Best-effort; an unwritable log only degrades error detail.
  }
};

const accessibilityGuidance =
  'Open System Settings → Privacy & Security → Accessibility and enable "Stella" (toggle it off and on if it is already listed), then retry.';

const describeDaemonStartupFailure = (
  sessionPaths: SessionPaths,
  fallback: string,
) => {
  const tail = automationLogTail(sessionPaths);
  if (!tail) {
    return fallback;
  }
  if (/accessibility permission/i.test(tail)) {
    return `desktop_automation daemon exited: macOS Accessibility is not granted for the process that runs Stella's automation. ${accessibilityGuidance} (daemon output: ${tail})`;
  }
  return `desktop_automation daemon failed to start: ${tail}`;
};

const filteredAutomationDaemonEnv = () =>
  Object.fromEntries(
    Object.entries(getComputerExecutionEnv()).filter(
      ([key, value]) =>
        key.startsWith("STELLA_COMPUTER_") && typeof value === "string",
    ),
  ) as Record<string, string>;

type AutomationAccessibilityState =
  | {
      ok: true;
      /**
       * True when the helper's own AXIsProcessTrusted() check (run from this
       * process tree) passed. False when only the Electron host vouched for
       * the grant — valid for a host-spawned daemon (the host's TCC identity
       * is what matters there) but not for a locally spawned one.
       */
      helperTrusted: boolean;
      hostGranted: boolean;
    }
  | { ok: false; error: string };

const promptForAutomationAccessibility = async (
  sessionPaths: SessionPaths,
): Promise<AutomationAccessibilityState> => {
  const accessibilityWaitMs = automationAccessibilityWaitMs();
  if (process.platform !== "darwin" || accessibilityWaitMs <= 0) {
    return { ok: true, helperTrusted: true, hostGranted: false };
  }

  const checkAccessibility = async (
    openSettings: boolean,
  ): Promise<AutomationDaemonReadyResult> => {
    const helperArgs = [
      "accessibility-permission",
      ...(openSettings ? ["--open-settings"] : []),
      "--wait-ms",
      "0",
    ];
    const result = await runNativeHelper({
      helperName: "desktop_automation",
      helperArgs,
      env: {
        ...getComputerExecutionEnv(),
        STELLA_COMPUTER_SESSION: sessionPaths.sessionId,
        STELLA_COMPUTER_STATE_DIR: computerStateDir(),
      },
      timeoutMs: 5_000,
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (!result.stdout) {
      return {
        ok: false,
        error:
          result.stderr ||
          "Accessibility permission is required for the desktop_automation daemon.",
      };
    }

    try {
      const payload = parseJson<AccessibilityPermissionPayload>(result.stdout);
      if (payload.granted) {
        return { ok: true };
      }
      return { ok: false, error: payload.message };
    } catch {
      return {
        ok: false,
        error:
          result.stderr ||
          "Accessibility permission is required for the desktop_automation daemon.",
      };
    }
  };

  const requestViaHost = async (): Promise<DesktopPermissionRequestResult> => {
    const socketPath = getComputerExecutionEnv().STELLA_CLI_BRIDGE_SOCK;
    if (!socketPath) {
      return { ok: false, reason: "no_bridge" as const };
    }
    try {
      return await requestDesktopPermissionFromBridge({
        socketPath,
        kind: "accessibility",
        timeoutMs: accessibilityWaitMs,
      });
    } catch (error) {
      return {
        ok: false,
        reason: (error as Error).message || "bridge_failed",
      };
    }
  };

  let lastResult = await checkAccessibility(false);
  if (lastResult.ok) {
    return { ok: true, helperTrusted: true, hostGranted: false };
  }

  const hostRequest = await requestViaHost();
  if (hostRequest.ok && hostRequest.granted) {
    // Re-verify with the helper's own check instead of trusting the host
    // blindly: the host answers for the Stella.app TCC identity, while a
    // helper spawned from this (worker) process tree can carry a different —
    // possibly orphaned — attribution. A disagreement here is expected when
    // the worker outlived a previous Stella.app instance; the daemon must
    // then be spawned by the live host (see ensureAutomationDaemon).
    lastResult = await checkAccessibility(false);
    return { ok: true, helperTrusted: lastResult.ok, hostGranted: true };
  }

  const shouldOpenSettingsFallback =
    !hostRequest.ok && hostRequest.reason === "no_bridge";
  if (shouldOpenSettingsFallback) {
    lastResult = await checkAccessibility(true);
  }
  if (lastResult.ok) {
    return { ok: true, helperTrusted: true, hostGranted: false };
  }

  const deadline = Date.now() + accessibilityWaitMs;
  while (Date.now() < deadline) {
    await delayMs(automationAccessibilityPollIntervalMs);
    lastResult = await checkAccessibility(false);
    if (lastResult.ok) {
      return { ok: true, helperTrusted: true, hostGranted: false };
    }
  }

  return {
    ok: false,
    error: `${
      lastResult.ok
        ? "Accessibility permission is required for the desktop_automation daemon."
        : lastResult.error
    } ${accessibilityGuidance}`,
  };
};

/**
 * Spawn the daemon via the Electron host (single "Stella" TCC identity) when
 * a CLI bridge is available. Returns null when host spawning is unavailable
 * so the caller can fall back to a local spawn.
 */
const spawnAutomationDaemonViaHost = async (
  sessionPaths: SessionPaths,
  socketPath: string,
  pidPath: string,
): Promise<{ ok: true } | { ok: false; reason: string } | null> => {
  if (process.platform !== "darwin") {
    return null;
  }
  const bridgeSocketPath = getComputerExecutionEnv().STELLA_CLI_BRIDGE_SOCK;
  if (!bridgeSocketPath) {
    return null;
  }
  const result = await requestAutomationDaemonSpawnFromBridge({
    socketPath: bridgeSocketPath,
    params: {
      daemonSocketPath: socketPath,
      pidPath,
      logPath: automationLogPath(sessionPaths),
      sessionId: sessionPaths.sessionId,
      stateDir: computerStateDir(),
      env: filteredAutomationDaemonEnv(),
    },
    timeoutMs: 15_000,
  });
  if (result.ok) {
    writeAutomationHostPid(sessionPaths, result.hostPid);
    return { ok: true };
  }
  // "unsupported" means the running host predates this RPC; let the caller
  // fall back to the legacy local spawn rather than hard-failing.
  if (result.reason === "unsupported") {
    return null;
  }
  return { ok: false, reason: result.reason };
};

const spawnAutomationDaemonLocally = (
  sessionPaths: SessionPaths,
  helperPath: string,
  socketPath: string,
  pidPath: string,
): { onSpawnError: () => Error | null; hasExited: () => boolean } => {
  // Pipe daemon output to a per-session log instead of discarding it; the
  // startup poll reads it back so a daemon that exits with "Accessibility
  // permission is required…" surfaces that message instead of an opaque
  // "failed to start after 7500ms".
  let stdio: StdioOptions = "ignore";
  let logFd: number | null = null;
  try {
    logFd = fs.openSync(automationLogPath(sessionPaths), "a");
    stdio = ["ignore", logFd, logFd];
  } catch {
    // Unwritable log only degrades error detail.
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      helperPath,
      ["daemon", "--socket-path", socketPath, "--pid-file", pidPath],
      {
        detached: process.platform !== "win32",
        stdio,
        windowsHide: true,
        env: {
          ...getComputerExecutionEnv(),
          STELLA_COMPUTER_SESSION: sessionPaths.sessionId,
          STELLA_COMPUTER_STATE_DIR: computerStateDir(),
        },
      },
    );
  } finally {
    if (logFd !== null) {
      fs.closeSync(logFd);
    }
  }
  const startup: { error: Error | null; exited: boolean } = {
    error: null,
    exited: false,
  };
  child.once("error", (error) => {
    startup.error = error;
  });
  child.once("exit", () => {
    startup.exited = true;
  });
  child.unref();
  return {
    onSpawnError: () => startup.error,
    hasExited: () => startup.exited,
  };
};

const ensureAutomationDaemon = async (
  sessionPaths: SessionPaths,
): Promise<AutomationDaemonReadyResult> => {
  const pidPath = automationPidPath(sessionPaths);
  const socketPath = automationSocketPath(sessionPaths);
  const socketPathBytes = Buffer.byteLength(socketPath, "utf8");
  if (socketPathBytes > maxAutomationSocketPathBytes) {
    // The daemon enforces the 104-byte BSD sockaddr_un cap with an opaque
    // "Daemon socket path is too long"; fail here with the actual path so
    // the problem (an unusually long home directory) is diagnosable.
    return {
      ok: false,
      error: `desktop_automation daemon socket path "${socketPath}" is ${socketPathBytes} bytes, above the ${maxAutomationSocketPathBytes}-byte limit imposed by the macOS 104-byte Unix socket path cap. Your home directory path is too long for desktop automation.`,
    };
  }
  const helperPath = resolveNativeHelperPath("desktop_automation");
  if (!helperPath) {
    return {
      ok: false,
      error:
        'Native helper "desktop_automation" was not found. Build desktop/native first.',
    };
  }
  const existingPid = readPidFile(pidPath);
  if (existingPid && pidIsRunning(existingPid) && fs.existsSync(socketPath)) {
    const staleHost =
      process.platform === "darwin" &&
      automationDaemonSpawnedByDeadHost(sessionPaths);
    if (!helperNewerThanDaemon(helperPath, pidPath) && !staleHost) {
      return { ok: true };
    }
    // Either the helper binary changed under the daemon, or the Electron host
    // that spawned it exited (which orphans the daemon's TCC attribution).
    // Restart it under the current host.
    killProcessGroup(existingPid);
    resetAutomationDaemonFiles(sessionPaths);
  }
  if (existingPid && pidIsRunning(existingPid) && !fs.existsSync(socketPath)) {
    killProcessGroup(existingPid);
  }
  resetAutomationDaemonFiles(sessionPaths);
  fs.mkdirSync(automationSocketsDir(), { recursive: true });

  const permission = await promptForAutomationAccessibility(sessionPaths);
  if (!permission.ok) {
    return permission;
  }

  truncateAutomationLog(sessionPaths);
  let onSpawnError: (() => Error | null) | null = null;
  let hasExited: (() => boolean) | null = null;
  const hostSpawn = await spawnAutomationDaemonViaHost(
    sessionPaths,
    socketPath,
    pidPath,
  );
  if (hostSpawn && !hostSpawn.ok) {
    return {
      ok: false,
      error: `desktop_automation daemon could not be spawned by the Stella app process: ${hostSpawn.reason}`,
    };
  }
  if (!hostSpawn) {
    if (
      process.platform === "darwin" &&
      permission.hostGranted &&
      !permission.helperTrusted
    ) {
      // The Stella app has Accessibility, but this detached worker's process
      // tree no longer inherits that grant (its spawning app instance is
      // gone) and no live host is reachable to spawn the daemon under the
      // app's identity. A locally spawned daemon would just exit; fail with
      // an actionable message instead.
      return {
        ok: false,
        error: `Stella has macOS Accessibility, but the automation daemon cannot inherit it because the Stella app that granted it is no longer running. Fully quit and reopen Stella, then retry. ${accessibilityGuidance}`,
      };
    }
    const local = spawnAutomationDaemonLocally(
      sessionPaths,
      helperPath,
      socketPath,
      pidPath,
    );
    onSpawnError = local.onSpawnError;
    hasExited = local.hasExited;
  }

  for (
    let attempt = 0;
    attempt < Math.ceil(automationDaemonStartupBudgetMs / 25);
    attempt += 1
  ) {
    await delayMs(25);
    const spawnError = onSpawnError?.();
    if (spawnError) {
      resetAutomationDaemonFiles(sessionPaths);
      return {
        ok: false,
        error: `desktop_automation daemon failed to start: ${spawnError.message}`,
      };
    }
    const pid = readPidFile(pidPath);
    if (pid && pidIsRunning(pid) && fs.existsSync(socketPath)) {
      return { ok: true };
    }
    if (hasExited?.() && (!pid || !pidIsRunning(pid))) {
      // The locally spawned daemon already died (e.g. its Accessibility
      // check failed); no point polling out the rest of the budget.
      break;
    }
  }
  resetAutomationDaemonFiles(sessionPaths);
  return {
    ok: false,
    error: describeDaemonStartupFailure(
      sessionPaths,
      `desktop_automation daemon failed to start after ${automationDaemonStartupBudgetMs}ms`,
    ),
  };
};

export const runAutomationDaemonCommand = async (
  sessionPaths: SessionPaths,
  helperArgs: string[],
  timeoutMs = automationDaemonRequestTimeoutMs,
): Promise<AutomationHelperResult> => {
  const daemonReady = await ensureAutomationDaemon(sessionPaths);
  if (!daemonReady.ok) {
    resetAutomationDaemonFiles(sessionPaths);
    return {
      status: 1,
      stdout: "",
      stderr:
        daemonReady.error ||
        `desktop_automation daemon failed to start after ${automationDaemonStartupBudgetMs}ms`,
    };
  }

  const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = JSON.stringify({
    seq,
    argv: helperArgs,
    env: {
      ...filteredAutomationDaemonEnv(),
      STELLA_COMPUTER_SESSION: sessionPaths.sessionId,
      STELLA_COMPUTER_STATE_DIR: computerStateDir(),
    },
  } satisfies AutomationDaemonRequestPayload);

  return await new Promise<AutomationHelperResult>((resolve) => {
    let settled = false;
    const responseChunks: Buffer[] = [];
    const socket = net.createConnection({
      path: automationSocketPath(sessionPaths),
    });
    const signal = getComputerExecutionSignal();
    const settle = (result: AutomationHelperResult) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => {
      const reason = signal?.reason;
      // Helper-style requests share the same serial daemon as typed
      // operations. Revoke it on cancellation as well, otherwise a blocked
      // helper remains at the head of the queue and wedges the next call.
      recoverAutomationDaemon(sessionPaths);
      settle({
        status: 1,
        stdout: "",
        stderr:
          reason instanceof Error
            ? reason.message
            : "Computer command aborted.",
        error:
          reason instanceof Error
            ? reason
            : new Error("Computer command aborted."),
      });
    };
    // The request deadline is a forked timeout fiber interrupted by settle
    // (the clearTimeout analogue); duration and daemon-reset path unchanged.
    const cancelTimer = forkCancelableTimeout(timeoutMs, () => {
      recoverAutomationDaemon(sessionPaths);
      settle({
        status: 1,
        stdout: "",
        stderr: `desktop_automation daemon timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    });

    socket.on("connect", () => {
      socket.write(`${payload}\n`);
    });
    socket.on("data", (chunk) => {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        const responseText = Buffer.concat(responseChunks).toString("utf8");
        const response =
          parseJson<AutomationDaemonResponsePayload>(responseText);
        if (response.seq !== seq) {
          settle({
            status: 1,
            stdout: "",
            stderr:
              "desktop_automation daemon returned a mismatched response sequence",
          });
          return;
        }
        settle({
          status: response.status,
          stdout: response.stdout,
          stderr: response.stderr,
        });
      } catch {
        settle({
          status: 1,
          stdout: "",
          stderr: "desktop_automation daemon returned an invalid response",
        });
      }
    });
    socket.on("error", (error) => {
      const pid = readPidFile(automationPidPath(sessionPaths));
      if (pid && !pidIsRunning(pid)) {
        resetAutomationDaemonFiles(sessionPaths);
      }
      settle({
        status: 1,
        stdout: "",
        stderr:
          error instanceof Error
            ? `desktop_automation daemon connection failed: ${error.message}`
            : "desktop_automation daemon connection failed",
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

export const runAutomationDaemonTypedOperation = async (
  sessionPaths: SessionPaths,
  operation: TypedAutomationOperation,
  timeoutMs = getComputerExecutionTimeoutMs() ??
    automationDaemonRequestTimeoutMs,
): Promise<unknown> => {
  const daemonReady = await ensureAutomationDaemon(sessionPaths);
  if (!daemonReady.ok) {
    resetAutomationDaemonFiles(sessionPaths);
    throw new Error(
      daemonReady.error ||
        `desktop_automation daemon failed to start after ${automationDaemonStartupBudgetMs}ms`,
    );
  }

  const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = JSON.stringify({
    schemaVersion: TYPED_AUTOMATION_SCHEMA_VERSION,
    protocolVersion: TYPED_AUTOMATION_PROTOCOL_VERSION,
    seq,
    operation,
  });

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const responseChunks: Buffer[] = [];
    const socket = net.createConnection({
      path: automationSocketPath(sessionPaths),
    });
    const signal = getComputerExecutionSignal();
    const settle = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const reason = signal?.reason;
      // The daemon serves requests serially. Dropping only this socket leaves
      // a wedged native operation blocking every later request, so revoke the
      // daemon generation and let the next call start a clean process.
      recoverAutomationDaemon(sessionPaths);
      settle(
        reason instanceof Error
          ? reason
          : new Error("Computer request aborted."),
      );
    };
    // The request deadline is a forked timeout fiber interrupted by settle
    // (the clearTimeout analogue); duration and daemon-reset path unchanged.
    const cancelTimer = forkCancelableTimeout(timeoutMs, () => {
      recoverAutomationDaemon(sessionPaths);
      settle(
        new Error(`desktop_automation daemon timed out after ${timeoutMs}ms`),
      );
    });

    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        const response = parseJson<TypedAutomationDaemonResponsePayload>(
          Buffer.concat(responseChunks).toString("utf8"),
        );
        if (
          response.schemaVersion !== TYPED_AUTOMATION_SCHEMA_VERSION ||
          response.protocolVersion !== TYPED_AUTOMATION_PROTOCOL_VERSION ||
          response.seq !== seq
        ) {
          const pid = readPidFile(automationPidPath(sessionPaths));
          killProcessGroup(pid);
          resetAutomationDaemonFiles(sessionPaths);
          settle(
            new Error(
              "desktop_automation returned a mismatched typed response",
            ),
          );
          return;
        }
        if (!response.ok || response.status !== 0) {
          if (response.error?.code === "stale_observation") {
            const details = response.error.details;
            const observed = details?.observed;
            const current = details?.current;
            const observedObject =
              observed &&
              typeof observed === "object" &&
              !Array.isArray(observed)
                ? (observed as JsonObject)
                : undefined;
            const currentObject =
              current && typeof current === "object" && !Array.isArray(current)
                ? (current as JsonObject)
                : undefined;
            const observedStateId =
              typeof observedObject?.state_id === "string"
                ? observedObject.state_id
                : "state_observed";
            const currentStateId =
              typeof currentObject?.state_id === "string"
                ? currentObject.state_id
                : "native_state_changed";
            settle(
              new ComputerUseResourceStaleError(
                observedStateId,
                currentStateId,
                {
                  ...(observedObject ? { nativeObserved: observedObject } : {}),
                  ...(currentObject ? { nativeCurrent: currentObject } : {}),
                  ...(typeof details?.reason === "string"
                    ? { nativeReason: details.reason }
                    : {}),
                },
              ),
            );
            return;
          }
          settle(
            new Error(
              response.error?.message ||
                `desktop_automation typed request failed with status ${response.status}`,
            ),
          );
          return;
        }
        settle(undefined, response.result);
      } catch (error) {
        const pid = readPidFile(automationPidPath(sessionPaths));
        killProcessGroup(pid);
        resetAutomationDaemonFiles(sessionPaths);
        settle(
          error instanceof Error
            ? new Error(
                `desktop_automation returned an invalid typed response: ${error.message}`,
              )
            : new Error(
                "desktop_automation returned an invalid typed response",
              ),
        );
      }
    });
    socket.on("error", (error) => {
      const pid = readPidFile(automationPidPath(sessionPaths));
      killProcessGroup(pid);
      resetAutomationDaemonFiles(sessionPaths);
      settle(
        new Error(
          `desktop_automation daemon connection failed: ${error.message}`,
        ),
      );
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

export const parseJson = <T>(text: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse desktop automation response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
