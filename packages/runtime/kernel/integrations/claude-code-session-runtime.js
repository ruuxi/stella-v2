import { spawn } from "child_process";
import { StringDecoder } from "node:string_decoder";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { extractAttachImageBlocks } from "../agent-runtime/tool-adapters.js";
import { executeToolWithInactivityBound } from "./tool-inactivity.js";
import { SAFETY_ABORT_FABLE_ATTEMPTS } from "../agent-runtime/provider-abort-containment.js";
import { sanitizeSensitiveData } from "@stella/contracts/sensitive-data";
import {
  CLAUDE_CODE_MODEL_ALIASES,
  formatClaudeCodeResolvedModel,
  readClaudeCodeResolvedModels,
  recordClaudeCodeResolvedModel,
} from "./claude-code-resolved-models.js";
import {
  buildExternalCliChildEnv,
  resolveExternalCliPath,
} from "./external-cli-resolution.js";
import { createClaudeCodeToolMcpHost } from "./claude-code-tool-mcp-host.js";
const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";

const CLAUDE_CODE_FALLBACK_MODEL = "claude-opus-4-8";

export const isClaudeCodeModelRefusalOrOverloadError = (message) =>
  /unable to respond to this request|usage policy|overloaded/i.test(message);

const CLAUDE_CODE_ALIASES = CLAUDE_CODE_MODEL_ALIASES;
const CLAUDE_CODE_ALIAS_LABELS = {
  default: {
    displayName: "Default",
    description: "Recommended model for your Claude account",
  },
  best: {
    displayName: "Best",
    description: "Most capable model available to you",
  },
  fable: {
    displayName: "Fable",
    description: "Long, hard tasks and deep autonomy",
  },
  opus: {
    displayName: "Opus",
    description: "Latest Opus for complex reasoning",
  },
  sonnet: {
    displayName: "Sonnet",
    description: "Latest Sonnet for everyday work",
  },
  haiku: {
    displayName: "Haiku",
    description: "Fast and efficient for simple tasks",
  },
  opusplan: {
    displayName: "Opus Plan",
    description: "Plans on Opus, executes on Sonnet",
  },
  "sonnet[1m]": {
    displayName: "Sonnet · 1M context",
    description: "Sonnet with a 1M-token context window",
  },
  "opus[1m]": {
    displayName: "Opus · 1M context",
    description: "Opus with a 1M-token context window",
  },
};
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const MAX_STDERR_CAPTURE = 4_000;
const DEFAULT_STEP_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_STEP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_STEP_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_STEERING_CONTROL_TIMEOUT_MS = 2 * 1000;
const DEFAULT_STEERING_RESULT_TIMEOUT_MS = 2 * 1000;
const CLAUDE_CODE_COMPACTING_TEXT = "Compacting context";
const CLAUDE_CODE_RUNNING_TEXT = "Working";

const MAX_COMPACTIONS_PER_TURN = 3;
const CLAUDE_CODE_COMPACTION_LOOP_MESSAGE =
  "Claude Code entered a compaction loop.";

const MAX_STEP_RECOVERIES_PER_TURN = 2;
const summarizeMcpLedgerValue = (value, maxChars) => {
  let serialized;
  try {
    serialized = JSON.stringify(sanitizeSensitiveData(value));
  } catch {
    serialized = "[unserializable]";
  }
  return serialized.length > maxChars
    ? `${serialized.slice(0, maxChars)}...[truncated]`
    : serialized;
};

export class ClaudeCodeProcessEndedError extends Error {
  exitCode;

  mcpCalls;
  constructor(message, exitCode = null, mcpCalls = []) {
    super(message);
    this.name = "ClaudeCodeProcessEndedError";
    this.exitCode = exitCode;
    this.mcpCalls = mcpCalls;
  }
}

export class ClaudeCodeMalformedResultError extends Error {
  kind;

  mcpCalls;
  constructor(message, kind, mcpCalls = []) {
    super(message);
    this.name = "ClaudeCodeMalformedResultError";
    this.kind = kind;
    this.mcpCalls = mcpCalls;
  }
}

export class ClaudeCodeSteeringInterruptError extends Error {
  mcpCalls;
  constructor(mcpCalls = []) {
    super("Claude Code turn interrupted for steering.");
    this.name = "ClaudeCodeSteeringInterruptError";
    this.mcpCalls = mcpCalls;
  }
}

export class ClaudeCodeCompactionLoopError extends Error {
  mcpCalls;
  constructor(mcpCalls = []) {
    super(CLAUDE_CODE_COMPACTION_LOOP_MESSAGE);
    this.name = "ClaudeCodeCompactionLoopError";
    this.mcpCalls = mcpCalls;
  }
}
const asRecoverableStepError = (error) =>
  error instanceof ClaudeCodeProcessEndedError ||
  error instanceof ClaudeCodeMalformedResultError
    ? error
    : null;

