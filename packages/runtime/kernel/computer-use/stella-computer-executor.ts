import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { screenshotPixelToScreenPoint } from "../cli/screenshot-coordinates.js";
import {
  cleanupWindowsStellaComputerSessionDaemon,
  runWindowsStellaComputer,
} from "../cli/stella-computer-windows.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";
import {
  formatStateDiffBlock,
  shouldUseDiffOnly,
} from "../cli/stella-computer-state-diff.js";
import { forkCancelableTimeout } from "./effect-runtime.js";
import {
  abortableComputerDelay,
  getComputerExecutionEnv,
  runWithComputerExecutionContext,
  throwIfComputerExecutionAborted,
  writeComputerStderr,
  writeComputerStdout,
  type ComputerExecutionContextOptions,
} from "./execution-context.js";
import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  assertComputerUseRequest,
  type ComputerUseAction,
  type ComputerUseActionCommand,
  type ComputerUseAppState,
  type ComputerUseAppPolicy,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseTarget,
  type ComputerUseWaitProvenance,
  type JsonObject,
} from "./contract.js";
import type { ComputerUseSession } from "./session.js";
import {
  ComputerUseResourceStaleError,
  macComputerUseResourceArbiter,
} from "./resource-arbiter.js";
import {
  DEFAULT_COMPUTER_SESSION_ID,
  computerStateDir,
  getOptionValue,
  hasOption,
  isTruthyEnv,
  normalizeTargetKey,
  pruneComputerSessions,
  readJsonFile,
  stripOptionValue,
  targetStatePathForKey,
  writeJsonAtomic,
} from "./session-fs.js";
import {
  appStateLines,
  formatAction,
  formatError,
  formatListApps,
  formatListWindows,
  formatSnapshot,
  snapshotDiff,
  snapshotStateId,
  snapshotVisualStateId,
  type ActionPayload,
  type ErrorPayload,
  type ListAppsPayload,
  type ListedAppPayload,
  type ListWindowsPayload,
  type SnapshotDocument,
} from "./mac/ax-format.js";
import {
  automationDaemonRequestTimeoutMs,
  automationHostPidPath,
  automationPidPath,
  automationSocketPath,
  automationSocketsDir,
  parseJson,
  recoverAutomationDaemon,
  runAutomationDaemonCommand,
  runAutomationDaemonTypedOperation,
  stopAutomationDaemon,
  type TypedAutomationAction,
  type TypedAutomationObservationPrecondition,
  type TypedAutomationOperation,
  type TypedAutomationState,
  type TypedAutomationTarget,
} from "./mac/daemon.js";
import {
  acquireLocks,
  endLockedUseLease,
  maybeBeginLockedUseLease,
  resolveLockKeys,
  runLockedUseManagementCommand,
} from "./mac/locked-use.js";
import {
  deriveScreenshotPath,
  ensureStateDirectory,
  locksDir,
  readSnapshotDocument,
  resolveSessionPaths,
  type SessionPaths,
} from "./mac/session-paths.js";

type TypedAutomationBatchPayload = {
  completed: number;
  results: Array<{
    index: number;
    ok: boolean;
    status: number;
    result: unknown;
  }>;
};

type SessionTargetSelector = {
  pid?: number | null;
  bundleId?: string | null;
  appName?: string | null;
};

type SessionTargetRecord = {
  key: string;
  appName: string;
  bundleId?: string | null;
  pid?: number | null;
  windowTitle?: string | null;
  statePath: string;
  screenshotPath: string;
  capturedAt?: string | null;
  updatedAt: string;
};

type SessionTargetRegistry = {
  activeTargetKey?: string | null;
  targets: Record<string, SessionTargetRecord>;
};

const defaultSessionStateExample = path.join(
  computerStateDir(),
  "sessions",
  "<session>",
  "last-snapshot.json",
);

const usage = `stella-computer - control macOS apps through Accessibility, in the background

Every command (except list-apps) requires an explicit target app via
--app NAME, --bundle-id ID, or --pid PID. There is no frontmost-app
fallback. Actions dispatch via Accessibility and never bring the target
to the front, so the user can keep using their computer while Stella
works.

Usage:
  stella-computer list-apps
  stella-computer list-windows
  stella-computer [--session ID] snapshot (--app NAME|--bundle-id ID|--pid PID) [--all-windows] [--screenshot [PATH]|--no-screenshot|--screenshot-policy auto|always|never] [--disable-diff] [--no-inline-screenshot] [--max-depth N] [--max-nodes N]
  stella-computer [--session ID] get-state (--app NAME|--bundle-id ID|--pid PID) [--all-windows] [--screenshot [PATH]|--no-screenshot|--screenshot-policy auto|always|never] [--disable-diff] [--no-inline-screenshot] [--max-depth N] [--max-nodes N]
  stella-computer [--session ID] click <element> [--mouse-button left|right|middle] [--click-count N] [--coordinate-fallback] [--allow-hid] [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] fill <element> <text> [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] select-text <element> <text> [--prefix TEXT] [--suffix TEXT] [--selection text|cursor-before|cursor-after] [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] focus <element> [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] secondary-action <element> <action> [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--pages N] [--defer-observation] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] drag <from_x> <from_y> <to_x> <to_y> [--allow-hid] [--raise] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] drag-element <source-element> (<dest-element> | <to_x> <to_y> | --to-ref REF | --to-x N --to-y N) [--type file|url|text] [--operation copy|link|move|every] [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] click-point <x> <y> [--mouse-button left|right|middle] [--click-count N] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--mouse-button left|right|middle] [--click-count N] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--allow-hid] [--raise] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] type <text> [--allow-hid] [--raise] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] press <key> [--allow-hid] [--raise] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] shutdown-session [--json]
  stella-computer locked-use status|enable|disable|install|uninstall [--json]

Notes:
  - snapshot writes element state to ${defaultSessionStateExample}
  - get-state is an alias for snapshot
  - click/fill/focus/secondary-action/scroll/drag reuse the last snapshot state unless --state is provided
  - snapshots are also cached per target under sessions/<session>/targets/<target>/last-snapshot.json so one session can retain multiple apps
  - snapshot captures a window screenshot by default; pass --screenshot-policy auto to capture only when visual context is needed, or --no-screenshot to skip it
  - --all-windows enumerates every accessibility window the app advertises (default: focused only)
  - menu bar items are intentionally omitted from snapshots so app-window automation does not open global menus by mistake
  - successful actions refresh state automatically unless --defer-observation is set; deferred actions return an acknowledgement and leave settling/capture to the next get-state
  - screenshots are auto-attached inline (base64 PNG); pass --no-inline-screenshot to keep only the file path
  - the agent runtime detects "[stella-attach-image]" markers in output and attaches the image as vision input on the next turn
  - Stella isolates default snapshot and screenshot files by session; agent runs set that session automatically
  - non-snapshot commands may also use --app/--bundle-id/--pid to select a cached target snapshot inside the current session
  - Global HID fallbacks require --allow-hid (or STELLA_COMPUTER_ALLOW_HID=1) because they can interfere with active user input
  - element actions accept the numbered IDs shown in snapshot output (and still accept legacy @d refs); macOS Accessibility is tried first so Stella avoids taking over the physical cursor
  - click-screenshot / drag-screenshot interpret coordinates in attached screenshot pixels, then map them back into screen space using the saved window frame
  - --raise (or STELLA_COMPUTER_RAISE=1) is OFF by default; only opt in for HID coordinate clicks/keystrokes that genuinely need the target frontmost. The legacy --no-raise / STELLA_COMPUTER_NO_RAISE flags are accepted as no-ops.
  - actions keep a session overlay alive between targets so the software cursor visibly moves from action to action; pass --no-overlay (or STELLA_COMPUTER_NO_OVERLAY=1) to skip it
  - STELLA_COMPUTER_ALWAYS_SIMULATE_INPUT=1 forces CGEvent synthesis for click/type/press (CLICK alias kept for back-compat)
  - locked-use enables macOS locked-screen Computer Use through a native authorization plug-in and a short per-action unlock lease
  - STELLA_COMPUTER_APP_INSTRUCTIONS_DIR=<dir> adds per-bundle markdown manuals (e.g. com.example.app.md)
  - Forbidden bundles: ${"set STELLA_COMPUTER_FORBIDDEN_BUNDLES=a,b,c to extend; the built-in deny list covers Stella, Keychain, password managers, System Settings"}
  - Forbidden URLs: ${"set STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS=foo,bar to extend; the built-in list covers banking + auth surfaces"}
`;

