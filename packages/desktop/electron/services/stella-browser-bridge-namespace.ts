import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveDesktopStellaDataDirPath } from "../data-paths.js";

const execFileAsync = promisify(execFile);

/**
 * Which browser bridge this Stella instance runs, and who owns it.
 *
 * The bridge's session name, socket directory, extension port and Chrome
 * native-messaging host are per user, so every Stella instance (the installed
 * app and any dev checkout) used to launch the same bridge and close or kill
 * whichever daemon was already there. Two live instances stole it from each
 * other on every retry, and a stale dev binary could replace the app's daemon
 * with one that lacks newer commands.
 *
 * - Namespace. The installed app runs the shared bridge, the one the Chrome
 *   extension reaches (its native-messaging host name and port 39040 are fixed
 *   by the extension, so there is only one per user). A dev checkout runs an
 *   isolated bridge by default: its own socket directory derived from its data
 *   dir (inherited by its runtime through STELLA_BROWSER_SOCKET_DIR), a free
 *   loopback extension port, and no native-messaging registration. The in-app
 *   browser and agent browsers keep working there; the user's Chrome extension
 *   stays with the installed app. `STELLA_BROWSER_BRIDGE=shared` opts a dev
 *   checkout into the shared bridge (and claims it), `=isolated` isolates any
 *   instance. Windows addresses daemons by TCP ports derived from the session
 *   name, so a directory cannot isolate it there: Windows always uses the
 *   shared namespace and relies on ownership alone.
 *
 * - Ownership. The launching instance records itself next to the daemon
 *   (`<session>.owner.json`). Before closing or killing anything, a launch
 *   reads that record: a daemon owned by another live instance is only ever
 *   replaced by a higher-priority instance (a dev checkout that opted in
 *   claims, then the installed app, then an unclaimed dev checkout), and never
 *   with an older bridge binary. A lower or equal priority instance defers and
 *   retries, so a replaced instance does not steal the bridge back.
 */

export type BrowserBridgeMode = "shared" | "isolated";

export type BrowserBridgeNamespace = Readonly<{
  mode: BrowserBridgeMode;
  socketDir: string;
  /** Opted in to take the shared bridge from another live instance. */
  claim: boolean;
  packaged: boolean;
  /** Fixed extension port, or null to pick a free loopback port per launch. */
  extPort: number | null;
  /** Whether this instance writes the Chrome native-messaging host. */
  ownsExtensionChannel: boolean;
  dataDir: string | null;
}>;

/** `shared` | `isolated`; unset picks by packaging. */
export const STELLA_BROWSER_BRIDGE_MODE_ENV = "STELLA_BROWSER_BRIDGE";
/** Lets an opted-in claim replace a newer bridge binary. */
export const STELLA_BROWSER_BRIDGE_ALLOW_DOWNGRADE_ENV =
  "STELLA_BROWSER_BRIDGE_ALLOW_DOWNGRADE";

const SHARED_EXTENSION_PORT = 39040;

/** Mirror of `getStellaBrowserSocketDir`, ignoring the explicit override. */
const defaultSocketDir = (env: NodeJS.ProcessEnv): string => {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, "stella-browser");
  const homeDir = os.homedir().trim();
  if (homeDir) return path.join(homeDir, ".stella-browser");
  return path.join(os.tmpdir(), "stella-browser");
};

const isolatedSocketDirName = (dataDir: string): string =>
  `i-${createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 12)}`;

export const resolveBrowserBridgeNamespace = (options: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): BrowserBridgeNamespace => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const requested = env[STELLA_BROWSER_BRIDGE_MODE_ENV]?.trim().toLowerCase();
  const dataDir = resolveDesktopStellaDataDirPath({
    mode: options.isPackaged ? "production" : "development",
    configuredStatePath: options.isPackaged
      ? env.STELLA_DATA_DIR
      : env.STELLA_V2_DEV_DATA_DIR,
  });
  const wantsIsolated =
    requested === "isolated" ||
    (requested !== "shared" && !options.isPackaged);
  const mode: BrowserBridgeMode =
    wantsIsolated && platform !== "win32" ? "isolated" : "shared";
  const explicitSocketDir = env.STELLA_BROWSER_SOCKET_DIR?.trim();
  const socketDir =
    explicitSocketDir ||
    (mode === "isolated"
      ? path.join(defaultSocketDir(env), isolatedSocketDirName(dataDir))
      : defaultSocketDir(env));
  return Object.freeze({
    mode,
    socketDir,
    claim: !options.isPackaged && requested === "shared",
    packaged: options.isPackaged,
    extPort: mode === "isolated" ? null : SHARED_EXTENSION_PORT,
    ownsExtensionChannel: mode === "shared",
    dataDir,
  });
};