const buildSideEffectReconciliationPrompt = (
  mcpCalls = [],
  referenceContext,
) => {
  return [
    "The previous step was interrupted after side-effecting work may already have been applied.",
    mcpCalls.length > 0
      ? [
          "Stella tool calls already started before the interruption:",
          ...mcpCalls.map((call) =>
            [
              `- ${call.toolName} (${call.toolCallId}, ${call.status})`,
              `  arguments: ${call.argsSummary}`,
              call.status === "completed"
                ? `  completed outcome: ${call.outcomeSummary ?? "[no result]"}`
                : "  outcome unknown; it may have applied before interruption",
            ].join("\n"),
          ),
          "Some of these calls may have already completed even if Claude Code did not receive the result.",
        ].join("\n")
      : "",
    "Do NOT redo, repeat, or revert those tool calls.",
    "If you are unsure what was applied, inspect the current state first.",
    referenceContext?.trim()
      ? [
          "Original request context, for reference only — do not re-execute work that already completed:",
          referenceContext.trim(),
        ].join("\n\n")
      : "",
    "Reconcile with the current state and report your final answer for the pending request.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
};
const buildResultRetryPrompt = () =>
  "Your previous reply produced no result text. Provide your complete final answer to the pending request now.";
const withStepRecoveryExhausted = (error) =>
  new Error(
    `${normalizeErrorMessage(error)} Stella retried ${MAX_STEP_RECOVERIES_PER_TURN} time(s) but Claude Code kept ending the step without a usable result. Check the \`claude\` CLI health (\`claude --version\`, login status), then retry the request.`,
  );
const buildClaudeCodeHookSettings = () => {
  const command = `"${process.execPath}" -e ""`;
  return JSON.stringify({

    workflowKeywordTriggerEnabled: false,
    disableWorkflows: true,
    hooks: {
      PreCompact: [{ hooks: [{ type: "command", command }] }],
      PostCompact: [{ hooks: [{ type: "command", command }] }],
    },
  });
};
const CLAUDE_CODE_HOOK_SETTINGS = buildClaudeCodeHookSettings();

const TRUNCATING_STOP_REASONS = new Set(["refusal", "max_tokens"]);

export const getClaudeCodeTruncatedToolUseFromStreamEvent = (event) => {
  if (event.type !== "assistant") return null;
  const message = asObject(event.message);
  const stopReason =
    typeof message?.stop_reason === "string" ? message.stop_reason : "";
  if (!TRUNCATING_STOP_REASONS.has(stopReason)) return null;
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const block = asObject(content[content.length - 1]);
  if (
    block?.type !== "tool_use" ||
    typeof block.id !== "string" ||
    typeof block.name !== "string"
  ) {
    return null;
  }
  const details = asObject(message?.stop_details);
  return {
    toolCallId: block.id,
    toolName: block.name,
    toolArgs: asObject(block.input) ?? {},
    stopReason,
    ...(typeof details?.category === "string"
      ? { category: details.category }
      : {}),
    ...(typeof details?.explanation === "string"
      ? { explanation: details.explanation }
      : {}),
  };
};
export const describeClaudeToolUseTruncation = (truncation) =>
  `Claude's stream ended with stop_reason "${truncation.stopReason}"` +
  `${truncation.category ? ` (${truncation.category})` : ""} while it was ` +
  `still writing the arguments for \`${truncation.toolName}\`, so those ` +
  `arguments are cut off mid-value.`;
const stableToolArgs = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableToolArgs).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableToolArgs(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
const normalizeClaudeToolName = (toolName) =>
  toolName.includes("__") ? (toolName.split("__").at(-1) ?? toolName) : toolName;
const claudeToolKey = (toolName, toolArgs) => {
  return crypto
    .createHash("sha256")
    .update(normalizeClaudeToolName(toolName))
    .update("\0")
    .update(stableToolArgs(toolArgs))
    .digest("hex");
};

export const repairPartialToolInputJson = (text) => {
  const attempt = (candidate) => {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of candidate) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") stack.pop();
    }

    let repaired = escaped ? candidate.slice(0, -1) : candidate;
    if (inString) repaired += '"';
    while (stack.length) repaired += stack.pop();
    try {
      const parsed = JSON.parse(repaired);
      return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = attempt(text);
  if (direct !== undefined) return direct;

  const trimmed = text.replace(/[\s,]*[A-Za-z0-9+\-.]*[\s,]*$/, "");
  if (trimmed && trimmed !== text) return attempt(trimmed);
  return undefined;
};

const TOOL_USE_INTEGRITY_SETTLE_MS = 750;
export const createClaudeNativeToolUseCorrelator = () => {
  const queued = new Map();
  const waiters = new Map();
  const observedIds = new Set();

  const truncatedKeys = new Map();

  const settledKeys = new Set();
  const integrityWaiters = new Map();
  const settleKey = (key) => {
    settledKeys.add(key);
    const pending = integrityWaiters.get(key);
    integrityWaiters.delete(key);
    for (const resolve of pending ?? []) resolve();
  };
  const streamingBlocks = new Map();

  const interruptedBlocks = [];
  const MAX_INTERRUPTED_BLOCKS = 16;
  const recordInterruptedBlock = (pending) => {
    interruptedBlocks.push(pending);
    if (interruptedBlocks.length > MAX_INTERRUPTED_BLOCKS) {
      interruptedBlocks.shift();
    }
  };

  const findInterruptedTruncation = (toolName, key) => {
    const normalizedName = normalizeClaudeToolName(toolName);
    for (const pending of [...streamingBlocks.values(), ...interruptedBlocks]) {
      if (normalizeClaudeToolName(pending.toolName) !== normalizedName) {
        continue;
      }
      if (!pending.partialJson.trim()) continue;
      try {
        JSON.parse(pending.partialJson);
        continue;
      } catch {

      }
      const repaired = asObject(repairPartialToolInputJson(pending.partialJson));
      if (!repaired) continue;
      if (claudeToolKey(pending.toolName, repaired) !== key) continue;
      return {
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        toolArgs: repaired,
        stopReason: "stream_interrupted",
        explanation:
          "the stream was cut off (turn abort, steering interrupt, or process exit) before these arguments finished streaming",
      };
    }
    return undefined;
  };

  const observe = (args) => {
    if (observedIds.has(args.toolCallId)) return;
    observedIds.add(args.toolCallId);
    const key = claudeToolKey(args.toolName, args.toolArgs);
    const waiter = waiters.get(key)?.shift();
    if (waiter) {
      waiter(args.toolCallId);
      return;
    }
    const values = queued.get(key) ?? [];
    if (!values.includes(args.toolCallId)) values.push(args.toolCallId);
    queued.set(key, values);
  };
  return {
    observe,

    observeAssistantMessage(event) {
      if (event.type !== "assistant") return null;
      const content = asObject(event.message)?.content;
      if (!Array.isArray(content)) return null;
      const truncated = getClaudeCodeTruncatedToolUseFromStreamEvent(event);
      for (const raw of content) {
        const block = asObject(raw);
        if (block?.type !== "tool_use" || typeof block.name !== "string") {
          continue;
        }
        const key = claudeToolKey(block.name, asObject(block.input) ?? {});
        if (truncated && block.id === truncated.toolCallId) {
          truncatedKeys.set(key, truncated);
        }
        settleKey(key);
      }
      return truncated;
    },

    async resolveToolUseIntegrity(
      toolName,
      toolArgs,
      signal,
      timeoutMs = TOOL_USE_INTEGRITY_SETTLE_MS,
    ) {
      const key = claudeToolKey(toolName, toolArgs);
      if (!settledKeys.has(key)) {
        await new Promise((resolve) => {
          const entries = integrityWaiters.get(key) ?? [];
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            const index = entries.indexOf(finish);
            if (index >= 0) entries.splice(index, 1);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          timer.unref?.();
          entries.push(finish);
          integrityWaiters.set(key, entries);
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
      const adjudicated = truncatedKeys.get(key);
      if (adjudicated) return adjudicated;

      if (!settledKeys.has(key)) {
        return findInterruptedTruncation(toolName, key);
      }
      return undefined;
    },
    observeStreamEvent(event) {
      if (event.type !== "stream_event") return;
      const source = asObject(event.event);
      const index = asNumber(source?.index);
      if (!source || index === undefined || !Number.isInteger(index)) return;
      if (source.type === "content_block_start") {
        const block = asObject(source.content_block);
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          streamingBlocks.set(index, {
            toolCallId: block.id,
            toolName: block.name,
            initialInput: asObject(block.input) ?? {},
            partialJson: "",
          });
        }
        return;
      }
      const pending = streamingBlocks.get(index);
      if (!pending) return;
      if (source.type === "content_block_delta") {
        const delta = asObject(source.delta);
        if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          pending.partialJson += delta.partial_json;
        }
        return;
      }
      if (source.type !== "content_block_stop") return;
      streamingBlocks.delete(index);
      let toolArgs = pending.initialInput;
      if (pending.partialJson.trim()) {
        try {
          const parsed = JSON.parse(pending.partialJson);
          toolArgs = asObject(parsed) ?? pending.initialInput;
        } catch {

          recordInterruptedBlock(pending);
          return;
        }
      }
      observe({
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        toolArgs,
      });
    },
    async claim(toolName, toolArgs, signal) {
      const key = claudeToolKey(toolName, toolArgs);
      const existing = queued.get(key)?.shift();
      if (existing) return existing;
      return await new Promise((resolve, reject) => {
        const entries = waiters.get(key) ?? [];
        const onAbort = () => {
          const index = entries.indexOf(onObserved);
          if (index >= 0) entries.splice(index, 1);
          reject(signal.reason ?? new Error("Claude tool call canceled."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          const index = entries.indexOf(onObserved);
          if (index >= 0) entries.splice(index, 1);
          reject(
            new Error(
              "Timed out waiting for Claude's durable tool_use identity.",
            ),
          );
        }, 5_000);
        timer.unref?.();
        const onObserved = (id) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(id);
        };
        entries.push(onObserved);
        waiters.set(key, entries);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
  };
};
const asNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const normalizeErrorMessage = (error) => {
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
};
const textArrayMessage = (value) => {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
};
const isSessionAlreadyInUseError = (message) =>
  /Session ID .* is already in use\./i.test(message);
const isMissingResumeSessionError = (message) =>
  /No conversation found with session ID:/i.test(message);
const configuredTimeoutMs = (envName, fallbackMs) => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

const processIsDead = (child) =>
  child.exitCode !== null || child.signalCode !== null;
const killProcess = (child) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {

  }
  const sigkillTimer = setTimeout(() => {
    if (processIsDead(child)) return;
    try {
      child.kill("SIGKILL");
    } catch {

    }
  }, SIGKILL_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(sigkillTimer));
};
const abortProcess = (child) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGINT");
  } catch {

  }
  setTimeout(() => {
    killProcess(child);
  }, SIGTERM_TIMEOUT_MS);
};
const parseClaudeCodeModel = (modelId) => {
  const normalized = modelId.trim();
  if (!normalized.startsWith(CLAUDE_CODE_MODEL_PREFIX)) return undefined;
  const suffix = normalized.slice(CLAUDE_CODE_MODEL_PREFIX.length).trim();
  if (!suffix || suffix === "default") return undefined;
  return suffix;
};
const mimeExtension = (mimeType) => {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
};
const parseDataUrlAttachment = (attachment) => {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(attachment.url.trim());
  if (!match) {
    return null;
  }
  try {
    return {
      mimeType: attachment.mimeType?.trim() || match[1],
      data: Buffer.from(match[2], "base64"),
    };
  } catch {
    return null;
  }
};
const ensureArtifactDir = (session) => {
  if (!session.artifactDir) {
    session.artifactDir = path.join(
      os.tmpdir(),
      "stella-claude-code",
      session.sessionId,
    );
  }
  fs.mkdirSync(session.artifactDir, { recursive: true });
  return session.artifactDir;
};
const materializeAttachments = (session, attachments) => {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const artifactDir = ensureArtifactDir(session);
  const notes = [];
  for (const [index, attachment] of attachments.entries()) {
    const parsed = parseDataUrlAttachment(attachment);
    if (!parsed) {
      continue;
    }
    const filePath = path.join(
      artifactDir,
      `attachment-${index + 1}-${crypto.randomUUID()}${mimeExtension(parsed.mimeType)}`,
    );
    fs.writeFileSync(filePath, parsed.data);
    notes.push(`${filePath} (${parsed.mimeType})`);
  }
  return notes;
};
const buildInitialPrompt = (session, request) => {
  const attachments = materializeAttachments(session, request.attachments);
  if (attachments.length === 0) {
    return request.prompt;
  }
  return [
    request.prompt.trim(),
    "User-provided attachments for this turn:",
    ...attachments.map((entry) => `- ${entry}`),
    "Treat these absolute file paths as attached image inputs for this turn.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
};
export const buildClaudeCodeNativeToolRuntimePrompt = (systemPrompt) =>
  [
    systemPrompt?.trim() ?? "",
    "Claude Code built-in tools are disabled for this session. Use the available Stella tools when needed and answer the user normally when finished.",
    "If you successfully call NoResponse and have nothing else to say, finish without adding a user-visible response.",
    "Never mention MCP, missing Claude tools, or the raw tool protocol to the user.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const parseStreamJsonLine = (line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};
export const getClaudeCodeTextDeltaFromStreamEvent = (event) => {
  if (event.type !== "stream_event") {
    return null;
  }
  const nested = asObject(event.event);
  const source = nested ?? event;
  if (source.type === "content_block_delta") {
    const delta = asObject(source.delta);
    if (!delta) return null;
    if (
      (delta.type === "text_delta" || delta.type === "thinking_delta") &&
      typeof delta.text === "string"
    ) {
      return delta.text;
    }
    if (typeof delta.text === "string") {
      return delta.text;
    }
    return null;
  }
  if (
    (source.type === "text_delta" || source.type === "thinking_delta") &&
    typeof source.text === "string"
  ) {
    return source.text;
  }
  return null;
};

const updateClaudeCodeNativeToolActivity = (event, activeToolUseIds) => {
  const before = activeToolUseIds.size;
  const updateFromContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asObject(raw);
      if (block?.type === "tool_use" && typeof block.id === "string") {
        activeToolUseIds.add(block.id);
      } else if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        activeToolUseIds.delete(block.tool_use_id);
      }
    }
  };
  if (event.type === "assistant" || event.type === "user") {
    updateFromContent(asObject(event.message)?.content);
  }
  if (event.type === "stream_event") {
    const source = asObject(event.event);
    if (source?.type === "content_block_start") {
      const block = asObject(source.content_block);
      if (block?.type === "tool_use" && typeof block.id === "string") {
        activeToolUseIds.add(block.id);
      }
    }
  }
  return before !== activeToolUseIds.size;
};
const observeFinalizedClaudeToolUses = (event, observe) => {
  if (event.type !== "assistant" || !observe) return;
  const content = asObject(event.message)?.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asObject(raw);
    if (
      block?.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    ) {
      continue;
    }
    observe({
      toolCallId: block.id,
      toolName: block.name,
      toolArgs: asObject(block.input) ?? {},
    });
  }
};
const mergeMcpCalls = (target, records) => {
  for (const record of records ?? []) {
    const existing = target.find(
      (entry) => entry.toolCallId === record.toolCallId,
    );
    if (existing) {
      if (record.status === "completed") {
        existing.status = "completed";
        existing.outcomeSummary = record.outcomeSummary;
      }
      continue;
    }
    target.push({ ...record });
  }
};
export const createClaudeCodeStreamEmitter = (onStream) => {
  let lastVisibleChar = "";
  let boundaryPending = false;
  return (event) => {
    if (event.type !== "stream_event") return;
    const source = asObject(event.event) ?? event;
    if (source.type === "message_start") {
      boundaryPending = true;
      return;
    }
    if (source.type === "content_block_start") {
      if (asObject(source.content_block)?.type === "text") {
        boundaryPending = true;
      }
      return;
    }
    const delta = getClaudeCodeTextDeltaFromStreamEvent(event);
    if (!delta) return;
    let out = delta;
    if (
      boundaryPending &&
      lastVisibleChar &&
      !/\s/.test(lastVisibleChar) &&
      !/^\s/.test(out)
    ) {
      out = `\n\n${out}`;
    }
    boundaryPending = false;
    lastVisibleChar = out.at(-1) ?? lastVisibleChar;
    onStream?.(out);
  };
};
export const getClaudeCodeStatusChangeFromStreamEvent = (event) => {
  const type = typeof event.type === "string" ? event.type : "";
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const hookEvent =
    typeof event.hook_event === "string"
      ? event.hook_event
      : typeof event.hookEvent === "string"
        ? event.hookEvent
        : "";
  const statusValue = typeof event.status === "string" ? event.status : "";
  if (
    type === "system" &&
    subtype === "status" &&
    statusValue === "compacting"
  ) {
    return {
      state: "compacting",
      text: CLAUDE_CODE_COMPACTING_TEXT,
    };
  }
  if (
    type === "system" &&
    (subtype === "hook_started" || subtype === "hook_response")
  ) {
    if (hookEvent === "PreCompact") {
      return {
        state: "compacting",
        text: CLAUDE_CODE_COMPACTING_TEXT,
      };
    }
    if (hookEvent === "PostCompact") {
      return {
        state: "running",
        text: CLAUDE_CODE_RUNNING_TEXT,
      };
    }
  }
  return null;
};

