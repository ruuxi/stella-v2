/**
 * The wire between a resident agent loop and the tool-host daemon that runs
 * inside a lazily attached Cloudflare Sandbox.
 *
 * Both ends parse with the same exact-key parsers. That is the point: the
 * Durable Object writes a root-owned request file and reads a root-owned
 * result file, and neither side may accept a frame it did not fully validate.
 * A tool name outside `ATTACHED_TOOL_NAMES` is refused before any handler
 * exists for it, so adding a bridged tool is a change to this allowlist rather
 * than something a request can assert.
 *
 * The raw turn token appears nowhere here. Idempotency is a `toolCallId` plus
 * a fingerprint of the exact arguments; a replay whose effect cannot be proven
 * fails closed rather than running a command twice.
 *
 * This module is imported by workerd. It holds types, constants and pure
 * parsers, and must never reach a Node builtin.
 */

import type { FileChangeRecord } from "@stella/contracts/file-changes";
import { isFileChangeRecordArray } from "@stella/contracts/file-changes";

/**
 * The tools the daemon serves.
 *
 * `code` is deliberately absent. Cloud `code` is not a tool the tool host can
 * answer on its own: it needs the turn-broker browser session factory, it
 * needs `endBrowserTurn` to be called for its exact tool-call ids when the
 * turn quiesces, and a login handoff makes the whole turn suspend rather than
 * returning a tool result. Those are agent-host concerns, not tool-host ones,
 * so `code` keeps its refusal stub until the resident Dynamic Worker path
 * lands.
 *
 * `view_image` is absent for a different reason: it has no runtime definition
 * and no descriptor, so it never reaches the model and the daemon has nothing
 * to dispatch it to.
 */
export const ATTACHED_TOOL_NAMES = [
  "exec_command",
  "write_stdin",
  "Read",
  "apply_patch",
] as const;

export type AttachedToolName = (typeof ATTACHED_TOOL_NAMES)[number];

const ATTACHED_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  ATTACHED_TOOL_NAMES,
);

export const isAttachedToolName = (value: unknown): value is AttachedToolName =>
  typeof value === "string" && ATTACHED_TOOL_NAME_SET.has(value);

export const ATTACHED_TOOL_PROTOCOL_VERSION = 1;

/** One framed request, including its identity envelope. */
export const ATTACHED_TOOL_REQUEST_MAX_BYTES = 1024 * 1024;

/**
 * One framed response. Large enough for the biggest image `Read` can already
 * return after base64 expansion, plus the surrounding result. Derived from the
 * existing per-image limit rather than chosen independently.
 */
export const ATTACHED_TOOL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHED_TOOL_MAX_IMAGES = 8;
export const ATTACHED_TOOL_RESPONSE_MAX_BYTES = 48 * 1024 * 1024;

/** Bounds the file records one call may report. */
export const ATTACHED_TOOL_MAX_FILE_RECORDS = 512;

const MAX_ID_LENGTH = 256;
const MAX_ERROR_LENGTH = 8 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type SerializedAuthorizedImage = Readonly<{
  /** Base64. The daemon holds the bytes; only this crosses the wire. */
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sourcePath: string;
}>;

export type ProducedFilesOmitted = Readonly<{
  count: number;
  limit: number;
}>;

/**
 * A `ToolResult` reduced to what survives JSON and what the worker still needs:
 * the model-visible outcome, the details blob, authorized image bytes, and the
 * file records final output reporting is built from. Nothing here is a live
 * handle, so a lost daemon cannot leave the worker holding one.
 */
export type SerializedAgentToolResult = Readonly<{
  outcome:
    | Readonly<{ kind: "ok"; text: string }>
    | Readonly<{ kind: "error"; message: string }>;
  details: unknown;
  authorizedImages: readonly SerializedAuthorizedImage[];
  fileChanges: readonly FileChangeRecord[];
  producedFiles: readonly FileChangeRecord[];
  producedFilesOmitted: ProducedFilesOmitted | null;
}>;

export type AttachedToolRequest = Readonly<{
  version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
  turnId: string;
  attemptGeneration: number;
  toolCallId: string;
  fingerprint: string;
  toolName: AttachedToolName;
  params: Readonly<Record<string, unknown>>;
}>;

export type AttachedToolResponse =
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "completed";
      toolCallId: string;
      fingerprint: string;
      result: SerializedAgentToolResult;
    }>
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "pending";
      toolCallId: string;
      fingerprint: string;
    }>
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "failed";
      toolCallId: string;
      fingerprint: string;
      error: string;
    }>;

/**
 * The daemon's answer to a boot, quiesce, or receipt question. These share the
 * socket with tool calls, so they share its parser discipline.
 */
export type AttachedToolControlRequest = Readonly<{
  version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
  turnId: string;
  attemptGeneration: number;
  control: "boot_report" | "quiesce";
}>;

