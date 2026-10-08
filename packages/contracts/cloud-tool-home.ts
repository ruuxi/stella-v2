/**
 * Where a cloud world's model-authored commands keep things.
 *
 * HOME is the world itself, so `~/.stella` in the cloud is the world's
 * `.stella` and `~` means what it means on a device. Caches, config and state
 * are pointed elsewhere: at the tool home beside the world, which never
 * reaches the world store or its quota and which the sandbox archives on its
 * own across images. The container executor, the resident worker shell and
 * the world sync all read their layout from here.
 */

/** The tool account's caches, config and state, beside the world. */
export const CLOUD_TOOL_HOME = "/workspace/.stella-tool-home";

/**
 * XDG and the common tool-specific cache locations under `root`. Tools that
 * honour none of these still write under HOME; `WORLD_UNSYNCED_PATHS` keeps
 * those directories out of the world store.
 */
export const toolStateEnvironment = (root: string): Record<string, string> => ({
  XDG_CONFIG_HOME: `${root}/.config`,
  XDG_CACHE_HOME: `${root}/.cache`,
  XDG_STATE_HOME: `${root}/.local/state`,
  XDG_DATA_HOME: `${root}/.local/share`,
  npm_config_cache: `${root}/.npm`,
  BUN_INSTALL_CACHE_DIR: `${root}/.bun/install/cache`,
  PLAYWRIGHT_BROWSERS_PATH: `${root}/.cache/ms-playwright`,
  PUPPETEER_CACHE_DIR: `${root}/.cache/puppeteer`,
});

/**
 * World-relative subtrees that only ever live on the sandbox's disk: the
 * caches tools create in HOME whatever the environment says, and the skills
 * mirrored into `~/.stella/skills` for each turn. The world sync never lists,
 * pulls or deletes anything under them.
 */
export const WORLD_UNSYNCED_PATHS: readonly string[] = [
  ".cache",
  ".npm",
  ".bun",
  ".local/share/pnpm",
  ".stella/skills",
];

export const isWorldUnsyncedPath = (relative: string): boolean =>
  WORLD_UNSYNCED_PATHS.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  );