const stripFlag = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let found = false;
  for (const arg of args) {
    if (arg === flag) {
      found = true;
      continue;
    }
    nextArgs.push(arg);
  }
  return { found, args: nextArgs };
};

const splitArgsIntoPositionalsAndOptions = (args: string[]) => {
  const positionals: string[] = [];
  const options: string[] = [];
  let index = 0;

  while (index < args.length) {
    const current = args[index];
    if (current.startsWith("--")) {
      options.push(current);
      if (
        !current.includes("=") &&
        index + 1 < args.length &&
        !args[index + 1].startsWith("--")
      ) {
        options.push(args[index + 1]);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    positionals.push(current);
    index += 1;
  }

  return { positionals, options };
};

const withStatePath = (args: string[], statePath: string) => {
  if (hasOption(args, "--state")) {
    return args;
  }
  return ["--state", statePath, ...args];
};

export const __testOnlyRecoverAutomationDaemon = (sessionId: string) => {
  const sessionPaths = resolveSessionPaths(sessionId);
  const pid = recoverAutomationDaemon(sessionPaths);
  return {
    pid,
    pidPath: automationPidPath(sessionPaths),
    socketPath: automationSocketPath(sessionPaths),
    hostPidPath: automationHostPidPath(sessionPaths),
  };
};

const ensureSnapshotArgs = (args: string[], sessionPaths: SessionPaths) => {
  const nextArgs = [...args];
  const statePath =
    getOptionValue(nextArgs, "--state") ?? sessionPaths.statePath;
  if (!hasOption(nextArgs, "--state")) {
    nextArgs.unshift(statePath);
    nextArgs.unshift("--state");
  }

  if (
    !hasOption(nextArgs, "--screenshot") &&
    !hasOption(nextArgs, "--screenshot-policy") &&
    !nextArgs.includes("--no-screenshot")
  ) {
    nextArgs.unshift(deriveScreenshotPath(statePath));
    nextArgs.unshift("--screenshot");
  }

  const screenshotIndex = nextArgs.findIndex((arg) => arg === "--screenshot");
  if (screenshotIndex >= 0) {
    const nextValue = nextArgs[screenshotIndex + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      nextArgs.splice(
        screenshotIndex,
        1,
        "--screenshot",
        deriveScreenshotPath(statePath),
      );
    }
  }

  return nextArgs;
};

const emitError = (payload: ErrorPayload, jsonMode: boolean) => {
  if (jsonMode) {
    writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    formatError(payload);
  }
  throw new StellaComputerExitError(1);
};

class StellaComputerExitError extends Error {
  constructor(readonly exitCode: number) {
    super(`stella-computer exited ${exitCode}`);
  }
}

const hidAllowed = (args: string[]) =>
  hasOption(args, "--allow-hid") ||
  isTruthyEnv(getComputerExecutionEnv().STELLA_COMPUTER_ALLOW_HID);

const sessionTargetsDir = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "targets");

const sessionTargetRegistryPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "targets.json");

const targetKeyFromSnapshot = (snapshot: SnapshotDocument) => {
  const bundleId = normalizeTargetKey(snapshot.bundleId ?? "");
  if (bundleId) {
    return `bundle-${bundleId}`;
  }
  const appName = normalizeTargetKey(snapshot.appName ?? "");
  if (appName) {
    return `app-${appName}`;
  }
  return `pid-${snapshot.pid}`;
};

const sessionTargetStatePath = (sessionPaths: SessionPaths, key: string) =>
  targetStatePathForKey(sessionTargetsDir(sessionPaths), key);

const readSessionTargetRegistry = (
  sessionPaths: SessionPaths,
): SessionTargetRegistry => {
  const parsed = readJsonFile<SessionTargetRegistry>(
    sessionTargetRegistryPath(sessionPaths),
  );
  return {
    activeTargetKey: parsed?.activeTargetKey ?? null,
    targets: parsed?.targets ?? {},
  };
};

const writeSessionTargetRegistry = (
  sessionPaths: SessionPaths,
  registry: SessionTargetRegistry,
) => {
  writeJsonAtomic(sessionTargetRegistryPath(sessionPaths), registry);
};

const mirrorSnapshotToPath = (
  snapshot: SnapshotDocument,
  destinationStatePath: string,
  destinationScreenshotPath: string,
) => {
  const nextSnapshot: SnapshotDocument = {
    ...snapshot,
    screenshotPath: snapshot.screenshotPath
      ? destinationScreenshotPath
      : snapshot.screenshotPath,
    screenshot: snapshot.screenshot
      ? {
          ...snapshot.screenshot,
          path:
            snapshot.screenshotPath || snapshot.screenshot.path
              ? destinationScreenshotPath
              : snapshot.screenshot.path,
        }
      : snapshot.screenshot,
  };
  if (
    snapshot.screenshotPath &&
    snapshot.screenshotPath !== destinationScreenshotPath &&
    fs.existsSync(snapshot.screenshotPath)
  ) {
    fs.mkdirSync(path.dirname(destinationScreenshotPath), { recursive: true });
    fs.copyFileSync(snapshot.screenshotPath, destinationScreenshotPath);
  }
  writeJsonAtomic(destinationStatePath, nextSnapshot);
};