export type AttachedToolControlResponse =
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "boot_report";
      notices: readonly string[];
    }>
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "quiesced";
      producedFiles: readonly FileChangeRecord[];
      producedFilesOmitted: ProducedFilesOmitted | null;
    }>
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      status: "failed";
      error: string;
    }>;

export class AttachedToolProtocolError extends Error {
  constructor(readonly field: string) {
    super(`Attached tool frame field ${field} is invalid.`);
    this.name = "AttachedToolProtocolError";
  }
}

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttachedToolProtocolError(field);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void => {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) throw new AttachedToolProtocolError(field);
  }
};

const boundedId = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new AttachedToolProtocolError(field);
  }
  return value;
};

const fingerprintOf = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    throw new AttachedToolProtocolError(field);
  }
  return value;
};

const attemptGenerationOf = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AttachedToolProtocolError("attemptGeneration");
  }
  return value as number;
};

const versionOf = (value: unknown): typeof ATTACHED_TOOL_PROTOCOL_VERSION => {
  if (value !== ATTACHED_TOOL_PROTOCOL_VERSION) {
    throw new AttachedToolProtocolError("version");
  }
  return ATTACHED_TOOL_PROTOCOL_VERSION;
};

const boundedError = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_ERROR_LENGTH
  ) {
    throw new AttachedToolProtocolError(field);
  }
  return value;
};

const fileRecords = (
  value: unknown,
  field: string,
): readonly FileChangeRecord[] => {
  if (
    !Array.isArray(value) ||
    value.length > ATTACHED_TOOL_MAX_FILE_RECORDS ||
    !isFileChangeRecordArray(value)
  ) {
    throw new AttachedToolProtocolError(field);
  }
  return value;
};

