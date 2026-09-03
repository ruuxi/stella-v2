/**
 * Run a script in a subshell of the Sandbox SDK's persistent session shell.
 *
 * Every `session.exec()` on one `ExecutionSession` runs in the same long-lived
 * bash process, so anything a script sets on the shell itself outlives the
 * call: `set -eu`, `umask 077`, and any `exec 9<>lock` descriptor. A later
 * command that exits non-zero then takes the whole shell down, the SDK
 * reports "shell exited (exit code: N)", and every background process the
 * session started dies with it. Wrapping the script in `( ... )` scopes all of
 * that to the script: errexit, the umask and the lock fd end when the
 * subshell does, which is also the intended lifetime of a per-command lock.
 *
 * Shared by the world-boundary scripts in `index.ts` and the checkpoint
 * archive scripts in `turn-state-archive.ts`; both run in the session that
 * later hosts model-controlled commands.
 */
export const inSubshell = (script: string): string => `( ${script} )`;
