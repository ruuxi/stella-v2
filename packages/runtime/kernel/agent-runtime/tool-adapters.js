import { promises as fs } from "node:fs";
import { DEVICE_TOOL_NAMES } from "../tools/schemas.js";
import { TOOL_IDS } from "@stella/contracts/agent-runtime";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";
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
import { resolveImageCaps } from "../../ai/utils/image-caps.js";
import { buildCatalogSection } from "../tools/code-catalog.js";
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
export const STELLA_LOCAL_TOOLS = [...DEVICE_TOOL_NAMES, TOOL_IDS.NO_RESPONSE];
const NODE_REPL_TOOL_NAME = "node_repl";
const COMMAND_OUTPUT_TOOL_NAMES = new Set(["exec_command", "write_stdin"]);
const MULTI_TOOL_USE_PARALLEL_TOOL_NAME = "multi_tool_use_parallel";
export const MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES = 10_000;

const APPROX_COMMAND_OUTPUT_BYTES_PER_TOKEN = 4;
const COMMAND_RESULT_LIMITS = Object.freeze({
  maxBytes: MODEL_VISIBLE_COMMAND_RESULT_MAX_BYTES,
  maxLines: Number.MAX_SAFE_INTEGER,
});
const containsCommandOutput = (toolName, toolResult) => {
  if (COMMAND_OUTPUT_TOOL_NAMES.has(toolName)) return true;
  if (toolName !== MULTI_TOOL_USE_PARALLEL_TOOL_NAME) return false;
  const results = toolResult?.details?.results;
  return (
    Array.isArray(results) &&
    results.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        COMMAND_OUTPUT_TOOL_NAMES.has(entry.tool_name),
    )
  );
};
const commandResultLimitsFor = (toolResult) => {
  const requestedTokens =
    typeof toolResult?.modelOutputTokens === "number" &&
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
  return {
    ...COMMAND_RESULT_LIMITS,
    previewMaxBytes: requestedBytes,
  };
};
const modelVisibleLimitsFor = (toolName, toolResult) =>
  containsCommandOutput(toolName, toolResult)
    ? commandResultLimitsFor(toolResult)
    : undefined;
const formatToolLabel = (toolName) =>
  toolName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || toolName;
const formatToolWorkingText = (metadata) =>
  metadata.workingText ??
  `Running ${metadata.label ?? formatToolLabel(metadata.name)}`;
export const getRequestedRuntimeToolNames = (toolsAllowlist) =>
  Array.isArray(toolsAllowlist) && toolsAllowlist.length > 0
    ? toolsAllowlist
    : [...STELLA_LOCAL_TOOLS];

export const getRuntimeToolMetadata = (opts) => {
  const catalog = new Map(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const resolved = [];
  const seen = new Set();
  const missing = [];
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

    console.warn(
      `[tool-adapters] dropped unknown tools from allowlist: ${missing.join(", ")}`,
    );
  }
  return resolved;
};
const mergeToolSideEffectsIntoDetails = (
  details,
  fileChanges,
  producedFiles,
) => {
  if (
    (!fileChanges || fileChanges.length === 0) &&
    (!producedFiles || producedFiles.length === 0)
  ) {
    return details;
  }
  const sideEffects = {
    ...(fileChanges && fileChanges.length > 0 ? { fileChanges } : {}),
    ...(producedFiles && producedFiles.length > 0 ? { producedFiles } : {}),
  };
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...details, ...sideEffects };
  }

  if (details === undefined || details === null) return sideEffects;
  return { result: details, ...sideEffects };
};
const formatToolResult = (toolResult, toolName) => {
  if (toolResult.error) {
    const error = sanitizeToolError(toolResult.error);
    return {
      text: `Error: ${error}`,
      details: mergeToolSideEffectsIntoDetails(
        sanitizeToolResult(toolResult.details ?? { error }),
        toolResult.fileChanges,
        toolResult.producedFiles,
      ),
    };
  }
  const result = sanitizeToolResult(toolResult.result);
  return {
    text: sanitizeToolVisibleText(textFromUnknown(result)),
    details: mergeToolSideEffectsIntoDetails(
      sanitizeToolResult(
        toolResult.details ??
          (COMMAND_OUTPUT_TOOL_NAMES.has(toolName) ? undefined : result),
      ),
      toolResult.fileChanges,
      toolResult.producedFiles,
    ),
  };
};

export const MODEL_VISIBLE_TOOL_RESULT_MAX_LINES = DEFAULT_MAX_LINES;
export const MODEL_VISIBLE_TOOL_RESULT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = DEFAULT_MAX_BYTES;

