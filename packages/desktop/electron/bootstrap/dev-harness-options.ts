import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const STELLA_DEV_HARNESS_ADDRESS = "127.0.0.1" as const;
export const STELLA_DEV_HARNESS_APP_NAME_PREFIX = "Stella v2 Harness" as const;

export type DevHarnessOptions = {
  /** Distinct macOS safeStorage / Keychain namespace for this profile. */
  appName: string;
  userDataDir: string;
  remoteDebuggingAddress: typeof STELLA_DEV_HARNESS_ADDRESS;
  /** Canonical base-10 value, ready for Electron's appendSwitch API. */
  remoteDebuggingPort: string;
};

export type DevHarnessElectronTarget = {
  setName: (name: string) => void;
  setPath: (name: "userData", value: string) => void;
  commandLine: {
    appendSwitch: (name: string, value: string) => void;
  };
};

type DevHarnessEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolveDevHarnessSessionTokenInput = {
  isPackaged: boolean;
  hasStoredBearer: boolean;
  env?: DevHarnessEnvironment;
};

export const resolveDevHarnessSessionToken = ({
  isPackaged,
  hasStoredBearer,
  env = process.env,
}: ResolveDevHarnessSessionTokenInput): string | null => {
  if (
    isPackaged ||
    env.STELLA_DEV_HARNESS !== "1" ||
    hasStoredBearer
  ) {
    return null;
  }
  return env.STELLA_DEV_HARNESS_SESSION_TOKEN?.trim() || null;
};

export type ResolveDevHarnessOptionsInput = {
  isPackaged: boolean;
  workspaceDir: string;
  env?: DevHarnessEnvironment;
  homeDir?: string;
  tempDir?: string;
};

const isPathWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const pathsOverlap = (left: string, right: string): boolean =>
  isPathWithin(left, right) || isPathWithin(right, left);

const canonicalPathIfPresent = (candidate: string): string => {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
};

const harnessAppNameForProfile = (canonicalProfilePath: string): string =>
  `${STELLA_DEV_HARNESS_APP_NAME_PREFIX} ${createHash("sha256")
    .update(canonicalProfilePath)
    .digest("hex")
    .slice(0, 12)}`;

const resolveHarnessUserDataDir = (args: {
  raw: string | undefined;
  workspaceDir: string;
  homeDir: string;
  tempDir: string;
}): string => {
  const raw = args.raw?.trim() ?? "";
  if (!raw) {
    throw new Error(
      "STELLA_V2_DEV_USER_DATA_DIR is required when STELLA_DEV_HARNESS=1.",
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new Error("STELLA_V2_DEV_USER_DATA_DIR must be absolute.");
  }

  const lexical = path.resolve(raw);
  const root = path.parse(lexical).root;
  const homeDir = canonicalPathIfPresent(args.homeDir);
  const workspaceDir = canonicalPathIfPresent(args.workspaceDir);
  const liveStellaDir = canonicalPathIfPresent(
    path.join(args.homeDir, ".stella"),
  );
  const tempDir = canonicalPathIfPresent(args.tempDir);

  const rejectBroadOrProtectedPath = (candidate: string): void => {
    const parent = path.dirname(candidate);
    const containsTempRoot = isPathWithin(tempDir, candidate);
    if (
      candidate === root ||
      parent === root ||
      candidate === tempDir ||
      containsTempRoot ||
      pathsOverlap(candidate, homeDir) ||
      pathsOverlap(candidate, workspaceDir) ||
      pathsOverlap(candidate, liveStellaDir)
    ) {
      throw new Error(
        "STELLA_V2_DEV_USER_DATA_DIR must be a narrow directory outside home, the workspace, and live ~/.stella trees.",
      );
    }
  };

  // Check the spelling before filesystem resolution, then check the canonical
  // target as well so a symlink cannot redirect the harness into protected data.
  rejectBroadOrProtectedPath(lexical);

  let canonical: string;
  try {
    canonical = realpathSync(lexical);
  } catch {
    throw new Error(
      "STELLA_V2_DEV_USER_DATA_DIR must be an existing directory.",
    );
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(
      "STELLA_V2_DEV_USER_DATA_DIR must be an existing directory.",
    );
  }
  rejectBroadOrProtectedPath(canonical);
  return canonical;
};

const resolveRemoteDebuggingPort = (rawValue: string | undefined): string => {
  const raw = rawValue?.trim() ?? "";
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(
      "STELLA_REMOTE_DEBUG_PORT must be 0 or an integer from 1024 through 65535.",
    );
  }
  const port = Number(raw);
  if (
    !Number.isSafeInteger(port) ||
    (port !== 0 && port < 1024) ||
    port > 65_535
  ) {
    throw new Error(
      "STELLA_REMOTE_DEBUG_PORT must be 0 or an integer from 1024 through 65535.",
    );
  }
  return String(port);
};

/**
 * Resolve the opt-in dev-harness settings without importing or mutating
 * Electron. Packaged builds and ordinary development ignore every harness
 * variable, including malformed values.
 */
export const resolveDevHarnessOptions = ({
  isPackaged,
  workspaceDir,
  env = process.env,
  homeDir = os.homedir(),
  tempDir = os.tmpdir(),
}: ResolveDevHarnessOptionsInput): DevHarnessOptions | null => {
  if (isPackaged || env.STELLA_DEV_HARNESS !== "1") {
    return null;
  }

  const userDataDir = resolveHarnessUserDataDir({
    raw: env.STELLA_V2_DEV_USER_DATA_DIR,
    workspaceDir,
    homeDir,
    tempDir,
  });

  return {
    appName: harnessAppNameForProfile(userDataDir),
    userDataDir,
    remoteDebuggingAddress: STELLA_DEV_HARNESS_ADDRESS,
    remoteDebuggingPort: resolveRemoteDebuggingPort(
      env.STELLA_REMOTE_DEBUG_PORT,
    ),
  };
};

/** Apply a previously validated option set before Electron becomes ready. */
export const applyDevHarnessOptions = (
  target: DevHarnessElectronTarget,
  options: DevHarnessOptions,
): void => {
  // On macOS, safeStorage derives its Keychain service from app.name. Set the
  // per-profile name before any storage access so an acceptance harness cannot
  // read or mutate the ordinary development app's Keychain item.
  target.setName(options.appName);
  target.setPath("userData", options.userDataDir);
  target.commandLine.appendSwitch(
    "remote-debugging-address",
    STELLA_DEV_HARNESS_ADDRESS,
  );
  target.commandLine.appendSwitch(
    "remote-debugging-port",
    options.remoteDebuggingPort,
  );
};
