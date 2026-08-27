import { renameSync, statSync } from "node:fs";

const DEFAULT_RUNTIME_LOG_MAX_BYTES = 16 * 1024 * 1024;

const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const rotateLogIfOversized = (
  filePath: string,
  maxBytes = parsePositiveInt(
    process.env.STELLA_RUNTIME_LOG_MAX_BYTES,
    DEFAULT_RUNTIME_LOG_MAX_BYTES,
  ),
): void => {
  try {
    if (statSync(filePath).size < maxBytes) return;
    renameSync(filePath, `${filePath}.1`);
  } catch {

  }
};
