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

/**
 * Root-only (0700) parent of the owner's cloud Claude Code logins, one
 * `CLAUDE_CONFIG_DIR` per account named by the hex SHA-256 of the account's
 * lowercased email. `claude auth login` writes its credential there and
 * Claude turns point `CLAUDE_SECURESTORAGE_CONFIG_DIR` at it; Stella never
 * reads what is inside. Model-authored commands run as `stella-tools` and
 * cannot traverse `/home/stella-host-state`.
 */
export const CLOUD_CLAUDE_ACCOUNTS_ROOT = "/home/stella-host-state/claude-accounts";

/**
 * Pending `claude auth login` attempts, beside the account directories
 * (root-only, never backed up).
 */
export const CLOUD_CLAUDE_LOGINS_ROOT = "/home/stella-host-state/claude-logins";

export const isCloudClaudeAccountKey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
