/**
 * The orchestrator's `memory` client inside `code`, one contract for every
 * host: `memory.read(path)`, `memory.write(path, content, { expectSha })` and
 * `memory.list()` over the memory files under `~/.stella`.
 *
 * Paths are relative to `~/.stella` and name only memory: `core-memory.md`
 * or a Markdown file under `memories/`. Writes are redacted with the memory
 * redaction and capped per file: a resident document at its injection budget
 * (so a write can never produce a file the model is shown truncated), any
 * other memory file at `MEMORY_FILE_MAX_CHARS`. A `sha` is the hex SHA-256 of
 * the file's bytes.
 *
 * This module does no I/O. Each side has one module that owns its files and
 * returns this client — `disk-memory.ts` over `~/.stella` on the desktop,
 * cloud-builder's `world-memory.ts` over `/workspace/world/.stella` in the
 * owner's world — so both validate, redact, cap and answer byte for byte the
 * same. The `$memory` code intrinsics on both hosts only forward a request
 * to that client (`runMemoryRequest`).
 */

import { redactMemoryText } from "./redaction.js";
import {
  CORE_MEMORY_FILE,
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORIES_DIR,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_FILE,
  USER_PROFILE_INJECTED_MAX_CHARS,
} from "./memory-layout.js";

/** Cap for a memory file that is not resident, in unicode code points. */
export const MEMORY_FILE_MAX_CHARS = 32_000;
/** `memory.list()` stops after this many files. */
export const MEMORY_LIST_MAX_FILES = 500;

const MAX_PATH_CHARS = 240;
const MAX_SEGMENT_CHARS = 96;
const MAX_SEGMENTS = 8;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export type MemoryFileInfo = {
  /** Relative to `~/.stella`, e.g. `memories/profile.md`. */
  path: string;
  /** UTF-8 bytes. */
  size: number;
  sha: string;
  /** Last modification, epoch milliseconds. */
  updatedAt: number;
};

export type MemoryWriteResult = { sha: string; bytes: number };

/**
 * One host's raw memory files. Paths are already validated memory paths.
 * `write` must compare and write atomically: with `expectSha` set it writes
 * only when the file's current sha is exactly that, and otherwise reports
 * what it found (`null` for a missing file).
 */
export type MemoryFileStore = {
  read(path: string): Promise<Uint8Array | null>;
  write(
    path: string,
    bytes: Uint8Array,
    sha: string,
    expectSha: string | undefined,
  ): Promise<{ ok: true } | { ok: false; actualSha: string | null }>;
  /** Every memory file, each with its sha. Non-memory paths may be included. */
  list(): Promise<MemoryFileInfo[]>;
};

export type MemoryClient = {
  read(path: unknown): Promise<string | null>;
  write(
    path: unknown,
    content: unknown,
    options?: unknown,
  ): Promise<MemoryWriteResult>;
  list(): Promise<MemoryFileInfo[]>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const codePoints = (text: string): number => Array.from(text).length;

export const memorySha = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const pathError = (op: string, input: unknown, reason: string): Error =>
  new Error(
    `memory.${op}: ${JSON.stringify(typeof input === "string" ? input : String(input))} ${reason}. Memory paths are relative to ~/.stella: "core-memory.md" or a Markdown file under "memories/", such as "memories/profile.md".`,
  );

/**
 * The validated memory path for `input`, or a thrown error naming what is
 * wrong. Only `core-memory.md` and `memories/**\/*.md`; no absolute, home,
 * parent, hidden or empty segments.
 */
export const memoryPath = (input: unknown, op = "read"): string => {
  if (typeof input !== "string" || input.length === 0) {
    throw pathError(op, input, "is not a path");
  }
  if (input.startsWith("~/.stella/")) {
    throw new Error(
      `memory.${op}: pass ${JSON.stringify(input.slice("~/.stella/".length))}, not ${JSON.stringify(input)}; memory paths are relative to ~/.stella.`,
    );
  }
  if (input.startsWith("/") || input.startsWith("~")) {
    throw pathError(op, input, "is absolute");
  }
  if (
    input.length > MAX_PATH_CHARS ||
    input.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw pathError(op, input, "is not a valid path");
  }
  const segments = input.split("/");
  if (
    segments.length > MAX_SEGMENTS ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.length > MAX_SEGMENT_CHARS,
    )
  ) {
    throw pathError(op, input, "is not a valid path");
  }
  if (input === CORE_MEMORY_FILE) return input;
  if (segments[0] !== MEMORIES_DIR || segments.length < 2) {
    throw pathError(op, input, "is not a memory file");
  }
  if (!input.endsWith(".md")) {
    throw pathError(op, input, "is not a Markdown (.md) file");
  }
  return input;
};

