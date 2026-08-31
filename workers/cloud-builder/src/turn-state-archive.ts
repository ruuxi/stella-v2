import type { ExecutionSession } from "@cloudflare/sandbox";
import { Effect, Fiber } from "effect";
import {
  forkAbortTimer,
  runToolEffect,
  toolsRuntime,
} from "@stella/runtime/kernel/tools/effect-runtime.js";
import { NATIVE_STATE_DIRECTORY } from "./native-state-checkpoint.js";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_OBJECT_PREFIX,
  TURN_STATE_SCHEMA_VERSION,
  TURN_STATE_MAX_ARCHIVE_BYTES,
  type TurnStateArchive,
  type TurnStateObjectKind,
} from "./turn-state-registry.js";
import { WORLD_ROOT } from "./workspace.js";

export { TURN_STATE_MAX_ARCHIVE_BYTES };

export type TurnStateArchiveTarget = { kind: "workspace" } | { kind: "native" };

export type TurnStateArchiveSession = Pick<
  ExecutionSession,
  "exec" | "readFile" | "writeFile"
>;

export type UploadTurnStateArchiveResult = {
  archive: TurnStateArchive;
  /** True when an exact prior upload was recovered or reused. */
  replayed: boolean;
};

const ARCHIVE_HOST_ROOT = "/home/stella-host-state";
const ARCHIVE_SCRATCH_ROOT = `${ARCHIVE_HOST_ROOT}/turn-state-archive`;
const ARCHIVE_STREAM_TIMEOUT_MS = 15 * 60 * 1_000;
const ARCHIVE_STREAM_CANCEL_GRACE_MS = 1_000;
const ARCHIVE_CLAIM_STALE_MINUTES = 20;
const ARCHIVE_OWNED_LOCK_WAIT_SECONDS = 30;
export const TURN_STATE_ARCHIVE_CONTENT_TYPE =
  "application/vnd.squashfs" as const;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const ARCHIVE_KEY = new RegExp(
  `^${TURN_STATE_OBJECT_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/` +
    "([0-9a-f]{64})/([0-9a-f]{64})/[0-9a-f]{64}/[0-9a-f]{64}/" +
    "[1-9][0-9]*-([0-9a-f]{64})/(workspace|native)\\.sqsh$",
  "u",
);

type ArchiveKeyParts = {
  ownerHash: string;
  workspaceHash: string;
  operationId: string;
  pairAddress: string;
  kind: TurnStateObjectKind;
};

const targetSource = (target: TurnStateArchiveTarget): string =>
  target.kind === "workspace" ? WORLD_ROOT : NATIVE_STATE_DIRECTORY;

const targetParent = (target: TurnStateArchiveTarget): string =>
  target.kind === "workspace" ? "/workspace" : "/home/stella-native-state";

const targetOwnerMode = (target: TurnStateArchiveTarget): string =>
  target.kind === "workspace" ? "42424:42424:750" : "0:0:700";

const targetPathSlug = (target: TurnStateArchiveTarget): string =>
  target.kind === "workspace" ? "workspace-world" : "native";

const newScratchId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const scratchPaths = (target: TurnStateArchiveTarget, scratchId: string) => {
  if (!HEX_SHA256.test(scratchId)) {
    throw new Error("Turn state archive scratch id is invalid.");
  }
  const slug = targetPathSlug(target);
  const parent = targetParent(target);
  return {
    archivePath: `${ARCHIVE_SCRATCH_ROOT}/${slug}-${scratchId}.sqsh`,
    restorePath: `${parent}/.stella-turn-state-restore-${slug}-${scratchId}`,
    priorPath: `${parent}/.stella-turn-state-prior-${slug}`,
    failedPath: `${parent}/.stella-turn-state-retired-${slug}`,
  } as const;
};

const runCommand = async (
  session: TurnStateArchiveSession,
  command: string,
  label: string,
): Promise<string> => {
  const result = await session.exec(command, {
    origin: "internal",
    timeout: 15 * 60 * 1_000,
  });
  if (!result.success) {
    throw new Error(`${label} failed.`);
  }
  return result.stdout;
};

const prepareArchiveLockCommand = (target: TurnStateArchiveTarget): string => {
  const lockPath = targetLockPath(target);
  return [
    "set -eu",
    "umask 077",
    `test -d ${ARCHIVE_HOST_ROOT}`,
    `test ! -L ${ARCHIVE_HOST_ROOT}`,
    `test "$(/usr/bin/readlink -f -- ${ARCHIVE_HOST_ROOT})" = ${ARCHIVE_HOST_ROOT}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${ARCHIVE_HOST_ROOT})" = 0:0:700`,
    `if [ ! -e ${ARCHIVE_SCRATCH_ROOT} ] && [ ! -L ${ARCHIVE_SCRATCH_ROOT} ]; then /usr/bin/install -d -o root -g root -m 0700 ${ARCHIVE_SCRATCH_ROOT}; fi`,
    `test -d ${ARCHIVE_SCRATCH_ROOT}`,
    `test ! -L ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/readlink -f -- ${ARCHIVE_SCRATCH_ROOT})" = ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${ARCHIVE_SCRATCH_ROOT})" = 0:0:700`,
    'test "$(/usr/bin/readlink -f -- /usr/bin/flock)" = /usr/bin/flock',
    "test \"$(/usr/bin/stat -c '%u:%g:%a:%h' -- /usr/bin/flock)\" = 0:0:755:1",
    // noclobber makes first creation an O_EXCL-style race: a second claimant
    // tolerates EEXIST and validates the same inode instead of replacing the
    // inode on which the first process already holds flock(2).
    `if [ ! -e ${lockPath} ] && [ ! -L ${lockPath} ]; then (umask 077; set -C; : > ${lockPath}) 2>/dev/null || true; fi`,
    `test -f ${lockPath}`,
    `test ! -L ${lockPath}`,
    `test "$(/usr/bin/readlink -f -- ${lockPath})" = ${lockPath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${lockPath})" = 0:0:600:1`,
  ].join("\n");
};