export const getClaudeCodeModelRoundFromStreamEvent = (event) => {
  if (event.type !== "assistant") return null;
  const message = asObject(event.message);
  const content = message?.content;
  const messageId =
    typeof message?.id === "string" && message.id.trim()
      ? message.id.trim()
      : undefined;
  if (!Array.isArray(content)) {
    return { ...(messageId ? { messageId } : {}), toolCallCount: 0 };
  }
  return {
    ...(messageId ? { messageId } : {}),
    toolCallCount: content.filter((raw) => asObject(raw)?.type === "tool_use")
      .length,
  };
};

const CLAUDE_CODE_MODEL_FALLBACK_RE =
  /^Model fallback triggered(?::? switching from (\S+) to (\S+))?/;

export const getClaudeCodeModelFallbackFromStreamEvent = (event) => {
  if (event.type !== "system" || event.subtype !== "informational") {
    return null;
  }
  const content = typeof event.content === "string" ? event.content : "";
  const match = CLAUDE_CODE_MODEL_FALLBACK_RE.exec(content);
  if (!match) {
    return null;
  }
  const fromModel = match[1]
    ? formatClaudeCodeResolvedModel(match[1])
    : "the configured model";
  const toModel = match[2]
    ? formatClaudeCodeResolvedModel(match[2])
    : "a fallback model";
  const text =
    `Claude Code switched this session from ${fromModel} to ${toModel} ` +
    `because ${fromModel} was unavailable. ` +
    `The rest of this session runs on ${toModel}.`;
  return { fromModel, toModel, text };
};
const cleanupSessionArtifacts = (session) => {
  if (!session.artifactDir) {
    return;
  }
  try {
    fs.rmSync(session.artifactDir, { recursive: true, force: true });
  } catch {

  }
  session.artifactDir = undefined;
};
const resetSessionMcpClients = (session, reason) => {
  void session.mcpHost?.resetClientSessions(reason).catch(() => {

  });
};
const cleanupSessionProcess = (session) => {
  if (!session.process) {
    return;
  }
  resetSessionMcpClients(
    session,
    new Error("Claude Code session process was closed."),
  );
  killProcess(session.process.child);
  session.process = undefined;
};
const cleanupSessionMcpHost = (session) => {
  const host = session.mcpHost;
  session.mcpHost = undefined;
  session.mcpToolCatalogKey = undefined;
  session.mcpConfigPath = undefined;
  session.activeMcpTurn = undefined;
  if (host) {
    void host.close().catch(() => {

    });
  }
};
const ensureSessionState = (sessions, request, sessionKey, cwd) => {
  const normalizedCwd = cwd?.trim() || undefined;
  const persistedSessionId = request.persistedSessionId?.trim() || undefined;
  const existing = sessions.get(sessionKey);
  if (existing) {
    if (existing.cwd === normalizedCwd) {
      if (persistedSessionId && existing.turnCount === 0) {
        existing.sessionId = persistedSessionId;
        existing.turnCount = 1;
        existing.resumeReady = true;
      }
      return existing;
    }
    cleanupSessionProcess(existing);
    cleanupSessionMcpHost(existing);
    cleanupSessionArtifacts(existing);
    const replacement = {
      sessionId: persistedSessionId ?? crypto.randomUUID(),
      cwd: normalizedCwd,
      lastUsedAt: Date.now(),
      turnCount: persistedSessionId ? 1 : 0,
      resumeReady: Boolean(persistedSessionId),
      running: false,
      queue: [],
    };
    sessions.set(sessionKey, replacement);
    return replacement;
  }
  const created = {
    sessionId: persistedSessionId ?? crypto.randomUUID(),
    cwd: normalizedCwd,
    lastUsedAt: Date.now(),
    turnCount: persistedSessionId ? 1 : 0,
    resumeReady: Boolean(persistedSessionId),
    running: false,
    queue: [],
  };
  sessions.set(sessionKey, created);
  return created;
};
class ClaudeCodeSessionRuntime {
  sessions = new Map();
  activeProcesses = new Map();
  closeWhenIdle = new Set();
  idleCloseTimers = new Map();
  async runTurn(request) {
    this.clearIdleCloseTimer(request.sessionKey);
    const session = ensureSessionState(
      this.sessions,
      request,
      request.sessionKey,
      request.cwd,
    );
    if (request.persistedSessionId?.trim()) {
      request.onSessionId?.(session.sessionId);
    }
    session.lastUsedAt = Date.now();
    return await new Promise((resolve, reject) => {
      session.queue.push({ request, resolve, reject });
      this.pumpSession(request.sessionKey, session);
    });
  }

