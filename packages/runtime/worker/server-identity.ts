import { randomUUID } from "node:crypto";

/**
 * Logical identity of one runtime process, for the app ↔ runtime handshake.
 *
 * The detached runtime outlives the app, and its socket path is keyed only by
 * the Stella root, so "something answers on the socket" is not proof that it
 * is the runtime the app expects. Each runtime boot mints a fresh `serverId`
 * and reports it, with its root, pid, build stamp and the environment it must
 * share with its app, in the readiness probe and the attach result:
 *
 *   - The attach pipeline verifies the probed identity against what this app
 *     expects (same root, the pidfile's pid, the same shared environment) and
 *     replaces a runtime that fails it, including a pre-identity runtime.
 *   - The peer socket is a second connection, so `runtime.attach` names the
 *     probed `serverId` and the runtime refuses a mismatch; a runtime that was
 *     replaced between probe and attach can never adopt the client.
 *
 * The build stamp is reported but not enforced here: a stale-code runtime is
 * replaced by the staleness handshake, which defers until in-flight work
 * finishes instead of killing it.
 */

export type RuntimeServerIdentity = {
  /** Fresh per runtime process boot (the runtime "instance"). */
  serverId: string;
  /** `hashStellaAppDir` of the root this runtime serves. */
  rootHash: string;
  pid: number;
  /** Build stamp of the runtime code loaded at boot (generation), when known. */
  buildStamp: string | null;
  protocolVersion: string;
  startedAtMs: number;
  /** The `RUNTIME_SHARED_ENV_KEYS` values this runtime booted with. */
  launchEnv: Record<string, string>;
};

/**
 * Environment the runtime must share with its app. Each one names a resource
 * both sides address independently (the browser bridge socket directory and
 * the in-app browser bootstrap session), so a runtime spawned under different
 * values would talk to another instance's endpoints.
 */
export const RUNTIME_SHARED_ENV_KEYS = [
  "STELLA_BROWSER_SOCKET_DIR",
  "STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION",
] as const;

export const readRuntimeLaunchEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const launchEnv: Record<string, string> = {};
  for (const key of RUNTIME_SHARED_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) launchEnv[key] = value;
  }
  return launchEnv;
};

export const createRuntimeServerIdentity = (args: {
  rootHash: string;
  buildStamp: string | null;
  protocolVersion: string;
}): RuntimeServerIdentity => ({
  serverId: randomUUID(),
  rootHash: args.rootHash,
  pid: process.pid,
  buildStamp: args.buildStamp,
  protocolVersion: args.protocolVersion,
  startedAtMs: Date.now(),
  launchEnv: readRuntimeLaunchEnv(),
});

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

export const parseRuntimeServerIdentity = (
  value: unknown,
): RuntimeServerIdentity | null => {
  const candidate = value as Partial<RuntimeServerIdentity> | null;
  if (
    !candidate ||
    typeof candidate.serverId !== "string" ||
    !candidate.serverId ||
    typeof candidate.rootHash !== "string" ||
    typeof candidate.pid !== "number" ||
    typeof candidate.protocolVersion !== "string" ||
    !isStringRecord(candidate.launchEnv)
  ) {
    return null;
  }
  return {
    serverId: candidate.serverId,
    rootHash: candidate.rootHash,
    pid: candidate.pid,
    buildStamp:
      typeof candidate.buildStamp === "string" ? candidate.buildStamp : null,
    protocolVersion: candidate.protocolVersion,
    startedAtMs:
      typeof candidate.startedAtMs === "number" ? candidate.startedAtMs : 0,
    launchEnv: candidate.launchEnv,
  };
};

/** What a client expects of the runtime it is about to adopt. */
export type ExpectedRuntimeServerIdentity = {
  rootHash: string;
  /** The pidfile's pid, when attaching to an existing runtime. */
  pid?: number;
  /** A specific instance, when the identity was already probed. */
  serverId?: string;
  launchEnv?: Record<string, string>;
};

const sameLaunchEnv = (
  left: Record<string, string>,
  right: Record<string, string>,
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
};

/**
 * Why `actual` is not the runtime `expected` describes, or null when it is.
 * A missing identity is a pre-identity runtime: never adopted.
 */
export const describeRuntimeServerIdentityMismatch = (
  expected: ExpectedRuntimeServerIdentity,
  actual: RuntimeServerIdentity | null,
): string | null => {
  if (!actual) return "the runtime predates the identity handshake";
  if (actual.rootHash !== expected.rootHash) {
    return `the runtime serves root ${actual.rootHash}, expected ${expected.rootHash}`;
  }
  if (expected.serverId && actual.serverId !== expected.serverId) {
    return `runtime instance ${actual.serverId} answered, expected ${expected.serverId}`;
  }
  if (expected.pid != null && actual.pid !== expected.pid) {
    return `runtime pid ${actual.pid} answered, but the pidfile names ${expected.pid}`;
  }
  if (expected.launchEnv && !sameLaunchEnv(expected.launchEnv, actual.launchEnv)) {
    return `the runtime booted with a different shared environment (${JSON.stringify(actual.launchEnv)}, expected ${JSON.stringify(expected.launchEnv)})`;
  }
  return null;
};
