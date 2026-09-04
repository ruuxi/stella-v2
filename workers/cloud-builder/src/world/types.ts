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
  fork?: string;
};

export type WorldToolResult = { ok: boolean; output: string; revision: number };

export type WorldChanges = {
  revision: number;
  entries: WorldEntry[];
  deleted: string[];
  resync: boolean;
};

export type WorldForkKind = "shared" | "fork" | "new";

export type WorldForkStatus = {
  kind: WorldForkKind;
  baseManifestId: string | null;
  headManifestId: string;
  changedSinceBase: number;
  revision: number;
};

export type WorldMergeResult = {
  applied: string[];
  deleted: string[];
  conflicts: string[];
};

export type WorldBlobPutOutcome =
  | { sha256: string; accepted: true }
  | { sha256: string; accepted: false; error: string };

export const WORLD_CHUNK_BYTES = 512 * 1024;
export const WORLD_BLOB_FRAME_HEADER_BYTES = 40;
export const WORLD_BLOB_BATCH_MAX_BYTES = 32 * 1024 * 1024;
export const WORLD_BLOB_BATCH_MAX_COUNT = 512;
export const WORLD_BLOB_BATCH_MAX_WIRE_BYTES =
  WORLD_BLOB_BATCH_MAX_BYTES +
  WORLD_BLOB_BATCH_MAX_COUNT * WORLD_BLOB_FRAME_HEADER_BYTES;
export const WORLD_R2_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const WORLD_FILE_LIMIT_BYTES = 256 * 1024 * 1024;
export const WORLD_READ_LIMIT_BYTES = 8 * 1024 * 1024;
export const WORLD_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const WORLD_PATH_LIMIT_BYTES = 1024;
export const WORLD_CHANGE_LOG_MAX_ROWS = 10_000;