const targetLockPath = (target: TurnStateArchiveTarget): string =>
  `${ARCHIVE_SCRATCH_ROOT}/lock-${targetPathSlug(target)}`;

const targetClaimPath = (target: TurnStateArchiveTarget): string =>
  `${ARCHIVE_SCRATCH_ROOT}/claim-${targetPathSlug(target)}`;

const sweepTargetScratchCommand = (target: TurnStateArchiveTarget): string => {
  const slug = targetPathSlug(target);
  return [
    `/usr/bin/find ${ARCHIVE_SCRATCH_ROOT} -xdev -mindepth 1 -maxdepth 1 -name '${slug}-*.sqsh' -exec /usr/bin/rm -f -- {} +`,
    `/usr/bin/find ${targetParent(target)} -xdev -mindepth 1 -maxdepth 1 -name '.stella-turn-state-restore-${slug}-*' -exec /usr/bin/rm -rf -- {} +`,
  ].join("\n");
};

const claimTargetScratchCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  if (!HEX_SHA256.test(scratchId)) {
    throw new Error("Turn state archive scratch id is invalid.");
  }
  const claimPath = targetClaimPath(target);
  const parent = targetParent(target);
  const parentOwnerMode =
    target.kind === "workspace" ? "0:42424:750" : "0:0:700";
  return [
    `test -d ${parent}`,
    `test ! -L ${parent}`,
    `test "$(/usr/bin/readlink -f -- ${parent})" = ${parent}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${parent})" = ${parentOwnerMode}`,
    `if [ -e ${claimPath} ] || [ -L ${claimPath} ]; then`,
    `  test -f ${claimPath}`,
    `  test ! -L ${claimPath}`,
    `  test "$(/usr/bin/readlink -f -- ${claimPath})" = ${claimPath}`,
    `  test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${claimPath})" = 0:0:600:1`,
    `  /usr/bin/find ${claimPath} -maxdepth 0 -mmin +${ARCHIVE_CLAIM_STALE_MINUTES} -print -quit | /usr/bin/grep -q .`,
    `  /usr/bin/rm -f -- ${claimPath}`,
    "fi",
    sweepTargetScratchCommand(target),
    `printf '%s\\n' ${scratchId} > ${claimPath}`,
    `/usr/bin/chmod 0600 -- ${claimPath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${claimPath})" = 0:0:600:1`,
  ].join("\n");
};

const heartbeatTargetScratchCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  if (!HEX_SHA256.test(scratchId)) {
    throw new Error("Turn state archive scratch id is invalid.");
  }
  const claimPath = targetClaimPath(target);
  return [
    `test -f ${claimPath}`,
    `test ! -L ${claimPath}`,
    `test "$(/usr/bin/readlink -f -- ${claimPath})" = ${claimPath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${claimPath})" = 0:0:600:1`,
    `test "$(/usr/bin/cat -- ${claimPath})" = ${scratchId}`,
    `/usr/bin/touch -- ${claimPath}`,
  ].join("\n");
};

const lockedTargetCommand = (
  target: TurnStateArchiveTarget,
  command: string,
  waitSeconds = 0,
): string =>
  [
    prepareArchiveLockCommand(target),
    `exec 9<>${targetLockPath(target)}`,
    waitSeconds > 0
      ? `/usr/bin/flock --exclusive --wait ${waitSeconds} 9`
      : "/usr/bin/flock --exclusive --nonblock 9",
    command,
  ].join("\n");

const runLockedCommand = async (
  session: TurnStateArchiveSession,
  target: TurnStateArchiveTarget,
  command: string,
  label: string,
  waitSeconds = 0,
): Promise<string> =>
  await runCommand(
    session,
    lockedTargetCommand(target, command, waitSeconds),
    label,
  );

const runOwnedLockedCommand = async (
  session: TurnStateArchiveSession,
  target: TurnStateArchiveTarget,
  command: string,
  label: string,
): Promise<string> =>
  await runLockedCommand(
    session,
    target,
    command,
    label,
    ARCHIVE_OWNED_LOCK_WAIT_SECONDS,
  );

const boundedArchivePipe = (
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
): {
  completed: Promise<void>;
  failed: Promise<never>;
  deadline: Promise<never>;
  cancel: () => void;
  finish: () => void;
} => {
  let completed: Promise<void> | undefined;
  const pipeFiber = toolsRuntime.runFork(
    Effect.tryPromise({
      try: (signal) => {
        completed = source.pipeTo(destination, { signal });
        return completed;
      },
      catch: (error) => error,
    }),
  );
  if (!completed) {
    throw new Error("Turn state archive stream did not start.");
  }
  const interruptPipe = () => {
    toolsRuntime.runFork(Fiber.interrupt(pipeFiber));
  };
  const cancelAbortTimeout = forkAbortTimer(
    ARCHIVE_STREAM_TIMEOUT_MS,
    interruptPipe,
  );
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const cancelHardTimeout = forkAbortTimer(
    ARCHIVE_STREAM_TIMEOUT_MS + ARCHIVE_STREAM_CANCEL_GRACE_MS,
    () =>
      rejectDeadline(
        new Error("Turn state archive stream did not settle after timeout."),
      ),
  );
  const failed = completed.then<never>(
    () => new Promise<never>(() => undefined),
    (error: unknown) => Promise.reject(error),
  );
  // Observe both rejecting promises immediately. Callers still await the
  // originals, but no delayed R2/Sandbox response can create an unhandled event.
  void completed.catch(() => undefined);
  void failed.catch(() => undefined);
  void deadline.catch(() => undefined);
  return {
    completed,
    failed,
    deadline,
    cancel: interruptPipe,
    finish: () => {
      cancelAbortTimeout();
      cancelHardTimeout();
    },
  };
};

