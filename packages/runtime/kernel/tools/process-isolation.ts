import type { ToolProcessIdentity } from "./types.js";

/** Fixed image-owned privilege-drop binary. Never resolve this through PATH. */
export const LINUX_SETPRIV_PATH = "/usr/bin/setpriv";

export type IsolatedProcessLaunch = {
  command: string;
  args: string[];
  /** Native uid/gid drop retained for non-cloud POSIX callers. */
  nativeIdentity?: Pick<ToolProcessIdentity, "uid" | "gid">;
};

/**
 * Build the final argv for a model-authored subprocess.
 *
 * A plain Node/Bun uid+gid spawn does not clear supplementary groups, the
 * capability bounding set, or set no_new_privs. Strict cloud identities must
 * therefore execute through image-owned util-linux `setpriv`; if a cloud turn
 * ever runs on another OS, fail closed instead of silently weakening it.
 */
export const isolateToolProcessLaunch = (args: {
  command: string;
  commandArgs: readonly string[];
  identity?: ToolProcessIdentity;
  platform?: NodeJS.Platform;
}): IsolatedProcessLaunch => {
  const identity = args.identity;
  if (!identity) {
    return { command: args.command, args: [...args.commandArgs] };
  }
  if (identity.requireNoNewPrivileges) {
    if ((args.platform ?? process.platform) !== "linux") {
      throw new Error(
        "Strict tool process isolation requires the Linux sandbox boundary.",
      );
    }
    return {
      command: LINUX_SETPRIV_PATH,
      args: [
        `--reuid=${identity.uid}`,
        `--regid=${identity.gid}`,
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        args.command,
        ...args.commandArgs,
      ],
    };
  }
  return {
    command: args.command,
    args: [...args.commandArgs],
    nativeIdentity: { uid: identity.uid, gid: identity.gid },
  };
};
