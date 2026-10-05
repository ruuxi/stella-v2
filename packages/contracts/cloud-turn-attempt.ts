/**
 * Root-only handoff files between BuildSession and the cloud executor for one
 * container attempt.
 *
 * One world container runs several threads at once (the orchestrator's
 * `orch:<conversationId>` thread beside general agents), so every attempt gets
 * its own directory, keyed by the thread hash (lowercase hex SHA-256 of the
 * thread id, as for the native state root) and the attempt generation. The
 * turn input, the executor's result and the broker credential handoff all
 * live there; no attempt can read or replace another's.
 *
 * `/workspace` is root-owned and outside every checkpointed tool root
 * (`/workspace/drive`, `/workspace/stella`, `/workspace/projects/...`), and
 * BuildSession makes the anchor and each attempt directory 0700, so
 * model-controlled UID 42424 can neither read nor create anything in them.
 * BuildSession removes the directory when the attempt finishes.
 */

export const CLOUD_TURN_ATTEMPT_ANCHOR = "/workspace/.stella-turn-attempts";

const ATTEMPT_DIRECTORY_PATTERN =
  /^\/workspace\/\.stella-turn-attempts\/[0-9a-f]{64}-[1-9][0-9]{0,15}$/u;

export type CloudTurnAttemptPaths = {
  directory: string;
  /** Turn input; the executor reads and unlinks it before anything else. */
  input: string;
  /** The executor's authoritative result, written mode 0600. */
  result: string;
};

const pathsFor = (directory: string): CloudTurnAttemptPaths => ({
  directory,
  input: `${directory}/turn-input.json`,
  result: `${directory}/result.json`,
});

/** BuildSession side: the directory for this thread's attempt. */
export const cloudTurnAttemptPaths = (
  threadHash: string,
  attemptGeneration: number,
): CloudTurnAttemptPaths => {
  if (!/^[0-9a-f]{64}$/u.test(threadHash)) {
    throw new Error("Turn attempt thread hash is invalid.");
  }
  if (!Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) {
    throw new Error("Turn attempt generation is invalid.");
  }
  return pathsFor(
    `${CLOUD_TURN_ATTEMPT_ANCHOR}/${threadHash}-${attemptGeneration}`,
  );
};

/**
 * Executor side: the paths for the directory BuildSession named on the
 * command line. Null for anything that is not an attempt directory.
 */
export const parseCloudTurnAttemptDirectory = (
  directory: string | undefined,
): CloudTurnAttemptPaths | null =>
  directory && ATTEMPT_DIRECTORY_PATTERN.test(directory)
    ? pathsFor(directory)
    : null;

/** The executor flag that carries the attempt directory. */
export const CLOUD_TURN_ATTEMPT_DIRECTORY_FLAG = "--attempt-dir";