let configuredNamespace: BrowserBridgeNamespace | null = null;

/**
 * Resolve this process's bridge namespace and publish its socket directory in
 * the environment, so every module that reads it (the bridge config, the
 * native-messaging shim, the in-app browser endpoint) and the runtime spawned
 * from this process agree. Must run before those modules load.
 */
export const configureBrowserBridgeNamespace = (options: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): BrowserBridgeNamespace => {
  const env = options.env ?? process.env;
  const namespace = resolveBrowserBridgeNamespace({
    isPackaged: options.isPackaged,
    env,
  });
  if (namespace.mode === "isolated") {
    env.STELLA_BROWSER_SOCKET_DIR = namespace.socketDir;
  }
  configuredNamespace = namespace;
  return namespace;
};

/**
 * The configured namespace, or the legacy shared one when nothing configured
 * it (tests, tools): the per-user directory, port 39040, no claim.
 */
export const getBrowserBridgeNamespace = (): BrowserBridgeNamespace =>
  configuredNamespace ??
  Object.freeze({
    mode: "shared" as const,
    socketDir:
      process.env.STELLA_BROWSER_SOCKET_DIR?.trim() ||
      defaultSocketDir(process.env),
    claim: false,
    packaged: false,
    extPort: SHARED_EXTENSION_PORT,
    ownsExtensionChannel: true,
    dataDir: null,
  });

/** A free loopback port for an isolated bridge's extension listener. */
export const pickFreeLoopbackPort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error("No free loopback port.")),
      );
    });
  });

// ---------------------------------------------------------------------------
// Ownership

/** This Electron process. Every bridge it launches is recorded under it. */
export const BROWSER_BRIDGE_INSTANCE_ID = randomUUID();

export type BrowserBridgeBinaryIdentity = Readonly<{
  path: string;
  /** `stella-browser --version`, e.g. "0.9.1"; null when it did not answer. */
  version: string | null;
  /** Source commit from the hydration manifest, when the binary has one. */
  sourceSha: string | null;
  size: number;
  mtimeMs: number;
}>;

export type BrowserBridgeOwnerRecord = Readonly<{
  version: 1;
  instanceId: string;
  /** The owning Electron main process. */
  ownerPid: number;
  daemonPid: number | null;
  mode: BrowserBridgeMode;
  claim: boolean;
  packaged: boolean;
  dataDir: string | null;
  stellaAppDir: string;
  binary: BrowserBridgeBinaryIdentity | null;
  recordedAtMs: number;
}>;

/** A record younger than this counts as live while its daemon is still booting. */
const LAUNCH_GRACE_MS = 60_000;

const ownerRecordPath = (socketDir: string, session: string) =>
  path.join(socketDir, `${session}.owner.json`);

export const pidIsAlive = (pid: number | null | undefined): boolean => {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readBrowserBridgeOwner = (
  socketDir: string,
  session: string,
): BrowserBridgeOwnerRecord | null => {
  try {
    const parsed = JSON.parse(
      readFileSync(ownerRecordPath(socketDir, session), "utf8"),
    ) as Partial<BrowserBridgeOwnerRecord>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.ownerPid !== "number"
    ) {
      return null;
    }
    return parsed as BrowserBridgeOwnerRecord;
  } catch {
    return null;
  }
};

export const writeBrowserBridgeOwner = (
  socketDir: string,
  session: string,
  record: BrowserBridgeOwnerRecord,
): void => {
  mkdirSync(socketDir, { recursive: true });
  const target = ownerRecordPath(socketDir, session);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, target);
};

/** Remove the record only if this instance wrote it. */
export const releaseBrowserBridgeOwner = (
  socketDir: string,
  session: string,
): void => {
  const current = readBrowserBridgeOwner(socketDir, session);
  if (current?.instanceId !== BROWSER_BRIDGE_INSTANCE_ID) return;
  try {
    unlinkSync(ownerRecordPath(socketDir, session));
  } catch {
    // Already gone.
  }
};

/**
 * Whether the recorded owner is a different, still-running instance: its
 * Electron process is alive and either its daemon is alive or it is still
 * launching one. (A reused owner pid with a dead daemon ages out.)
 */
export const isLiveForeignOwner = (
  record: BrowserBridgeOwnerRecord | null,
  now = Date.now(),
): record is BrowserBridgeOwnerRecord =>
  Boolean(
    record &&
      record.instanceId !== BROWSER_BRIDGE_INSTANCE_ID &&
      record.ownerPid !== process.pid &&
      pidIsAlive(record.ownerPid) &&
      (pidIsAlive(record.daemonPid) || now - record.recordedAtMs < LAUNCH_GRACE_MS),
  );