const syncSessionTargetSnapshot = (
  sessionPaths: SessionPaths,
  statePath: string,
) => {
  const snapshot = readSnapshotDocument(statePath);
  if (!snapshot?.ok) {
    return;
  }
  const key = targetKeyFromSnapshot(snapshot);
  const targetStatePath = sessionTargetStatePath(sessionPaths, key);
  const targetScreenshotPath = deriveScreenshotPath(targetStatePath);
  mirrorSnapshotToPath(snapshot, targetStatePath, targetScreenshotPath);
  if (statePath !== sessionPaths.statePath) {
    mirrorSnapshotToPath(
      snapshot,
      sessionPaths.statePath,
      sessionPaths.screenshotPath,
    );
  }
  const registry = readSessionTargetRegistry(sessionPaths);
  registry.activeTargetKey = key;
  registry.targets[key] = {
    key,
    appName: snapshot.appName,
    bundleId: snapshot.bundleId ?? null,
    pid: snapshot.pid,
    windowTitle: snapshot.windowTitle ?? null,
    statePath: targetStatePath,
    screenshotPath: targetScreenshotPath,
    capturedAt: snapshot.capturedAt ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeSessionTargetRegistry(sessionPaths, registry);
};

const hasTargetSelector = (selector: SessionTargetSelector) =>
  selector.pid != null || !!selector.bundleId || !!selector.appName;

const describeTargetSelector = (selector: SessionTargetSelector) => {
  if (selector.bundleId) return `bundle '${selector.bundleId}'`;
  if (selector.pid != null) return `pid ${selector.pid}`;
  if (selector.appName) return `app '${selector.appName}'`;
  return "the requested target";
};

const consumeActionTargetSelector = (args: string[]) => {
  let nextArgs = args;
  const pidResult = stripOptionValue(nextArgs, "--pid");
  nextArgs = pidResult.args;
  const bundleResult = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundleResult.args;
  const appResult = stripOptionValue(nextArgs, "--app");
  nextArgs = appResult.args;
  const invalidPid =
    pidResult.value != null && !Number.isFinite(Number(pidResult.value));
  const parsedPid =
    pidResult.value != null && Number.isFinite(Number(pidResult.value))
      ? Number(pidResult.value)
      : null;
  return {
    args: nextArgs,
    selector: {
      pid: parsedPid,
      bundleId: bundleResult.value,
      appName: appResult.value,
    } satisfies SessionTargetSelector,
    missingValue:
      pidResult.missingValue ||
      bundleResult.missingValue ||
      appResult.missingValue,
    invalidPid,
  };
};

const consumeActionObservationProvenance = (args: string[]) => {
  let nextArgs = args;
  const stateResult = stripOptionValue(nextArgs, "--observed-state-id");
  nextArgs = stateResult.args;
  const visualResult = stripOptionValue(nextArgs, "--observed-visual-state-id");
  return {
    args: visualResult.args,
    observedStateId: stateResult.value,
    observedVisualStateId: visualResult.value,
    missingValue: stateResult.missingValue || visualResult.missingValue,
  };
};

const resolveTargetRecord = (
  sessionPaths: SessionPaths,
  selector: SessionTargetSelector,
): SessionTargetRecord => {
  const registry = readSessionTargetRegistry(sessionPaths);
  const targets = Object.values(registry.targets);
  if (selector.pid != null) {
    const exact = targets.find((target) => target.pid === selector.pid);
    if (exact) return exact;
    throw new Error(
      `No cached target snapshot for pid ${selector.pid} in session '${sessionPaths.sessionId}'. Take a snapshot of that app first.`,
    );
  }
  if (selector.bundleId) {
    const needle = normalizeTargetKey(selector.bundleId);
    const exact = targets.find(
      (target) => normalizeTargetKey(target.bundleId ?? "") === needle,
    );
    if (exact) return exact;
    throw new Error(
      `No cached target snapshot for bundle '${selector.bundleId}' in session '${sessionPaths.sessionId}'. Take a snapshot of that app first.`,
    );
  }
  if (selector.appName) {
    const needle = normalizeTargetKey(selector.appName);
    const exact = targets.filter(
      (target) => normalizeTargetKey(target.appName ?? "") === needle,
    );
    if (exact.length === 1) {
      return exact[0]!;
    }
    if (exact.length > 1) {
      throw new Error(
        `Multiple cached targets match --app '${selector.appName}'. Use --bundle-id or --pid instead.`,
      );
    }
    const fuzzy = targets.filter((target) => {
      const appName = normalizeTargetKey(target.appName ?? "");
      const bundleId = normalizeTargetKey(target.bundleId ?? "");
      return appName.includes(needle) || bundleId.includes(needle);
    });
    if (fuzzy.length === 1) {
      return fuzzy[0]!;
    }
    if (fuzzy.length > 1) {
      throw new Error(
        `Multiple cached targets partially match --app '${selector.appName}'. Use --bundle-id or --pid instead.`,
      );
    }
    throw new Error(
      `No cached target snapshot for app '${selector.appName}' in session '${sessionPaths.sessionId}'. Take a snapshot of that app first.`,
    );
  }
  throw new Error(
    `No target selector provided for session '${sessionPaths.sessionId}'.`,
  );
};

const resolveActionStatePath = (
  sessionPaths: SessionPaths,
  args: string[],
  selector: SessionTargetSelector,
) => {
  const explicitStatePath = getOptionValue(args, "--state");
  if (explicitStatePath) {
    return explicitStatePath;
  }
  if (!hasTargetSelector(selector)) {
    return sessionPaths.statePath;
  }
  return resolveTargetRecord(sessionPaths, selector).statePath;
};

const translateScreenshotCoordinateCommand = (
  command: string,
  args: string[],
  statePath: string,
) => {
  if (command !== "click-screenshot" && command !== "drag-screenshot") {
    return { command, args };
  }

  const { positionals, options } = splitArgsIntoPositionalsAndOptions(args);
  const snapshot = readSnapshotDocument(statePath);

  if (command === "click-screenshot") {
    if (positionals.length < 2) {
      throw new Error("click-screenshot requires x_px and y_px.");
    }
    const xPx = Number(positionals[0]);
    const yPx = Number(positionals[1]);
    const { point, error } = screenshotPixelToScreenPoint(snapshot, xPx, yPx);
    if (!point) {
      throw new Error(error ?? "Failed to map screenshot pixel coordinates.");
    }
    return {
      command: "click-point",
      args: [String(point.x), String(point.y), ...options],
    };
  }

  if (positionals.length < 4) {
    throw new Error(
      "drag-screenshot requires from_x_px, from_y_px, to_x_px, and to_y_px.",
    );
  }

  const fromX = Number(positionals[0]);
  const fromY = Number(positionals[1]);
  const toX = Number(positionals[2]);
  const toY = Number(positionals[3]);
  const fromPoint = screenshotPixelToScreenPoint(snapshot, fromX, fromY);
  if (!fromPoint.point) {
    throw new Error(
      fromPoint.error ?? "Failed to map drag start screenshot coordinates.",
    );
  }
  const toPoint = screenshotPixelToScreenPoint(snapshot, toX, toY);
  if (!toPoint.point) {
    throw new Error(
      toPoint.error ?? "Failed to map drag end screenshot coordinates.",
    );
  }

  return {
    command: "drag",
    args: [
      String(fromPoint.point.x),
      String(fromPoint.point.y),
      String(toPoint.point.x),
      String(toPoint.point.y),
      ...options,
    ],
  };
};

const ensureCommandPaths = (command: string, args: string[]) => {
  if (command === "list-apps") {
    return;
  }

  const statePath = getOptionValue(args, "--state");
  if (statePath) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  }

  if (command === "snapshot") {
    const screenshotPath = getOptionValue(args, "--screenshot");
    if (screenshotPath) {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    }
  }
};