  hasActiveProcess(sessionKey) {
    const child = this.activeProcesses.get(sessionKey);
    return Boolean(child && !child.killed && child.exitCode === null);
  }
  closeSessionWhenIdle(sessionKey) {
    this.clearIdleCloseTimer(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (session.running || session.queue.length > 0) {
      this.closeWhenIdle.add(sessionKey);
      return;
    }
    this.closeSession(sessionKey, session);
  }
  scheduleSessionCloseWhenIdle(sessionKey, timeoutMs) {
    this.clearIdleCloseTimer(sessionKey);
    const timer = setTimeout(
      () => this.closeSessionWhenIdle(sessionKey),
      Math.max(1_000, timeoutMs),
    );
    timer.unref?.();
    this.idleCloseTimers.set(sessionKey, timer);
  }
  clearIdleCloseTimer(sessionKey) {
    const timer = this.idleCloseTimers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.idleCloseTimers.delete(sessionKey);
  }
  closeSession(sessionKey, session) {
    this.clearIdleCloseTimer(sessionKey);
    const child = session.process?.child;
    if (child && this.activeProcesses.get(sessionKey) === child) {
      this.activeProcesses.delete(sessionKey);
    }
    cleanupSessionProcess(session);
    cleanupSessionMcpHost(session);
    cleanupSessionArtifacts(session);
    this.sessions.delete(sessionKey);
    this.closeWhenIdle.delete(sessionKey);
  }
  dispose() {
    for (const child of this.activeProcesses.values()) {
      killProcess(child);
    }
    this.activeProcesses.clear();
    for (const session of this.sessions.values()) {
      cleanupSessionProcess(session);
      cleanupSessionMcpHost(session);
      cleanupSessionArtifacts(session);
    }
    this.sessions.clear();
    this.closeWhenIdle.clear();
    for (const timer of this.idleCloseTimers.values()) clearTimeout(timer);
    this.idleCloseTimers.clear();
  }
  pruneIdleSessions() {
    const now = Date.now();
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.running || session.queue.length > 0) continue;
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
        cleanupSessionProcess(session);
        cleanupSessionMcpHost(session);
        cleanupSessionArtifacts(session);
        this.sessions.delete(sessionKey);
      }
    }
  }
  pumpSession(sessionKey, session) {
    if (session.running) return;
    const job = session.queue.shift();
    if (!job) {
      this.pruneIdleSessions();
      return;
    }
    session.running = true;
    void this.executeTurn(session, job.request)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        session.running = false;
        session.lastUsedAt = Date.now();
        if (this.closeWhenIdle.has(sessionKey) && session.queue.length === 0) {
          this.closeSession(sessionKey, session);
          return;
        }
        this.pumpSession(sessionKey, session);
      });
  }
  async executeTurn(session, request) {

    const effectiveSystemPrompt = request.vanilla
      ? ""
      : buildClaudeCodeNativeToolRuntimePrompt(request.systemPrompt);
    const prompt = buildInitialPrompt(session, request);

    session.modelOverride = undefined;
    session.fableSafetyFailures = 0;
    session.allowEmptyNativeFinal = false;

    if (session.process) {
      session.process.compacting = false;
      session.process.compactionCount = 0;
    }
    if (!request.vanilla) {
      const nativeToolUseCorrelator = createClaudeNativeToolUseCorrelator();
      session.activeNativeToolUseCorrelator = nativeToolUseCorrelator;
      session.activeMcpTurn = {

        identityScope: request.sessionKey,
        claimNativeToolUseId: (toolName, toolArgs, signal) =>
          nativeToolUseCorrelator.claim(toolName, toolArgs, signal),
        checkToolUseIntegrity: (toolName, toolArgs, signal) =>
          nativeToolUseCorrelator.resolveToolUseIntegrity(
            toolName,
            toolArgs,
            signal,
          ),
        executeTool: async (
          toolCallId,
          toolName,
          toolArgs,
          toolSignal,
          onUpdate,
        ) => {
          const pending = session.process?.pending[0];
          const callRecord = {
            toolCallId,
            toolName,
            status: "started",
            argsSummary: summarizeMcpLedgerValue(toolArgs, 4_000),
          };
          pending?.mcpCalls.push(callRecord);
          const signal =
            request.abortSignal && toolSignal
              ? AbortSignal.any([request.abortSignal, toolSignal])
              : (request.abortSignal ?? toolSignal);
          const toolResult = await executeToolWithInactivityBound({
            toolName,
            signal,
            run: (boundedSignal, onActivity) =>
              request.executeTool(
                toolCallId,
                toolName,
                toolArgs,
                boundedSignal,
                (update) => {
                  onActivity();
                  onUpdate?.(update);
                  request.onToolUpdate?.({
                    toolCallId,
                    toolName,
                    update,
                  });
                },
              ),
          });
          callRecord.status = "completed";
          callRecord.outcomeSummary = summarizeMcpLedgerValue(
            {
              result: toolResult.result,
              details: toolResult.details,
              error: toolResult.error,
            },
            6_000,
          );
          if (toolName === "NoResponse" && !toolResult.error) {
            session.allowEmptyNativeFinal = true;
          }
          return toolResult;
        },
        onToolResponseWritten: request.onToolResponseWritten,
      };
    }
    try {
      const response = await this.executeStepWithRecovery(
        session,
        request,
        effectiveSystemPrompt,
        prompt,
        [],
        { remaining: MAX_STEP_RECOVERIES_PER_TURN },
      );
      return {
        text: response.message,
        sessionId: response.sessionId,
        usage: response.usage,
      };
    } finally {
      session.activeMcpTurn = undefined;
      session.allowEmptyNativeFinal = false;
    }
  }

  async executeStepWithRecovery(
    session,
    request,
    effectiveSystemPrompt,
    prompt,
    promptImages,
    recoveryBudget,
  ) {
    let currentPrompt = prompt;
    let currentPromptImages = promptImages;
    const failedAttemptMcpCalls = [];
    for (;;) {
      try {
        const result = await this.executeStep(
          session,
          request,
          effectiveSystemPrompt,
          currentPrompt,
          currentPromptImages,
          failedAttemptMcpCalls,
        );
        return result;
      } catch (error) {
        if (request.abortSignal?.aborted) {
          throw error;
        }
        const recoverable = asRecoverableStepError(error);
        const hasPossibleSideEffects = Boolean(
          recoverable && recoverable.mcpCalls.length > 0,
        );

        if (
          !hasPossibleSideEffects &&
          this.applyFableFallbackPolicy(session, request, error)
        ) {
          continue;
        }
        if (!recoverable) {
          throw error;
        }
        mergeMcpCalls(failedAttemptMcpCalls, recoverable.mcpCalls);
        if (recoveryBudget.remaining <= 0) {
          throw withStepRecoveryExhausted(error);
        }
        recoveryBudget.remaining -= 1;
        if (recoverable instanceof ClaudeCodeProcessEndedError) {
          this.resetStreamingProcess(request.sessionKey, session);

          if (failedAttemptMcpCalls.length > 0) {
            currentPrompt = buildSideEffectReconciliationPrompt(
              failedAttemptMcpCalls,
            );
            currentPromptImages = [];
          }
          continue;
        }
        currentPrompt = hasPossibleSideEffects
          ? buildSideEffectReconciliationPrompt(
              failedAttemptMcpCalls,
            )
          : buildResultRetryPrompt();
        currentPromptImages = [];
      }
    }
  }

  applyFableFallbackPolicy(session, request, error) {
    if (session.modelOverride) return false;
    const modelName = parseClaudeCodeModel(request.modelId);
    if (!modelName || !/\bfable\b/.test(modelName)) return false;
    const message = error instanceof Error ? error.message : "";
    if (!isClaudeCodeModelRefusalOrOverloadError(message)) return false;
    session.fableSafetyFailures = (session.fableSafetyFailures ?? 0) + 1;
    const prettyFrom = formatClaudeCodeResolvedModel(modelName);
    if (session.fableSafetyFailures < SAFETY_ABORT_FABLE_ATTEMPTS) {
      request.onStatusChange?.({
        state: "running",
        text:
          `${prettyFrom} refused this request — retrying ` +
          `(attempt ${session.fableSafetyFailures + 1} of ` +
          `${SAFETY_ABORT_FABLE_ATTEMPTS})`,
      });
      return true;
    }
    session.modelOverride = CLAUDE_CODE_FALLBACK_MODEL;
    const prettyTo = formatClaudeCodeResolvedModel(CLAUDE_CODE_FALLBACK_MODEL);
    if (!session.modelFallbackNotified) {
      session.modelFallbackNotified = true;
      request.onStatusChange?.({
        state: "model-fallback",
        text:
          `${prettyFrom} failed ${SAFETY_ABORT_FABLE_ATTEMPTS} attempts ` +
          `(refusal/overload), so this turn switched to ${prettyTo}. ` +
          `${prettyFrom} will be retried on your next message.`,
      });
    }
    return true;
  }
  async executeStep(
    session,
    request,
    effectiveSystemPrompt,
    prompt,
    promptImages,
    observedMcpCalls = [],
  ) {
    return await this.executeStepWithMode(
      session,
      request,
      effectiveSystemPrompt,
      prompt,
      session.resumeReady,
      true,
      promptImages,
      observedMcpCalls,
    );
  }

  async executeStepWithMode(
    session,
    request,
    effectiveSystemPrompt,
    prompt,
    useResume,
    allowCompactionLoopRestart = true,
    promptImages = [],
    observedMcpCalls = [],
  ) {

    const buildReseedPrompt = (mcpCalls) =>
      mcpCalls.length > 0
        ? buildSideEffectReconciliationPrompt(
            mcpCalls,
            request.resumeFallbackPrompt ?? prompt,
          )
        : (request.resumeFallbackPrompt ?? prompt);
    try {
      const processState = await this.ensureStreamingProcess(
        session,
        request,
        effectiveSystemPrompt,
        useResume,
      );
      return await this.sendStreamingPrompt(
        session,
        processState,
        request,
        prompt,
        promptImages,
      );
    } catch (error) {
      const message = normalizeErrorMessage(error);
      if (!useResume && isSessionAlreadyInUseError(message)) {
        this.resetStreamingProcess(request.sessionKey, session);
        return await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          prompt,
          true,
          allowCompactionLoopRestart,
          promptImages,
          observedMcpCalls,
        );
      }
      if (useResume && isMissingResumeSessionError(message)) {
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        return await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(observedMcpCalls),
          false,
          allowCompactionLoopRestart,
          promptImages,
          observedMcpCalls,
        );
      }
      if (
        allowCompactionLoopRestart &&
        error instanceof ClaudeCodeCompactionLoopError
      ) {

        const mcpCalls = [...observedMcpCalls];
        mergeMcpCalls(mcpCalls, error.mcpCalls);
        this.resetStreamingProcess(request.sessionKey, session);
        session.sessionId = crypto.randomUUID();
        session.turnCount = 0;
        session.resumeReady = false;
        const result = await this.executeStepWithMode(
          session,
          request,
          effectiveSystemPrompt,
          buildReseedPrompt(mcpCalls),
          false,
          false,
          promptImages,
          mcpCalls,
        );
        return result;
      }
      throw error;
    }
  }
  buildClaudeCodeArgs(
    session,
    request,
    effectiveSystemPrompt,
    useResume,
    mcpHost,
  ) {

    const modelName =
      session.modelOverride ?? parseClaudeCodeModel(request.modelId);
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--settings",
      CLAUDE_CODE_HOOK_SETTINGS,
    ];
    if (!request.vanilla) {
      if (!mcpHost || !session.mcpConfigPath) {
        throw new Error("Claude Code native tool host is unavailable.");
      }

      const allowedStellaTools = request.tools
        .map((tool) => `mcp__stella__${tool.name}`)
        .join(",");
      args.push(
        "--strict-mcp-config",
        "--mcp-config",
        session.mcpConfigPath,
        "--disable-slash-commands",
        "--tools",
        "mcp__stella__*",
        "--allowedTools",
        allowedStellaTools,
      );
    }
    if (effectiveSystemPrompt.trim()) {
      args.push("--system-prompt", effectiveSystemPrompt.trim());
    }
    if (modelName) {
      args.push("--model", modelName);
    }
    if (useResume) {
      args.push("--resume", session.sessionId);
    }
    return args;
  }
  buildProcessLaunchConfig(session, request, effectiveSystemPrompt, mcpHost) {
    return JSON.stringify([
      session.modelOverride ?? parseClaudeCodeModel(request.modelId) ?? "",
      request.effortLevel?.trim() ?? "",
      Boolean(request.vanilla),
      mcpHost?.toolCatalogHash ?? "",
      effectiveSystemPrompt.trim(),
      request.autoCompactWindowTokens ?? null,
      request.autoCompactTriggerPct ?? null,
      request.cliBridgeSocketPath ?? "",
    ]);
  }
  async ensureMcpHost(session, request) {
    if (request.vanilla) {
      if (session.mcpHost) {
        await session.mcpHost.close().catch(() => undefined);
        session.mcpHost = undefined;
        session.mcpToolCatalogKey = undefined;
        session.mcpConfigPath = undefined;
      }
      return undefined;
    }
    const catalogKey = crypto
      .createHash("sha256")
      .update(JSON.stringify(request.tools))
      .digest("hex");
    if (session.mcpHost && session.mcpToolCatalogKey === catalogKey) {
      return session.mcpHost;
    }

    this.resetStreamingProcess(request.sessionKey, session);
    if (session.mcpHost) {
      await session.mcpHost.close().catch(() => undefined);
    }
    session.mcpHost = await createClaudeCodeToolMcpHost({
      tools: request.tools,
      identityScope: request.sessionKey,
      getActiveTurn: () => session.activeMcpTurn,
    });
    session.mcpToolCatalogKey = catalogKey;
    session.mcpConfigPath = path.join(
      ensureArtifactDir(session),
      "claude-code-mcp.json",
    );
    fs.writeFileSync(
      session.mcpConfigPath,
      JSON.stringify({
        mcpServers: { stella: session.mcpHost.mcpServerConfig },
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    fs.chmodSync(session.mcpConfigPath, 0o600);
    return session.mcpHost;
  }
  async ensureStreamingProcess(
    session,
    request,
    effectiveSystemPrompt,
    useResume,
  ) {
    const mcpHost = await this.ensureMcpHost(session, request);
    const launchConfig = this.buildProcessLaunchConfig(
      session,
      request,
      effectiveSystemPrompt,
      mcpHost,
    );
    if (
      session.process &&
      !session.process.closed &&

      !session.process.child.killed &&
      !processIsDead(session.process.child)
    ) {
      if (session.process.launchConfig === launchConfig) {
        return session.process;
      }
      if (session.process.pending.length > 0) {

        return session.process;
      }

      this.resetStreamingProcess(request.sessionKey, session);
    }
    const executablePath = resolveExternalCliPath("claude");
    const effortLevel = request.effortLevel?.trim();
    const childEnv = buildExternalCliChildEnv(executablePath, process.env, {
      ...(request.cliBridgeSocketPath
        ? { cliBridgeSocketPath: request.cliBridgeSocketPath }
        : {}),
    });
    if (effortLevel) {
      childEnv.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
    }
    if (
      Number.isFinite(request.autoCompactWindowTokens) &&
      (request.autoCompactWindowTokens ?? 0) > 0
    ) {
      childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.floor(request.autoCompactWindowTokens),
      );
    }
    if (
      Number.isFinite(request.autoCompactTriggerPct) &&
      (request.autoCompactTriggerPct ?? 0) > 0
    ) {
      childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(
        Math.min(100, Math.max(1, Math.floor(request.autoCompactTriggerPct))),
      );
    }
    const child = spawn(
      executablePath,
      this.buildClaudeCodeArgs(
        session,
        request,
        effectiveSystemPrompt,
        useResume,
        mcpHost,
      ),
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: request.cwd,
        env: childEnv,
      },
    );
    const processState = {
      child,
      stdoutBuffer: "",
      stdoutDecoder: new StringDecoder("utf8"),
      stderrText: "",
      finalSessionId: session.sessionId,
      pending: [],
      pendingControlRequests: new Map(),
      closed: false,
      compacting: false,
      compactionCount: 0,
      launchConfig,
    };
    session.process = processState;
    this.activeProcesses.set(request.sessionKey, child);
    const refreshPendingIdleTimers = (hasOutput = false) => {
      for (const pending of processState.pending) {
        if (hasOutput) pending.hasOutput = true;
        this.refreshPendingIdleTimer(processState, pending);
      }
    };
    const consumeStdout = (flush = false) => {
      const segments = flush
        ? [processState.stdoutBuffer]
        : processState.stdoutBuffer.split("\n");
      const completeSegments = flush ? segments : segments.slice(0, -1);
      processState.stdoutBuffer = flush
        ? ""
        : (segments[segments.length - 1] ?? "");
      for (const segment of completeSegments) {
        const line = segment.trim();
        if (!line) {
          continue;
        }
        const parsedLine = parseStreamJsonLine(line);
        if (!parsedLine) {
          continue;
        }
        if (parsedLine.type === "control_response") {
          const response = asObject(parsedLine.response);
          const requestId =
            typeof response?.request_id === "string"
              ? response.request_id
              : undefined;
          const pendingControl = requestId
            ? processState.pendingControlRequests.get(requestId)
            : undefined;
          if (pendingControl && requestId) {
            processState.pendingControlRequests.delete(requestId);
            clearTimeout(pendingControl.timeout);
            if (response?.subtype === "error") {
              pendingControl.reject(
                new Error(
                  typeof response.error === "string" && response.error.trim()
                    ? response.error
                    : "Claude Code control request failed.",
                ),
              );
            } else {
              pendingControl.resolve(response ?? {});
            }
          }
          continue;
        }
        if (
          typeof parsedLine.session_id === "string" &&
          parsedLine.session_id.trim()
        ) {
          processState.finalSessionId = parsedLine.session_id.trim();
          session.sessionId = processState.finalSessionId;
          session.resumeReady = true;
          request.onSessionId?.(session.sessionId);
        }

        if (
          parsedLine.type === "system" &&
          parsedLine.subtype === "init" &&
          request.onProtocolInit
        ) {
          request.onProtocolInit({
            tools: Array.isArray(parsedLine.tools)
              ? parsedLine.tools.filter((entry) => typeof entry === "string")
              : [],
            mcpServers: Array.isArray(parsedLine.mcp_servers)
              ? parsedLine.mcp_servers.map((entry) => {
                  const value = asObject(entry);
                  return {
                    ...(typeof value?.name === "string"
                      ? { name: value.name }
                      : {}),
                    ...(typeof value?.status === "string"
                      ? { status: value.status }
                      : {}),
                  };
                })
              : [],
          });
        }
        if (
          parsedLine.type === "system" &&
          parsedLine.subtype === "init" &&
          typeof parsedLine.model === "string" &&
          request.stellaAppDir
        ) {
          void recordClaudeCodeResolvedModel(
            request.stellaAppDir,
            parseClaudeCodeModel(request.modelId) ?? "default",
            parsedLine.model,
          );
        }
        const status = getClaudeCodeStatusChangeFromStreamEvent(parsedLine);
        if (status) {

          if (status.state === "compacting" && !processState.compacting) {
            processState.compacting = true;
            processState.compactionCount += 1;
            if (processState.compactionCount > MAX_COMPACTIONS_PER_TURN) {
              this.failCompactionLoop(
                request.sessionKey,
                session,
                processState,
              );
              return;
            }
          } else if (status.state === "running") {
            processState.compacting = false;
          }
        }

        const modelFallback =
          getClaudeCodeModelFallbackFromStreamEvent(parsedLine);
        const current = processState.pending[0];
        if (current) {
          const modelRound = getClaudeCodeModelRoundFromStreamEvent(parsedLine);
          if (modelRound) {
            try {
              current.request.onModelRound?.(modelRound);
            } catch {

            }
          }
          if (
            updateClaudeCodeNativeToolActivity(
              parsedLine,
              current.activeNativeToolUseIds,
            )
          ) {
            this.refreshPendingIdleTimer(processState, current);
          }
          if (status) {
            current.request.onStatusChange?.(status);
          }
          if (modelFallback && !session.modelFallbackNotified) {
            session.modelFallbackNotified = true;
            current.request.onStatusChange?.({
              state: "model-fallback",
              text: modelFallback.text,
            });
          }
          current.emitStreamDelta(parsedLine);
        }
        if (parsedLine.type === "result") {
          const completed = processState.pending.shift();
          if (!completed) {
            continue;
          }
          this.detachAbortListener(completed);
          if (completed.steeringInterrupted) {
            completed.reject(
              new ClaudeCodeSteeringInterruptError(completed.mcpCalls),
            );
            continue;
          }
          try {
            const stepResult = this.parseResultPayload(
              session,
              parsedLine,
              processState.stderrText,
              Boolean(
                !completed.request.vanilla && session.allowEmptyNativeFinal,
              ),
            );
            completed.resolve(stepResult);
          } catch (error) {
            if (error instanceof ClaudeCodeMalformedResultError) {
              mergeMcpCalls(error.mcpCalls, completed.mcpCalls);
            }
            completed.reject(error);
          }
        }
      }
    };
    child.stdout.on("data", (chunk) => {
      processState.stdoutBuffer += processState.stdoutDecoder.write(chunk);
      refreshPendingIdleTimers(true);
      consumeStdout(false);
    });
    child.stderr.on("data", (chunk) => {
      refreshPendingIdleTimers(true);
      if (processState.stderrText.length >= MAX_STDERR_CAPTURE) return;
      processState.stderrText += chunk.toString("utf8");
      if (processState.stderrText.length > MAX_STDERR_CAPTURE) {
        processState.stderrText = processState.stderrText.slice(
          0,
          MAX_STDERR_CAPTURE,
        );
      }
    });
    child.once("error", (error) => {
      const wrapped = new Error(
        `Failed to start Claude Code: ${normalizeErrorMessage(error)}`,
      );
      processState.closed = true;
      const ownsSessionProcess = session.process === processState;
      if (ownsSessionProcess) {
        resetSessionMcpClients(session, wrapped);
        session.process = undefined;
      }

      if (this.activeProcesses.get(request.sessionKey) === child) {
        this.activeProcesses.delete(request.sessionKey);
      }
      for (const pending of processState.pending.splice(0)) {
        this.detachAbortListener(pending);
        pending.reject(
          new ClaudeCodeProcessEndedError(
            wrapped.message,
            null,
            pending.mcpCalls,
          ),
        );
      }
      this.rejectControlRequests(processState, wrapped);
    });
    child.once("close", (code) => {
      consumeStdout(true);
      processState.closed = true;
      const ownsSessionProcess = session.process === processState;
      if (ownsSessionProcess) {
        resetSessionMcpClients(
          session,
          new Error("Claude Code process exited."),
        );
        session.process = undefined;
      }

      if (this.activeProcesses.get(request.sessionKey) === child) {
        this.activeProcesses.delete(request.sessionKey);
      }
      const message =
        processState.stderrText.trim() ||
        `Claude Code exited with code ${code ?? "unknown"} before returning a result.`;
      for (const pending of processState.pending.splice(0)) {
        this.detachAbortListener(pending);
        pending.reject(
          pending.request.abortSignal?.aborted
            ? new Error("Claude Code run aborted.")
            : new ClaudeCodeProcessEndedError(
                message,
                code,
                pending.mcpCalls,
              ),
        );
      }
      this.rejectControlRequests(
        processState,
        new ClaudeCodeProcessEndedError(message, code),
      );
    });
    // Claude accepts stdin before it has discovered the private MCP catalog.
    // Do not let the first tool-bearing prompt race that discovery.
    if (mcpHost && request.tools.length > 0) {
      await mcpHost.waitForClientReady(request.abortSignal);
    }
    return processState;
  }
  async sendStreamingPrompt(
    session,
    processState,
    request,
    prompt,
    promptImages = [],
  ) {
    if (processState.closed || processState.child.stdin.destroyed) {
      throw new ClaudeCodeProcessEndedError("Claude Code stream is closed.");
    }
    return await new Promise((resolve, reject) => {
      const pending = {
        request,
        resolve,
        reject,
        emitStreamDelta: createClaudeCodeStreamEmitter(request.onStream),
        mcpCalls: [],
        activeNativeToolUseIds: new Set(),
      };
      this.refreshPendingIdleTimer(processState, pending);
      if (request.abortSignal) {
        pending.abortListener = () => {
          resetSessionMcpClients(
            session,
            request.abortSignal?.reason ??
              new Error("Claude Code run aborted."),
          );
          abortProcess(processState.child);
        };
        if (request.abortSignal.aborted) {
          pending.abortListener();
        } else {
          request.abortSignal.addEventListener("abort", pending.abortListener, {
            once: true,
          });
        }
      }
      processState.pending.push(pending);

      const content =
        promptImages.length > 0
          ? [
              { type: "text", text: prompt },
              ...promptImages.map((image) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mimeType,
                  data: image.data,
                },
              })),
            ]
          : prompt;
      const payload = JSON.stringify({
        type: "user",
        session_id: session.sessionId,
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
      });
      processState.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        const index = processState.pending.indexOf(pending);
        if (index >= 0) {
          processState.pending.splice(index, 1);
        }
        this.detachAbortListener(pending);

        reject(
          new ClaudeCodeProcessEndedError(
            `Failed to write Claude Code prompt: ${normalizeErrorMessage(error)}`,
            null,
            pending.mcpCalls,
          ),
        );
      });
      if (request.onTurnControl) {
        try {
          pending.detachTurnControl = request.onTurnControl({
            interrupt: async () => {
              if (pending.steeringInterruptPromise) {
                return await pending.steeringInterruptPromise;
              }
              pending.steeringInterrupted = true;
              pending.steeringSettledPromise = new Promise((resolve) => {
                pending.resolveSteeringSettled = resolve;
              });
              pending.steeringInterruptPromise = this.interruptPendingTurn(
                session,
                request.sessionKey,
                processState,
                pending,
              );
              return await pending.steeringInterruptPromise;
            },
          });
        } catch {

        }
      }
    });
  }
  detachAbortListener(pending) {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
      pending.idleTimer = undefined;
    }
    if (pending.abortListener && pending.request.abortSignal) {
      pending.request.abortSignal.removeEventListener(
        "abort",
        pending.abortListener,
      );
    }
    pending.detachTurnControl?.();
    pending.detachTurnControl = undefined;
    pending.resolveSteeringSettled?.();
    pending.resolveSteeringSettled = undefined;
  }
  async interruptPendingTurn(session, sessionKey, processState, pending) {
    const controlTimeoutMs = configuredTimeoutMs(
      "STELLA_CLAUDE_CODE_STEERING_CONTROL_TIMEOUT_MS",
      configuredTimeoutMs(
        "STELLA_CLAUDE_CODE_CONTROL_TIMEOUT_MS",
        DEFAULT_STEERING_CONTROL_TIMEOUT_MS,
      ),
    );
    try {
      await this.sendControlRequest(
        processState,
        { subtype: "interrupt" },
        controlTimeoutMs,
      );
    } catch (error) {
      this.failSteeringTurn(sessionKey, session, processState, pending);
      throw error;
    }
    if (!processState.pending.includes(pending)) {
      return;
    }
    const resultTimeoutMs = configuredTimeoutMs(
      "STELLA_CLAUDE_CODE_STEERING_RESULT_TIMEOUT_MS",
      DEFAULT_STEERING_RESULT_TIMEOUT_MS,
    );
    let timeout;
    const resultArrived = await Promise.race([
      pending.steeringSettledPromise.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), resultTimeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!resultArrived && processState.pending.includes(pending)) {
      this.failSteeringTurn(sessionKey, session, processState, pending);
    }
  }
  failSteeringTurn(sessionKey, session, processState, pending) {
    const index = processState.pending.indexOf(pending);
    if (index >= 0) {
      processState.pending.splice(index, 1);
      this.detachAbortListener(pending);
    }
    if (session.process === processState) {
      processState.closed = true;
      this.resetStreamingProcess(sessionKey, session);
    }
    if (index >= 0) {
      pending.reject(
        new ClaudeCodeSteeringInterruptError(pending.mcpCalls),
      );
    }
  }
  async sendControlRequest(
    processState,
    request,
    timeoutMs = configuredTimeoutMs(
      "STELLA_CLAUDE_CODE_CONTROL_TIMEOUT_MS",
      DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
    ),
  ) {
    if (processState.closed || processState.child.stdin.destroyed) {
      throw new ClaudeCodeProcessEndedError("Claude Code stream is closed.");
    }
    const requestId = `stella_${crypto.randomUUID()}`;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        processState.pendingControlRequests.delete(requestId);
        reject(
          new Error(
            `Claude Code control request ${request.subtype} timed out after ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
      processState.pendingControlRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });
    });
    const payload = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    });
    processState.child.stdin.write(`${payload}\n`, (error) => {
      if (!error) return;
      const pending = processState.pendingControlRequests.get(requestId);
      if (!pending) return;
      processState.pendingControlRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(
        new ClaudeCodeProcessEndedError(
          `Failed to write Claude Code control request: ${normalizeErrorMessage(error)}`,
        ),
      );
    });
    await response;
  }
  rejectControlRequests(processState, error) {
    for (const pending of processState.pendingControlRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    processState.pendingControlRequests.clear();
  }
  refreshPendingIdleTimer(processState, pending) {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    pending.idleTimer = undefined;

    const toolsInFlight = pending.activeNativeToolUseIds.size > 0;
    const timeoutMs = toolsInFlight
      ? configuredTimeoutMs(
          "STELLA_CLAUDE_CODE_TOOL_IDLE_TIMEOUT_MS",
          DEFAULT_STEP_TOOL_IDLE_TIMEOUT_MS,
        )
      : pending.hasOutput
        ? configuredTimeoutMs(
            "STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS",
            DEFAULT_STEP_IDLE_TIMEOUT_MS,
          )
        : configuredTimeoutMs(
            "STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS",
            DEFAULT_STEP_STARTUP_IDLE_TIMEOUT_MS,
          );
    pending.idleTimer = setTimeout(() => {
      const index = processState.pending.indexOf(pending);
      if (index >= 0) {
        processState.pending.splice(index, 1);
      }
      this.detachAbortListener(pending);
      abortProcess(processState.child);
      pending.reject(
        new Error(
          toolsInFlight
            ? `Claude Code produced no output for ${Math.round(timeoutMs / 1000)}s with ${pending.activeNativeToolUseIds.size} native tool call(s) still unresolved.`
            : `Claude Code did not produce output for ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    pending.idleTimer.unref?.();
  }
  parseResultPayload(session, parsed, stderrText, allowEmptyFinal = false) {
    let resultError;
    if (parsed.is_error === true) {
      const parsedError =
        (typeof parsed.result === "string" && parsed.result.trim()) ||
        (typeof parsed.error === "string" && parsed.error.trim()) ||
        textArrayMessage(parsed.errors) ||
        stderrText.trim() ||
        "";
      resultError = parsedError || "Claude Code reported an error.";
    }
    if (resultError) {
      throw new ClaudeCodeMalformedResultError(resultError, "result_error");
    }
    const usageRaw = parsed.usage;
    const inputTokens = asNumber(
      usageRaw?.input_tokens ?? usageRaw?.inputTokens,
    );
    const outputTokens = asNumber(
      usageRaw?.output_tokens ?? usageRaw?.outputTokens,
    );
    const usage =
      inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;
    const message =
      typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (!message && !allowEmptyFinal) {
      throw new ClaudeCodeMalformedResultError(
        stderrText.trim() || "Claude Code returned an empty result.",
        "empty_result",
      );
    }
    session.turnCount += 1;
    session.lastUsedAt = Date.now();
    return {
      message,
      sessionId: session.sessionId,
      usage,
    };
  }

  failCompactionLoop(sessionKey, session, processState) {
    processState.closed = true;
    if (session.process === processState) {
      session.process = undefined;
    }
    if (this.activeProcesses.get(sessionKey) === processState.child) {
      this.activeProcesses.delete(sessionKey);
    }
    const failed = processState.pending.splice(0);
    resetSessionMcpClients(session, new ClaudeCodeCompactionLoopError());
    killProcess(processState.child);
    for (const pending of failed) {
      this.detachAbortListener(pending);

      pending.reject(
        new ClaudeCodeCompactionLoopError(pending.mcpCalls),
      );
    }
  }
  resetStreamingProcess(sessionKey, session) {
    if (!session.process) {
      return;
    }
    const child = session.process.child;
    resetSessionMcpClients(
      session,
      new Error("Claude Code process is restarting."),
    );
    killProcess(child);
    session.process = undefined;
    if (this.activeProcesses.get(sessionKey) === child) {
      this.activeProcesses.delete(sessionKey);
    }
  }
}
const runtime = new ClaudeCodeSessionRuntime();
export const isClaudeCodeModel = (modelId) =>
  modelId.trim().startsWith(CLAUDE_CODE_MODEL_PREFIX);
export const runClaudeCodeTurn = async (request) =>
  await runtime.runTurn(request);

export const claudeCodeSessionHasActiveProcess = (sessionKey) =>
  runtime.hasActiveProcess(sessionKey);
export const closeClaudeCodeSessionWhenIdle = (sessionKey) => {
  runtime.closeSessionWhenIdle(sessionKey);
};
export const scheduleClaudeCodeSessionCloseWhenIdle = (
  sessionKey,
  timeoutMs,
) => {
  runtime.scheduleSessionCloseWhenIdle(sessionKey, timeoutMs);
};
export const listClaudeCodeModels = async (auth, stellaAppDir) => {
  const models = new Map();
  const resolvedModels = stellaAppDir
    ? readClaudeCodeResolvedModels(stellaAppDir)
    : {};
  for (const alias of CLAUDE_CODE_ALIASES) {
    const labels = CLAUDE_CODE_ALIAS_LABELS[alias];
    const resolved = resolvedModels[alias];
    models.set(alias, {
      id: alias,

      displayName: resolved
        ? `${labels.displayName} · ${formatClaudeCodeResolvedModel(resolved)}`
        : labels.displayName,
      description: labels.description,
      source: "alias",
    });
  }
  const apiKey = auth?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  const oauthToken =
    auth?.oauthToken?.trim() || process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (!apiKey && !oauthToken) return { models: [...models.values()] };
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        ...(oauthToken
          ? {
              authorization: `Bearer ${oauthToken}`,
              "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
              "anthropic-dangerous-direct-browser-access": "true",
              "user-agent": "claude-cli/2.1.146",
            }
          : { "x-api-key": apiKey ?? "" }),
      },
    });
    if (!response.ok) return { models: [...models.values()] };
    const parsed = await response.json();
    for (const model of parsed.data ?? []) {
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const id = model.id.trim();
      models.set(id, {
        id,
        displayName:
          typeof model.display_name === "string" && model.display_name.trim()
            ? model.display_name.trim()
            : id,
        source: "anthropic",
      });
    }
  } catch {
    return { models: [...models.values()] };
  }
  return { models: [...models.values()] };
};
export const shutdownClaudeCodeRuntime = () => {
  runtime.dispose();
};
