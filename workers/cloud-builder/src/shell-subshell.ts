/**
 * Run a script in a subshell.
 *
 * Each `session.exec()` now starts its own `bash -c`, so nothing a script sets
 * on its shell (`set -eu`, `umask 077`, an `exec 9<>lock` descriptor) can
 * outlive the call. The 0.12 SDK ran every call in one long-lived session
 * shell, where those settings leaked into later commands; the explicit
 * `( ... )` keeps the scripts' scope obvious regardless of the runner.
 *
 * Shared by the world-boundary scripts in `index.ts` and the checkpoint
 * archive scripts in `turn-state-archive.ts`; both run in the session that
 * later hosts model-controlled commands.
 */
export const inSubshell = (script: string): string => `( ${script} )`;