const validateHidAccess = (
  command: string,
  args: string[],
  jsonMode: boolean,
) => {
  if (
    command === "click" &&
    hasOption(args, "--coordinate-fallback") &&
    !hidAllowed(args)
  ) {
    emitError(
      {
        ok: false,
        error:
          "Coordinate fallback requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1.",
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  if (
    (command === "drag" ||
      command === "drag-element" ||
      command === "type" ||
      command === "press") &&
    !hidAllowed(args)
  ) {
    emitError(
      {
        ok: false,
        error: `${command} requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1 because it sends global HID events.`,
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }
};

// The argv CLI path. It deliberately does not route through
// executeMacComputerUseRequest: it forwards native argv (target resolution,
// --state/--screenshot files, HID opt-in) to the daemon, takes the directory
// locks and locked-use lease itself, and prints human-readable output, while
// the typed path resolves targets from list_apps, requires observed state ids
// for actions, and returns structured responses.
const runCommand = async (
  command: string,
  args: string[],
  jsonMode: boolean,
  sessionOverride?: string | null,
): Promise<number> => {
  const sessionPaths = resolveSessionPaths(sessionOverride);
  ensureStateDirectory(sessionPaths);
  pruneComputerSessions(sessionPaths.sessionId, [
    automationSocketsDir(),
    locksDir(),
  ]);

  let effectiveCommand = command === "get-state" ? "snapshot" : command;
  let effectiveArgs = args;
  let selectedStatePath = sessionPaths.statePath;
  let actionObservation:
    | {
        observedStateId: string | null;
        observedVisualStateId: string | null;
      }
    | undefined;
  const isListCommand =
    effectiveCommand === "list-apps" || effectiveCommand === "list-windows";
  if (!isListCommand && effectiveCommand !== "snapshot") {
    const observation = consumeActionObservationProvenance(effectiveArgs);
    if (observation.missingValue) {
      emitError(
        {
          ok: false,
          error:
            "Observation provenance flags require a value. Use --observed-state-id ID and --observed-visual-state-id ID.",
          warnings: [],
          screenshotPath: null,
        },
        jsonMode,
      );
      return 1;
    }
    effectiveArgs = observation.args;
    actionObservation = {
      observedStateId: observation.observedStateId,
      observedVisualStateId: observation.observedVisualStateId,
    };
    const selection = consumeActionTargetSelector(effectiveArgs);
    if (selection.missingValue) {
      emitError(
        {
          ok: false,
          error:
            "Target selectors require a value. Use --app NAME, --bundle-id ID, or --pid PID.",
          warnings: [],
          screenshotPath: null,
        },
        jsonMode,
      );
      return 1;
    }
    if (selection.invalidPid) {
      emitError(
        {
          ok: false,
          error: "Target selector --pid requires a numeric PID.",
          warnings: [],
          screenshotPath: null,
        },
        jsonMode,
      );
      return 1;
    }
    effectiveArgs = selection.args;
    try {
      selectedStatePath = resolveActionStatePath(
        sessionPaths,
        effectiveArgs,
        selection.selector,
      );
    } catch (error) {
      emitError(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          warnings: hasTargetSelector(selection.selector)
            ? [
                `Session target selection failed for ${describeTargetSelector(
                  selection.selector,
                )}.`,
              ]
            : [],
          screenshotPath: null,
        },
        jsonMode,
      );
      return 1;
    }
  }
  try {
    const translated = translateScreenshotCoordinateCommand(
      effectiveCommand,
      effectiveArgs,
      selectedStatePath,
    );
    effectiveCommand = translated.command;
    effectiveArgs = translated.args;
  } catch (error) {
    emitError(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  const initialHelperArgs = isListCommand
    ? [effectiveCommand]
    : effectiveCommand === "snapshot"
      ? ["snapshot", ...ensureSnapshotArgs(effectiveArgs, sessionPaths)]
      : [effectiveCommand, ...withStatePath(effectiveArgs, selectedStatePath)];
  const statePathForCommand =
    effectiveCommand === "snapshot"
      ? (getOptionValue(initialHelperArgs.slice(1), "--state") ??
        sessionPaths.statePath)
      : selectedStatePath;
  const previousSnapshotForDiff = !isListCommand
    ? readSnapshotDocument(statePathForCommand)
    : null;
  const deferredObservation =
    effectiveCommand !== "snapshot" &&
    !isListCommand &&
    hasOption(initialHelperArgs.slice(1), "--defer-observation");
  const disableDiff = hasOption(initialHelperArgs.slice(1), "--disable-diff");

  validateHidAccess(effectiveCommand, initialHelperArgs.slice(1), jsonMode);
  ensureCommandPaths(effectiveCommand, initialHelperArgs.slice(1));

  let releaseLocks: (() => void) | undefined;
  try {
    releaseLocks = await acquireLocks(
      resolveLockKeys(
        effectiveCommand,
        initialHelperArgs.slice(1),
        sessionPaths,
      ),
      sessionPaths.sessionId,
    );
  } catch (error) {
    emitError(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  let lockedUseLeaseOpened = false;
  try {
    if (actionObservation?.observedStateId) {
      await validateCliActionObservation(
        sessionPaths,
        selectedStatePath,
        actionObservation.observedStateId,
        actionObservation.observedVisualStateId ?? undefined,
      );
    }
    if (!isListCommand) {
      lockedUseLeaseOpened = await maybeBeginLockedUseLease(sessionPaths);
    }

    const result = await runAutomationDaemonCommand(
      sessionPaths,
      initialHelperArgs,
    );

    if (result.error) {
      throw result.error;
    }
    if (result.timedOut) {
      const payload = {
        ok: false,
        error: result.stderr || "desktop_automation timed out",
        warnings: result.stdout
          ? ["Partial helper output was discarded after timeout."]
          : [],
        screenshotPath: null,
      } satisfies ErrorPayload;
      if (jsonMode) {
        writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        formatError(payload);
      }
      return 1;
    }
    if (!result.stdout) {
      const payload = {
        ok: false,
        error: result.stderr || "desktop_automation returned no output",
        warnings: [],
        screenshotPath: null,
      } satisfies ErrorPayload;
      if (jsonMode) {
        writeComputerStdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        formatError(payload);
      }
      return 1;
    }

    const parsed = parseJson<
      | SnapshotDocument
      | ActionPayload
      | ListAppsPayload
      | ListWindowsPayload
      | ErrorPayload
    >(result.stdout);
    const stateUpdated =
      effectiveCommand === "snapshot" ||
      (!deferredObservation &&
        (parsed as ActionPayload).stateUpdated !== false);

    if (parsed.ok && !isListCommand && stateUpdated) {
      syncSessionTargetSnapshot(sessionPaths, statePathForCommand);
    }

    const currentSnapshotForDiff =
      parsed.ok && !isListCommand && stateUpdated
        ? (readSnapshotDocument(statePathForCommand) ??
          (effectiveCommand === "snapshot"
            ? (parsed as SnapshotDocument)
            : null))
        : null;
    const stateDiff =
      currentSnapshotForDiff && !isListCommand && !disableDiff
        ? snapshotDiff(previousSnapshotForDiff, currentSnapshotForDiff)
        : null;

    if (jsonMode) {
      const jsonPayload = stateDiff ? { ...parsed, stateDiff } : parsed;
      writeComputerStdout(`${JSON.stringify(jsonPayload, null, 2)}\n`);
      return result.status === 0 ? 0 : 1;
    }

    if (!parsed.ok) {
      formatError(parsed as ErrorPayload);
      return 1;
    }

    if (effectiveCommand === "list-apps") {
      formatListApps(parsed as ListAppsPayload);
    } else if (effectiveCommand === "list-windows") {
      formatListWindows(parsed as ListWindowsPayload);
    } else if (effectiveCommand === "snapshot") {
      formatSnapshot(
        readSnapshotDocument(statePathForCommand) ??
          (parsed as SnapshotDocument),
      );
    } else {
      formatAction(parsed as ActionPayload, currentSnapshotForDiff, stateDiff);
    }

    return 0;
  } finally {
    if (lockedUseLeaseOpened) {
      await endLockedUseLease(sessionPaths);
    }
    releaseLocks?.();
  }
};

export type StellaComputerExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type StellaComputerExecutionOptions = ComputerExecutionContextOptions & {
  timeoutMs?: number;
};

const macForbiddenBundleIdentifiers = new Set([
  "com.stella.desktop",
  "com.stella.app",
  "com.stella.app.dev",
  "com.stella.runtime",
  "com.apple.systempreferences",
  "com.apple.systemsettings",
  "com.apple.keychainaccess",
  "com.apple.security.keychain-access",
  "com.apple.securityagent",
  "com.apple.localauthentication.uiagent",
  "com.1password.1password",
  "com.1password.1password7",
  "com.agilebits.onepassword7",
  "com.lastpass.lastpassmacdesktop",
  "com.bitwarden.desktop",
  "com.dashlane.dashlane",
]);

const typedResponseEnvelope = (request: ComputerUseRequest) => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

class ComputerUseWaitTimeoutError extends Error {
  readonly code = "wait_timeout";
  readonly retryable = true;

  constructor(
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    readonly pollCount: number,
    readonly afterStateId: string,
    readonly afterVisualStateId?: string,
  ) {
    super(
      `Computer state did not change within ${timeoutMs}ms (after_state_id=${afterStateId}, polls=${pollCount}, elapsed_ms=${elapsedMs}).`,
    );
    this.name = "ComputerUseWaitTimeoutError";
  }
}

const computerUseErrorResponse = (
  request: ComputerUseRequest,
  error: unknown,
): Extract<ComputerUseResponse, { type: "error" }> => ({
  ...typedResponseEnvelope(request),
  type: "error",
  error: {
    code:
      error instanceof ComputerUseResourceStaleError
        ? error.code
        : error instanceof ComputerUseWaitTimeoutError
          ? error.code
          : "native_request_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable:
      error instanceof ComputerUseResourceStaleError ||
      error instanceof ComputerUseWaitTimeoutError
        ? error.retryable
        : false,
    ...(error instanceof ComputerUseResourceStaleError
      ? {
          details: {
            observedStateId: error.observedStateId,
            currentStateId: error.currentStateId,
            ...(error.resourceKeys
              ? { resourceKeys: [...error.resourceKeys] }
              : {}),
            ...(error.observedResourceGeneration !== undefined
              ? {
                  observedResourceGeneration: error.observedResourceGeneration,
                }
              : {}),
            ...(error.currentResourceGeneration !== undefined
              ? { currentResourceGeneration: error.currentResourceGeneration }
              : {}),
            ...(error.nativeObserved
              ? { nativeObserved: error.nativeObserved }
              : {}),
            ...(error.nativeCurrent
              ? { nativeCurrent: error.nativeCurrent }
              : {}),
            ...(error.nativeReason ? { nativeReason: error.nativeReason } : {}),
          },
        }
      : {}),
    ...(error instanceof ComputerUseWaitTimeoutError
      ? {
          details: {
            timeoutMs: error.timeoutMs,
            elapsedMs: error.elapsedMs,
            pollCount: error.pollCount,
            afterStateId: error.afterStateId,
            ...(error.afterVisualStateId
              ? { afterVisualStateId: error.afterVisualStateId }
              : {}),
          },
        }
      : {}),
  },
});

const typedTargetKey = (target: TypedAutomationTarget) => {
  const bundleId = normalizeTargetKey(target.bundleId ?? "");
  if (bundleId) return `bundle-${bundleId}`;
  const appName = normalizeTargetKey(target.appName ?? "");
  if (appName) return `app-${appName}`;
  return `pid-${target.pid}`;
};

const policyForMacTarget = (app: ListedAppPayload): ComputerUseAppPolicy => {
  const bundleIdentifier = app.bundleId?.trim() || `pid:${app.pid}`;
  const canonical = bundleIdentifier.toLocaleLowerCase();
  const configuredForbidden = new Set(
    (process.env.STELLA_COMPUTER_FORBIDDEN_BUNDLES ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  return {
    bundleIdentifier,
    displayName: app.name,
    decision:
      macForbiddenBundleIdentifiers.has(canonical) ||
      configuredForbidden.has(canonical)
        ? "forbidden"
        : "allowed",
    allowPersistentApproval: Boolean(app.bundleId),
    warningSubtitle: "Stella can view and interact with this app.",
  };
};

const targetSelectorLabel = (target: ComputerUseTarget) =>
  target.type === "app" ? target.app : `window ${target.windowId}`;

const resolveMacTypedTarget = async (
  sessionPaths: SessionPaths,
  target: ComputerUseTarget,
): Promise<{
  target: TypedAutomationTarget;
  policy: ComputerUseAppPolicy;
}> => {
  const apps = (await runAutomationDaemonTypedOperation(sessionPaths, {
    type: "list_apps",
  })) as ListAppsPayload;
  if (!apps?.ok || !Array.isArray(apps.apps)) {
    throw new Error("desktop_automation returned an invalid application list.");
  }

  let visibleWindows: ListWindowsPayload | undefined;
  const windows = async () => {
    if (!visibleWindows) {
      visibleWindows = (await runAutomationDaemonTypedOperation(sessionPaths, {
        type: "list_windows",
      })) as ListWindowsPayload;
    }
    return visibleWindows.windows ?? [];
  };
  const preferVisibleWindowOwner = async (candidates: ListedAppPayload[]) => {
    if (candidates.length <= 1) return candidates[0];
    const visiblePids = new Set((await windows()).map((window) => window.pid));
    const visible = candidates.filter((app) => visiblePids.has(app.pid));
    if (visible.length === 1) return visible[0];
    const active = visible.filter((app) => app.isActive);
    if (active.length === 1) return active[0];
    return undefined;
  };

  let matched: ListedAppPayload | undefined;
  if (target.type === "window") {
    const windowId = Number(target.windowId);
    const window = (await windows()).find(
      (candidate) => candidate.windowId === windowId,
    );
    if (!window) {
      throw new Error(`No running window matches id ${target.windowId}.`);
    }
    matched = apps.apps.find((app) => app.pid === window.pid);
  } else {
    const needle = target.app.trim().toLocaleLowerCase();
    const exact = apps.apps.filter(
      (app) =>
        app.name.toLocaleLowerCase() === needle ||
        app.bundleId?.toLocaleLowerCase() === needle,
    );
    matched = await preferVisibleWindowOwner(exact);
    if (!matched) {
      const fuzzy = apps.apps.filter(
        (app) =>
          app.name.toLocaleLowerCase().includes(needle) ||
          app.bundleId?.toLocaleLowerCase().includes(needle),
      );
      matched = await preferVisibleWindowOwner(fuzzy);
      if (!matched && fuzzy.length > 1) {
        throw new Error(
          `Multiple running apps match '${target.app}'. Use a bundle identifier.`,
        );
      }
    }
  }
  if (!matched) {
    throw new Error(`No running app matches ${targetSelectorLabel(target)}.`);
  }
  return {
    target: {
      pid: matched.pid,
      appName: matched.name,
      ...(matched.bundleId ? { bundleId: matched.bundleId } : {}),
    },
    policy: policyForMacTarget(matched),
  };
};

const actionState = (
  sessionPaths: SessionPaths,
  target: TypedAutomationTarget,
): TypedAutomationState => {
  const statePath = sessionTargetStatePath(
    sessionPaths,
    typedTargetKey(target),
  );
  if (!readSnapshotDocument(statePath)?.ok) {
    throw new Error(
      `No cached state exists for ${target.appName ?? target.bundleId ?? target.pid}. Call get_app_state first.`,
    );
  }
  return {
    path: statePath,
    sessionId: sessionPaths.sessionId,
    screenshotPolicy: "never",
    inlineScreenshot: false,
  };
};

const screenPointForAction = (statePath: string, x: number, y: number) => {
  const { point, error } = screenshotPixelToScreenPoint(
    readSnapshotDocument(statePath),
    x,
    y,
  );
  if (!point) throw new Error(error ?? "Failed to map screenshot coordinates.");
  return point;
};

const typedNativeAction = (
  action: ComputerUseAction,
  statePath: string,
): TypedAutomationAction => {
  switch (action.type) {
    case "click_element":
      return {
        kind: "click",
        ref: action.elementId,
        mouseButton: action.mouseButton,
        clickCount: action.clickCount,
        options: { deferObservation: true, raise: false },
      };
    case "click_point": {
      const point = screenPointForAction(
        statePath,
        action.point.x,
        action.point.y,
      );
      return {
        kind: "click_point",
        x: point.x,
        y: point.y,
        mouseButton: action.mouseButton,
        clickCount: action.clickCount,
        options: { allowHid: true, deferObservation: true, raise: false },
      };
    }
    case "drag": {
      const from = screenPointForAction(
        statePath,
        action.from.x,
        action.from.y,
      );
      const to = screenPointForAction(statePath, action.to.x, action.to.y);
      return {
        kind: "drag",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        options: { allowHid: true, deferObservation: true, raise: false },
      };
    }
    case "perform_secondary_action":
      return {
        kind: "secondary_action",
        ref: action.elementId,
        name: action.action,
        options: { deferObservation: true, raise: false },
      };
    case "press_key":
      return {
        kind: "press",
        key: action.key,
        options: { allowHid: true, deferObservation: true, raise: false },
      };
    case "scroll":
      return {
        kind: "scroll",
        ref: action.elementId,
        direction: action.direction,
        pages: action.pages,
        options: { deferObservation: true, raise: false },
      };
    case "select_text":
      return {
        kind: "select_text",
        ref: action.elementId,
        text: action.text,
        ...(action.prefix === undefined ? {} : { prefix: action.prefix }),
        ...(action.suffix === undefined ? {} : { suffix: action.suffix }),
        ...(action.selectionType === undefined
          ? {}
          : { selection: action.selectionType }),
        options: { deferObservation: true, raise: false },
      };
    case "set_value":
      return {
        kind: "fill",
        ref: action.elementId,
        text: action.value,
        options: { deferObservation: true, raise: false },
      };
    case "type_text":
      return {
        kind: "type",
        text: action.text,
        options: { allowHid: true, deferObservation: true, raise: false },
      };
  }
};

const typedActionOperation = async (
  sessionPaths: SessionPaths,
  command: ComputerUseActionCommand,
): Promise<TypedAutomationOperation> => {
  if (!command.observedStateId) {
    throw new Error(
      `${command.action.type} requires observedStateId before native dispatch.`,
    );
  }
  const resolved = await resolveMacTypedTarget(sessionPaths, command.target);
  const state = actionState(sessionPaths, resolved.target);
  const validationPath = `${state.path}.validation`;
  let precondition: TypedAutomationObservationPrecondition;
  try {
    const current = await captureMacState(
      sessionPaths,
      resolved.target,
      validationPath,
      command.observedVisualStateId ? "always" : "never",
    );
    const currentStateId = snapshotStateId(current);
    if (currentStateId !== command.observedStateId) {
      throw new ComputerUseResourceStaleError(
        command.observedStateId,
        currentStateId,
      );
    }
    if (command.observedVisualStateId) {
      const currentVisualStateId =
        snapshotVisualStateId(current) ?? "visual_state_missing";
      if (currentVisualStateId !== command.observedVisualStateId) {
        throw new ComputerUseResourceStaleError(
          command.observedVisualStateId,
          currentVisualStateId,
        );
      }
    }
    precondition = {
      observedStateId: command.observedStateId,
      ...(command.observedVisualStateId
        ? { observedVisualStateId: command.observedVisualStateId }
        : {}),
      targetPid: current.pid,
      ...(current.bundleId ? { targetBundleId: current.bundleId } : {}),
      ...(current.windowId != null ? { windowId: current.windowId } : {}),
      ...(current.windowTitle ? { windowTitle: current.windowTitle } : {}),
      ...(current.windowFrame ? { windowFrame: current.windowFrame } : {}),
      ...(current.revision != null
        ? { observerRevision: current.revision }
        : {}),
      ...(current.materializedRevision != null &&
      current.materializedRevision === current.revision
        ? { materializedRevision: current.materializedRevision }
        : {}),
      ...(current.screenshot?.treeRevision != null
        ? { visualTreeRevision: current.screenshot.treeRevision }
        : {}),
      ...(current.screenshot?.widthPx != null
        ? { screenshotWidthPx: current.screenshot.widthPx }
        : {}),
      ...(current.screenshot?.heightPx != null
        ? { screenshotHeightPx: current.screenshot.heightPx }
        : {}),
    };
  } finally {
    removeWaitArtifacts(validationPath);
  }
  const stableTarget: TypedAutomationTarget = resolved.target.bundleId
    ? { bundleId: resolved.target.bundleId }
    : resolved.target.appName
      ? { appName: resolved.target.appName }
      : resolved.target;
  return {
    type: "action",
    target: stableTarget,
    state,
    action: typedNativeAction(command.action, state.path),
    precondition,
  };
};

const actionReceiptFromNative = (
  command: ComputerUseActionCommand,
  payload: ActionPayload,
) => ({
  type: "action" as const,
  action: command.action.type,
  target: command.target,
  status:
    payload.deferred === false ? ("completed" as const) : ("accepted" as const),
  deferred: payload.deferred !== false,
  details: payload as unknown as JsonObject,
});

const macStatePath = (
  sessionPaths: SessionPaths,
  target: TypedAutomationTarget,
) => sessionTargetStatePath(sessionPaths, typedTargetKey(target));

const captureMacState = async (
  sessionPaths: SessionPaths,
  target: TypedAutomationTarget,
  statePath: string,
  screenshotPolicy: "auto" | "always" | "never",
) =>
  (await runAutomationDaemonTypedOperation(sessionPaths, {
    type: "get_app_state",
    target,
    state: {
      path: statePath,
      sessionId: sessionPaths.sessionId,
      screenshotPath:
        screenshotPolicy === "never"
          ? undefined
          : deriveScreenshotPath(statePath),
      screenshotPolicy,
      inlineScreenshot: false,
    },
  })) as SnapshotDocument;

const validateCliActionObservation = async (
  sessionPaths: SessionPaths,
  statePath: string,
  observedStateId: string,
  observedVisualStateId?: string,
) => {
  const baseline = readSnapshotDocument(statePath);
  if (!baseline?.ok) {
    throw new Error(
      "No cached state exists for the supplied observation. Call get-state before acting.",
    );
  }
  const target: TypedAutomationTarget = {
    pid: baseline.pid,
    appName: baseline.appName,
    ...(baseline.bundleId ? { bundleId: baseline.bundleId } : {}),
  };
  const validationPath = `${statePath}.provenance-${randomUUID()}`;
  try {
    const current = await captureMacState(
      sessionPaths,
      target,
      validationPath,
      observedVisualStateId ? "always" : "never",
    );
    const currentStateId = snapshotStateId(current);
    if (currentStateId !== observedStateId) {
      throw new ComputerUseResourceStaleError(observedStateId, currentStateId);
    }
    if (observedVisualStateId) {
      const currentVisualStateId =
        snapshotVisualStateId(current) ?? "visual_state_missing";
      if (currentVisualStateId !== observedVisualStateId) {
        throw new ComputerUseResourceStaleError(
          observedVisualStateId,
          currentVisualStateId,
        );
      }
    }
  } finally {
    removeWaitArtifacts(validationPath);
  }
};

const renderMacState = (input: {
  snapshot: SnapshotDocument;
  previous?: SnapshotDocument | null;
  app: string;
  disableDiff: boolean;
  wait?: ComputerUseWaitProvenance;
}): ComputerUseAppState => {
  const { snapshot, previous = null } = input;
  const diff = previous ? snapshotDiff(previous, snapshot) : null;
  const useDiff =
    !input.disableDiff && Boolean(diff && shouldUseDiffOnly(diff));
  const stateId = snapshotStateId(snapshot);
  const visualStateId = snapshotVisualStateId(snapshot);
  const baseStateId =
    useDiff && previous ? snapshotStateId(previous) : undefined;
  const baseVisualStateId =
    useDiff && previous ? snapshotVisualStateId(previous) : undefined;
  const imagePath = snapshot.screenshot?.path ?? snapshot.screenshotPath;
  return {
    app: input.app,
    text: useDiff
      ? formatStateDiffBlock(diff!).trim()
      : appStateLines(snapshot).join("\n"),
    stateId,
    semanticStateId: stateId,
    ...(visualStateId ? { visualStateId } : {}),
    ...(baseStateId ? { baseStateId } : {}),
    ...(baseVisualStateId ? { baseVisualStateId } : {}),
    representation: useDiff ? "diff" : "full",
    ...(input.wait ? { wait: input.wait } : {}),
    screenshot:
      imagePath && path.isAbsolute(imagePath)
        ? {
            type: "image",
            url: pathToFileURL(imagePath).href,
            ...(snapshot.screenshot?.mimeType
              ? { mimeType: snapshot.screenshot.mimeType }
              : {}),
            ...(snapshot.screenshot?.widthPx
              ? { width: snapshot.screenshot.widthPx }
              : {}),
            ...(snapshot.screenshot?.heightPx
              ? { height: snapshot.screenshot.heightPx }
              : {}),
          }
        : null,
    ...(snapshot.appInstructions
      ? { instructions: snapshot.appInstructions }
      : {}),
  };
};

const waitStatePath = (canonicalPath: string, requestId: string) =>
  `${canonicalPath}.wait-${requestId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;

const removeWaitArtifacts = (statePath: string) => {
  fs.rmSync(statePath, { force: true });
  fs.rmSync(deriveScreenshotPath(statePath), { force: true });
};

const executeMacComputerUseRequest = async (
  request: ComputerUseRequest,
): Promise<ComputerUseResponse> => {
  const sessionPaths = resolveSessionPaths(request.sessionId);
  ensureStateDirectory(sessionPaths);
  pruneComputerSessions(sessionPaths.sessionId, [
    automationSocketsDir(),
    locksDir(),
  ]);
  const envelope = typedResponseEnvelope(request);

  if (request.type === "list_apps") {
    const payload = (await runAutomationDaemonTypedOperation(sessionPaths, {
      type: "list_apps",
    })) as ListAppsPayload;
    const rendered = payload.apps
      .map(
        (app) =>
          `${app.name}${app.bundleId ? ` [${app.bundleId}]` : ""} (pid ${app.pid})${app.isActive ? " [active]" : ""}`,
      )
      .join("\n");
    return { ...envelope, type: "list_apps", text: rendered };
  }
  if (request.type === "list_windows") {
    const payload = (await runAutomationDaemonTypedOperation(sessionPaths, {
      type: "list_windows",
    })) as ListWindowsPayload;
    const rendered = payload.windows
      .map(
        (window) =>
          `${window.appName}${window.title ? ` - ${window.title}` : ""}${window.bundleId ? ` [${window.bundleId}]` : ""} [window-id=${window.windowId}, pid=${window.pid}]`,
      )
      .join("\n");
    return { ...envelope, type: "list_windows", text: rendered };
  }
  if (request.type === "resolve_target") {
    const resolved = await resolveMacTypedTarget(
      sessionPaths,
      request.selector,
    );
    return { ...envelope, type: "target_policy", policy: resolved.policy };
  }
  if (request.type === "get_app_state") {
    const resolved = await resolveMacTypedTarget(sessionPaths, request.target);
    const statePath = macStatePath(sessionPaths, resolved.target);
    const previous = readSnapshotDocument(statePath);
    const snapshot = await captureMacState(
      sessionPaths,
      resolved.target,
      statePath,
      request.screenshotPolicy,
    );
    syncSessionTargetSnapshot(sessionPaths, statePath);
    return {
      ...envelope,
      type: "app_state",
      state: renderMacState({
        snapshot,
        previous,
        app: resolved.policy.bundleIdentifier,
        disableDiff: request.disableDiff,
      }),
    };
  }
  if (request.type === "wait_for_change") {
    const resolved = await resolveMacTypedTarget(sessionPaths, request.target);
    const statePath = macStatePath(sessionPaths, resolved.target);
    const baseline = readSnapshotDocument(statePath);
    if (!baseline) {
      throw new Error(
        `No baseline state is available for ${resolved.policy.displayName}. Call get_app_state before wait_for_change.`,
      );
    }
    const baselineStateId = snapshotStateId(baseline);
    if (baselineStateId !== request.afterStateId) {
      throw new ComputerUseResourceStaleError(
        request.afterStateId,
        baselineStateId,
      );
    }
    const baselineVisualStateId = snapshotVisualStateId(baseline);
    if (
      request.afterVisualStateId &&
      baselineVisualStateId !== request.afterVisualStateId
    ) {
      throw new ComputerUseResourceStaleError(
        request.afterVisualStateId,
        baselineVisualStateId ?? "visual_state_missing",
      );
    }

    const temporaryStatePath = waitStatePath(statePath, request.requestId);
    const startedAt = Date.now();
    let pollCount = 0;
    try {
      for (;;) {
        throwIfComputerExecutionAborted();
        pollCount += 1;
        const poll = await captureMacState(
          sessionPaths,
          resolved.target,
          temporaryStatePath,
          request.afterVisualStateId ? "always" : "never",
        );
        const pollStateId = snapshotStateId(poll);
        const pollVisualStateId = snapshotVisualStateId(poll);
        const semanticChanged = pollStateId !== request.afterStateId;
        const visualChanged = Boolean(
          request.afterVisualStateId &&
            pollVisualStateId &&
            pollVisualStateId !== request.afterVisualStateId,
        );
        if (semanticChanged || visualChanged) {
          const finalSnapshot = await captureMacState(
            sessionPaths,
            resolved.target,
            temporaryStatePath,
            request.afterVisualStateId && request.screenshotPolicy === "auto"
              ? "always"
              : request.screenshotPolicy,
          );
          const finalStateId = snapshotStateId(finalSnapshot);
          const finalVisualStateId = snapshotVisualStateId(finalSnapshot);
          const changeKinds: ComputerUseWaitProvenance["changeKinds"] = [
            ...(finalStateId !== request.afterStateId
              ? (["semantic"] as const)
              : []),
            ...(request.afterVisualStateId &&
            finalVisualStateId &&
            finalVisualStateId !== request.afterVisualStateId
              ? (["visual"] as const)
              : []),
          ];
          if (changeKinds.length > 0) {
            mirrorSnapshotToPath(
              finalSnapshot,
              statePath,
              deriveScreenshotPath(statePath),
            );
            const committedSnapshot =
              readSnapshotDocument(statePath) ?? finalSnapshot;
            syncSessionTargetSnapshot(sessionPaths, statePath);
            return {
              ...envelope,
              type: "wait_for_change",
              state: renderMacState({
                snapshot: committedSnapshot,
                previous: baseline,
                app: resolved.policy.bundleIdentifier,
                disableDiff: request.disableDiff,
                wait: {
                  afterStateId: request.afterStateId,
                  ...(request.afterVisualStateId
                    ? { afterVisualStateId: request.afterVisualStateId }
                    : {}),
                  timeoutMs: request.timeoutMs,
                  elapsedMs: Date.now() - startedAt,
                  pollCount,
                  changeKinds,
                },
              }),
            };
          }
        }
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = request.timeoutMs - elapsedMs;
        if (remainingMs <= 0) {
          throw new ComputerUseWaitTimeoutError(
            request.timeoutMs,
            elapsedMs,
            pollCount,
            request.afterStateId,
            request.afterVisualStateId,
          );
        }
        await abortableComputerDelay(Math.min(150, remainingMs));
      }
    } finally {
      removeWaitArtifacts(temporaryStatePath);
    }
  }
  if (request.type === "action") {
    const operation = await typedActionOperation(sessionPaths, request.command);
    const payload = (await runAutomationDaemonTypedOperation(
      sessionPaths,
      operation,
    )) as ActionPayload;
    return {
      ...envelope,
      type: "action",
      receipt: actionReceiptFromNative(request.command, payload),
    };
  }

  const operations: TypedAutomationOperation[] = [];
  for (const command of request.commands) {
    operations.push(await typedActionOperation(sessionPaths, command));
  }
  const batchPayload = (await runAutomationDaemonTypedOperation(sessionPaths, {
    type: "batch",
    operations,
  })) as TypedAutomationBatchPayload;
  const payloads = batchPayload?.results?.map(
    (entry) => entry.result as ActionPayload,
  );
  if (
    batchPayload?.completed !== request.commands.length ||
    !Array.isArray(payloads) ||
    payloads.length !== request.commands.length
  ) {
    throw new Error("desktop_automation returned an invalid batch result.");
  }
  return {
    ...envelope,
    type: "batch",
    receipt: {
      type: "batch",
      receipts: payloads.map((payload, index) =>
        actionReceiptFromNative(request.commands[index]!, payload),
      ),
    },
  };
};

const requestDeadlineMs = (
  request: ComputerUseRequest,
  configuredMs: number,
): number => {
  if (request.type === "wait_for_change") {
    return Math.max(1, Math.min(125_000, request.timeoutMs + 5_000));
  }
  const operationLimit =
    request.type === "get_app_state"
      ? 25_000
      : request.type === "list_apps" ||
          request.type === "list_windows" ||
          request.type === "resolve_target"
        ? 10_000
        : configuredMs;
  return Math.max(1, Math.min(configuredMs, operationLimit));
};

export const __testOnlyComputerRequestDeadlineMs = requestDeadlineMs;

export const createMacComputerUseSession = (options: {
  sessionId: string;
  commandTimeoutMs?: number;
  getSignal?: () => AbortSignal | undefined;
  /**
   * Worker CLI-bridge socket. When present, the automation daemon is spawned
   * by the Electron host through this bridge so it stays under the single
   * "Stella" macOS TCC identity (see ensureAutomationDaemon).
   */
  cliBridgeSocketPath?: string;
}): ComputerUseSession => ({
  request: async (request, requestOptions) => {
    try {
      assertComputerUseRequest(request);
      if (request.sessionId !== options.sessionId) {
        throw new Error(
          "Computer-use request session does not match its native session.",
        );
      }
      const signal = requestOptions?.signal ?? options.getSignal?.();
      const timeoutMs = requestDeadlineMs(
        request,
        options.commandTimeoutMs ?? automationDaemonRequestTimeoutMs,
      );
      const result = await runWithComputerExecutionContext(
        {
          signal,
          timeoutMs,
          ...(options.cliBridgeSocketPath
            ? {
                env: {
                  ...process.env,
                  STELLA_CLI_BRIDGE_SOCK: options.cliBridgeSocketPath,
                },
              }
            : {}),
        },
        async () =>
          await macComputerUseResourceArbiter.runRequest(
            request,
            signal,
            async () => await executeMacComputerUseRequest(request),
          ),
      );
      return result.value;
    } catch (error) {
      return computerUseErrorResponse(request, error);
    }
  },
});

export const shutdownMacStellaComputerSession = (
  sessionId: string,
): boolean => {
  if (process.platform !== "darwin") return false;
  macComputerUseResourceArbiter.forgetSession(sessionId);
  const sanitized = sanitizeStellaComputerSessionId(sessionId);
  if (!sanitized) return false;
  if (sanitized !== sessionId) {
    macComputerUseResourceArbiter.forgetSession(sanitized);
  }
  return stopAutomationDaemon(resolveSessionPaths(sanitized));
};

const SUPPORTED_COMMANDS = new Set([
  "list-apps",
  "list-windows",
  "snapshot",
  "get-state",
  "click",
  "fill",
  "select-text",
  "focus",
  "secondary-action",
  "perform-secondary-action",
  "scroll",
  "drag",
  "drag-element",
  "click-point",
  "click-screenshot",
  "drag-screenshot",
  "type",
  "press",
  "shutdown-session",
]);

const executeArgv = async (rawArgv: string[]): Promise<number> => {
  const {
    value: sessionOverride,
    args: argv,
    missingValue: missingSessionValue,
  } = stripOptionValue(rawArgv, "--session");

  if (missingSessionValue) {
    writeComputerStderr("--session requires a value.\n");
    return 1;
  }

  if (process.platform === "win32" && argv[0] === "shutdown-session") {
    const sessionId =
      sanitizeStellaComputerSessionId(sessionOverride) ??
      DEFAULT_COMPUTER_SESSION_ID;
    const stopped = await cleanupWindowsStellaComputerSessionDaemon(sessionId);
    const { found: jsonMode } = stripFlag(argv.slice(1), "--json");
    if (jsonMode) {
      writeComputerStdout(
        `${JSON.stringify({ ok: true, sessionId, stopped })}\n`,
      );
    } else {
      writeComputerStdout(
        `Computer session ${sessionId} ${stopped ? "stopped" : "was already stopped"}.\n`,
      );
    }
    return 0;
  }

  if (process.platform === "win32") {
    return await runWindowsStellaComputer(
      argv,
      argv.includes("--json"),
      sessionOverride,
    );
  }

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeComputerStdout(usage);
    return 0;
  }

  if (process.platform !== "darwin") {
    writeComputerStderr(
      "stella-computer is currently only available on macOS.\n",
    );
    return 1;
  }

  const command = argv[0]!;
  const restArgs = argv.slice(1);
  const { found: jsonMode, args: plainArgs } = stripFlag(restArgs, "--json");

  if (command === "shutdown-session") {
    const sessionId =
      sanitizeStellaComputerSessionId(sessionOverride) ??
      DEFAULT_COMPUTER_SESSION_ID;
    const stopped = shutdownMacStellaComputerSession(sessionId);
    if (jsonMode) {
      writeComputerStdout(
        `${JSON.stringify({ ok: true, sessionId, stopped })}\n`,
      );
    } else {
      writeComputerStdout(
        `Computer session ${sessionId} ${stopped ? "stopped" : "was already stopped"}.\n`,
      );
    }
    return 0;
  }

  if (command === "locked-use") {
    return await runLockedUseManagementCommand(plainArgs[0], jsonMode);
  }
  if (!SUPPORTED_COMMANDS.has(command)) {
    writeComputerStderr(`Unknown command: ${command}\n\n${usage}`);
    return 1;
  }
  return await runCommand(command, plainArgs, jsonMode, sessionOverride);
};

export const executeStellaComputerCommand = async (
  argv: string[],
  options: StellaComputerExecutionOptions = {},
): Promise<StellaComputerExecutionResult> => {
  // Effect-ratchet pin (1 new AbortController): this is the seam controller
  // whose real AbortSignal rides the execution context into native helper
  // children, daemon sockets, and bridge requests — non-Effect consumers
  // that need a genuine AbortSignal.
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("Computer command aborted."),
    );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  // The execution deadline is a forked timeout fiber aborting the seam
  // controller, interrupted in the finally block on every exit path (the
  // cleared, unref'd setTimeout analogue — cancellation in finally keeps
  // CLI process liveness identical).
  const cancelTimeout =
    options.timeoutMs && options.timeoutMs > 0
      ? forkCancelableTimeout(options.timeoutMs, () =>
          controller.abort(
            new Error(
              `Computer command timed out after ${options.timeoutMs}ms.`,
            ),
          ),
        )
      : null;

  try {
    return await runWithComputerExecutionContext(
      { ...options, signal: controller.signal },
      async () => {
        try {
          return await executeArgv([...argv]);
        } catch (error) {
          if (error instanceof StellaComputerExitError) return error.exitCode;
          writeComputerStderr(
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
          return 1;
        }
      },
    ).then(({ value, stdout, stderr }) => ({
      exitCode: value,
      stdout,
      stderr,
    }));
  } finally {
    cancelTimeout?.();
    options.signal?.removeEventListener("abort", onAbort);
  }
};
