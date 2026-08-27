import { z } from "zod";

export type FileChangeKind =
  | { type: "add" }
  | { type: "delete" }

  | { type: "update"; move_path?: string };

export type FileChangeRecord = {

  path: string;
  kind: FileChangeKind;
};

export type ProducedFileRecord = FileChangeRecord;

const fileChangeKindSchema = z.union([
  z.object({ type: z.literal("add") }),
  z.object({ type: z.literal("delete") }),
  z.object({
    type: z.literal("update"),
    move_path: z.string().trim().min(1).optional(),
  }),
]);

const fileChangeRecordSchema = z.object({
  path: z.string().trim().min(1),
  kind: fileChangeKindSchema,
});

export const isFileChangeRecord = (value: unknown): value is FileChangeRecord =>
  fileChangeRecordSchema.safeParse(value).success;

export const isFileChangeRecordArray = (
  value: unknown,
): value is FileChangeRecord[] =>
  Array.isArray(value) && value.every(isFileChangeRecord);

export const isProducedFileRecordArray = (
  value: unknown,
): value is ProducedFileRecord[] =>
  Array.isArray(value) && value.every(isFileChangeRecord);

export const fileChange = (
  path: string,
  kind: FileChangeKind,
): FileChangeRecord => ({ path, kind });

const NOISE_PATH_SEGMENTS = new Set(["node_modules", "__pycache__"]);
const NOISE_EXTS = new Set(["log", "tmp", "lock", "pid"]);

const extensionOfPath = (filePath: string): string | null => {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
};

export const isNoiseProducedPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (!trimmed) return true;
  for (const segment of trimmed.split(/[\\/]/)) {
    if (!segment) continue;
    if (segment.startsWith(".") && segment !== ".stella") return true;
    if (NOISE_PATH_SEGMENTS.has(segment)) return true;
  }
  const ext = extensionOfPath(trimmed);
  return ext != null && NOISE_EXTS.has(ext);
};

export const MAX_PRODUCED_FILES_PER_COMMAND = 12;
