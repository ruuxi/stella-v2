import { promises as fs } from "node:fs";

import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "../agent-core/types.js";
import { createToolExecutionSupervisor } from "./tool-lifecycle.js";
import type { RunResourceRegistrar } from "./run-resources.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ImageContent, TextContent } from "../../ai/types.js";
import { DEVICE_TOOL_NAMES } from "../tools/schemas.js";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import type {
  AuthorizedToolImage,
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import { TOOL_RESULT_AUTHORIZED_IMAGES } from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { TOOL_IDS } from "@stella/contracts/agent-runtime";
import {
  AnyToolArgsSchema,
  resolveAgentWorkingDirectory,
  textFromUnknown,
} from "./shared.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import {
  sanitizeToolError,
  sanitizeToolResult,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import { resolveImageMimeType } from "../shared/image-mime.js";
import { readImageFileSettled } from "../shared/read-image-file.js";
import { formatDimensionNote, resizeImage } from "../shared/image-resize.js";
import {
  detectImageMediaType,
  isCompleteImage,
  MAX_IMAGE_BASE64_BYTES,
} from "../../ai/utils/image-payload.js";
import {
  maxInlineImageBase64Bytes,
  resolveImageCaps,
  type ImageCapTarget,
} from "../../ai/utils/image-caps.js";
import { decodeAndValidateImage } from "../tools/image-decode-validation.js";
import { buildCatalogSection } from "../tools/code-catalog.js";
import {
  CODE_TOOL_NAME,
  toolRequiresExplicitApproval,
} from "../tools/code-tool.js";
import { spillSanitizedToolOutput } from "./tool-output-spill.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  splitLinesForCounting,
  truncateHead,
  truncateTail,
  truncateStringToBytesFromStart,
  utf8ByteLength,
} from "../tools/truncate.js";

export const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  TOOL_IDS.NO_RESPONSE,
] as const;

const COMMAND_OUTPUT_TOOL_NAMES = new Set(["exec_command", "write_stdin"]);
const MULTI_TOOL_USE_PARALLEL_TOOL_NAME = "multi_tool_use_parallel";
export const MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES = 10_000;
// Codex's ExecCommandToolOutput::model_output_policy compares the model's
// truncation policy with max_output_tokens at four approximate bytes/token.
// Keep Stella's approved 10KB model policy as the outer cap and let smaller
// per-call token requests reduce only the command preview inside that cap.
const APPROX_COMMAND_OUTPUT_BYTES_PER_TOKEN = 4;
const COMMAND_RESULT_LIMITS = Object.freeze({
  maxBytes: MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES,
  maxLines: Number.MAX_SAFE_INTEGER,
});

const containsCommandOutput = (
  toolName: string,
  toolResult: ToolResult,
): boolean => {
  if (COMMAND_OUTPUT_TOOL_NAMES.has(toolName)) return true;
  if (toolName !== MULTI_TOOL_USE_PARALLEL_TOOL_NAME) return false;
  const results = (
    toolResult.details as
      | { results?: Array<{ tool_name?: unknown }> }
      | undefined
  )?.results;
  return (
    Array.isArray(results) &&
    results.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.tool_name === "string" &&
        COMMAND_OUTPUT_TOOL_NAMES.has(entry.tool_name),
    )
  );
};

const commandResultLimitsFor = (
  toolResult: ToolResult,
): ModelVisibleLimits & { previewMaxBytes: number } => {
  const requestedTokens =
    typeof toolResult.modelOutputTokens === "number" &&
    Number.isFinite(toolResult.modelOutputTokens)
      ? Math.max(0, Math.floor(toolResult.modelOutputTokens))
      : undefined;
  const requestedBytes =
    requestedTokens === undefined ||
    requestedTokens >=
      Math.ceil(
        MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES /
          APPROX_COMMAND_OUTPUT_BYTES_PER_TOKEN,
      )
      ? MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES
      : requestedTokens * APPROX_COMMAND_OUTPUT_BYTES_PER_TOKEN;
  return { ...COMMAND_RESULT_LIMITS, previewMaxBytes: requestedBytes };
};

const modelVisibleLimitsFor = (
  toolName: string,
  toolResult: ToolResult,
): ModelVisibleLimits | undefined =>
  containsCommandOutput(toolName, toolResult)
    ? commandResultLimitsFor(toolResult)
    : undefined;

const formatToolLabel = (toolName: string): string =>
  toolName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || toolName;

const formatToolWorkingText = (metadata: ToolMetadata): string =>
  metadata.workingText ??
  `Running ${metadata.label ?? formatToolLabel(metadata.name)}`;

export const getRequestedRuntimeToolNames = (
  toolsAllowlist?: string[],
): string[] =>
  Array.isArray(toolsAllowlist) && toolsAllowlist.length > 0
    ? toolsAllowlist
    : [...STELLA_LOCAL_TOOLS];

/**
 * Resolve the agent's tool allowlist against the host's catalog.
 *
 * The catalog is the single source of truth for tool metadata — every tool
 * lives as a self-contained `ToolDefinition` under
 * `runtime/kernel/tools/defs/` and is registered into the catalog by the
 * host. If a name in the allowlist isn't in the catalog, it's silently
 * dropped and a warning is logged.
 */