const settleWithinArchiveCancelGrace = async (
  work: PromiseLike<unknown>,
): Promise<void> => {
  await Promise.race([
    Promise.resolve(work).then(
      () => undefined,
      () => undefined,
    ),
    runToolEffect(Effect.sleep(ARCHIVE_STREAM_CANCEL_GRACE_MS)),
  ]);
};

const cancelReadableStream = async (
  stream: ReadableStream | undefined,
): Promise<void> => {
  if (!stream || typeof stream.cancel !== "function") return;
  let cancellation: Promise<void>;
  try {
    cancellation = stream.cancel();
  } catch {
    return;
  }
  void cancellation.catch(() => undefined);
  await settleWithinArchiveCancelGrace(cancellation);
};

const cancelBoundedArchivePipe = async (
  fixed: FixedLengthStream,
  transfer: ReturnType<typeof boundedArchivePipe>,
): Promise<void> => {
  transfer.cancel();
  const cancelReadable = fixed.readable.cancel();
  void cancelReadable.catch(() => undefined);
  await settleWithinArchiveCancelGrace(
    Promise.allSettled([cancelReadable, transfer.completed]),
  );
  transfer.finish();
};

const recoverPriorCommand = (
  target: TurnStateArchiveTarget,
  priorPath: string,
  failedPath: string,
): string => {
  const source = targetSource(target);
  return [
    `if [ -e ${priorPath} ] || [ -L ${priorPath} ]; then`,
    `  test -d ${priorPath}`,
    `  test ! -L ${priorPath}`,
    `  test "$(/usr/bin/readlink -f -- ${priorPath})" = ${priorPath}`,
    `  test "$(/usr/bin/stat -c '%u:%g:%a' -- ${priorPath})" = ${targetOwnerMode(target)}`,
    `  if [ -e ${failedPath} ] || [ -L ${failedPath} ]; then /usr/bin/rm -rf -- ${failedPath}; fi`,
    `  if [ -e ${source} ] || [ -L ${source} ]; then /usr/bin/mv -- ${source} ${failedPath}; fi`,
    `  /usr/bin/mv -- ${priorPath} ${source}`,
    `  test -d ${source}`,
    `  test ! -L ${source}`,
    `  test "$(/usr/bin/readlink -f -- ${source})" = ${source}`,
    `  test "$(/usr/bin/stat -c '%u:%g:%a' -- ${source})" = ${targetOwnerMode(target)}`,
    `  if [ -e ${failedPath} ] || [ -L ${failedPath} ]; then /usr/bin/rm -rf -- ${failedPath}; fi`,
    `elif [ -e ${failedPath} ] || [ -L ${failedPath} ]; then`,
    `  test -d ${source}`,
    `  test ! -L ${source}`,
    `  test "$(/usr/bin/readlink -f -- ${source})" = ${source}`,
    `  test "$(/usr/bin/stat -c '%u:%g:%a' -- ${source})" = ${targetOwnerMode(target)}`,
    `  /usr/bin/rm -rf -- ${failedPath}`,
    "fi",
  ].join("\n");
};

const prepareScratchCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const { archivePath, restorePath } = scratchPaths(target, scratchId);
  const parent = targetParent(target);
  const parentOwnerMode =
    target.kind === "workspace" ? "0:42424:750" : "0:0:700";
  return [
    "set -eu",
    "umask 077",
    `test -d ${ARCHIVE_HOST_ROOT}`,
    `test ! -L ${ARCHIVE_HOST_ROOT}`,
    `test "$(/usr/bin/readlink -f -- ${ARCHIVE_HOST_ROOT})" = ${ARCHIVE_HOST_ROOT}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${ARCHIVE_HOST_ROOT})" = 0:0:700`,
    `if [ ! -e ${ARCHIVE_SCRATCH_ROOT} ] && [ ! -L ${ARCHIVE_SCRATCH_ROOT} ]; then /usr/bin/install -d -o root -g root -m 0700 ${ARCHIVE_SCRATCH_ROOT}; fi`,
    `test -d ${ARCHIVE_SCRATCH_ROOT}`,
    `test ! -L ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/readlink -f -- ${ARCHIVE_SCRATCH_ROOT})" = ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${ARCHIVE_SCRATCH_ROOT})" = 0:0:700`,
    `test -d ${parent}`,
    `test ! -L ${parent}`,
    `test "$(/usr/bin/readlink -f -- ${parent})" = ${parent}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${parent})" = ${parentOwnerMode}`,
    `/usr/bin/rm -f -- ${archivePath}`,
    `if [ -e ${restorePath} ] || [ -L ${restorePath} ]; then test ! -L ${restorePath}; test "$(/usr/bin/readlink -f -- ${restorePath})" = ${restorePath}; /usr/bin/rm -rf -- ${restorePath}; fi`,
  ].join("\n");
};

const cleanupScratchCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const { archivePath, restorePath } = scratchPaths(target, scratchId);
  const claimPath = targetClaimPath(target);
  const parent = targetParent(target);
  const parentOwnerMode =
    target.kind === "workspace" ? "0:42424:750" : "0:0:700";
  return [
    "set -eu",
    `test -d ${ARCHIVE_SCRATCH_ROOT}`,
    `test ! -L ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/readlink -f -- ${ARCHIVE_SCRATCH_ROOT})" = ${ARCHIVE_SCRATCH_ROOT}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${ARCHIVE_SCRATCH_ROOT})" = 0:0:700`,
    `test -d ${parent}`,
    `test ! -L ${parent}`,
    `test "$(/usr/bin/readlink -f -- ${parent})" = ${parent}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${parent})" = ${parentOwnerMode}`,
    `/usr/bin/rm -f -- ${archivePath}`,
    `if [ -e ${restorePath} ] || [ -L ${restorePath} ]; then test ! -L ${restorePath}; test "$(/usr/bin/readlink -f -- ${restorePath})" = ${restorePath}; /usr/bin/rm -rf -- ${restorePath}; fi`,
    `if [ -e ${claimPath} ] || [ -L ${claimPath} ]; then`,
    `  test -f ${claimPath}`,
    `  test ! -L ${claimPath}`,
    `  test "$(/usr/bin/readlink -f -- ${claimPath})" = ${claimPath}`,
    `  test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${claimPath})" = 0:0:600:1`,
    `  if [ "$(/usr/bin/cat -- ${claimPath})" = ${scratchId} ]; then /usr/bin/rm -f -- ${claimPath}; fi`,
    "fi",
  ].join("\n");
};

const buildArchiveCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const source = targetSource(target);
  const { archivePath, priorPath, failedPath } = scratchPaths(
    target,
    scratchId,
  );
  return [
    "set -eu",
    "umask 077",
    recoverPriorCommand(target, priorPath, failedPath),
    `test -d ${source}`,
    `test ! -L ${source}`,
    `test "$(/usr/bin/readlink -f -- ${source})" = ${source}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${source})" = ${targetOwnerMode(target)}`,
    // Excluding xattrs keeps the archive's authority aligned with the native
    // attestation (which binds paths, bytes, owner, mode and link count, not
    // ambient security.capability or other unaccounted-for attributes).
    `/usr/bin/mksquashfs ${source} ${archivePath} -noappend -comp zstd -no-progress -no-xattrs -reproducible -mkfs-time 0 >/dev/null`,
    `test -f ${archivePath}`,
    `test ! -L ${archivePath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${archivePath})" = 0:0:600:1`,
    `archive_size="$(/usr/bin/stat -c '%s' -- ${archivePath})"`,
    `archive_digest="$(/usr/bin/sha256sum -- ${archivePath} | /usr/bin/cut -d ' ' -f 1)"`,
    `printf 'STELLA_ARCHIVE_SIZE=%s\\nSTELLA_ARCHIVE_SHA256=%s\\n' "$archive_size" "$archive_digest"`,
  ].join("\n");
};

const verifyDownloadedArchiveCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const { archivePath } = scratchPaths(target, scratchId);
  return [
    "set -eu",
    `test -f ${archivePath}`,
    `test ! -L ${archivePath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%h' -- ${archivePath})" = 0:0:1`,
    `/usr/bin/chmod 0600 -- ${archivePath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a:%h' -- ${archivePath})" = 0:0:600:1`,
    `archive_size="$(/usr/bin/stat -c '%s' -- ${archivePath})"`,
    `archive_digest="$(/usr/bin/sha256sum -- ${archivePath} | /usr/bin/cut -d ' ' -f 1)"`,
    `printf 'STELLA_ARCHIVE_SIZE=%s\\nSTELLA_ARCHIVE_SHA256=%s\\n' "$archive_size" "$archive_digest"`,
  ].join("\n");
};

const extractArchiveCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const parent = targetParent(target);
  const { archivePath, restorePath } = scratchPaths(target, scratchId);
  const parentOwnerMode =
    target.kind === "workspace" ? "0:42424:750" : "0:0:700";
  return [
    "set -eu",
    "umask 077",
    `test -d ${parent}`,
    `test ! -L ${parent}`,
    `test "$(/usr/bin/readlink -f -- ${parent})" = ${parent}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${parent})" = ${parentOwnerMode}`,
    `test ! -e ${restorePath}`,
    `test ! -L ${restorePath}`,
    `/usr/bin/unsquashfs -no-progress -no-xattrs -d ${restorePath} ${archivePath} >/dev/null`,
    `test -d ${restorePath}`,
    `test ! -L ${restorePath}`,
    `test "$(/usr/bin/readlink -f -- ${restorePath})" = ${restorePath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${restorePath})" = ${targetOwnerMode(target)}`,
  ].join("\n");
};

