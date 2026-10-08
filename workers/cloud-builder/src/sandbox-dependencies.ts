/**
 * The agent containers' caches and installed dependencies, kept across images.
 *
 * A container snapshot cannot cross images and nearly every deploy changes the
 * image, so a cold start usually begins from a clean disk: the world comes back
 * from the world store, but everything agents set up beside it does not. This
 * keeps the two things that are expensive to rebuild and never belong in the
 * world store: the tool home (caches, config and state under
 * `/workspace/.stella-tool-home`) and the `node_modules` directories under the
 * world. Both go into one size-capped archive per owner in `BACKUP_BUCKET`,
 * outside the world quota, shared by every agent container of the owner:
 * written when a turn releases its container and something in them changed
 * there, and restored by any of them that starts without a snapshot.
 *
 * Only the tool account's own files leave the container. Anything owned by
 * another user (root's in particular) is excluded file by file, the root-only
 * host state (`/home/stella-host-state`, where the Claude Code logins live) is
 * never inside the archived tree, and the credential stores the file tools
 * already refuse to touch (`command-safety.ts`) are left out of the tool home.
 */
import {
  CLOUD_TOOL_HOME,
  WORLD_UNSYNCED_PATHS,
} from "@stella/contracts/cloud-tool-home";
import { WORLD_ROOT } from "./workspace.js";

/** A larger tree is not archived; the previous archive, if any, is kept. */
export const DEPENDENCY_BACKUP_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** Hang protection only: a 5 GiB archive moves in well under this. */
export const DEPENDENCY_TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** The archive is taken of `/workspace`, so its paths start here. */
export const DEPENDENCY_BACKUP_DIR = "/workspace";

/**
 * Where a cold start unpacks the archive. Root-only, so nothing in it can be
 * swapped for a link before it is moved into place.
 */
export const DEPENDENCY_RESTORE_ROOT = "/home/stella-host-state/dependency-restore";

/** Above this many foreign-owned entries the archive is skipped, not bloated with patterns. */
export const DEPENDENCY_FOREIGN_LIMIT = 1_000;

/**
 * One prefix per owner, keyed by the owner's world name: every agent
 * container of the owner restores from and archives into it.
 */
export const dependencyBackupPrefix = (worldName: string): string =>
  `sandbox-dependencies/v1/${worldName}/`;

const TOOL_HOME = CLOUD_TOOL_HOME.slice(`${DEPENDENCY_BACKUP_DIR}/`.length);
const WORLD = WORLD_ROOT.slice(`${DEPENDENCY_BACKUP_DIR}/`.length);

/**
 * World subtrees the archive never looks into: the user's drive syncs on its
 * own, the world's `.stella` holds per-container state, and the unsynced
 * HOME caches are disposable by design.
 */
const WORLD_SKIPPED = ["drive", ".stella", ...WORLD_UNSYNCED_PATHS];

/** Credential stores under the tool home that never leave the container. */
const TOOL_HOME_CREDENTIALS = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".azure/",
  ".config/gh/",
  ".config/gcloud/",
  ".config/git/credentials",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
];

/**
 * Gitignore patterns over `/workspace`, last match wins: every directory is
 * walked, but the only files kept are the tool home's and those inside a
 * `node_modules` outside `WORLD_SKIPPED`.
 */
export const DEPENDENCY_BACKUP_EXCLUDES: readonly string[] = [
  "*",
  "!*/",
  "!**/node_modules/**",
  `!/${TOOL_HOME}/**`,
  "/*",
  `!/${WORLD}/`,
  `!/${TOOL_HOME}/`,
  ...WORLD_SKIPPED.map((entry) => `/${WORLD}/${entry}/`),
  ...TOOL_HOME_CREDENTIALS.map((entry) => `/${TOOL_HOME}/${entry}`),
];

/**
 * An exact `/workspace`-relative path as an anchored gitignore pattern, or null
 * when no pattern can name it.
 */
