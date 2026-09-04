export type WorldKind = "file" | "dir" | "symlink";

export type WorldEntry = {
  path: string;
  kind: WorldKind;
  mode: number;
  mtime: number;
  size: number;
  sha256?: string;
  target?: string;
};

export type WorldListingEntry = Omit<WorldEntry, "mtime"> & { mtime?: number };

export type WorldToolCall = {
  name: "Read" | "Write" | "Edit" | "Grep" | "apply_patch" | "glob";
  arguments: Record<string, unknown>;
};

export type WorldToolResult = { ok: boolean; output: string };

export const WORLD_CHUNK_BYTES = 512 * 1024;
export const WORLD_R2_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const WORLD_FILE_LIMIT_BYTES = 256 * 1024 * 1024;
export const WORLD_READ_LIMIT_BYTES = 8 * 1024 * 1024;
export const WORLD_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const WORLD_PATH_LIMIT_BYTES = 1024;

export const WORLD_ROOT = "/workspace/world";