const swapRestoredTargetCommand = (
  target: TurnStateArchiveTarget,
  scratchId: string,
): string => {
  const source = targetSource(target);
  const parent = targetParent(target);
  const { restorePath, priorPath, failedPath } = scratchPaths(
    target,
    scratchId,
  );
  const parentOwnerMode =
    target.kind === "workspace" ? "0:42424:750" : "0:0:700";
  return [
    "set -eu",
    "umask 077",
    `test -d ${parent}`,
    `test ! -L ${parent}`,
    `test "$(/usr/bin/readlink -f -- ${parent})" = ${parent}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${parent})" = ${parentOwnerMode}`,
    `test -d ${restorePath}`,
    `test ! -L ${restorePath}`,
    `test "$(/usr/bin/readlink -f -- ${restorePath})" = ${restorePath}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${restorePath})" = ${targetOwnerMode(target)}`,
    // A previous swap may have lost its response at any rename boundary. Roll
    // it back to the old complete tree before applying this fully staged tree.
    recoverPriorCommand(target, priorPath, failedPath),
    `test ! -e ${priorPath}`,
    `test ! -L ${priorPath}`,
    `test ! -e ${failedPath}`,
    `test ! -L ${failedPath}`,
    `if [ -e ${source} ] || [ -L ${source} ]; then test -d ${source}; test ! -L ${source}; test "$(/usr/bin/readlink -f -- ${source})" = ${source}; test "$(/usr/bin/stat -c '%u:%g:%a' -- ${source})" = ${targetOwnerMode(target)}; /usr/bin/mv -- ${source} ${priorPath}; fi`,
    `/usr/bin/mv -- ${restorePath} ${source}`,
    `test -d ${source}`,
    `test ! -L ${source}`,
    `test "$(/usr/bin/readlink -f -- ${source})" = ${source}`,
    `test "$(/usr/bin/stat -c '%u:%g:%a' -- ${source})" = ${targetOwnerMode(target)}`,
    `if [ -e ${priorPath} ] || [ -L ${priorPath} ]; then /usr/bin/mv -- ${priorPath} ${failedPath}; fi`,
    `if [ -e ${failedPath} ] || [ -L ${failedPath} ]; then /usr/bin/rm -rf -- ${failedPath}; fi`,
  ].join("\n");
};

type ArchiveDigest = { sizeBytes: number; sha256: string };

const parseArchiveDigest = (stdout: string): ArchiveDigest => {
  const match =
    /^STELLA_ARCHIVE_SIZE=([0-9]+)\r?\nSTELLA_ARCHIVE_SHA256=([0-9a-f]{64})\r?\n?$/u.exec(
      stdout,
    );
  if (!match) throw new Error("Turn state archive digest output is invalid.");
  const sizeBytes = Number(match[1]);
  const sha256 = match[2]!;
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > TURN_STATE_MAX_ARCHIVE_BYTES ||
    !HEX_SHA256.test(sha256)
  ) {
    throw new Error("Turn state archive exceeds its bounded object contract.");
  }
  return { sizeBytes, sha256 };
};

const assertArchiveKey = (
  key: string,
  kind: TurnStateObjectKind,
): ArchiveKeyParts => {
  const match = ARCHIVE_KEY.exec(key);
  if (
    !match ||
    match[0] !== key ||
    match[4] !== kind ||
    new TextEncoder().encode(key).byteLength > 1_024
  ) {
    throw new Error("Turn state archive key was not pre-registered.");
  }
  return {
    ownerHash: match[1]!,
    workspaceHash: match[2]!,
    operationId: match[3]!,
    pairAddress: key.slice(0, -`/${kind}.sqsh`.length),
    kind,
  };
};

type ArchiveExpectation = Pick<
  TurnStateArchive,
  "kind" | "key" | "sizeBytes" | "sha256"
> & { target: TurnStateArchiveTarget };

/**
 * Canonical custom metadata for a durable turn-state archive object.
 *
 * Both the uploader and owner route use this constructor so a successfully
 * uploaded workspace/native object is judged against one exact metadata
 * contract when it is marked durable.
 */
export const turnStateArchiveMetadata = (
  archive: Pick<TurnStateArchive, "kind" | "key" | "sizeBytes" | "sha256">,
  target: TurnStateArchiveTarget,
): Record<string, string> => {
  if (archive.kind !== target.kind) {
    throw new Error("Turn state archive metadata target kind does not match.");
  }
  return {
    stellaSchemaVersion: String(TURN_STATE_SCHEMA_VERSION),
    stellaKind: archive.kind,
    stellaFormat: TURN_STATE_OBJECT_FORMAT,
    stellaKey: archive.key,
    stellaDirectory: targetSource(target),
    stellaSizeBytes: String(archive.sizeBytes),
    stellaSha256: archive.sha256,
    stellaComplete: "true",
  };
};

const exactMetadata = (archive: ArchiveExpectation): Record<string, string> =>
  turnStateArchiveMetadata(archive, archive.target);

const sameMetadata = (
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean => {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key, index) =>
        actualKeys[index] === key && actual[key] === expected[key],
    )
  );
};

export const turnStateArchiveMetadataMatches = (
  actual: Record<string, string> | undefined,
  archive: Pick<TurnStateArchive, "kind" | "key" | "sizeBytes" | "sha256">,
  target: TurnStateArchiveTarget,
): boolean => sameMetadata(actual, turnStateArchiveMetadata(archive, target));