export const getRuntimeToolMetadata = (opts: {
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
}): ToolMetadata[] => {
  const catalog = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const resolved: ToolMetadata[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const toolName of getRequestedRuntimeToolNames(opts.toolsAllowlist)) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    const entry = catalog.get(toolName);
    if (!entry) {
      missing.push(toolName);
      continue;
    }
    resolved.push(entry);
  }
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tool-adapters] dropped unknown tools from allowlist: ${missing.join(", ")}`,
    );
  }
  return resolved;
};

const formatToolResult = (
  toolResult: ToolResult,
  toolName: string,
): { text: string; details: unknown } => {
  if (toolResult.error) {
    const error = sanitizeToolError(toolResult.error);
    return {
      text: `Error: ${error}`,
      details: sanitizeToolResult(toolResult.details ?? { error }),
    };
  }

  const result = sanitizeToolResult(toolResult.result);
  return {
    text: sanitizeToolVisibleText(textFromUnknown(result)),
    details: sanitizeToolResult(
      toolResult.details ??
        (COMMAND_OUTPUT_TOOL_NAMES.has(toolName) ? undefined : result),
    ),
  };
};

// Model-visible tool text is bounded once, before the tool-result message is
// appended to history. That exact content is then reused until compaction.
// Dual limits match the Pi harness: 2000 lines or 50KB UTF-8, first hit wins.
export const MODEL_VISIBLE_TOOL_RESULT_MAX_LINES = DEFAULT_MAX_LINES;
export const MODEL_VISIBLE_TOOL_RESULT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = DEFAULT_MAX_BYTES;

type ModelVisibleLimits =
  | number
  | { maxBytes?: number; maxLines?: number; previewMaxBytes?: number };

const resolveModelVisibleLimits = (
  limits?: ModelVisibleLimits,
): { maxBytes: number; maxLines: number; previewMaxBytes: number } => {
  if (typeof limits === "number") {
    const maxBytes = Math.max(0, limits);
    return {
      maxBytes,
      maxLines: Number.MAX_SAFE_INTEGER,
      previewMaxBytes: maxBytes,
    };
  }
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    maxBytes,
    maxLines: limits?.maxLines ?? DEFAULT_MAX_LINES,
    previewMaxBytes: Math.min(maxBytes, limits?.previewMaxBytes ?? maxBytes),
  };
};

const buildTruncationNotice = (
  totalBytes: number,
  totalLines: number,
  outputBytes: number,
): string => {
  const omittedBytes = Math.max(0, totalBytes - outputBytes);
  return `\n\n[Tool output truncated: ${omittedBytes} bytes omitted. Total output lines: ${totalLines}.]\n\n`;
};

const previewHead = (
  text: string,
  maxBytes: number,
  maxLines: number,
): string => {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  const head = truncateHead(text, { maxBytes, maxLines });
  if (head.firstLineExceedsLimit) {
    return truncateStringToBytesFromStart(text, maxBytes);
  }
  return head.content;
};

const previewTail = (
  text: string,
  maxBytes: number,
  maxLines: number,
): string => {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  return truncateTail(text, { maxBytes, maxLines }).content;
};

const windowsOverlap = (text: string, head: string, tail: string): boolean => {
  if (!head || !tail) return false;
  const headAt = text.indexOf(head);
  const tailAt = text.lastIndexOf(tail);
  return headAt >= 0 && tailAt >= 0 && headAt + head.length >= tailAt;
};

export const truncateModelVisibleToolText = (
  text: string,
  limits?: ModelVisibleLimits,
): {
  text: string;
  truncated: boolean;
  originalChars: number;
  originalBytes: number;
  originalLines: number;
} => {
  const originalChars = text.length;
  const resolved = resolveModelVisibleLimits(limits);
  const maxBytes = Math.min(resolved.maxBytes, resolved.previewMaxBytes);
  const { maxLines } = resolved;
  const originalBytes = utf8ByteLength(text);
  const originalLines = splitLinesForCounting(text).length;
  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return {
      text,
      truncated: false,
      originalChars,
      originalBytes,
      originalLines,
    };
  }
  let notice = buildTruncationNotice(originalBytes, originalLines, 0);
  let head = "";
  let tail = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const available = maxBytes - utf8ByteLength(notice);
    if (available <= 0) {
      head = "";
      tail = "";
      break;
    }
    const headBytes = Math.ceil(available / 2);
    const tailBytes = Math.floor(available / 2);
    const headLines = Math.ceil(maxLines / 2);
    const tailLines = Math.floor(maxLines / 2);
    head = previewHead(text, headBytes, headLines);
    tail = previewTail(text, tailBytes, tailLines);
    if (windowsOverlap(text, head, tail)) {
      tail = "";
    }
    const outputBytes = utf8ByteLength(head) + utf8ByteLength(tail);
    notice = buildTruncationNotice(originalBytes, originalLines, outputBytes);
    if (
      utf8ByteLength(head) + utf8ByteLength(notice) + utf8ByteLength(tail) <=
      maxBytes
    ) {
      break;
    }
  }
  let rendered = `${head}${notice}${tail}`;
  if (utf8ByteLength(rendered) > maxBytes) {
    const fallback = previewHead(text, maxBytes, maxLines);
    rendered =
      fallback.length > 0 ? fallback : text.slice(0, Math.max(0, maxBytes));
  }
  return {
    text: rendered,
    truncated: true,
    originalChars,
    originalBytes,
    originalLines,
  };
};

export const preserveModelVisibleToolText = async (
  text: string,
  context: { stellaDataDir?: string; runId: string; toolCallId: string },
  limits?: ModelVisibleLimits,
) => {
  const resolved = resolveModelVisibleLimits(limits);
  const truncated = truncateModelVisibleToolText(text, resolved);
  if (!truncated.truncated) return { ...truncated, artifact: undefined };
  const artifact = await spillSanitizedToolOutput({
    text,
    stellaDataDir: context.stellaDataDir,
    runId: context.runId,
    toolCallId: context.toolCallId,
  });
  const marker = `\n\n[TOOL_OUTPUT_TRUNCATED complete post-sanitization output preserved: artifact=${artifact.path} bytes=${artifact.bytes} sha256=${artifact.sha256} encoding=${artifact.encoding} lines=${artifact.lineCount}. Read more with Read({ file_path: ${JSON.stringify(artifact.path)}, offset: 1, limit: 200 }); offsets are 1-based lines; complete byte range is [0, ${artifact.bytes}).]`;
  const previewBudget = Math.max(
    0,
    Math.min(resolved.previewMaxBytes, resolved.maxBytes) -
      utf8ByteLength(marker),
  );
  return {
    ...truncated,
    text: `${truncateModelVisibleToolText(text, { maxBytes: previewBudget, maxLines: resolved.maxLines }).text}${marker}`,
    artifact,
  };
};

// Inline-image attach contract used by diagnostic tool output and other
// runtime emitters: when tool output contains a substring of the form
//
//     [stella-attach-image][ <WxH>][ <N>KB][ inline=image/png] <PATH>
//     [stella-attach-image] ... path="<JSON-escaped absolute path>"
//
// the runtime reads the file at <PATH> and emits an image content block
// alongside the text result, so the model sees the screenshot on its very
// next turn without having to call a separate Read.
//
// The marker is stripped from the text we forward to the model so the
// model doesn't waste tokens describing a path it doesn't need to see.
//
// This is a local-runtime compatibility parser only. Tool output such as an
// `exec_command` stdout stream is model-controlled and therefore cannot grant
// a privileged Cloud adapter permission to reopen a path. Cloud callers use
// `neutralizeLegacyAttachImageMarkers` and accept only symbol-carried bytes
// from a descriptor-authorized read. The marker can appear anywhere in local
// tool result text, including inside a JSON-stringified `output` field where
// real newlines are escaped as `\n` — that's why this regex is
// position-agnostic. New local emitters should use
// `path=${JSON.stringify(path)}` so spaces, quotes, non-ASCII, and Windows
// separators survive transport. Legacy whitespace-delimited paths remain
// supported locally.
const STELLA_ATTACH_IMAGE_MARKER = "[stella-attach-image]";
const ATTACH_IMAGE_EXTENSION_RE = /\.(?:png|jpg|jpeg|gif|webp)$/i;
const ABSOLUTE_IMAGE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

type AttachImageMatch = {
  full: string;
  path: string;
  detailOriginal: boolean;
};

const parseAttachImageMatches = (text: string): AttachImageMatch[] => {
  const matches: AttachImageMatch[] = [];
  let markerStart = text.indexOf(STELLA_ATTACH_IMAGE_MARKER);
  while (markerStart >= 0) {
    const nextMarker = text.indexOf(
      STELLA_ATTACH_IMAGE_MARKER,
      markerStart + STELLA_ATTACH_IMAGE_MARKER.length,
    );
    const newline = text.indexOf("\n", markerStart);
    const markerEnd = Math.min(
      nextMarker < 0 ? text.length : nextMarker,
      newline < 0 ? text.length : newline,
    );
    const marker = text.slice(markerStart, markerEnd);
    const pathAssignment = /\bpath\s*=\s*("(?:\\.|[^"\\])*")/.exec(marker);
    const quotedFallback = pathAssignment
      ? null
      : /(?:^|\s)("(?:\\.|[^"\\])*")/.exec(marker);
    const legacyFallback =
      pathAssignment || quotedFallback
        ? null
        : /(?:^|\s)((?:\/[^\s"]+|[A-Za-z]:[\\/][^\s"]+?)\.(?:png|jpg|jpeg|gif|webp))/i.exec(
            marker,
          );
    const token = pathAssignment?.[1] ?? quotedFallback?.[1];
    let imagePath: string | undefined;
    if (token) {
      try {
        imagePath = JSON.parse(token) as string;
      } catch {
        imagePath = undefined;
      }
    } else if (legacyFallback?.[1]) {
      imagePath = normalizeAttachImagePath(legacyFallback[1]);
    }
    if (
      imagePath &&
      ABSOLUTE_IMAGE_PATH_RE.test(imagePath) &&
      ATTACH_IMAGE_EXTENSION_RE.test(imagePath)
    ) {
      const pathEnd =
        markerStart +
        (pathAssignment?.index ??
          quotedFallback?.index ??
          legacyFallback?.index ??
          0) +
        (pathAssignment?.[0].length ??
          quotedFallback?.[0].length ??
          legacyFallback?.[0].length ??
          marker.length);
      matches.push({
        full: text.slice(markerStart, pathEnd),
        path: imagePath,
        detailOriginal: /\bdetail=original\b/.test(marker),
      });
    }
    markerStart = nextMarker;
  }
  return matches;
};

export type ImageBlock = ImageContent & {
  sourcePath: string;
  width?: number;
  height?: number;
};

type NodeReplImageRequest = {
  type: "image";
  path: string;
  detail?: unknown;
  alreadyAttached?: unknown;
  deleteAfterAttach?: unknown;
};

const base64Length = (binaryBytes: number) => Math.ceil(binaryBytes / 3) * 4;

const omittedAttachImageNote = (imgPath: string, binaryBytes: number) =>
  `[Image omitted: ${imgPath} is ${(binaryBytes / (1024 * 1024)).toFixed(1)}MB and could not be resized below the inline image size limit.]`;

const unreadableAttachImageNote = (imgPath: string) =>
  `[Image omitted: ${imgPath} could not be decoded as a valid image (it may be corrupt or truncated) and was skipped.]`;

const normalizeAttachImagePath = (filePath: string) =>
  /^[A-Za-z]:\\\\/.test(filePath) ? filePath.replace(/\\\\/g, "\\") : filePath;

const LEGACY_IMAGE_MARKER_DISABLED_NOTE =
  "[Path-based tool image attachment ignored; this runtime accepts only descriptor-authorized image bytes.]";

const neutralizeAttachImageString = (text: string): string => {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const markerStart = text.indexOf(STELLA_ATTACH_IMAGE_MARKER, cursor);
    if (markerStart < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, markerStart);
    const newline = text.indexOf("\n", markerStart);
    const markerEnd = newline < 0 ? text.length : newline;
    output += LEGACY_IMAGE_MARKER_DISABLED_NOTE;
    cursor = markerEnd;
  }
  return output.replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Remove legacy path-bearing image markers without reading any referenced
 * path. Cloud tool output passes through this fail-closed transform: model
 * text can request or echo a marker, but only symbol-carried bytes that were
 * already read through the trusted descriptor boundary can become an image.
 */
export const neutralizeLegacyAttachImageMarkers = (text: string): string => {
  if (!text || !text.includes(STELLA_ATTACH_IMAGE_MARKER)) return text;
  let jsonValue: unknown;
  try {
    jsonValue = JSON.parse(text);
  } catch {
    return neutralizeAttachImageString(text);
  }
  const neutralizeJsonStrings = (value: unknown): unknown => {
    if (typeof value === "string") return neutralizeAttachImageString(value);
    if (Array.isArray(value)) return value.map(neutralizeJsonStrings);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          neutralizeJsonStrings(entry),
        ]),
      );
    }
    return value;
  };
  return JSON.stringify(neutralizeJsonStrings(jsonValue), null, 2);
};

/**
 * Convert bytes already authorized by a trusted file descriptor into model
 * image blocks. This never reopens `sourcePath`; the path is provenance only.
 * Provider-specific dimension and byte caps are applied before the bytes
 * cross the model boundary, with a bounded raw fallback only when the image
 * was fully decoded and already fits those same caps.
 */
export const prepareAuthorizedToolImageBlocks = async (
  authorizedImages: readonly AuthorizedToolImage[] | undefined,
  target: ImageCapTarget = {},
): Promise<ImageBlock[]> => {
  if (!authorizedImages?.length) return [];
  const images: ImageBlock[] = [];
  const caps = resolveImageCaps({
    ...target,
    imageCount: authorizedImages.length,
  });
  const hardBase64Bytes = maxInlineImageBase64Bytes(target);
  for (const image of authorizedImages) {
    // Copy at the trust boundary so a mutable Buffer retained by a handler
    // cannot change after validation but before MCP/provider serialization.
    const bytes = Buffer.from(image.data);
    const decoded = await decodeAndValidateImage(bytes);
    if (!decoded || decoded.mimeType !== image.mimeType) continue;

    const resized = await resizeImage(bytes, decoded.mimeType, caps);
    if (resized) {
      if (
        Buffer.byteLength(resized.data, "utf8") > caps.maxBytes ||
        Buffer.byteLength(resized.data, "utf8") > hardBase64Bytes ||
        resized.width > caps.maxWidth ||
        resized.height > caps.maxHeight
      ) {
        continue;
      }
      images.push({
        type: "image",
        mimeType: resized.mimeType,
        data: resized.data,
        sourcePath: image.sourcePath,
        width: resized.width,
        height: resized.height,
      });
      continue;
    }

    const encoded = bytes.toString("base64");
    if (
      decoded.width > caps.maxWidth ||
      decoded.height > caps.maxHeight ||
      Buffer.byteLength(encoded, "utf8") > caps.maxBytes ||
      Buffer.byteLength(encoded, "utf8") > hardBase64Bytes
    ) {
      continue;
    }
    images.push({
      type: "image",
      mimeType: decoded.mimeType,
      data: encoded,
      sourcePath: image.sourcePath,
      width: decoded.width,
      height: decoded.height,
    });
  }
  return images;
};

/**
 * Context-visible demoted tools for an (already agent-scoped) catalog:
 * a demoted tool whose `requiredConnectorProvider` doesn't match the turn's
 * connector-delivery provider is invisible everywhere — catalog section,
 * REPL-allowed union, and the direct-list fallback alike.
 */
export const collectVisibleDemotedTools = (
  toolCatalog: readonly ToolMetadata[] | undefined,
  connectorProvider: string | undefined,
): ToolMetadata[] =>
  (toolCatalog ?? []).filter((tool) => {
    if (!tool.demoted) return false;
    const requiredProvider = tool.demoted.requiredConnectorProvider;
    return !requiredProvider || requiredProvider === connectorProvider;
  });

/**
 * Names to widen `allowedToolNames` with so code's nested dispatcher
 * (and multi_tool_use_parallel) or a provider's direct-schema fallback can
 * reach demoted tools.
 */
export const collectDemotedToolNames = (
  toolCatalog: readonly ToolMetadata[] | undefined,
  connectorProvider: string | undefined,
): string[] =>
  collectVisibleDemotedTools(toolCatalog, connectorProvider).map(
    (tool) => tool.name,
  );

const DEMOTED_WORKFLOW_TEXT =
  'Some tools are demoted from your direct tool list and callable only here via tools.<name>(args). The compact catalog below lists names, signatures, and descriptions. When it is marked COMPLETE, call simple listed tools directly. When PARTIAL, first run await tools.$search({ query: "<intent + key nouns>" }) for ranked compact matches. For an unfamiliar or complex match, optionally run await tools.$describe(name) to load exactly that tool\'s complete schema, then invoke tools.<name>(args). Do not guess tool names.';

/** Workflow paragraph + budgeted signature catalog; "" for an empty set. */
const buildDemotedCodeSuffix = (demotedTools: ToolMetadata[]): string =>
  demotedTools.length > 0
    ? `\n\n${DEMOTED_WORKFLOW_TEXT}\n\n${buildCatalogSection(demotedTools)}`
    : "";

/**
 * External-engine parity for the code catalog: engines that build their
 * tool list through `getRuntimeToolMetadata` (never `createPiTools`) still
 * get the workflow text + signature catalog appended to code's
 * description, so demoted tools are discoverable there the same way. No-op
 * when code is absent from the metadata or nothing is demoted.
 */
export const appendDemotedCatalogToCode = (
  toolMetadata: ToolMetadata[],
  toolCatalog: ToolMetadata[] | undefined,
  connectorProvider: string | undefined,
): ToolMetadata[] => {
  const suffix = buildDemotedCodeSuffix(
    collectVisibleDemotedTools(toolCatalog ?? [], connectorProvider).filter(
      (tool) => !toolRequiresExplicitApproval(tool.approval),
    ),
  );
  if (!suffix) return toolMetadata;
  return toolMetadata.map((tool) =>
    tool.name === CODE_TOOL_NAME
      ? { ...tool, description: `${tool.description}${suffix}` }
      : tool,
  );
};

/** @deprecated Source-compatibility alias; only `code` is advertised. */
export const appendDemotedCatalogToNodeRepl = appendDemotedCatalogToCode;

/**
 * Provider-visible metadata with deferred-tool semantics applied.
 *
 * This is the metadata-only counterpart to createPiTools for external
 * engines: when code is active, demoted tools are removed from the eager
 * function list and summarized in code's bounded catalog. Without code,
 * visible demoted tools retain their full direct schemas so a
 * profile can never strand them.
 */
export const getProviderToolMetadata = (opts: {
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  connectorProvider?: string;
}): ToolMetadata[] => {
  const catalog = opts.toolCatalog ?? [];
  const requestedNames = getRequestedRuntimeToolNames(opts.toolsAllowlist);
  const codeAvailable =
    requestedNames.includes(CODE_TOOL_NAME) &&
    catalog.some((tool) => tool.name === CODE_TOOL_NAME);
  const hasExplicitAllowlist =
    Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0;
  const visibleDemotedTools = hasExplicitAllowlist
    ? collectVisibleDemotedTools(catalog, opts.connectorProvider)
    : [];
  const visibleDemotedNames = new Set(
    visibleDemotedTools.map((tool) => tool.name),
  );
  const eager: ToolMetadata[] = [];
  const eagerNames = new Set<string>();
  for (const tool of getRuntimeToolMetadata(opts)) {
    if (tool.demoted) {
      if (
        !visibleDemotedNames.has(tool.name) ||
        (codeAvailable && !toolRequiresExplicitApproval(tool.approval))
      ) {
        continue;
      }
    }
    eager.push(tool);
    eagerNames.add(tool.name);
  }
  if (codeAvailable) {
    for (const tool of visibleDemotedTools) {
      if (
        eagerNames.has(tool.name) ||
        !toolRequiresExplicitApproval(tool.approval)
      ) {
        continue;
      }
      eager.push(tool);
      eagerNames.add(tool.name);
    }
  }
  if (!codeAvailable) {
    for (const tool of visibleDemotedTools) {
      if (eagerNames.has(tool.name)) continue;
      eager.push(tool);
      eagerNames.add(tool.name);
    }
    return eager;
  }
  return appendDemotedCatalogToCode(eager, catalog, opts.connectorProvider);
};

export const extractAttachImageBlocks = async (
  text: string,
  target: ImageCapTarget = {},
): Promise<{ text: string; images: ImageBlock[] }> => {
  if (!text || !text.includes("[stella-attach-image]")) {
    return { text, images: [] };
  }
  let jsonValue: unknown;
  try {
    jsonValue = JSON.parse(text);
  } catch {
    jsonValue = undefined;
  }
  const jsonStrings: string[] = [];
  const collectJsonStrings = (value: unknown) => {
    if (typeof value === "string") {
      jsonStrings.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectJsonStrings);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collectJsonStrings);
    }
  };
  if (jsonValue !== undefined) collectJsonStrings(jsonValue);
  const sourceStrings = jsonStrings.length > 0 ? jsonStrings : [text];
  const matches = sourceStrings.flatMap(parseAttachImageMatches);
  if (matches.length === 0) return { text, images: [] };

  const images: ImageBlock[] = [];
  const markerReplacements: Array<{ full: string; replacement: string }> = [];
  // Read sequentially to keep failure messages deterministic; screenshots are
  // small and there's typically 1-2 per call.
  for (const { full, path: imgPath, detailOriginal } of matches) {
    try {
      // Settle the read against the capture -> read race: a screenshot the
      // agent just captured can still be mid-flush when its path reaches us,
      // and reading it early yields a truncated PNG that 400s Anthropic
      // fatally. `readImageFileSettled` re-reads until the bytes complete (or
      // the file stops growing / the budget is spent); the completeness gate
      // below stays as defense-in-depth for genuinely corrupt files.
      const buf = await readImageFileSettled(imgPath);
      const mimeType = resolveImageMimeType(imgPath, buf);
      if (!mimeType) {
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }
      // Provider-aware auto-resize: pass-through when the image already fits
      // the resolved target's dimension + byte caps (e.g. computer-use
      // screenshots that the native service pre-caps at 1024px, so screenshot
      // coordinates stay 1:1), otherwise shrink to fit that target.
      // `detail=original` lifts the caps to the provider's
      // hard ceiling so a deliberate full-res read isn't downscaled. The
      // dimension note tells the model how to map coordinates back when a
      // resize did happen.
      const caps = resolveImageCaps({
        ...target,
        imageCount: matches.length,
        detailOriginal,
      });
      const resized = await resizeImage(buf, mimeType, caps);
      if (resized) {
        const note = formatDimensionNote(resized);
        markerReplacements.push({ full, replacement: note ?? "" });
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data,
          sourcePath: imgPath,
        });
        continue;
      }
      // Resize unavailable: either Photon is missing (image is likely fine)
      // OR Photon threw because the bytes can't be decoded — which is exactly
      // what a truncated/corrupt capture (e.g. a screenshot read mid-write)
      // looks like. Only attach the raw file when it's a structurally
      // complete, supported image; a broken payload inlined into the request
      // 400s fatally ("Could not process image") and, because it lands in
      // thread history, poisons every subsequent resume.
      const detected = detectImageMediaType(buf);
      if (!detected || !isCompleteImage(buf, detected)) {
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }
      // We already prefer resizing-to-fit above: `resizeImage` shrinks any
      // large image well under the ceiling, so this raw-attach fallback is
      // only reached when resize is unavailable (Photon missing) or returned
      // null. Guard it against the *shared* per-image ceiling
      // (`MAX_IMAGE_BASE64_BYTES`, the same value the Anthropic send boundary
      // enforces): swap the marker for a note rather than inline an over-cap
      // image. Using the shared constant means an image can't pass here and
      // then be silently dropped at the wire.
      if (base64Length(buf.length) > MAX_IMAGE_BASE64_BYTES) {
        markerReplacements.push({
          full,
          replacement: omittedAttachImageNote(imgPath, buf.length),
        });
        continue;
      }
      markerReplacements.push({ full, replacement: "" });
      images.push({
        type: "image",
        mimeType,
        data: buf.toString("base64"),
        sourcePath: imgPath,
      });
    } catch {
      // If the file vanished between CLI exit and our read, leave the marker
      // in the text so the model can still see what was attempted, but keep
      // processing sibling markers so one missing image cannot discard them.
      markerReplacements.push({ full, replacement: full });
      continue;
    }
  }

  // Strip attached markers (and swap oversized ones for their notes) so we
  // don't double-send paths the model no longer needs.
  let stripped = text;
  if (jsonStrings.length > 0) {
    let replacementIndex = 0;
    const replaceJsonStrings = (value: unknown): unknown => {
      if (typeof value === "string") {
        let replaced = value;
        for (const match of parseAttachImageMatches(value)) {
          const replacement = markerReplacements[replacementIndex++];
          if (replacement?.full === match.full) {
            replaced = replaced.replace(
              replacement.full,
              replacement.replacement,
            );
          }
        }
        return replaced;
      }
      if (Array.isArray(value)) return value.map(replaceJsonStrings);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            replaceJsonStrings(entry),
          ]),
        );
      }
      return value;
    };
    stripped = JSON.stringify(replaceJsonStrings(jsonValue), null, 2);
    return { text: stripped, images };
  }
  for (const { full, replacement } of markerReplacements) {
    stripped = stripped.replace(full, replacement).replace(/\n{3,}/g, "\n\n");
  }
  stripped = stripped.replace(/[ \t]+\n/g, "\n").trim();
  return { text: stripped, images };
};

/**
 * Materialize typed code-runtime image items without converting them back into
 * model-visible marker strings. Audio remains in structured details because
 * the current ToolResultMessage content union supports text and images only.
 */
export const extractCodeImageBlocks = async (
  details: unknown,
  target: ImageCapTarget = {},
): Promise<ImageBlock[]> => {
  const codeRuntime =
    details && typeof details === "object" && !Array.isArray(details)
      ? ((details as Record<string, unknown>).code ??
        (details as Record<string, unknown>).nodeRepl)
      : undefined;
  const content =
    codeRuntime &&
    typeof codeRuntime === "object" &&
    !Array.isArray(codeRuntime)
      ? (codeRuntime as Record<string, unknown>).content
      : undefined;
  if (!Array.isArray(content)) return [];

  const requests = content.filter(
    (item: unknown): item is NodeReplImageRequest =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "image" &&
      (item as Record<string, unknown>).alreadyAttached !== true &&
      typeof (item as Record<string, unknown>).path === "string" &&
      ABSOLUTE_IMAGE_PATH_RE.test(
        (item as Record<string, unknown>).path as string,
      ) &&
      ATTACH_IMAGE_EXTENSION_RE.test(
        (item as Record<string, unknown>).path as string,
      ),
  );
  const images: ImageBlock[] = [];
  for (const item of requests) {
    try {
      const buf = await readImageFileSettled(item.path);
      const mimeType = resolveImageMimeType(item.path, buf);
      if (!mimeType) continue;
      const caps = resolveImageCaps({
        ...target,
        imageCount: requests.length,
        detailOriginal: item.detail === "original",
      });
      const resized = await resizeImage(buf, mimeType, caps);
      if (resized) {
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data,
          sourcePath: item.path,
          width: resized.width,
          height: resized.height,
        });
        continue;
      }
      const detected = detectImageMediaType(buf);
      if (
        !detected ||
        !isCompleteImage(buf, detected) ||
        base64Length(buf.length) > MAX_IMAGE_BASE64_BYTES
      ) {
        continue;
      }
      images.push({
        type: "image",
        mimeType,
        data: buf.toString("base64"),
        sourcePath: item.path,
      });
    } catch {
      // A vanished or invalid typed image is omitted without degrading
      // sibling items; its path remains available in tool details.
    } finally {
      // Browser screenshots created by the Node kernel transfer ownership
      // here before a reset closes that kernel. Reading the bytes is the
      // acknowledgement boundary; only kernel-marked temporary files are
      // removed, never user-provided nodeRepl.emitImage paths.
      if (item.deleteAfterAttach === true) {
        await fs.rm(item.path, { force: true }).catch(() => undefined);
      }
    }
  }
  return images;
};

/** @deprecated Reads both legacy `nodeRepl` and current `code` details. */
export const extractNodeReplImageBlocks = extractCodeImageBlocks;

type RuntimeToolContextArgs = {
  toolCallId: string;
  runId: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  agentType: string;
  deviceId: string;
  stellaAppDir?: string;
  stellaDataDir?: string;
  toolWorkspaceRoot?: string;
  parentAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  allowedToolNames?: string[];
  deferImageDeliveryAck?: boolean;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
};

export const buildRuntimeToolContext = (
  args: RuntimeToolContextArgs,
): ToolContext => {
  const workingDirectory = resolveAgentWorkingDirectory({
    agentType: args.agentType,
    stellaAppDir: args.stellaAppDir,
    workingDirectory: args.toolWorkspaceRoot,
  });
  return {
    conversationId: args.conversationId,
    deviceId: args.deviceId,
    requestId: args.toolCallId,
    runId: args.runId,
    ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
    agentType: args.agentType,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(args.stellaAppDir ? { stellaAppDir: args.stellaAppDir } : {}),
    ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    ...(args.toolWorkspaceRoot
      ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
      : {}),
    storageMode: args.storageMode ?? "local",
    ...(args.ownerGeneration ? { ownerGeneration: args.ownerGeneration } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.parentAgentId ? { parentAgentId: args.parentAgentId } : {}),
    ...(typeof args.agentDepth === "number"
      ? { agentDepth: args.agentDepth }
      : {}),
    ...(typeof args.maxAgentDepth === "number"
      ? { maxAgentDepth: args.maxAgentDepth }
      : {}),
    ...(args.modelConfigSnapshot
      ? { modelConfigSnapshot: args.modelConfigSnapshot }
      : {}),
    ...(Array.isArray(args.allowedToolNames) && args.allowedToolNames.length > 0
      ? { allowedToolNames: args.allowedToolNames }
      : {}),
    ...(args.deferImageDeliveryAck ? { deferImageDeliveryAck: true } : {}),
    ...(args.connectorDeliveryTarget
      ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
      : {}),
  };
};

type RuntimeToolExecutionArgs = RuntimeToolContextArgs & {
  toolName: string;
  args: Record<string, unknown>;
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  hookEmitter?: HookEmitter;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
};

export const executeRuntimeToolCall = async (
  args: RuntimeToolExecutionArgs,
): Promise<ToolResult> => {
  if (args.toolName === TOOL_IDS.NO_RESPONSE) {
    const localResult = await dispatchLocalTool(args.toolName, args.args, {
      conversationId: args.conversationId,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (localResult.handled) {
      return {
        result: localResult.text,
        details: { text: localResult.text },
      };
    }
  }

  const context = buildRuntimeToolContext(args);
  let effectiveArgs = args.args;
  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "before_tool",
      { tool: args.toolName, args: args.args, context },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.cancel) {
      return {
        error: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
      };
    }
    if (hookResult?.args) {
      effectiveArgs = hookResult.args;
    }
  }

  let toolResult = await args.toolExecutor(
    args.toolName,
    effectiveArgs,
    context,
    args.signal,
    args.onUpdate,
  );

  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "after_tool",
      {
        tool: args.toolName,
        args: effectiveArgs,
        result: toolResult,
        context,
      },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.result) {
      toolResult = hookResult.result;
    }
  }

  return toolResult;
};

export const createPiTools = (opts: {
  runId: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  agentType: string;
  deviceId: string;
  stellaAppDir?: string;
  stellaDataDir?: string;
  toolWorkspaceRoot?: string;
  parentAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  hookEmitter?: HookEmitter;
  /**
   * Resolved target provider/model for this run, so `[stella-attach-image]`
   * screenshots are resized to the best quality that provider supports
   * (e.g. Anthropic's 2576px high-res tier) instead of a blunt global cap.
   */
  imageCapTarget?: ImageCapTarget;
  /**
   * Registers each tool execution as a child resource of the owning run's
   * supervision scope (fiber-derived abort, teardown-joining settlement,
   * duplicate-execution guard). When absent, tools run without supervision.
   */
  superviseRunResource?: RunResourceRegistrar;
}): AgentTool[] => {
  const superviseToolExecution = createToolExecutionSupervisor({
    supervise: opts.superviseRunResource,
  });
  const requested = getRequestedRuntimeToolNames(opts.toolsAllowlist);
  const catalog = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const connectorProvider = opts.connectorDeliveryTarget?.provider;
  // Never-strand rule: demoted tools leave the direct list ONLY when code is
  // actually part of this turn's resolved active set. Profiles intentionally
  // lacking code keep demoted tools as plain
  // direct tools with full schemas.
  const codeAvailable =
    requested.includes(CODE_TOOL_NAME) && catalog.has(CODE_TOOL_NAME);
  // Demoted reachability requires an explicit per-agent allowlist. The
  // empty-allowlist STELLA_LOCAL_TOOLS fallback is a minimal device-tool
  // surface that could never reach deferred tools before the clean cut,
  // and it must not start direct-listing demoted tools now.
  const hasExplicitAllowlist =
    Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0;
  const visibleDemotedTools = hasExplicitAllowlist
    ? collectVisibleDemotedTools([...catalog.values()], connectorProvider)
    : [];
  const demotedToolNames = new Set(
    visibleDemotedTools.map((tool) => tool.name),
  );
  // Catalog section is generated fresh each turn from the live catalog
  // snapshot; with no demoted tools in scope the code description
  // stays byte-identical and the whole feature is inert.
  const codeReachableDemotedTools = visibleDemotedTools.filter(
    (tool) => !toolRequiresExplicitApproval(tool.approval),
  );
  const codeDescriptionSuffix = codeAvailable
    ? buildDemotedCodeSuffix(codeReachableDemotedTools)
    : "";
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();
  const contextAllowedToolNames = (): string[] =>
    codeAvailable
      ? [
          ...new Set(
            [
              ...activeToolNames,
              ...codeReachableDemotedTools.map((tool) => tool.name),
            ].filter(
              (name) =>
                !toolRequiresExplicitApproval(catalog.get(name)?.approval),
            ),
          ),
        ]
      : [...activeToolNames];

  const registerTool = (toolName: string): AgentTool => {
    const entry = catalog.get(toolName);
    const metadata: ToolMetadata = entry ?? {
      name: toolName,
      label: formatToolLabel(toolName),
      description: `${toolName} tool`,
      parameters: AnyToolArgsSchema as Record<string, unknown>,
    };
    const executeBody = async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
    ): Promise<AgentToolResult<unknown>> => {
      const args = (params as Record<string, unknown>) ?? {};
      const toolResult = await executeRuntimeToolCall({
        toolCallId,
        toolName,
        args,
        runId: opts.runId,
        rootRunId: opts.rootRunId,
        agentId: opts.agentId,
        conversationId: opts.conversationId,
        storageMode: opts.storageMode,
        ownerGeneration: opts.ownerGeneration,
        agentType: opts.agentType,
        deviceId: opts.deviceId,
        stellaAppDir: opts.stellaAppDir,
        stellaDataDir: opts.stellaDataDir,
        toolWorkspaceRoot: opts.toolWorkspaceRoot,
        parentAgentId: opts.parentAgentId,
        agentDepth: opts.agentDepth,
        maxAgentDepth: opts.maxAgentDepth,
        modelConfigSnapshot: opts.modelConfigSnapshot,
        connectorDeliveryTarget: opts.connectorDeliveryTarget,
        // Code-reachable union: nested dispatch (and
        // multi_tool_use_parallel) must pass the host allowlist
        // gate for demoted tools that are absent from the direct
        // list. Without code the union collapses to the
        // active set — demoted tools were registered directly.
        allowedToolNames: contextAllowedToolNames(),
        store: opts.store,
        toolExecutor: opts.toolExecutor,
        hookEmitter: opts.hookEmitter,
        signal,
        onUpdate: onUpdate
          ? (partialResult: ToolResult) => {
              const formattedPartial = formatToolResult(
                partialResult,
                toolName,
              );
              const truncatedPartial = truncateModelVisibleToolText(
                formattedPartial.text,
                modelVisibleLimitsFor(toolName, partialResult),
              );
              onUpdate({
                content: [{ type: "text", text: truncatedPartial.text }],
                details: formattedPartial.details,
              });
            }
          : undefined,
      });
      const formatted = formatToolResult(toolResult, toolName);
      // Local diagnostic tools retain their legacy path-marker bridge. Cloud
      // tool output is model-controlled and must never authorize the root
      // adapter to reopen a pathname, so neutralize it without I/O there.
      const { text: forwardedText, images: legacyImages } =
        opts.storageMode === "cloud"
          ? {
              text: neutralizeLegacyAttachImageMarkers(formatted.text),
              images: [],
            }
          : await extractAttachImageBlocks(formatted.text, opts.imageCapTarget);
      const codeImages =
        opts.storageMode === "cloud"
          ? []
          : await extractCodeImageBlocks(
              formatted.details,
              opts.imageCapTarget,
            );
      const authorizedImages = await prepareAuthorizedToolImageBlocks(
        toolResult[TOOL_RESULT_AUTHORIZED_IMAGES],
        opts.imageCapTarget,
      );
      const preservedText = await preserveModelVisibleToolText(
        forwardedText,
        {
          stellaDataDir: opts.stellaDataDir,
          runId: opts.runId,
          toolCallId,
        },
        modelVisibleLimitsFor(toolName, toolResult),
      );
      const truncatedText = preservedText.text;
      const content: Array<TextContent | ImageBlock> = [];
      const attachedImages = [
        ...codeImages,
        ...legacyImages,
        ...authorizedImages,
      ];
      const screenshotNote =
        attachedImages.length > 0
          ? "\n\n[Image attached below. Inspect it directly. If it is a UI screenshot and the accessibility tree is sparse or missing a visible control, use screenshot x/y coordinates.]"
          : "";
      if (truncatedText || attachedImages.length === 0) {
        content.push({
          type: "text" as const,
          text: `${truncatedText}${screenshotNote}`,
        });
      } else if (screenshotNote) {
        content.push({
          type: "text" as const,
          text: screenshotNote.trim(),
        });
      }
      content.push(...attachedImages);
      return {
        content,
        details: preservedText.artifact
          ? {
              ...(formatted.details &&
              typeof formatted.details === "object" &&
              !Array.isArray(formatted.details)
                ? (formatted.details as Record<string, unknown>)
                : formatted.details === undefined
                  ? {}
                  : { result: formatted.details }),
              toolOutputArtifact: preservedText.artifact,
            }
          : formatted.details,
        isError: Boolean(toolResult.error),
        ...(typeof toolResult.modelOutputTokens === "number"
          ? { modelOutputTokens: toolResult.modelOutputTokens }
          : {}),
      };
    };
    const tool: AgentTool = {
      name: toolName,
      label: metadata.label ?? formatToolLabel(toolName),
      workingText: formatToolWorkingText(metadata),
      description:
        toolName === CODE_TOOL_NAME && codeDescriptionSuffix
          ? `${metadata.description}${codeDescriptionSuffix}`
          : metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      // Tool executions supervise as child fibers of the owning run: the
      // body observes a child signal derived from the loop's per-tool
      // signal, run cancel/shutdown interrupts it, and settlement joins
      // the body's own cleanup.
      execute: (toolCallId, params, signal, onUpdate) =>
        superviseToolExecution({
          toolCallId,
          toolName,
          signal,
          run: (toolSignal) =>
            executeBody(toolCallId, params, toolSignal, onUpdate),
        }),
    };
    return tool;
  };

  for (const toolName of requested) {
    if (activeToolNames.has(toolName)) continue;
    const demotedMeta = catalog.get(toolName)?.demoted;
    if (demotedMeta) {
      // Connector-gated demoted tools that fail the gate are invisible
      // everywhere, including the direct-list fallback.
      if (!demotedToolNames.has(toolName)) continue;
      // Code-only this turn unless an explicit top-level approval is required.
      if (
        codeAvailable &&
        !toolRequiresExplicitApproval(catalog.get(toolName)?.approval)
      ) {
        continue;
      }
    }
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  }
  // Demoted tools outside the frontmatter allowlist surface directly when
  // Approval-bearing tools stay direct so nested code cannot bypass their
  // top-level approval flow. Without code, every visible demoted tool stays
  // direct so nothing reachable becomes stranded.
  const directlyAddedDemotedTools = codeAvailable
    ? visibleDemotedTools.filter((tool) =>
        toolRequiresExplicitApproval(tool.approval),
      )
    : visibleDemotedTools;
  for (const tool of directlyAddedDemotedTools) {
    if (activeToolNames.has(tool.name)) continue;
    activeToolNames.add(tool.name);
    activeTools.push(registerTool(tool.name));
  }
  return activeTools;
};
