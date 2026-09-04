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

/**
 * The tools the daemon serves.
 *
 * `code` is deliberately absent. A resident turn runs `code` in a Dynamic
 * Worker the Durable Object loads itself (see `general-agent-tools.ts`,
 * placement `js_sandbox`), so it never crosses this channel: there is no
 * container to attach for it and nothing for the daemon to serve. The
 * in-container `code` of an eager container turn is a different tool host
 * with the turn-broker browser session factory; it is not bridged either.
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

/**
 * v2: tool results no longer carry `fileChanges` / `producedFiles` /
 * `producedFilesOmitted`; the quiesce control request carries the untrusted
 * `linkedPaths` derived from the reply's markdown links, and the quiesced
 * response reports the delivered drive paths. A mixed-version daemon/DO pair
 * fails closed on the version check rather than silently dropping fields.
 */
export const ATTACHED_TOOL_PROTOCOL_VERSION = 2;

/**
 * Everything the bridge touches lives here, outside the world root. The world
 * is owned by the unprivileged tool account; this directory is root-owned, so
 * a tool the agent ran cannot read a frame or plant one.
 */
export const ATTACHED_TOOL_ROOT = "/workspace/attached";

export type AttachedToolPaths = Readonly<{
  directory: string;
  socket: string;
  hostInput: string;
  request: string;
  result: string;
  daemonStderr: string;
}>;

const ATTACHED_TOOL_DIRECTORY =
  /^\/workspace\/attached\/[A-Za-z0-9._~-]{1,256}-[1-9][0-9]*$/u;

export const attachedToolPaths = (args: {
  turnId: string;
  attemptGeneration: number;
}): AttachedToolPaths => {
  if (
    !/^[A-Za-z0-9._~-]{1,256}$/u.test(args.turnId) ||
    !Number.isSafeInteger(args.attemptGeneration) ||
    args.attemptGeneration < 1
  ) {
    throw new TypeError("Attached tool identity must be exact.");
  }
  return attachedToolPathsForDirectory(
    `${ATTACHED_TOOL_ROOT}/${args.turnId}-${args.attemptGeneration}`,
  );
};

export const attachedToolPathsForDirectory = (
  directory: string,
): AttachedToolPaths => {
  if (!ATTACHED_TOOL_DIRECTORY.test(directory)) {
    throw new TypeError("Attached tool directory must be exact.");
  }
  return {
    directory,
    socket: `${directory}/tool-host.sock`,
    hostInput: `${directory}/host-input.json`,
    request: `${directory}/request.json`,
    result: `${directory}/result.json`,
    daemonStderr: `${directory}/daemon.stderr`,
  };
};

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

/** Bounds the linked paths one quiesce request may carry. */
export const ATTACHED_TOOL_MAX_LINKED_PATHS = 512;
const MAX_LINKED_PATH_LENGTH = 4096;
/** Bounds the delivered drive paths one quiesced response may report. */
export const ATTACHED_TOOL_MAX_DELIVERED_FILES = 512;

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

/**
 * A `ToolResult` reduced to what survives JSON and what the worker still needs:
 * the model-visible outcome, the details blob, and authorized image bytes.
 * Nothing here is a live handle, so a lost daemon cannot leave the worker
 * holding one.
 */
export type SerializedAgentToolResult = Readonly<{
  outcome:
    | Readonly<{ kind: "ok"; text: string }>
    | Readonly<{ kind: "error"; message: string }>;
  details: unknown;
  authorizedImages: readonly SerializedAuthorizedImage[];
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
export type AttachedToolControlRequest =
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      turnId: string;
      attemptGeneration: number;
      control: "boot_report";
    }>
  | Readonly<{
      version: typeof ATTACHED_TOOL_PROTOCOL_VERSION;
      turnId: string;
      attemptGeneration: number;
      control: "quiesce";
      /**
       * Untrusted paths linked in the turn's final assistant message(s). The
       * daemon authorizes each one beneath the workspace boundary before
       * anything is delivered.
       */
      linkedPaths: readonly string[];
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
      /** Drive paths whose delivery to the drive succeeded. */
      deliveredFiles: readonly string[];
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

const boundedPaths = (
  value: unknown,
  field: string,
  maxEntries: number,
): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > maxEntries ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= MAX_LINKED_PATH_LENGTH,
    )
  ) {
    throw new AttachedToolProtocolError(field);
  }
  return value as readonly string[];
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
  exactKeys(row, ["outcome", "details", "authorizedImages"], "result");
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
  if (row.control === "boot_report") {
    exactKeys(
      row,
      ["version", "turnId", "attemptGeneration", "control"],
      "control",
    );
    return {
      version: versionOf(row.version),
      turnId: boundedId(row.turnId, "turnId"),
      attemptGeneration: attemptGenerationOf(row.attemptGeneration),
      control: "boot_report",
    };
  }
  if (row.control === "quiesce") {
    exactKeys(
      row,
      ["version", "turnId", "attemptGeneration", "control", "linkedPaths"],
      "control",
    );
    return {
      version: versionOf(row.version),
      turnId: boundedId(row.turnId, "turnId"),
      attemptGeneration: attemptGenerationOf(row.attemptGeneration),
      control: "quiesce",
      linkedPaths: boundedPaths(
        row.linkedPaths,
        "linkedPaths",
        ATTACHED_TOOL_MAX_LINKED_PATHS,
      ),
    };
  }
  throw new AttachedToolProtocolError("control");
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
    exactKeys(row, ["version", "status", "deliveredFiles"], "control");
    return {
      version,
      status: "quiesced",
      deliveredFiles: boundedPaths(
        row.deliveredFiles,
        "deliveredFiles",
        ATTACHED_TOOL_MAX_DELIVERED_FILES,
      ),
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