const hexToArrayBuffer = (value: string): ArrayBuffer => {
  if (!HEX_SHA256.test(value)) {
    throw new Error("Turn state archive digest is invalid.");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
};

const arrayBufferHex = (value: ArrayBuffer | undefined): string | null => {
  if (!value || value.byteLength !== 32) return null;
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

type StoredArchiveObject = Pick<
  R2Object,
  "key" | "size" | "etag" | "checksums" | "httpMetadata" | "customMetadata"
>;

const assertStoredObject = (
  stored: StoredArchiveObject,
  expected: ArchiveExpectation,
  expectedEtag?: string,
): void => {
  const etag = stored.etag;
  if (
    stored.key !== expected.key ||
    stored.size !== expected.sizeBytes ||
    typeof etag !== "string" ||
    etag.length === 0 ||
    etag.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(etag) ||
    (expectedEtag !== undefined && etag !== expectedEtag) ||
    stored.httpMetadata?.contentType !== TURN_STATE_ARCHIVE_CONTENT_TYPE ||
    !sameMetadata(stored.customMetadata, exactMetadata(expected)) ||
    arrayBufferHex(stored.checksums.sha256) !== expected.sha256
  ) {
    throw new Error(
      "Turn state archive object conflicts with its reservation.",
    );
  }
};

const assertArchiveDescriptor = (
  archive: TurnStateArchive,
): ArchiveKeyParts => {
  const keyParts = assertArchiveKey(archive.key, archive.kind);
  if (
    archive.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    archive.format !== TURN_STATE_OBJECT_FORMAT ||
    archive.complete !== true ||
    !Number.isSafeInteger(archive.sizeBytes) ||
    archive.sizeBytes <= 0 ||
    archive.sizeBytes > TURN_STATE_MAX_ARCHIVE_BYTES ||
    !HEX_SHA256.test(archive.sha256) ||
    typeof archive.etag !== "string" ||
    archive.etag.length === 0 ||
    archive.etag.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(archive.etag)
  ) {
    throw new Error("Turn state archive descriptor is invalid.");
  }
  return keyParts;
};

const asDescriptor = (
  expected: Pick<TurnStateArchive, "kind" | "key" | "sizeBytes" | "sha256">,
  stored: StoredArchiveObject,
): TurnStateArchive => ({
  schemaVersion: TURN_STATE_SCHEMA_VERSION,
  kind: expected.kind,
  format: TURN_STATE_OBJECT_FORMAT,
  key: expected.key,
  sizeBytes: expected.sizeBytes,
  sha256: expected.sha256,
  etag: stored.etag,
  complete: true,
});

const reusableStoredArchive = async (
  bucket: Pick<R2Bucket, "head">,
  expected: ArchiveExpectation,
): Promise<TurnStateArchive | null> => {
  const stored = await bucket.head(expected.key);
  if (!stored) return null;
  assertStoredObject(stored, expected);
  return asDescriptor(expected, stored);
};

const withScratchCleanup = async <T>(
  session: TurnStateArchiveSession,
  target: TurnStateArchiveTarget,
  scratchId: string,
  work: () => Promise<T>,
): Promise<T> => {
  let primaryFailed = false;
  try {
    return await work();
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await runOwnedLockedCommand(
        session,
        target,
        cleanupScratchCommand(target, scratchId),
        "Turn state archive scratch cleanup",
      );
    } catch (cleanupError) {
      if (!primaryFailed) throw cleanupError;
      // Preserve the integrity/R2 failure as the actionable error. Scratch is
      // invocation-unique and root-confined, so a retry cannot consume it.
      console.error(
        JSON.stringify({
          level: "error",
          event: "turn_state_archive_scratch_cleanup_failed",
          targetKind: target.kind,
          errorName:
            cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        }),
      );
    }
  }
};

/**
 * Build and upload one pre-registered Stella checkpoint object.
 *
 * The caller must quiesce all model-controlled processes before invoking this
 * function. The key comes from `prepareTurnStateOperation`; this helper accepts
 * no arbitrary directory and never interpolates the key into a shell command.
 */
export const uploadTurnStateArchive = async (args: {
  session: TurnStateArchiveSession;
  bucket: Pick<R2Bucket, "head" | "put">;
  key: string;
  target: TurnStateArchiveTarget;
}): Promise<UploadTurnStateArchiveResult> => {
  assertArchiveKey(args.key, args.target.kind);
  const scratchId = newScratchId();
  const { archivePath } = scratchPaths(args.target, scratchId);
  return await withScratchCleanup(
    args.session,
    args.target,
    scratchId,
    async () => {
      const digest = parseArchiveDigest(
        await runLockedCommand(
          args.session,
          args.target,
          [
            claimTargetScratchCommand(args.target, scratchId),
            prepareScratchCommand(args.target, scratchId),
            buildArchiveCommand(args.target, scratchId),
          ].join("\n"),
          "Turn state archive creation",
        ),
      );
      await runOwnedLockedCommand(
        args.session,
        args.target,
        heartbeatTargetScratchCommand(args.target, scratchId),
        "Turn state archive claim heartbeat",
      );
      const expected = {
        kind: args.target.kind,
        key: args.key,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        target: args.target,
      } as const;
      const existing = await reusableStoredArchive(args.bucket, expected);
      if (existing) return { archive: existing, replayed: true };

      // Cloud Builder pins Sandbox to RPC. `encoding: "none"` is the raw-byte
      // RPC path; unlike readFileStream(), it is not an SSE/base64 envelope.
      const file = await args.session.readFile(archivePath, {
        encoding: "none",
      });
      if (
        file.success !== true ||
        file.size !== expected.sizeBytes ||
        !file.content ||
        typeof file.content.getReader !== "function"
      ) {
        await cancelReadableStream(
          (file as Partial<{ content: ReadableStream }>).content,
        );
        throw new Error("Turn state archive sandbox stream is invalid.");
      }
      // R2 needs a known-length stream for multi-gigabyte uploads. It also makes
      // truncation/overrun fail before the checksum-bound object can be accepted.
      const fixed = new FixedLengthStream(expected.sizeBytes);
      const transfer = boundedArchivePipe(file.content, fixed.writable);
      let putResult: R2Object | null;
      try {
        const put = args.bucket.put(args.key, fixed.readable, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: TURN_STATE_ARCHIVE_CONTENT_TYPE },
          customMetadata: exactMetadata(expected),
          sha256: hexToArrayBuffer(expected.sha256),
        });
        void put.catch(() => undefined);
        putResult = await Promise.race([
          put,
          transfer.failed,
          transfer.deadline,
        ]);
        if (putResult === null) {
          await cancelBoundedArchivePipe(fixed, transfer);
        } else {
          await Promise.race([transfer.completed, transfer.deadline]);
          transfer.finish();
        }
      } catch (error) {
        await cancelBoundedArchivePipe(fixed, transfer);
        // Covers the important lost-response edge: R2 may have durably accepted
        // the object before the request failed. Exact bytes/metadata are a replay;
        // anything else is a conflict and is never overwritten.
        const recovered = await reusableStoredArchive(args.bucket, expected);
        if (recovered) return { archive: recovered, replayed: true };
        throw error;
      }

      const verified = await reusableStoredArchive(args.bucket, expected);
      if (!verified) {
        throw new Error(
          putResult
            ? "Turn state archive upload was not durably visible."
            : "Turn state archive upload lost its conditional race.",
        );
      }
      if (putResult) assertStoredObject(putResult, expected, verified.etag);
      return { archive: verified, replayed: putResult === null };
    },
  );
};

