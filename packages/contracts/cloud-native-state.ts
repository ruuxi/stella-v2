/**
 * Where a Claude Code thread keeps its native session state
 * (`CLAUDE_CONFIG_DIR`) inside a cloud world container.
 *
 * One container serves every thread of an owner's world, so each thread has
 * its own root under the image's root-only anchor. The session marker, the
 * attestation bound to the thread id, the checkpoint archive and its restore
 * swap are all per root; two threads never share or swap the same directory.
 *
 * `threadHash` is the lowercase hex SHA-256 of the UTF-8 thread id, the same
 * hash the turn-state registry keys threads by.
 */

/** Root-owned 0700 directory the image creates; every thread root sits in it. */
export const CLOUD_NATIVE_STATE_ANCHOR = "/home/stella-native-state";

export const CLOUD_NATIVE_STATE_ROOT_PATTERN =
  /^\/home\/stella-native-state\/anthropic-[0-9a-f]{64}$/u;

export const cloudNativeStateRoot = (threadHash: string): string => {
  if (!/^[0-9a-f]{64}$/u.test(threadHash)) {
    throw new Error("Native state thread hash is invalid.");
  }
  return `${CLOUD_NATIVE_STATE_ANCHOR}/anthropic-${threadHash}`;
};