const resolveModelVisibleLimits = (limits) => {
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

const buildTruncationNotice = (totalBytes, totalLines, outputBytes) => {
  const omittedBytes = Math.max(0, totalBytes - outputBytes);
  return `\n\n[Tool output truncated: ${omittedBytes} bytes omitted. Total output lines: ${totalLines}.]\n\n`;
};

const previewHead = (text, maxBytes, maxLines) => {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  const head = truncateHead(text, { maxBytes, maxLines });
  if (head.firstLineExceedsLimit) {
    return truncateStringToBytesFromStart(text, maxBytes);
  }
  return head.content;
};

const previewTail = (text, maxBytes, maxLines) => {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  return truncateTail(text, { maxBytes, maxLines }).content;
};

const windowsOverlap = (text, head, tail) => {
  if (!head || !tail) return false;
  const headAt = text.indexOf(head);
  const tailAt = text.lastIndexOf(tail);
  return headAt >= 0 && tailAt >= 0 && headAt + head.length >= tailAt;
};

export const truncateModelVisibleToolText = (text, limits) => {
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
export const preserveModelVisibleToolText = async (text, context, limits) => {
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

const STELLA_ATTACH_IMAGE_MARKER = "[stella-attach-image]";
const ATTACH_IMAGE_EXTENSION_RE = /\.(?:png|jpg|jpeg|gif|webp)$/i;
const ABSOLUTE_IMAGE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;
const parseAttachImageMatches = (text) => {
  const matches = [];
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
    let imagePath;
    if (token) {
      try {
        imagePath = JSON.parse(token);
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
const base64Length = (binaryBytes) => Math.ceil(binaryBytes / 3) * 4;
const omittedAttachImageNote = (imgPath, binaryBytes) =>
  `[Image omitted: ${imgPath} is ${(binaryBytes / (1024 * 1024)).toFixed(1)}MB and could not be resized below the inline image size limit.]`;
const unreadableAttachImageNote = (imgPath) =>
  `[Image omitted: ${imgPath} could not be decoded as a valid image (it may be corrupt or truncated) and was skipped.]`;
const normalizeAttachImagePath = (filePath) =>
  /^[A-Za-z]:\\\\/.test(filePath) ? filePath.replace(/\\\\/g, "\\") : filePath;

export const collectVisibleDemotedTools = (toolCatalog, connectorProvider) =>
  (toolCatalog ?? []).filter((tool) => {
    if (!tool.demoted) return false;
    const requiredProvider = tool.demoted.requiredConnectorProvider;
    return !requiredProvider || requiredProvider === connectorProvider;
  });

export const collectDemotedToolNames = (toolCatalog, connectorProvider) =>
  collectVisibleDemotedTools(toolCatalog, connectorProvider).map(
    (tool) => tool.name,
  );
const DEMOTED_WORKFLOW_TEXT =
  'Some tools are demoted from your direct tool list and callable only here via tools.<name>(args). The catalog below lists their exact signatures. When it is marked COMPLETE, call listed tools directly. When PARTIAL, first run await tools.$search({ query: "<intent + key nouns>" }) — it returns full callable signatures, so search once and call in the same or next cell. Do not guess tool names.';

const buildDemotedNodeReplSuffix = (demotedTools) =>
  demotedTools.length > 0
    ? `\n\n${DEMOTED_WORKFLOW_TEXT}\n\n${buildCatalogSection(demotedTools)}`
    : "";

export const appendDemotedCatalogToNodeRepl = (
  toolMetadata,
  toolCatalog,
  connectorProvider,
) => {
  const suffix = buildDemotedNodeReplSuffix(
    collectVisibleDemotedTools(toolCatalog ?? [], connectorProvider),
  );
  if (!suffix) return toolMetadata;
  return toolMetadata.map((tool) =>
    tool.name === NODE_REPL_TOOL_NAME
      ? { ...tool, description: `${tool.description}${suffix}` }
      : tool,
  );
};

export const extractAttachImageBlocks = async (text, target = {}) => {
  if (!text || !text.includes("[stella-attach-image]")) {
    return { text, images: [] };
  }
  let jsonValue;
  try {
    jsonValue = JSON.parse(text);
  } catch {
    jsonValue = undefined;
  }
  const jsonStrings = [];
  const collectJsonStrings = (value) => {
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
  const images = [];
  const markerReplacements = [];

  for (const { full, path: imgPath, detailOriginal } of matches) {
    try {

      const buf = await readImageFileSettled(imgPath);
      const mimeType = resolveImageMimeType(imgPath, buf);
      if (!mimeType) {
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }

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
          width: resized.width,
          height: resized.height,
        });
        continue;
      }

      const detected = detectImageMediaType(buf);
      if (!detected || !isCompleteImage(buf, detected)) {
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }

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

      markerReplacements.push({ full, replacement: full });
      continue;
    }
  }

  let stripped = text;
  if (jsonStrings.length > 0) {
    let replacementIndex = 0;
    const replaceJsonStrings = (value) => {
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

export const extractNodeReplImageBlocks = async (details, target = {}) => {
  const nodeRepl =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.nodeRepl
      : undefined;
  const content =
    nodeRepl && typeof nodeRepl === "object" && !Array.isArray(nodeRepl)
      ? nodeRepl.content
      : undefined;
  if (!Array.isArray(content)) return [];
  const requests = content.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      item.type === "image" &&
      item.alreadyAttached !== true &&
      typeof item.path === "string" &&
      ABSOLUTE_IMAGE_PATH_RE.test(item.path) &&
      ATTACH_IMAGE_EXTENSION_RE.test(item.path),
  );
  const images = [];
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

    } finally {

      if (item.deleteAfterAttach === true) {
        await fs.rm(item.path, { force: true }).catch(() => undefined);
      }
    }
  }
  return images;
};
export const buildRuntimeToolContext = (args) => ({
  conversationId: args.conversationId,
  deviceId: args.deviceId,
  requestId: args.toolCallId,
  runId: args.runId,
  ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
  agentType: args.agentType,
  ...(args.stellaAppDir ? { stellaAppDir: args.stellaAppDir } : {}),
  ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
  ...(args.toolWorkspaceRoot
    ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
    : {}),
  storageMode: "local",
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
});
export const executeRuntimeToolCall = async (args) => {
  if (args.toolName === TOOL_IDS.NO_RESPONSE) {
    const localResult = await dispatchLocalTool(args.toolName, args.args, {
      conversationId: args.conversationId,
      store: args.store,
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
export const createPiTools = (opts) => {
  const requested = getRequestedRuntimeToolNames(opts.toolsAllowlist);
  const catalog = new Map(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const connectorProvider = opts.connectorDeliveryTarget?.provider;

  const nodeReplAvailable =
    requested.includes(NODE_REPL_TOOL_NAME) && catalog.has(NODE_REPL_TOOL_NAME);

  const hasExplicitAllowlist =
    Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0;
  const visibleDemotedTools = hasExplicitAllowlist
    ? collectVisibleDemotedTools([...catalog.values()], connectorProvider)
    : [];
  const demotedToolNames = new Set(
    visibleDemotedTools.map((tool) => tool.name),
  );

  const nodeReplDescriptionSuffix = nodeReplAvailable
    ? buildDemotedNodeReplSuffix(visibleDemotedTools)
    : "";
  const activeTools = [];
  const activeToolNames = new Set();
  const contextAllowedToolNames = () =>
    nodeReplAvailable
      ? [...new Set([...activeToolNames, ...demotedToolNames])]
      : [...activeToolNames];
  const registerTool = (toolName) => {
    const entry = catalog.get(toolName);
    const metadata = entry ?? {
      name: toolName,
      label: formatToolLabel(toolName),
      description: `${toolName} tool`,
      parameters: AnyToolArgsSchema,
    };
    const tool = {
      name: toolName,
      label: metadata.label ?? formatToolLabel(toolName),
      workingText: formatToolWorkingText(metadata),
      description:
        toolName === NODE_REPL_TOOL_NAME && nodeReplDescriptionSuffix
          ? `${metadata.description}${nodeReplDescriptionSuffix}`
          : metadata.description,
      parameters: metadata.parameters,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const args = params ?? {};
        const toolResult = await executeRuntimeToolCall({
          toolCallId,
          toolName,
          args,
          runId: opts.runId,
          rootRunId: opts.rootRunId,
          agentId: opts.agentId,
          conversationId: opts.conversationId,
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

          allowedToolNames: contextAllowedToolNames(),
          store: opts.store,
          toolExecutor: opts.toolExecutor,
          hookEmitter: opts.hookEmitter,
          signal,
          onUpdate: onUpdate
            ? (partialResult) => {
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

        const { text: forwardedText, images: legacyImages } =
          await extractAttachImageBlocks(formatted.text, opts.imageCapTarget);
        const nodeReplImages = await extractNodeReplImageBlocks(
          formatted.details,
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
        const content = [];
        const attachedImages = [...nodeReplImages, ...legacyImages];
        const screenshotNote =
          attachedImages.length > 0
            ? "\n\n[Image attached below. Inspect it directly. If it is a UI screenshot and the accessibility tree is sparse or missing a visible control, use screenshot x/y coordinates.]"
            : "";
        if (truncatedText || attachedImages.length === 0) {
          content.push({
            type: "text",
            text: `${truncatedText}${screenshotNote}`,
          });
        } else if (screenshotNote) {
          content.push({
            type: "text",
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
                  ? formatted.details
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
      },
    };
    return tool;
  };
  for (const toolName of requested) {
    if (activeToolNames.has(toolName)) continue;
    const demotedMeta = catalog.get(toolName)?.demoted;
    if (demotedMeta) {

      if (!demotedToolNames.has(toolName)) continue;

      if (nodeReplAvailable) continue;
    }
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  }

  if (!nodeReplAvailable) {
    for (const tool of visibleDemotedTools) {
      if (activeToolNames.has(tool.name)) continue;
      activeToolNames.add(tool.name);
      activeTools.push(registerTool(tool.name));
    }
  }
  return activeTools;
};