const objectBody = (stored: R2ObjectBody | R2Object): ReadableStream => {
  const body = (stored as Partial<R2ObjectBody>).body;
  if (!body || typeof body.getReader !== "function") {
    throw new Error("Turn state archive conditional read was not satisfied.");
  }
  return body;
};

const cancelObjectBody = async (
  stored: R2ObjectBody | R2Object,
): Promise<void> => {
  await cancelReadableStream((stored as Partial<R2ObjectBody>).body);
};

export type TurnStateArchiveCopy = {
  source: TurnStateArchive;
  destinationKey: string;
  target: TurnStateArchiveTarget;
};

export type CopyTurnStateArchivePairResult = {
  workspace: UploadTurnStateArchiveResult;
  native?: UploadTurnStateArchiveResult;
};

const validateTurnStateArchiveCopy = (
  copy: TurnStateArchiveCopy,
): { source: ArchiveKeyParts; destination: ArchiveKeyParts } => {
  const source = assertArchiveDescriptor(copy.source);
  if (copy.source.kind !== copy.target.kind) {
    throw new Error("Turn state archive copy target kind does not match.");
  }
  const destination = assertArchiveKey(copy.destinationKey, copy.source.kind);
  if (copy.destinationKey === copy.source.key) {
    throw new Error("Turn state archive copy must re-address its destination.");
  }
  return { source, destination };
};

/** Re-address one exact archive without retiring or mutating its source. */
export const copyTurnStateArchive = async (args: {
  bucket: Pick<R2Bucket, "get" | "head" | "put">;
  source: TurnStateArchive;
  destinationKey: string;
  target: TurnStateArchiveTarget;
}): Promise<UploadTurnStateArchiveResult> => {
  const copy: TurnStateArchiveCopy = {
    source: args.source,
    destinationKey: args.destinationKey,
    target: args.target,
  };
  validateTurnStateArchiveCopy(copy);
  const sourceExpected: ArchiveExpectation = {
    ...copy.source,
    target: copy.target,
  };
  const destinationExpected: ArchiveExpectation = {
    ...sourceExpected,
    key: copy.destinationKey,
  };
  const existing = await reusableStoredArchive(
    args.bucket,
    destinationExpected,
  );
  if (existing) return { archive: existing, replayed: true };

  const sourceHead = await args.bucket.head(copy.source.key);
  if (!sourceHead)
    throw new Error("Turn state archive copy source is missing.");
  assertStoredObject(sourceHead, sourceExpected, copy.source.etag);
  const source = await args.bucket.get(copy.source.key, {
    onlyIf: { etagMatches: copy.source.etag },
  });
  if (!source) throw new Error("Turn state archive copy source is missing.");
  try {
    assertStoredObject(source, sourceExpected, copy.source.etag);
  } catch (error) {
    await cancelObjectBody(source);
    throw error;
  }

  const fixed = new FixedLengthStream(copy.source.sizeBytes);
  const transfer = boundedArchivePipe(
    objectBody(source) as ReadableStream<Uint8Array>,
    fixed.writable,
  );
  let putResult: R2Object | null;
  try {
    const put = args.bucket.put(copy.destinationKey, fixed.readable, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: TURN_STATE_ARCHIVE_CONTENT_TYPE },
      customMetadata: exactMetadata(destinationExpected),
      sha256: hexToArrayBuffer(copy.source.sha256),
    });
    void put.catch(() => undefined);
    putResult = await Promise.race([put, transfer.failed, transfer.deadline]);
    if (putResult === null) {
      await cancelBoundedArchivePipe(fixed, transfer);
    } else {
      await Promise.race([transfer.completed, transfer.deadline]);
      transfer.finish();
    }
  } catch (error) {
    await cancelBoundedArchivePipe(fixed, transfer);
    const recovered = await reusableStoredArchive(
      args.bucket,
      destinationExpected,
    );
    if (recovered) return { archive: recovered, replayed: true };
    throw error;
  }
  const verified = await reusableStoredArchive(
    args.bucket,
    destinationExpected,
  );
  if (!verified) {
    throw new Error(
      putResult
        ? "Turn state archive copy was not durably visible."
        : "Turn state archive copy lost its conditional race.",
    );
  }
  if (putResult) {
    assertStoredObject(putResult, destinationExpected, verified.etag);
  }
  return { archive: verified, replayed: putResult === null };
};