/** Whether `path` is a memory path, without throwing. */
export const isMemoryPath = (path: string): boolean => {
  try {
    memoryPath(path);
    return true;
  } catch {
    return false;
  }
};

/** Characters one memory file may hold after redaction. */
export const memoryFileMaxChars = (path: string): number => {
  if (path === CORE_MEMORY_FILE) return CORE_MEMORY_INJECTED_MAX_CHARS;
  if (path === `${MEMORIES_DIR}/${USER_PROFILE_FILE}`) {
    return USER_PROFILE_INJECTED_MAX_CHARS;
  }
  if (path === `${MEMORIES_DIR}/${MEMORY_INDEX_FILE}`) {
    return MEMORY_INDEX_INJECTED_MAX_CHARS;
  }
  return MEMORY_FILE_MAX_CHARS;
};

const expectShaOption = (options: unknown): string | undefined => {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(
      "memory.write: options must be an object such as { expectSha }.",
    );
  }
  const expectSha = (options as { expectSha?: unknown }).expectSha;
  if (expectSha === undefined) return undefined;
  if (typeof expectSha !== "string" || !SHA256_HEX.test(expectSha)) {
    throw new Error(
      "memory.write: expectSha must be a file's sha from memory.list() or an earlier memory.write().",
    );
  }
  return expectSha;
};

const shortSha = (sha: string | null): string =>
  sha ? `${sha.slice(0, 12)}…` : "no file";

/** The `memory` client over one host's files. */
export const createMemoryClient = (store: MemoryFileStore): MemoryClient => ({
  read: async (input) => {
    const path = memoryPath(input, "read");
    const bytes = await store.read(path);
    return bytes === null ? null : decoder.decode(bytes);
  },
  write: async (input, content, options) => {
    const path = memoryPath(input, "write");
    if (typeof content !== "string") {
      throw new Error(`memory.write: content for ${path} must be a string.`);
    }
    const expectSha = expectShaOption(options);
    const text = redactMemoryText(content);
    const chars = codePoints(text);
    const maxChars = memoryFileMaxChars(path);
    if (chars > maxChars) {
      throw new Error(
        `memory.write: ${path} would be ${chars.toLocaleString("en-US")} characters; its limit is ${maxChars.toLocaleString("en-US")}. Nothing was written. Curate it down (rewrite stale lines, or move detail into its own file under memories/ with one line in memories/index.md) and write again.`,
      );
    }
    const bytes = encoder.encode(text);
    const sha = await memorySha(bytes);
    const outcome = await store.write(path, bytes, sha, expectSha);
    if (!outcome.ok) {
      throw new Error(
        `memory.write: ${path} changed since that sha was taken (expected ${shortSha(expectSha ?? null)}, found ${shortSha(outcome.actualSha)}). Nothing was written; read it again, reapply the edit, and write with the new sha.`,
      );
    }
    return { sha, bytes: bytes.byteLength };
  },
  list: async () =>
    (await store.list())
      .filter((file) => isMemoryPath(file.path))
      .sort((left, right) =>
        left.path === CORE_MEMORY_FILE
          ? -1
          : right.path === CORE_MEMORY_FILE
            ? 1
            : left.path.localeCompare(right.path),
      )
      .slice(0, MEMORY_LIST_MAX_FILES),
});

/**
 * Answer one `$memory` intrinsic call against `client`. Both hosts' code
 * bridges send `{ op: "read", path }`, `{ op: "write", path, content,
 * options }` or `{ op: "list" }`.
 */
export const runMemoryRequest = async (
  client: MemoryClient,
  input: unknown,
): Promise<unknown> => {
  const request =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  switch (request.op) {
    case "read":
      return await client.read(request.path);
    case "write":
      return await client.write(request.path, request.content, request.options);
    case "list":
      return await client.list();
    default:
      throw new Error(
        `memory.${String(request.op ?? "?")} is not a memory method; use memory.read, memory.write or memory.list.`,
      );
  }
};