const omission = (value: unknown): ProducedFilesOmitted | null => {
  if (value === null) return null;
  const row = record(value, "producedFilesOmitted");
  exactKeys(row, ["count", "limit"], "producedFilesOmitted");
  if (
    !Number.isSafeInteger(row.count) ||
    (row.count as number) < 0 ||
    !Number.isSafeInteger(row.limit) ||
    (row.limit as number) < 0
  ) {
    throw new AttachedToolProtocolError("producedFilesOmitted");
  }
  return { count: row.count as number, limit: row.limit as number };
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const authorizedImages = (
  value: unknown,
): readonly SerializedAuthorizedImage[] => {
  if (!Array.isArray(value) || value.length > ATTACHED_TOOL_MAX_IMAGES) {
    throw new AttachedToolProtocolError("authorizedImages");
  }
  return value.map((entry) => {
    const row = record(entry, "authorizedImages");
    exactKeys(row, ["data", "mimeType", "sourcePath"], "authorizedImages");
    if (
      typeof row.data !== "string" ||
      row.data.length % 4 !== 0 ||
      !BASE64.test(row.data) ||
      row.data.length > ATTACHED_TOOL_IMAGE_MAX_BYTES ||
      typeof row.mimeType !== "string" ||
      !MIME_TYPES.has(row.mimeType) ||
      typeof row.sourcePath !== "string" ||
      row.sourcePath.length === 0 ||
      row.sourcePath.length > 4096
    ) {
      throw new AttachedToolProtocolError("authorizedImages");
    }
    return {
      data: row.data,
      mimeType: row.mimeType as SerializedAuthorizedImage["mimeType"],
      sourcePath: row.sourcePath,
    };
  });
};

export const parseSerializedAgentToolResult = (
  value: unknown,
): SerializedAgentToolResult => {
  const row = record(value, "result");
  exactKeys(
    row,
    [
      "outcome",
      "details",
      "authorizedImages",
      "fileChanges",
      "producedFiles",
      "producedFilesOmitted",
    ],
    "result",
  );
  const outcomeRow = record(row.outcome, "outcome");
  let outcome: SerializedAgentToolResult["outcome"];
  if (outcomeRow.kind === "ok") {
    exactKeys(outcomeRow, ["kind", "text"], "outcome");
    if (typeof outcomeRow.text !== "string") {
      throw new AttachedToolProtocolError("outcome");
    }
    outcome = { kind: "ok", text: outcomeRow.text };
  } else if (outcomeRow.kind === "error") {
    exactKeys(outcomeRow, ["kind", "message"], "outcome");
    outcome = {
      kind: "error",
      message: boundedError(outcomeRow.message, "outcome"),
    };
  } else {
    throw new AttachedToolProtocolError("outcome");
  }
  return {
    outcome,
    details: row.details ?? null,
    authorizedImages: authorizedImages(row.authorizedImages),
    fileChanges: fileRecords(row.fileChanges, "fileChanges"),
    producedFiles: fileRecords(row.producedFiles, "producedFiles"),
    producedFilesOmitted: omission(row.producedFilesOmitted),
  };
};

export const parseAttachedToolRequest = (
  value: unknown,
): AttachedToolRequest => {
  const row = record(value, "request");
  exactKeys(
    row,
    [
      "version",
      "turnId",
      "attemptGeneration",
      "toolCallId",
      "fingerprint",
      "toolName",
      "params",
    ],
    "request",
  );
  if (!isAttachedToolName(row.toolName)) {
    throw new AttachedToolProtocolError("toolName");
  }
  return {
    version: versionOf(row.version),
    turnId: boundedId(row.turnId, "turnId"),
    attemptGeneration: attemptGenerationOf(row.attemptGeneration),
    toolCallId: boundedId(row.toolCallId, "toolCallId"),
    fingerprint: fingerprintOf(row.fingerprint, "fingerprint"),
    toolName: row.toolName,
    params: record(row.params, "params"),
  };
};

export const parseAttachedToolResponse = (
  value: unknown,
): AttachedToolResponse => {
  const row = record(value, "response");
  const version = versionOf(row.version);
  const toolCallId = boundedId(row.toolCallId, "toolCallId");
  const fingerprint = fingerprintOf(row.fingerprint, "fingerprint");
  if (row.status === "completed") {
    exactKeys(
      row,
      ["version", "status", "toolCallId", "fingerprint", "result"],
      "response",
    );
    return {
      version,
      status: "completed",
      toolCallId,
      fingerprint,
      result: parseSerializedAgentToolResult(row.result),
    };
  }
  if (row.status === "pending") {
    exactKeys(
      row,
      ["version", "status", "toolCallId", "fingerprint"],
      "response",
    );
    return { version, status: "pending", toolCallId, fingerprint };
  }
  if (row.status === "failed") {
    exactKeys(
      row,
      ["version", "status", "toolCallId", "fingerprint", "error"],
      "response",
    );
    return {
      version,
      status: "failed",
      toolCallId,
      fingerprint,
      error: boundedError(row.error, "error"),
    };
  }
  throw new AttachedToolProtocolError("status");
};

export const parseAttachedToolControlRequest = (
  value: unknown,
): AttachedToolControlRequest => {
  const row = record(value, "control");
  exactKeys(
    row,
    ["version", "turnId", "attemptGeneration", "control"],
    "control",
  );
  if (row.control !== "boot_report" && row.control !== "quiesce") {
    throw new AttachedToolProtocolError("control");
  }
  return {
    version: versionOf(row.version),
    turnId: boundedId(row.turnId, "turnId"),
    attemptGeneration: attemptGenerationOf(row.attemptGeneration),
    control: row.control,
  };
};

export const parseAttachedToolControlResponse = (
  value: unknown,
): AttachedToolControlResponse => {
  const row = record(value, "control");
  const version = versionOf(row.version);
  if (row.status === "boot_report") {
    exactKeys(row, ["version", "status", "notices"], "control");
    if (
      !Array.isArray(row.notices) ||
      row.notices.length > 256 ||
      !row.notices.every(
        (notice) => typeof notice === "string" && notice.length <= 4096,
      )
    ) {
      throw new AttachedToolProtocolError("notices");
    }
    return { version, status: "boot_report", notices: row.notices };
  }
  if (row.status === "quiesced") {
    exactKeys(
      row,
      ["version", "status", "producedFiles", "producedFilesOmitted"],
      "control",
    );
    return {
      version,
      status: "quiesced",
      producedFiles: fileRecords(row.producedFiles, "producedFiles"),
      producedFilesOmitted: omission(row.producedFilesOmitted),
    };
  }
  if (row.status === "failed") {
    exactKeys(row, ["version", "status", "error"], "control");
    return {
      version,
      status: "failed",
      error: boundedError(row.error, "error"),
    };
  }
  throw new AttachedToolProtocolError("status");
};

/**
 * Stable across key order so a replay of the same call cannot look like a
 * different one, and so a different call cannot borrow a completed receipt.
 * `crypto.subtle` is available in both workerd and Node, which is why the
 * fingerprint is computed here rather than on either side alone.
 */
export const attachedToolFingerprint = async (args: {
  toolName: AttachedToolName;
  params: Readonly<Record<string, unknown>>;
}): Promise<string> => {
  const canonical = JSON.stringify([
    ATTACHED_TOOL_PROTOCOL_VERSION,
    args.toolName,
    canonicalize(args.params),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

export const encodeAttachedToolFrame = (frame: unknown): string => {
  const text = JSON.stringify(frame);
  if (
    new TextEncoder().encode(text).byteLength > ATTACHED_TOOL_RESPONSE_MAX_BYTES
  ) {
    throw new AttachedToolProtocolError("frame");
  }
  return text;
};

export const decodeAttachedToolFrame = (
  text: string,
  maxBytes: number,
): unknown => {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AttachedToolProtocolError("frame");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AttachedToolProtocolError("frame");
  }
};