/**
 * Re-address a canonical workspace/native pair without retiring the source.
 *
 * Destination keys must already be reserved by the strong destination
 * registry. Workspace is copied first; if native copy fails, an exact retry
 * reuses that workspace object and resumes the pair without overwriting either
 * source or destination. Source purge remains a separate, later authority.
 */
export const copyTurnStateArchivePair = async (args: {
  bucket: Pick<R2Bucket, "get" | "head" | "put">;
  workspace: TurnStateArchiveCopy;
  native?: TurnStateArchiveCopy;
}): Promise<CopyTurnStateArchivePairResult> => {
  if (
    args.workspace.source.kind !== "workspace" ||
    args.workspace.target.kind !== "workspace" ||
    (args.native &&
      (args.native.source.kind !== "native" ||
        args.native.target.kind !== "native"))
  ) {
    throw new Error("Turn state archive copy pair is invalid.");
  }
  const workspaceParts = validateTurnStateArchiveCopy(args.workspace);
  if (args.native) {
    const nativeParts = validateTurnStateArchiveCopy(args.native);
    if (
      workspaceParts.source.pairAddress !== nativeParts.source.pairAddress ||
      workspaceParts.destination.pairAddress !==
        nativeParts.destination.pairAddress
    ) {
      throw new Error("Turn state archive copy pair addresses do not match.");
    }
  }
  const workspace = await copyTurnStateArchive({
    bucket: args.bucket,
    ...args.workspace,
  });
  const native = args.native
    ? await copyTurnStateArchive({
        bucket: args.bucket,
        ...args.native,
      })
    : undefined;
  return {
    workspace,
    ...(native ? { native } : {}),
  };
};

/** Restore one exact registered object into its fixed workspace/native root. */
export const restoreTurnStateArchive = async (args: {
  session: TurnStateArchiveSession;
  bucket: Pick<R2Bucket, "head" | "get">;
  archive: TurnStateArchive;
  target: TurnStateArchiveTarget;
}): Promise<void> => {
  assertArchiveDescriptor(args.archive);
  if (args.archive.kind !== args.target.kind) {
    throw new Error("Turn state archive target kind does not match.");
  }
  const scratchId = newScratchId();
  const { archivePath } = scratchPaths(args.target, scratchId);
  await withScratchCleanup(args.session, args.target, scratchId, async () => {
    await runLockedCommand(
      args.session,
      args.target,
      [
        claimTargetScratchCommand(args.target, scratchId),
        prepareScratchCommand(args.target, scratchId),
      ].join("\n"),
      "Turn state archive scratch preparation",
    );
    const expected: ArchiveExpectation = {
      ...args.archive,
      target: args.target,
    };
    const head = await args.bucket.head(args.archive.key);
    if (!head) throw new Error("Turn state archive object is missing.");
    assertStoredObject(head, expected, args.archive.etag);

    const stored = await args.bucket.get(args.archive.key, {
      onlyIf: { etagMatches: args.archive.etag },
    });
    if (!stored) throw new Error("Turn state archive object is missing.");
    try {
      assertStoredObject(stored, expected, args.archive.etag);
    } catch (error) {
      await cancelObjectBody(stored);
      throw error;
    }
    try {
      await runOwnedLockedCommand(
        args.session,
        args.target,
        heartbeatTargetScratchCommand(args.target, scratchId),
        "Turn state archive claim heartbeat",
      );
    } catch (error) {
      await cancelObjectBody(stored);
      throw error;
    }
    const fixed = new FixedLengthStream(args.archive.sizeBytes);
    const transfer = boundedArchivePipe(
      objectBody(stored) as ReadableStream<Uint8Array>,
      fixed.writable,
    );
    let writeResult: { success: boolean };
    try {
      const write = args.session.writeFile(archivePath, fixed.readable);
      void write.catch(() => undefined);
      writeResult = await Promise.race([
        write,
        transfer.failed,
        transfer.deadline,
      ]);
      if (!writeResult.success) {
        throw new Error("Turn state archive sandbox write was incomplete.");
      }
      await Promise.race([transfer.completed, transfer.deadline]);
      transfer.finish();
    } catch (error) {
      await cancelBoundedArchivePipe(fixed, transfer);
      throw error;
    }
    await runOwnedLockedCommand(
      args.session,
      args.target,
      heartbeatTargetScratchCommand(args.target, scratchId),
      "Turn state archive claim heartbeat",
    );

    const downloaded = parseArchiveDigest(
      await runCommand(
        args.session,
        verifyDownloadedArchiveCommand(args.target, scratchId),
        "Turn state archive download verification",
      ),
    );
    if (
      downloaded.sizeBytes !== args.archive.sizeBytes ||
      downloaded.sha256 !== args.archive.sha256
    ) {
      throw new Error("Turn state archive downloaded bytes failed integrity.");
    }
    await runOwnedLockedCommand(
      args.session,
      args.target,
      [
        heartbeatTargetScratchCommand(args.target, scratchId),
        extractArchiveCommand(args.target, scratchId),
        swapRestoredTargetCommand(args.target, scratchId),
      ].join("\n"),
      "Turn state archive target swap",
    );
  });
};
