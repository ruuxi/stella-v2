import { dependencyAdoptionLines } from "./sandbox-dependencies.js";
import { inSubshell } from "./shell-subshell.js";
import { WORLD_ROOT } from "./workspace.js";

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
  const index = `${args.worldRoot.slice(0, args.worldRoot.lastIndexOf("/"))}/.stella-world-index.json`;
  return inSubshell(
    [
      "set -euo pipefail",
      "umask 077",
      "exec 9>/workspace/.world-materialize.lock",
      "/usr/bin/flock --exclusive 9",
      `root=${shellQuote(args.worldRoot)}`,
      `marker=${shellQuote(marker)}`,
      'if [ ! -f "$marker" ]; then',
      "headers=/workspace/.world-export-headers",
      "trap 'rm -f -- \"$headers\"' EXIT",
      `find ${shellQuote(args.worldRoot)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      `curl --fail --silent --show-error --dump-header "$headers" -H ${shellQuote(`Authorization: Bearer ${args.capability}`)} ${shellQuote(args.exportUrl)} | tar -x -f - -C ${shellQuote(args.worldRoot)}`,
      `manifest=${shellQuote(args.manifestId)}`,
      'revision="$(awk \'BEGIN { IGNORECASE=1 } /^x-stella-world-revision:/ { gsub("\\r", "", $2); print $2 }\' "$headers" | tail -1)"',
      'case "$revision" in ""|*[!0-9]*) exit 1;; esac',
      `mkdir -p ${shellQuote(`${args.worldRoot}/.stella`)}`,
      `printf '{"manifestId":"%s","revision":%s}\\n' "$manifest" "$revision" > "$marker"`,
      `chown -R 42424:42424 ${shellQuote(args.worldRoot)}`,
      'chown 0:0 "$marker"',
      'chmod 0600 "$marker"',
      // A container started from a new image restored the previous one's
      // dependencies beside the world; they go back in now.
      ...(args.worldRoot === WORLD_ROOT ? dependencyAdoptionLines(index) : []),
      "fi",
    ].join("\n"),
  );
};
