import { inSubshell } from "./shell-subshell.js";

const shellQuote = (value: string): string => {
  if (value.includes("\0")) throw new TypeError("Shell value contains NUL.");
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
};

/** Build the locked, cold-container-only world import command. */
export const worldMaterializationCommand = (args: {
  worldRoot: string;
  manifestId: string;
  exportUrl: string;
  capability: string;
}): string => {
  if (!args.worldRoot.startsWith("/") || !args.manifestId) {
    throw new TypeError("World materialization target must be exact.");
  }
  const marker = `${args.worldRoot}/.stella/world-manifest`;
  return inSubshell(
    [
      "set -eu",
      "umask 077",
      "exec 9>/workspace/.world-materialize.lock",
      "/usr/bin/flock --exclusive 9",
      `marker=${shellQuote(marker)}`,
      'if [ ! -f "$marker" ]; then',
      `find ${shellQuote(args.worldRoot)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      `curl --fail --silent --show-error -H ${shellQuote(`Authorization: Bearer ${args.capability}`)} ${shellQuote(args.exportUrl)} | tar -x -f - -C ${shellQuote(args.worldRoot)}`,
      `mkdir -p ${shellQuote(`${args.worldRoot}/.stella`)}`,
      `printf '%s\\n' ${shellQuote(args.manifestId)} > "$marker"`,
      `chown -R 42424:42424 ${shellQuote(args.worldRoot)}`,
      'chown 0:0 "$marker"',
      'chmod 0600 "$marker"',
      "fi",
    ].join("\n"),
  );
};