export const dependencyExcludeForPath = (relative: string): string | null => {
  if (!relative || /[\n\r]/u.test(relative)) return null;
  const escaped = relative
    .replace(/[\\*?[\]!#]/gu, (character) => `\\${character}`)
    .replace(/ +$/u, (spaces) => spaces.replace(/ /gu, "\\ "));
  return `/${escaped}`;
};

/**
 * Decides whether the archive is due, from `/workspace`. Prints one JSON line:
 *   `no_world` / `restore_pending` — nothing to archive yet;
 *   `unchanged` — nothing written since `$1` (container epoch seconds, to the
 *     millisecond) and the same `node_modules` set as fingerprint `$2`;
 *   `changed` — with the tree's apparent size and the entries the tool account
 *     does not own, which the archive must exclude.
 * `now` is taken before anything is read, so a write that races the archive is
 * newer than the next mark and is picked up next time.
 */
export const DEPENDENCY_PROBE_SCRIPT = `set -euo pipefail
mark=$1
previous=$2
cd ${DEPENDENCY_BACKUP_DIR}
now=$(date +%s.%3N)
if [ ! -f ${WORLD}/.stella/world-manifest ]; then jq -cn --argjson now "$now" '{state:"no_world",now:$now}'; exit 0; fi
if [ -e ${DEPENDENCY_RESTORE_ROOT} ]; then jq -cn --argjson now "$now" '{state:"restore_pending",now:$now}'; exit 0; fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# A turn may still be deleting files; a vanished path is not a failure.
{ find ${WORLD} \\( ${WORLD_SKIPPED.map((entry) => `-path ${WORLD}/${entry}`).join(" -o ")} \\) -prune -o -type d -name node_modules -prune -print0 2>/dev/null || true; } | sort -z >"$work/roots"
fingerprint=$(sha256sum <"$work/roots" | cut -c1-64)
{ if [ -d ${TOOL_HOME} ]; then printf '%s\\0' ${TOOL_HOME}; fi; cat "$work/roots"; } >"$work/targets"
if [ "$mark" != 0 ] && [ "$fingerprint" = "$previous" ]; then
  newer=$(xargs -0 -r sh -c 'find "$@" -newermt "@$0" -print -quit 2>/dev/null || true' "$mark" <"$work/targets")
  if [ -z "$newer" ]; then
    jq -cn --argjson now "$now" --arg fingerprint "$fingerprint" '{state:"unchanged",now:$now,fingerprint:$fingerprint}'
    exit 0
  fi
fi
: >"$work/foreign"
bytes=0
if [ -s "$work/targets" ]; then
  bytes=$({ du -sbc --files0-from="$work/targets" 2>/dev/null || true; } | tail -n 1 | cut -f 1)
  xargs -0 -r sh -c 'find "$@" ! -user 42424 -prune -print0 2>/dev/null || true' foreign <"$work/targets" >"$work/foreign-all"
  head -z -n ${DEPENDENCY_FOREIGN_LIMIT + 1} "$work/foreign-all" >"$work/foreign"
fi
jq -cRs --argjson now "$now" --arg fingerprint "$fingerprint" --argjson bytes "\${bytes:-0}" \\
  '{state:"changed",now:$now,fingerprint:$fingerprint,bytes:$bytes,foreign:(split("\\u0000") | map(select(length > 0)))}' <"$work/foreign"
`;

/**
 * After a cold start's restore: the tool home goes straight back into place,
 * since nothing has run in the new container yet. The world part waits for
 * the world to be materialized (`dependencyAdoptionLines`).
 */
export const DEPENDENCY_PLACE_TOOL_HOME_SCRIPT = `set -eu
stage=${DEPENDENCY_RESTORE_ROOT}
if [ -d "$stage/${TOOL_HOME}" ] && [ ! -e ${DEPENDENCY_BACKUP_DIR}/${TOOL_HOME} ] && [ ! -L ${DEPENDENCY_BACKUP_DIR}/${TOOL_HOME} ]; then
  mv -T -- "$stage/${TOOL_HOME}" ${DEPENDENCY_BACKUP_DIR}/${TOOL_HOME}
fi
rm -rf -- "$stage/${TOOL_HOME}"
if [ ! -d "$stage/${WORLD}" ]; then rm -rf -- "$stage"; fi
`;

/**
 * Shell lines for the cold world materialization, run once the export is on
 * disk and before any agent process: move each restored `node_modules` back
 * under its project when the project is still there and has none, then drop
 * the rest. The world index is seeded first with the export's own
 * `node_modules` (`indexRestoredNodeModules` in world-sync), as an incomplete
 * base the first pull completes from the disk, so the restored ones stay
 * ephemeral and are never pushed. `$root` is the world root; nothing else is
 * running in the container yet, so the parent checks cannot be raced. A
 * failure here costs only the restored dependencies, never the
 * materialization.
 */
export const dependencyAdoptionLines = (indexPath: string): string[] => [
  `restored=${DEPENDENCY_RESTORE_ROOT}/${WORLD}`,
  `if [ -d "$restored" ] && find "$root" -type d -name node_modules -prune -printf '%P\\0%T@\\0%m\\0' | jq -cRs 'split("\\u0000") as $f | {complete: false, entries: ([range(0; ($f | length) - 2; 3) | {key: $f[.], value: {kind: "dir", mode: ($f[. + 2] | explode | reduce .[] as $digit (0; . * 8 + $digit - 48)), size: 0, mtime: (($f[. + 1] | tonumber) * 1000 | floor)}}] | from_entries)}' >"${indexPath}.tmp" && mv -f -- "${indexPath}.tmp" "${indexPath}"; then`,
  `find "$restored" -type d -name node_modules -prune -printf '%P\\0' | while IFS= read -r -d '' rel; do`,
  'target="$root/$rel"',
  'parent=${target%/*}',
  'if [ -d "$parent" ] && [ "$(realpath -e -- "$parent")" = "$parent" ] && [ ! -e "$target" ] && [ ! -L "$target" ]; then mv -T -- "$restored/$rel" "$target" || true; fi',
  "done || true",
  "fi",
  `rm -rf -- "${indexPath}.tmp" ${DEPENDENCY_RESTORE_ROOT}`,
];

/** What the owner's world store keeps about the owner's archive. */
export type StoredDependencyBackup = {
  record: import("@cloudflare/sandbox").DirectoryBackupRecord;
  /** sha256 of the sorted `node_modules` paths the archive holds. */
  fingerprint: string;
  /** Container epoch seconds, to the millisecond, read before the archive was taken. */
  mark: number;
  /** Apparent bytes of the archived tree. */
  bytes: number;
  takenAt: number;
};

export type DependencyProbe =
  | { state: "no_world" | "restore_pending"; now: number }
  | { state: "unchanged"; now: number; fingerprint: string }
  | {
      state: "changed";
      now: number;
      fingerprint: string;
      bytes: number;
      foreign: string[];
    };

export const parseDependencyProbe = (stdout: string): DependencyProbe | null => {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as Partial<DependencyProbe> & {
      fingerprint?: unknown;
      bytes?: unknown;
      foreign?: unknown;
    };
    if (!value || typeof value !== "object" || !Number.isFinite(value.now)) {
      return null;
    }
    switch (value.state) {
      case "no_world":
      case "restore_pending":
        return { state: value.state, now: value.now! };
      case "unchanged":
        return typeof value.fingerprint === "string"
          ? { state: "unchanged", now: value.now!, fingerprint: value.fingerprint }
          : null;
      case "changed":
        return typeof value.fingerprint === "string" &&
          Number.isSafeInteger(value.bytes) &&
          Array.isArray(value.foreign) &&
          value.foreign.every((entry) => typeof entry === "string")
          ? {
              state: "changed",
              now: value.now!,
              fingerprint: value.fingerprint,
              bytes: Number(value.bytes),
              foreign: value.foreign as string[],
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
};