/** Opted-in dev claim > installed app > unclaimed dev checkout. */
const ownerPriority = (owner: { claim: boolean; packaged: boolean }): number =>
  owner.claim ? 2 : owner.packaged ? 1 : 0;

const parseVersion = (value: string | null): number[] | null => {
  const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map((part) => Number(part)) : null;
};

/** -1 when `left` is older than `right`, 1 newer, 0 same/unknown. */
export const compareBridgeBinaryVersions = (
  left: string | null,
  right: string | null,
): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
};

export type BrowserBridgeTakeoverDecision =
  | Readonly<{ action: "proceed"; replacing: "none" | "own" | "orphan" | "legacy" }>
  | Readonly<{ action: "replace-live"; owner: BrowserBridgeOwnerRecord }>
  | Readonly<{ action: "defer"; owner: BrowserBridgeOwnerRecord; reason: string }>;

/**
 * The handshake a launch runs before it closes or kills anything in its
 * namespace: may this instance replace whatever daemon is there?
 */
export const decideBrowserBridgeTakeover = (args: {
  namespace: BrowserBridgeNamespace;
  owner: BrowserBridgeOwnerRecord | null;
  binary: BrowserBridgeBinaryIdentity | null;
  env?: NodeJS.ProcessEnv;
}): BrowserBridgeTakeoverDecision => {
  const { owner, namespace } = args;
  if (!owner) return { action: "proceed", replacing: "legacy" };
  if (owner.instanceId === BROWSER_BRIDGE_INSTANCE_ID) {
    return { action: "proceed", replacing: "own" };
  }
  if (!isLiveForeignOwner(owner)) {
    return { action: "proceed", replacing: "orphan" };
  }
  const describeOwner = `${owner.packaged ? "the installed Stella app" : "a Stella dev checkout"} (pid ${owner.ownerPid}${owner.dataDir ? `, data ${owner.dataDir}` : ""})`;
  if (ownerPriority(namespace) <= ownerPriority(owner)) {
    return {
      action: "defer",
      owner,
      reason: `The browser bridge is in use by ${describeOwner}. ${
        namespace.packaged
          ? "Stella will take it over when that instance exits."
          : `Set ${STELLA_BROWSER_BRIDGE_MODE_ENV}=shared to claim it from this dev checkout, or leave it unset for an isolated bridge.`
      }`,
    };
  }
  const env = args.env ?? process.env;
  if (
    env[STELLA_BROWSER_BRIDGE_ALLOW_DOWNGRADE_ENV] !== "1" &&
    compareBridgeBinaryVersions(
      args.binary?.version ?? null,
      owner.binary?.version ?? null,
    ) < 0
  ) {
    return {
      action: "defer",
      owner,
      reason: `Refusing to replace the browser bridge of ${describeOwner}: its bridge binary ${owner.binary?.version} is newer than this instance's ${args.binary?.version}. Rebuild or rehydrate stella-browser, or set ${STELLA_BROWSER_BRIDGE_ALLOW_DOWNGRADE_ENV}=1.`,
    };
  }
  return { action: "replace-live", owner };
};

const binaryIdentityCache = new Map<string, BrowserBridgeBinaryIdentity>();

const readHydrationSourceSha = (binaryPath: string): string | null => {
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(path.dirname(binaryPath), ".stella-browser.json"),
        "utf8",
      ),
    ) as { sourceSha?: unknown };
    return typeof manifest.sourceSha === "string" ? manifest.sourceSha : null;
  } catch {
    return null;
  }
};

/** Identify a bridge binary (cached per path, size and mtime). */
export const readBrowserBridgeBinaryIdentity = async (
  binaryPath: string,
): Promise<BrowserBridgeBinaryIdentity | null> => {
  let size = 0;
  let mtimeMs = 0;
  try {
    const stats = statSync(binaryPath);
    size = stats.size;
    mtimeMs = Math.round(stats.mtimeMs);
  } catch {
    return null;
  }
  const key = `${binaryPath}\0${size}\0${mtimeMs}`;
  const cached = binaryIdentityCache.get(key);
  if (cached) return cached;
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    version = stdout.trim().match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  } catch {
    version = null;
  }
  const identity = Object.freeze({
    path: binaryPath,
    version,
    sourceSha: readHydrationSourceSha(binaryPath),
    size,
    mtimeMs,
  });
  binaryIdentityCache.set(key, identity);
  return identity;
};

/** The pid the session's daemon recorded at boot, or null. */
export const readBrowserBridgeDaemonPid = (
  socketDir: string,
  session: string,
): number | null => {
  try {
    const pid = Number.parseInt(
      readFileSync(path.join(socketDir, `${session}.pid`), "utf8").trim(),
      10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};
