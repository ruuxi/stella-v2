import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const TOOL_OUTPUT_SPILL_DIR = "tool-output-artifacts";
export const DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_TOOL_OUTPUT_SPILL_QUOTA_BYTES = 32 * 1024 * 1024;

const safeSegment = (value, fallback) => {
  const normalized = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
};

const collectArtifacts = async (root) => {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return await visit(filePath);
        if (!entry.isFile() || !entry.name.endsWith(".txt")) return;
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat)
          files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      }),
    );
  };
  await visit(root);
  return files;
};

export const cleanupToolOutputSpills = async ({
  stellaDataDir,
  now = Date.now(),
  maxAgeMs = DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS,
  quotaBytes = DEFAULT_TOOL_OUTPUT_SPILL_QUOTA_BYTES,
} = {}) => {
  const root = path.join(stellaDataDir, TOOL_OUTPUT_SPILL_DIR);
  const files = await collectArtifacts(root);
  const retained = [];
  for (const file of files) {
    if (now - file.mtimeMs > maxAgeMs) {
      await fs.rm(file.filePath, { force: true }).catch(() => undefined);
    } else {
      retained.push(file);
    }
  }
  retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
  for (const file of retained.reverse()) {
    if (retainedBytes <= quotaBytes) break;
    await fs.rm(file.filePath, { force: true }).catch(() => undefined);
    retainedBytes -= file.size;
  }
  return { retainedBytes };
};

export const spillSanitizedToolOutput = async ({
  text,
  stellaDataDir,
  runId,
  toolCallId,
}) => {
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const runDirectory = path.join(
    stellaDataDir,
    TOOL_OUTPUT_SPILL_DIR,
    safeSegment(runId, "unscoped-run"),
  );
  await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(runDirectory, 0o700).catch(() => undefined);
  const base = `${safeSegment(toolCallId, "tool-call")}-${sha256.slice(0, 16)}`;
  const filePath = path.join(runDirectory, `${base}.txt`);
  const temporaryPath = path.join(runDirectory, `.${base}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, text, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  // Linking is atomic and, unlike POSIX rename, cannot replace an existing
  // artifact from a concurrent identical spill.
  await fs.link(temporaryPath, filePath).catch(async (error) => {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error?.code !== "EEXIST") throw error;
  });
  await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  await fs.chmod(filePath, 0o600);
  void cleanupToolOutputSpills({ stellaDataDir }).catch(() => undefined);
  return Object.freeze({
    path: filePath,
    bytes,
    sha256,
    encoding: "utf8",
    lineCount: text.length === 0 ? 0 : text.split("\n").length,
    read: Object.freeze({
      tool: "Read",
      arguments: Object.freeze({ file_path: filePath, offset: 1, limit: 200 }),
      offsetUnit: "line",
      byteRange: Object.freeze({ start: 0, endExclusive: bytes }),
    }),
  });
};
