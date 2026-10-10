import { spawn } from "child_process";
import type { ChildProcess, ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
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
import {
  createClaudeCodeToolMcpHost,
  type ClaudeCodeToolMcpActiveTurn,
  type ClaudeCodeToolMcpHost,
} from "./claude-code-tool-mcp-host.js";
import { getClaudeCodeConfig } from "../storage/local-llm-credential-access.js";
import type {
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";

/** One parsed stream-json line from the CLI: untrusted JSON, read defensively. */
type ClaudeStreamEvent = Record<string, any>;
type ClaudeToolArgs = Record<string, any>;
/** One Stella or native tool call a step started, for side-effect reconciliation. */
type McpCallRecord = {
  toolCallId: string;
  toolName: string;
  status: "started" | "completed";
  argsSummary: string;
  outcomeSummary?: string;
};
type ClaudeToolUseTruncation = {
  toolCallId: string;
  toolName: string;
  toolArgs: ClaudeToolArgs;
  stopReason: string;
  category?: string;
  explanation?: string;
};
type ClaudeCodeStatusChange = {
  state: "running" | "compacting" | "model-fallback";
  text: string;
};
type ClaudeCodeImage = { mimeType: string; data: string };
type ClaudeCodeUsage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};
type ClaudeCodeStepResult = {
  message: string;
  sessionId: string;
  usage: ClaudeCodeUsage | undefined;
  delivered?: boolean;
};
export type ClaudeCodeTurnResult = {
  text: string;
  sessionId: string;
  usage: ClaudeCodeUsage | undefined;
  delivered?: true;
};
type ClaudeCodeInjectInput = {
  text: string;
  images?: ClaudeCodeImage[];
  onConsumed?: () => void;
  onDropped?: () => void;
};
/**
 * Callbacks use method syntax so callers may declare narrower argument
 * shapes for what they read.
 */
export type ClaudeCodeTurnRequest = {
  runId?: string;
  sessionKey: string;
  persistedSessionId?: string;
  modelId: string;
  stellaAppDir?: string;
  shellEnv?: Record<string, string>;
  cliBridgeSocketPath?: string;
  vanilla?: boolean;
  effortLevel?: string;
  prompt: string;
  resumeFallbackPrompt?: string;
  systemPrompt?: string;
  cwd?: string;
  attachments?: readonly { url: string; mimeType?: string }[];
  tools: readonly ToolMetadata[];
  nativeTools?: readonly string[];
  autoCompactWindowTokens?: number;
  autoCompactTriggerPct?: number;
  abortSignal?: AbortSignal;
  executeTool(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ): Promise<ToolResult>;
  onToolUpdate?(args: {
    toolCallId: string;
    toolName: string;
    update: ToolResult;
  }): void;
  onToolResponseWritten?(args: {
    toolCallId: string;
    toolName: string;
  }): void | Promise<void>;
  onNativeToolStart?(args: {
    toolCallId: string;
    toolName: string;
    toolArgs: ClaudeToolArgs;
  }): void;
  onNativeToolEnd?(args: {
    toolCallId: string;
    toolName: string;
    result: string;
    isError: boolean;
  }): void;
  onTurnControl?(control: {
    inject: (input: ClaudeCodeInjectInput) => boolean;
  }): (() => void) | undefined;
  onIntermediateResult?(result: ClaudeCodeStepResult): void;
  onSessionId?(sessionId: string): void;
  onStatusChange?(status: ClaudeCodeStatusChange): void;
  onStream?(chunk: string): void;
  onModelRound?(round: { messageId?: string; toolCallCount: number }): void;
  onProtocolInit?(init: {
    tools: string[];
    mcpServers: { name?: string; status?: string }[];
  }): void;
};
type ClaudeCodeInjection = {
  consumed: boolean;
  answered?: boolean;
  dropped?: boolean;
  onConsumed?: () => void;
  onDropped?: () => void;
  text: string;
};
type NativeToolCall = {
  toolName: string;
  toolArgs: ClaudeToolArgs;
  settled?: boolean;
};
/** One prompt written to the CLI and still waiting on its `result` line. */
type PendingStep = {
  request: ClaudeCodeTurnRequest;
  resolve: (result: ClaudeCodeStepResult) => void;
  reject: (error: unknown) => void;
  emitStreamDelta: (event: ClaudeStreamEvent) => void;
  mcpCalls: McpCallRecord[];
  activeNativeToolUseIds: Set<string>;
  nativeToolCalls: Map<string, NativeToolCall>;
  injections: Map<string, ClaudeCodeInjection>;
  hasOutput?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  detachTurnControl?: () => void;
  intermediateResult?: ClaudeCodeStepResult;
  answeredMcpCallCount?: number;
};
type ClaudeCodeChild = ChildProcessByStdio<Writable, Readable, Readable>;
type ClaudeCodeProcessState = {
  child: ClaudeCodeChild;
  stdoutBuffer: string;
  stdoutDecoder: StringDecoder;
  stderrText: string;
  finalSessionId: string;
  pending: PendingStep[];
  closed: boolean;
  compacting: boolean;
  compactionCount: number;
  launchConfig: string;
  claudeConfigDir: string | null;
};
type ClaudeCodeSession = {
  sessionId: string;
  cwd: string | undefined;
  lastUsedAt: number;
  turnCount: number;
  resumeReady: boolean;
  running: boolean;
  queue: {
    request: ClaudeCodeTurnRequest;
    resolve: (result: ClaudeCodeTurnResult) => void;
    reject: (error: unknown) => void;
  }[];
  artifactDir?: string;
  process?: ClaudeCodeProcessState;
  mcpHost?: ClaudeCodeToolMcpHost;
  mcpToolCatalogKey?: string;
  mcpConfigPath?: string;
  activeMcpTurn?: ClaudeCodeToolMcpActiveTurn;
  activeNativeToolUseCorrelator?: ClaudeNativeToolUseCorrelator;
  modelOverride?: string;
  fableSafetyFailures?: number;
  allowEmptyNativeFinal?: boolean;
  /** Set to [] at every turn start, before any step can consume steering. */
  consumedSteeringTexts?: string[];
  modelFallbackNotified?: boolean;
  claudeLoginEmail?: string;
};
type ClaudeCodeError = Error & { code?: string; status?: number };
const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
/**
 * Model the fable fallback policy switches a turn to after the configured
 * fable model exhausts its attempts (matches the stella engine's
 * safety-swap target in provider-abort-containment.ts).
 */
const CLAUDE_CODE_FALLBACK_MODEL = "claude-opus-4-8";
/**
 * CLI error text for a model-side refusal (safety / Usage Policy stop) or
 * an exhausted-overload failure — the two failures where retrying the
 * configured model, then falling back, makes sense. Wording verified
 * against CLI 2.1.32; anything else propagates as a normal turn error.
 */
export const isClaudeCodeModelRefusalOrOverloadError = (message: string) =>
  /unable to respond to this request|usage policy|overloaded/i.test(message);
/**
 * Model aliases the `claude` CLI accepts via `--model` — canonical list in
 * claude-code-resolved-models.ts. `default` is special: it clears any
 * override and runs the recommended model for the account, so we pass no
 * `--model` flag for it and surface the CLI-reported resolved model next
 * to it in pickers when known.
 */
const CLAUDE_CODE_ALIASES = CLAUDE_CODE_MODEL_ALIASES;
const CLAUDE_CODE_ALIAS_LABELS: Record<
  (typeof CLAUDE_CODE_ALIASES)[number],
  { displayName: string; description: string }
> = {
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
// Ceiling while native tool_use blocks are unresolved. Native tools run
// inside the CLI where we cannot cancel just the tool, so this is the only
// bound on a turn whose tool never reports a result — long enough for real
// silent work, finite so a wedged CLI can't hang the session forever.
// (Bridged Stella tools are separately bounded at 10 min by
// executeToolWithInactivityBound; this only backstops native tools and
// leaked tracking.)
const DEFAULT_STEP_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const CLAUDE_CODE_COMPACTING_TEXT = "Compacting context";
const CLAUDE_CODE_RUNNING_TEXT = "Working";
/**
 * Loop breaker for Claude Code's own auto-compaction. A healthy turn compacts
 * at most once; repeated compactions within one Stella turn mean the session
 * context can no longer fit and compaction will keep re-triggering forever.
 * Past this count the session process is killed and the turn restarts on a
 * fresh session seeded from `resumeFallbackPrompt` (the checkpoint-compacted
 * Stella history).
 */
export const MAX_COMPACTIONS_PER_TURN = 3;
const CLAUDE_CODE_COMPACTION_LOOP_MESSAGE =
  "Claude Code entered a compaction loop.";
/**
 * Recovery budget for flaky step endings within one Stella turn. Covers two
 * observed CLI failure shapes:
 *
 * - The CLI process ends (often cleanly, exit code 0) while a step prompt is
 *   still in flight, without ever emitting its `result` line. Recovery
 *   respawns the CLI and resends the same step prompt — `--resume` restores
 *   the on-disk transcript when one exists, and the missing-resume fallback
 *   reseeds from the checkpoint history otherwise.
 * - The step's `result` arrives without final text. Recovery nudges the
 *   still-live session to restate the answer.
 *
 * Past the budget the turn fails to the caller with an actionable message.
 */
const MAX_STEP_RECOVERIES_PER_TURN = 2;
const summarizeMcpLedgerValue = (value: unknown, maxChars: number) => {
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
/**
 * The CLI process ended (exit, spawn stream teardown) while a step was still
 * waiting on its `result` line. `exitCode` 0 means a clean-but-early exit.
 */
export class ClaudeCodeProcessEndedError extends Error {
  exitCode: number | null;

  mcpCalls: McpCallRecord[];
  constructor(
    message: string,
    exitCode: number | null = null,
    mcpCalls: McpCallRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeProcessEndedError";
    this.exitCode = exitCode;
    this.mcpCalls = mcpCalls;
  }
}
/**
 * The step completed but its `result` payload contained no final text.
 */
export class ClaudeCodeMalformedResultError extends Error {
  kind: "result_error" | "empty_result";

  mcpCalls: McpCallRecord[];
  constructor(
    message: string,
    kind: "result_error" | "empty_result",
    mcpCalls: McpCallRecord[] = [],
  ) {
    super(message);
    this.name = "ClaudeCodeMalformedResultError";
    this.kind = kind;
    this.mcpCalls = mcpCalls;
  }
}
/**
 * The CLI re-compacted past `MAX_COMPACTIONS_PER_TURN` within one Stella
 * turn. Handled inside `executeStepWithMode` (fresh-session
 * reseed), NOT by the step-recovery budget — a reseeded session that loops
 * again fails loudly. Carries the failed step's observed MCP calls so the
 * reseed can reconcile instead of replaying them.
 */
export class ClaudeCodeCompactionLoopError extends Error {
  mcpCalls: McpCallRecord[];
  constructor(mcpCalls: McpCallRecord[] = []) {
    super(CLAUDE_CODE_COMPACTION_LOOP_MESSAGE);
    this.name = "ClaudeCodeCompactionLoopError";
    this.mcpCalls = mcpCalls;
  }
}
/**
 * Which login Claude Code runs on. Stella never holds a Claude credential:
 * the CLI always runs on its own login, in its default config or in the
 * Stella-managed `CLAUDE_CONFIG_DIR` signed in to the owner's active Claude
 * account (the host picks it; `getClaudeCodeConfig`).
 */
const claudeLoginLabel = (email: string | undefined) =>
  email
    ? `the Claude Code login for ${email}`
    : "the Claude Code login on this computer";
/**
 * Pre-flight the login Claude Code will run on, so a caller can say "this
 * will fail, and here is what to do" BEFORE spawning an agent that would 401
 * and die. Only the knowable case: the owner's active Claude account has no
 * Claude Code login on this computer. A login Anthropic rejects is reported
 * when the step fails.
 */
export const checkClaudeCodeAuth = async () => {
  const config = await getClaudeCodeConfig();
  if (config.signedIn) return { status: "ok" };
  return {
    status: "reauth_required",
    message: config.email
      ? `Claude Code isn't signed in to ${config.email} on this computer. Sign in to ${config.email} on this computer in Settings › Account, or pick another Claude account there.`
      : "Claude Code isn't signed in on this computer. Sign in to Claude in Settings › Account.",
  };
};

/**
 * A subscription limit (5-hour or weekly window) in a CLI result, with the
 * reset time when the CLI printed one (`...limit reached|<epoch seconds>`).
 */
export const claudeCodeSubscriptionLimitOf = (
  error: unknown,
): { resetsAt?: number } | null => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    !/usage limit|limit reached|hit your (?:usage )?limit|out of (?:extra )?usage/i.test(
      message,
    )
  ) {
    return null;
  }
  const epoch = /\|(\d{10})\b/.exec(message)?.[1];
  return epoch ? { resetsAt: Number(epoch) * 1000 } : {};
};
/**
 * Anthropic rejected the credential the CLI was given. Distinct from a
 * subscription limit (a 429, checked first by the caller) and from CLI
 * breakage: the process ran, reached the API, and was refused.
 *
 * `OAuth access token has been revoked` and `token_expired`/`token_revoked`
 * are the OAuth 401 codes the CLI prints without an HTTP status, so the text
 * is the only signal. Kept deliberately narrow — "authentication" alone would
 * also match a model asking the user to authenticate to some third-party
 * site, which is not a Stella credential problem.
 */
export const claudeCodeAuthFailureOf = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (claudeCodeSubscriptionLimitOf(error)) return null;
  if (
    !/\bOAuth access token has been revoked\b|\btoken_(?:expired|revoked)\b|\bfailed to authenticate\b|\bauthentication_error\b|\bapi error:?\s*401\b|\b401\s+unauthorized\b|\binvalid bearer token\b|\bnot logged in\b|\bOAuth authentication (?:failed|is currently not supported)\b/i.test(
      message,
    )
  ) {
    return null;
  }
  return { revoked: /revoked|token_revoked/i.test(message) };
};

const asRecoverableStepError = (error: unknown) =>
  error instanceof ClaudeCodeProcessEndedError ||
  error instanceof ClaudeCodeMalformedResultError
    ? error
    : null;
/**
 * Corrective prompt for a malformed step result. The CLI session is still
 * alive and already has the full step context (including any tool result we
 * just forwarded), so the nudge only needs to ask for a well-formed restate.
 */
/**
 * Recovery prompt for a step that died AFTER side-effecting work was already
 * observed. Blind-replaying the original prompt (or the history-seeded
 * `resumeFallbackPrompt`) could re-run those side effects, so the retry must
 * reconcile instead of redo.
 *
 * `referenceContext` is included (framed as reference-only) when the retry
 * lands on a FRESH session that has no transcript — a bare reconciliation
 * directive would otherwise arrive without any task context.
 */
const buildSideEffectReconciliationPrompt = (
  mcpCalls: McpCallRecord[] = [],
  referenceContext?: string,
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
/**
 * Anthropic rejected the login the CLI ran on. Stella holds no credential to
 * refresh, so a human signs that config in again. `code` lets callers (agent
 * retry classification, the orchestrator) treat this as auth rather than
 * re-deriving it from prose.
 */
const withClaudeLoginRejected = (error: unknown, email: string | undefined) => {
  const failure: ClaudeCodeError = new Error(
    `${withPeriod(normalizeErrorMessage(error))} Anthropic rejected ${claudeLoginLabel(email)}. Sign in again in Settings › Account.`,
  );
  failure.code = "CLAUDE_CODE_AUTH_REAUTH_REQUIRED";
  failure.status = 401;
  return failure;
};
/**
 * The shared recovery budget ran out. Auth rejections and usage limits never
 * reach here (they are reported at once), so the CLI is the suspect.
 */
const withStepRecoveryExhausted = (error: unknown) =>
  new Error(
    `${normalizeErrorMessage(error)} Stella retried ${MAX_STEP_RECOVERIES_PER_TURN} time(s) but Claude Code kept ending the step without a usable result. Check the \`claude\` CLI health (\`claude --version\`, login status), then retry the request.`,
  );
/**
 * A Claude subscription usage limit, named as such. Inform only: Stella never
 * switches accounts.
 */
const withClaudeSubscriptionLimitReported = (limit: { resetsAt?: number }) => {
  const resetsAt =
    typeof limit.resetsAt === "number" && Number.isFinite(limit.resetsAt)
      ? new Date(limit.resetsAt)
      : null;
  const failure: ClaudeCodeError = new Error(
    resetsAt
      ? `Claude usage limit reached. It resets at ${resetsAt.toLocaleString()}.`
      : "Claude usage limit reached for this account.",
  );
  failure.code = "CLAUDE_CODE_USAGE_LIMIT";
  return failure;
};
const buildClaudeCodeHookSettings = () => {
  const command = `"${process.execPath}" -e ""`;
  return JSON.stringify({
    // Keep the CLI's built-in workflow/keyword-trigger feature from hijacking
    // sub-agent turns whose prompts merely mention workflow-related keywords.
    workflowKeywordTriggerEnabled: false,
    disableWorkflows: true,
    hooks: {
      PreCompact: [{ hooks: [{ type: "command", command }] }],
      PostCompact: [{ hooks: [{ type: "command", command }] }],
    },
  });
};
const CLAUDE_CODE_HOOK_SETTINGS = buildClaudeCodeHookSettings();
/**
 * Message-level stop reasons that mean the model's stream ended BEFORE the
 * content block it was generating was complete. `refusal` is a mid-stream
 * safety stop (the API cuts generation the moment a classifier fires);
 * `max_tokens` is the output budget running out. In both cases the CLI still
 * repairs the partial `input_json_delta` into syntactically valid JSON and
 * dispatches the tool call, so a half-written string argument arrives here
 * looking exactly like a complete one.
 */
const TRUNCATING_STOP_REASONS = new Set(["refusal", "max_tokens"]);
/**
 * Detects an `assistant` stream event whose trailing content block is a
 * `tool_use` that was cut off mid-generation.
 *
 * The CLI emits one `assistant` event per finalized content block, stamping
 * each with the message-level `stop_reason`. A truncating stop always cuts the
 * block that was in flight, which is the LAST block of the message — so a
 * `tool_use` that is followed by another block completed normally and must not
 * be flagged. Requiring the tool_use to be last keeps this free of false
 * positives on multi-block messages.
 */
export const getClaudeCodeTruncatedToolUseFromStreamEvent = (
  event: ClaudeStreamEvent,
): ClaudeToolUseTruncation | null => {
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
export const describeClaudeToolUseTruncation = (
  truncation: ClaudeToolUseTruncation,
) =>
  `Claude's stream ended with stop_reason "${truncation.stopReason}"` +
  `${truncation.category ? ` (${truncation.category})` : ""} while it was ` +
  `still writing the arguments for \`${truncation.toolName}\`, so those ` +
  `arguments are cut off mid-value.`;
const stableToolArgs = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableToolArgs).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableToolArgs(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
const normalizeClaudeToolName = (toolName: string) =>
  toolName.includes("__")
    ? (toolName.split("__").at(-1) ?? toolName)
    : toolName;
const claudeToolKey = (toolName: string, toolArgs: ClaudeToolArgs) => {
  return crypto
    .createHash("sha256")
    .update(normalizeClaudeToolName(toolName))
    .update("\0")
    .update(stableToolArgs(toolArgs))
    .digest("hex");
};
/**
 * Re-creates the CLI's own repair of a cut-off `input_json_delta` stream:
 * close the string the cursor was inside and every open bracket, so a partial
 * argument blob parses to exactly the object the CLI would dispatch. Returns
 * undefined when no such repair parses — callers must then fail open, never
 * guess.
 */
export const repairPartialToolInputJson = (
  text: string,
): object | undefined => {
  const attempt = (candidate: string): object | undefined => {
    const stack: string[] = [];
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
    // A dangling escape backslash would swallow the closing quote we append.
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
  // A trailing structural fragment (`,`, `:`, or an unfinished bare literal
  // like `tru`) keeps the closers from parsing; strip it and retry once.
  const trimmed = text.replace(/[\s,]*[A-Za-z0-9+\-.]*[\s,]*$/, "");
  if (trimmed && trimmed !== text) return attempt(trimmed);
  return undefined;
};
/**
 * How long an inbound MCP call waits for the finalized `assistant` event that
 * carries its `stop_reason` before giving up and running anyway.
 *
 * The CLI writes that event to stdout immediately before issuing the MCP HTTP
 * call, so in practice the verdict is already recorded and the wait is zero.
 * The ceiling only covers the window where the HTTP request beats the pipe
 * read; it stays modest because the gate FAILS OPEN — an unmatched call must
 * never be delayed or blocked on the strength of missing evidence. (Raised
 * 3x from the original 250ms after live truncations slipped through the
 * fail-open window.)
 */
const TOOL_USE_INTEGRITY_SETTLE_MS = 750;
type StreamingToolBlock = {
  toolCallId: string;
  toolName: string;
  initialInput: ClaudeToolArgs;
  partialJson: string;
};
type ObservedToolUse = {
  toolCallId: string;
  toolName: string;
  toolArgs: ClaudeToolArgs;
};
export const createClaudeNativeToolUseCorrelator = () => {
  const queued = new Map<string, string[]>();
  const waiters = new Map<string, ((id: string) => void)[]>();
  const observedIds = new Set<string>();
  /** Keys of tool_use blocks a finalized assistant event proved truncated. */
  const truncatedKeys = new Map<string, ClaudeToolUseTruncation>();
  /** Keys a finalized assistant event has adjudicated (truncated or clean). */
  const settledKeys = new Set<string>();
  const integrityWaiters = new Map<string, (() => void)[]>();
  const settleKey = (key: string) => {
    settledKeys.add(key);
    const pending = integrityWaiters.get(key);
    integrityWaiters.delete(key);
    for (const resolve of pending ?? []) resolve();
  };
  const streamingBlocks = new Map<number, StreamingToolBlock>();
  /**
   * Blocks whose `content_block_stop` arrived with UNPARSEABLE accumulated
   * JSON — the stream was cut mid-argument (turn abort, process exit,
   * CLI restart) with a stop_reason the finalized-event gate never sees. The
   * CLI still repairs and dispatches such calls; keep the raw partials so the
   * integrity gate can match the dispatched args against their repair.
   */
  const interruptedBlocks: StreamingToolBlock[] = [];
  const MAX_INTERRUPTED_BLOCKS = 16;
  const recordInterruptedBlock = (pending: StreamingToolBlock) => {
    interruptedBlocks.push(pending);
    if (interruptedBlocks.length > MAX_INTERRUPTED_BLOCKS) {
      interruptedBlocks.shift();
    }
  };
  /**
   * Truncation verdict from raw stream evidence, for calls no finalized
   * assistant event adjudicated. A block whose accumulated partial JSON does
   * NOT parse as-is, but whose repaired form matches the inbound call's args
   * exactly, proves the CLI dispatched a repaired half-written call. Blocks
   * whose raw JSON already parses are complete — a call matching one is just
   * the benign pipe-read race and must stay fail-open.
   */
  const findInterruptedTruncation = (
    toolName: string,
    key: string,
  ): ClaudeToolUseTruncation | undefined => {
    const normalizedName = normalizeClaudeToolName(toolName);
    for (const pending of [...streamingBlocks.values(), ...interruptedBlocks]) {
      if (normalizeClaudeToolName(pending.toolName) !== normalizedName) {
        continue;
      }
      if (!pending.partialJson.trim()) continue;
      try {
        JSON.parse(pending.partialJson);
        continue; // Complete args; never refuse on the settle race.
      } catch {
        // Unparseable partial: candidate for a repaired dispatch.
      }
      const repaired = asObject(
        repairPartialToolInputJson(pending.partialJson),
      );
      if (!repaired) continue;
      if (claudeToolKey(pending.toolName, repaired) !== key) continue;
      return {
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        toolArgs: repaired,
        stopReason: "stream_interrupted",
        explanation:
          "the stream was cut off (turn abort or process exit) before these arguments finished streaming",
      };
    }
    return undefined;
  };

  const observe = (args: ObservedToolUse) => {
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
    /**
     * Records the integrity verdict a finalized `assistant` event carries for
     * the tool_use blocks it contains. Returns the truncation when this event
     * proved one, so the caller can also surface it to the user (the call may
     * already be executing, in which case the gate below cannot stop it).
     */
    observeAssistantMessage(event: ClaudeStreamEvent) {
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
    /**
     * Verdict for an inbound MCP call: the truncation that cut its arguments,
     * or undefined when the arguments are whole OR when no finalized event
     * arrived in time to say. Fails open by design — see the settle constant.
     */
    async resolveToolUseIntegrity(
      toolName: string,
      toolArgs: ClaudeToolArgs,
      signal?: AbortSignal,
      timeoutMs = TOOL_USE_INTEGRITY_SETTLE_MS,
    ) {
      const key = claudeToolKey(toolName, toolArgs);
      if (!settledKeys.has(key)) {
        await new Promise<void>((resolve) => {
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
      // No finalized-event verdict. Before failing open, check the raw stream
      // evidence: an interrupted turn (abort/process exit) never
      // emits a `refusal`/`max_tokens` assistant event, yet the CLI still
      // repairs the half-streamed arguments and dispatches the call. Matching
      // the inbound args against a repaired unfinished block catches exactly
      // that case — LOUD refusal instead of silently executing clipped args.
      if (!settledKeys.has(key)) {
        return findInterruptedTruncation(toolName, key);
      }
      return undefined;
    },
    observeStreamEvent(event: ClaudeStreamEvent) {
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
          // Malformed accumulated JSON at block stop means the stream was cut
          // mid-argument. Never bind an MCP mutation to it — but retain the
          // partial so the integrity gate can refuse the repaired call the
          // CLI dispatches for it.
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
    async claim(
      toolName: string,
      toolArgs: ClaudeToolArgs,
      signal: AbortSignal,
    ): Promise<string> {
      const key = claudeToolKey(toolName, toolArgs);
      const existing = queued.get(key)?.shift();
      if (existing) return existing;
      return await new Promise<string>((resolve, reject) => {
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
        const onObserved = (id: string) => {
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
type ClaudeNativeToolUseCorrelator = ReturnType<
  typeof createClaudeNativeToolUseCorrelator
>;
const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const withPeriod = (text: string) => (/[.!?]$/u.test(text) ? text : `${text}.`);
const normalizeErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
};
const textArrayMessage = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
};
const isSessionAlreadyInUseError = (message: string) =>
  /Session ID .* is already in use\./i.test(message);
const isMissingResumeSessionError = (message: string) =>
  /No conversation found with session ID:/i.test(message);
const configuredTimeoutMs = (envName: string, fallbackMs: number) => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};
/**
 * True only when the child has actually terminated. `child.killed` must
 * NOT be used for ladder guards: it flips true as soon as any signal was
 * SENT, which previously made every later rung unreachable — after the
 * SIGINT in `abortProcess`, neither SIGTERM nor SIGKILL could ever fire,
 * so a signal-ignoring CLI survived cancellation.
 */
const processIsDead = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;
const killProcess = (child: ChildProcess) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may have already exited.
  }
  const sigkillTimer = setTimeout(() => {
    if (processIsDead(child)) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }, SIGKILL_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(sigkillTimer));
};
const abortProcess = (child: ChildProcess) => {
  if (processIsDead(child)) return;
  try {
    child.kill("SIGINT");
  } catch {
    // Ignore and fall through to SIGTERM/SIGKILL.
  }
  setTimeout(() => {
    killProcess(child);
  }, SIGTERM_TIMEOUT_MS);
};
const parseClaudeCodeModel = (modelId: string) => {
  const normalized = modelId.trim();
  if (!normalized.startsWith(CLAUDE_CODE_MODEL_PREFIX)) return undefined;
  const suffix = normalized.slice(CLAUDE_CODE_MODEL_PREFIX.length).trim();
  if (!suffix || suffix === "default") return undefined;
  return suffix;
};
const mimeExtension = (mimeType: string) => {
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
const parseDataUrlAttachment = (attachment: {
  url: string;
  mimeType?: string;
}) => {
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
const ensureArtifactDir = (session: ClaudeCodeSession) => {
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
const materializeAttachments = (
  session: ClaudeCodeSession,
  attachments: ClaudeCodeTurnRequest["attachments"],
) => {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const artifactDir = ensureArtifactDir(session);
  const notes: string[] = [];
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
const buildInitialPrompt = (
  session: ClaudeCodeSession,
  request: ClaudeCodeTurnRequest,
) => {
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
const normalizeNativeTools = (nativeTools: unknown): string[] =>
  Array.isArray(nativeTools)
    ? [
        ...new Set(
          nativeTools
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ]
    : [];
export const buildClaudeCodeNativeToolRuntimePrompt = (
  systemPrompt: string | undefined,
  nativeTools: readonly string[] = [],
) => {
  const enabled = normalizeNativeTools(nativeTools);
  return [
    systemPrompt?.trim() ?? "",
    enabled.length > 0
      ? `Your Claude Code built-in tools for this session are ${enabled.join(", ")}; use them for files and ${enabled.includes("Bash") ? "shell commands" : "searches"}. Other built-ins are disabled. Use the available Stella tools for everything else and answer the user normally when finished.`
      : "Claude Code built-in tools are disabled for this session. Use the available Stella tools when needed and answer the user normally when finished.",
    "If you successfully call NoResponse and have nothing else to say, finish without adding a user-visible response.",
    "Never mention MCP, missing Claude tools, or the raw tool protocol to the user.",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
};
/** Text of one stream-json `tool_result` block, for Stella's own journal. */
const nativeToolResultText = (block: ClaudeStreamEvent | null) => {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const part = asObject(raw);
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};
/**
 * Mirror the CLI's own built-in tool calls into Stella's tool events. Native
 * calls never pass through the MCP host, so without this the journal, the
 * working indicator, and crash-recovery reconciliation would not know a
 * Bash or Edit ran. Returns true when the event announced or settled a
 * native call.
 */
const observeNativeToolCalls = (
  event: ClaudeStreamEvent,
  pending: PendingStep,
) => {
  const content = asObject(event.message)?.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  if (event.type === "assistant") {
    for (const raw of content) {
      const block = asObject(raw);
      if (
        block?.type !== "tool_use" ||
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        block.name.startsWith("mcp__") ||
        pending.nativeToolCalls.has(block.id)
      ) {
        continue;
      }
      const toolArgs = asObject(block.input) ?? {};
      pending.nativeToolCalls.set(block.id, { toolName: block.name, toolArgs });
      pending.mcpCalls.push({
        toolCallId: block.id,
        toolName: block.name,
        status: "started",
        argsSummary: summarizeMcpLedgerValue(toolArgs, 4_000),
      });
      changed = true;
      try {
        pending.request.onNativeToolStart?.({
          toolCallId: block.id,
          toolName: block.name,
          toolArgs,
        });
      } catch {
        // Journal observers must never disrupt the engine stream.
      }
    }
    return changed;
  }
  if (event.type !== "user") return false;
  for (const raw of content) {
    const block = asObject(raw);
    if (
      block?.type !== "tool_result" ||
      typeof block.tool_use_id !== "string"
    ) {
      continue;
    }
    const call = pending.nativeToolCalls.get(block.tool_use_id);
    if (!call || call.settled) continue;
    call.settled = true;
    const text = nativeToolResultText(block);
    const isError = block.is_error === true;
    const record = pending.mcpCalls.find(
      (entry) => entry.toolCallId === block.tool_use_id,
    );
    if (record) {
      record.status = "completed";
      record.outcomeSummary = summarizeMcpLedgerValue(
        isError ? { error: text } : { result: text },
        6_000,
      );
    }
    changed = true;
    try {
      pending.request.onNativeToolEnd?.({
        toolCallId: block.tool_use_id,
        toolName: call.toolName,
        result: text,
        isError,
      });
    } catch {
      // Journal observers must never disrupt the engine stream.
    }
  }
  return changed;
};
/**
 * One stream-json user line. Claude Code's stream-json input accepts Anthropic
 * image content blocks directly, so screenshots reach vision without enabling
 * any Claude-native file or shell tools outside Stella's tool boundary.
 */
const buildStreamJsonUserMessage = (
  sessionId: string,
  text: string,
  images: ClaudeCodeImage[],
  uuid?: string,
) =>
  JSON.stringify({
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content:
        images.length > 0
          ? [
              { type: "text", text },
              ...images.map((image) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mimeType,
                  data: image.data,
                },
              })),
            ]
          : text,
    },
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
  });
const asObject = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
/**
 * Hand steering back to the host newest-first, so its prepends keep the
 * original order.
 */
const dropInjections = (
  pending: PendingStep,
  shouldDrop: (injection: ClaudeCodeInjection) => boolean,
) => {
  for (const injection of [...(pending.injections?.values() ?? [])].reverse()) {
    if (injection.dropped || !shouldDrop(injection)) continue;
    injection.dropped = true;
    try {
      injection.onDropped?.();
    } catch {
      // A host-side steering observer must not break the engine turn.
    }
  }
};
/**
 * A fresh session seeded from the turn's history must still see the steering
 * the lost session had already taken in this turn.
 */
const withConsumedSteering = (session: ClaudeCodeSession, prompt: string) =>
  session.consumedSteeringTexts?.length
    ? [prompt, ...session.consumedSteeringTexts].join("\n\n")
    : prompt;
const hasUnconsumedInjection = (pending: PendingStep) => {
  for (const injection of pending.injections?.values() ?? []) {
    if (!injection.consumed) return true;
  }
  return false;
};
const parseStreamJsonLine = (line: string): ClaudeStreamEvent | null => {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};
export const getClaudeCodeTextDeltaFromStreamEvent = (
  event: ClaudeStreamEvent,
): string | null => {
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

const updateClaudeCodeNativeToolActivity = (
  event: ClaudeStreamEvent,
  activeToolUseIds: Set<string>,
) => {
  const before = activeToolUseIds.size;
  const updateFromContent = (content: unknown) => {
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
const observeFinalizedClaudeToolUses = (
  event: ClaudeStreamEvent,
  observe: ((args: ObservedToolUse) => void) | undefined,
) => {
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
const mergeMcpCalls = (
  target: McpCallRecord[],
  records: readonly McpCallRecord[] | undefined,
) => {
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
export const createClaudeCodeStreamEmitter = (
  onStream: ((chunk: string) => void) | undefined,
) => {
  let lastVisibleChar = "";
  let boundaryPending = false;
  return (event: ClaudeStreamEvent) => {
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
export const getClaudeCodeStatusChangeFromStreamEvent = (
  event: ClaudeStreamEvent,
): ClaudeCodeStatusChange | null => {
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
  if (type === "system" && subtype === "compact_boundary") {
    return {
      state: "running",
      text: CLAUDE_CODE_RUNNING_TEXT,
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
/** Diagnostic boundary: one finalized Claude assistant message is one model round. */
export const getClaudeCodeModelRoundFromStreamEvent = (
  event: ClaudeStreamEvent,
) => {
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
/**
 * The CLI has no structured event for a model fallback — it announces it as
 * a `system`/`informational` message with exactly this content (verified
 * against the CLI bundle: `Model fallback triggered: switching from ${X} to
 * ${Y}`). Text match is brittle across CLI versions by nature; if the
 * wording drops the model ids we still detect the switch and fall back to
 * generic labels.
 */
const CLAUDE_CODE_MODEL_FALLBACK_RE =
  /^Model fallback triggered(?::? switching from (\S+) to (\S+))?/;
/**
 * Detect the CLI's model-fallback announcement on the stream. When the
 * configured model errors as overloaded (529) and a `--fallback-model` is
 * in play (e.g. from the user's own CLI settings — we don't pass one; our
 * fable fallback policy lives in `applyFableFallbackPolicy`), the CLI
 * stickily switches the session's main-loop model to the fallback for the
 * rest of the session — the model actually answering is no longer the
 * configured one. We surface that switch as a visible toast,
 * pretty-printing the from/to ids parsed out of the message. Returns null
 * for any other event.
 */
export const getClaudeCodeModelFallbackFromStreamEvent = (
  event: ClaudeStreamEvent,
) => {
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
const cleanupSessionArtifacts = (session: ClaudeCodeSession) => {
  if (!session.artifactDir) {
    return;
  }
  try {
    fs.rmSync(session.artifactDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
  session.artifactDir = undefined;
};
const resetSessionMcpClients = (
  session: ClaudeCodeSession,
  reason: unknown,
) => {
  void session.mcpHost?.resetClientSessions(reason).catch(() => {
    // Process teardown must continue even if a stale transport resists close.
  });
};
const cleanupSessionProcess = (session: ClaudeCodeSession) => {
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
const cleanupSessionMcpHost = (session: ClaudeCodeSession) => {
  const host = session.mcpHost;
  session.mcpHost = undefined;
  session.mcpToolCatalogKey = undefined;
  session.mcpConfigPath = undefined;
  session.activeMcpTurn = undefined;
  if (host) {
    void host.close().catch(() => {
      // The private loopback listener is best-effort cleanup on teardown.
    });
  }
};
const ensureSessionState = (
  sessions: Map<string, ClaudeCodeSession>,
  request: ClaudeCodeTurnRequest,
  sessionKey: string,
  cwd: string | undefined,
): ClaudeCodeSession => {
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
    const replacement: ClaudeCodeSession = {
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
  const created: ClaudeCodeSession = {
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
  sessions = new Map<string, ClaudeCodeSession>();
  activeProcesses = new Map<string, ChildProcess>();
  closeWhenIdle = new Set<string>();
  idleCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
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
    return await new Promise<ClaudeCodeTurnResult>((resolve, reject) => {
      session.queue.push({ request, resolve, reject });
      this.pumpSession(request.sessionKey, session);
    });
  }
  /**
   * Diagnostic/test hook: whether a live CLI child is tracked for the
   * session key. Guards against restart races where a stale close handler
   * would otherwise evict the replacement child from tracking.
   */
  hasActiveProcess(sessionKey: string) {
    const child = this.activeProcesses.get(sessionKey);
    return Boolean(child && !child.killed && child.exitCode === null);
  }
  resumableSessionId(sessionKey: string, cwd: string | undefined) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.resumeReady) {
      return undefined;
    }
    const normalizedCwd = cwd?.trim() || undefined;
    if (session.cwd !== normalizedCwd) {
      return undefined;
    }
    return session.sessionId;
  }
  closeSessionWhenIdle(sessionKey: string) {
    this.clearIdleCloseTimer(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (session.running || session.queue.length > 0) {
      this.closeWhenIdle.add(sessionKey);
      return;
    }
    this.closeSession(sessionKey, session);
  }
  scheduleSessionCloseWhenIdle(sessionKey: string, timeoutMs: number) {
    this.clearIdleCloseTimer(sessionKey);
    const timer = setTimeout(
      () => this.closeSessionWhenIdle(sessionKey),
      Math.max(1_000, timeoutMs),
    );
    timer.unref?.();
    this.idleCloseTimers.set(sessionKey, timer);
  }
  clearIdleCloseTimer(sessionKey: string) {
    const timer = this.idleCloseTimers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.idleCloseTimers.delete(sessionKey);
  }
  closeSession(sessionKey: string, session: ClaudeCodeSession) {
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
  pumpSession(sessionKey: string, session: ClaudeCodeSession) {
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
  async executeTurn(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
  ): Promise<ClaudeCodeTurnResult> {
    // Vanilla mode sends the prompt to stock Claude Code untouched: no
    // Stella runtime contract, no system-prompt override.
    const effectiveSystemPrompt = request.vanilla
      ? ""
      : buildClaudeCodeNativeToolRuntimePrompt(
          request.systemPrompt,
          request.nativeTools,
        );
    const prompt = buildInitialPrompt(session, request);
    // Every user message reattempts the configured model: a fallback from a
    // previous turn does not stick to the session. The next
    // ensureStreamingProcess sees the config change and restarts the CLI on
    // the configured model with --resume.
    session.modelOverride = undefined;
    session.fableSafetyFailures = 0;
    session.allowEmptyNativeFinal = false;
    session.consumedSteeringTexts = [];
    // The compaction loop breaker counts per Stella turn.
    if (session.process) {
      session.process.compacting = false;
      session.process.compactionCount = 0;
    }
    if (!request.vanilla) {
      const nativeToolUseCorrelator = createClaudeNativeToolUseCorrelator();
      session.activeNativeToolUseCorrelator = nativeToolUseCorrelator;
      session.activeMcpTurn = {
        // The persisted Claude session is the conversation boundary. Native
        // tool_use.id distinguishes invocations within it; Stella run IDs can
        // change during crash recovery and must not alter replay identity.
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
          const callRecord: McpCallRecord = {
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
        ...(response.delivered ? { delivered: true } : {}),
      };
    } finally {
      session.activeMcpTurn = undefined;
      session.allowEmptyNativeFinal = false;
    }
  }
  /**
   * Run one Claude Code turn, absorbing recoverable CLI flakiness within the
   * turn's shared recovery budget:
   *
   * - `process_ended`: the CLI died (or exited cleanly) before delivering the
   *   step's result. Respawn and resend the same prompt; the spawn path
   *   resumes the persisted transcript when possible and otherwise falls back
   *   to reseeding from `resumeFallbackPrompt`. If the failed attempt had
   *   already made MCP calls, the retry switches to a non-mutating
   *   reconciliation prompt so those side effects are never replayed.
   * - `malformed_result`: the CLI answered without final text. The session
   *   process is still alive with full context, so send a corrective nudge.
   *
   * Aborted runs never retry; exhausted budgets rethrow with an actionable
   * message.
   */
  async executeStepWithRecovery(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: ClaudeCodeImage[],
    recoveryBudget: { remaining: number },
  ): Promise<ClaudeCodeStepResult> {
    let currentPrompt = prompt;
    let currentPromptImages = promptImages;
    const failedAttemptMcpCalls: McpCallRecord[] = [];

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
        // A usage limit or a rejected login: report it, never switch
        // accounts or retry. Detection is the CLI's own wording.
        const limit = claudeCodeSubscriptionLimitOf(error);
        if (limit) {
          throw withClaudeSubscriptionLimitReported(limit);
        }
        if (claudeCodeAuthFailureOf(error)) {
          throw withClaudeLoginRejected(error, session.claudeLoginEmail);
        }

        // A normal refusal/overload can retry the configured model and then
        // fall back. Once any tool call started, the same prompt is never
        // replayed: even an aborted/errored call may already have committed.
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
          ? buildSideEffectReconciliationPrompt(failedAttemptMcpCalls)
          : buildResultRetryPrompt();
        currentPromptImages = [];
      }
    }
  }
  /**
   * Fable refusal/overload policy, mirroring the stella engine's safety
   * swap: give the configured fable model SAFETY_ABORT_FABLE_ATTEMPTS
   * consecutive attempts at the failing step, then switch the REST OF THIS
   * TURN to CLAUDE_CODE_FALLBACK_MODEL via `session.modelOverride` (the
   * next ensureStreamingProcess sees the config change and restarts on the
   * fallback with --resume, keeping the CLI conversation). executeTurn
   * clears the override at every turn start, so each new user message
   * reattempts fable. Returns true when the caller should resend the same
   * prompt; false when the policy doesn't apply (including a failure on the
   * fallback itself) and the error should propagate.
   */
  applyFableFallbackPolicy(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    error: unknown,
  ) {
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
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    promptImages: ClaudeCodeImage[],
    observedMcpCalls: McpCallRecord[] = [],
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
  /**
   * `observedMcpCalls` carries side effects already applied by earlier
   * attempts of THIS step. Every reseed path below (missing resume,
   * compaction loop) must honor it: once side effects are known, the reseed
   * prompt is the reconciliation prompt — never `resumeFallbackPrompt`,
   * whose history+request would replay them on the fresh session.
   */
  async executeStepWithMode(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    prompt: string,
    useResume: boolean,
    allowCompactionLoopRestart = true,
    promptImages: ClaudeCodeImage[] = [],
    observedMcpCalls: McpCallRecord[] = [],
  ): Promise<ClaudeCodeStepResult> {
    const buildReseedPrompt = (mcpCalls: McpCallRecord[]) => {
      // Read at recovery time: steering consumed during the failed attempt
      // must reach the fresh session too.
      const reseedBase = withConsumedSteering(
        session,
        request.resumeFallbackPrompt ?? prompt,
      );
      return mcpCalls.length > 0
        ? buildSideEffectReconciliationPrompt(mcpCalls, reseedBase)
        : reseedBase;
    };
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
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    useResume: boolean,
    mcpHost: ClaudeCodeToolMcpHost | undefined,
  ) {
    // A turn-scoped fallback override (fable exhausted its attempts) beats
    // the configured model; executeTurn clears it at every turn start.
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
      "--replay-user-messages",
      "--settings",
      CLAUDE_CODE_HOOK_SETTINGS,
    ];
    if (!request.vanilla) {
      if (!mcpHost || !session.mcpConfigPath) {
        throw new Error("Claude Code native tool host is unavailable.");
      }
      // Native takeover: Claude owns the tool loop. Only the built-ins the
      // caller asked for stay on (file and shell tools that are far cheaper
      // in-process than over MCP; none for a bare catalog); every other
      // built-in and all ambient/user MCP servers remain disabled, so besides
      // those the run-private, token-authenticated Stella server is all
      // that is visible.
      const nativeTools = normalizeNativeTools(request.nativeTools);
      const allowedTools = [
        ...nativeTools,
        ...request.tools.map((tool) => `mcp__stella__${tool.name}`),
      ].join(",");
      args.push(
        "--strict-mcp-config",
        "--mcp-config",
        session.mcpConfigPath,
        "--disable-slash-commands",
        "--tools",
        [...nativeTools, "mcp__stella__*"].join(","),
        "--allowedTools",
        allowedTools,
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
  buildProcessLaunchConfig(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    mcpHost: ClaudeCodeToolMcpHost | undefined,
  ) {
    return JSON.stringify([
      session.modelOverride ?? parseClaudeCodeModel(request.modelId) ?? "",
      request.effortLevel?.trim() ?? "",
      Boolean(request.vanilla),
      mcpHost?.toolCatalogHash ?? "",
      normalizeNativeTools(request.nativeTools),
      effectiveSystemPrompt.trim(),
      request.autoCompactWindowTokens ?? null,
      request.autoCompactTriggerPct ?? null,
      request.cliBridgeSocketPath ?? "",
    ]);
  }
  async ensureMcpHost(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
  ): Promise<ClaudeCodeToolMcpHost | undefined> {
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
    // A process spawned against the old immutable catalog cannot be pointed
    // at a replacement listener in place. Stop it before rotating the host;
    // the caller resumes the same Claude conversation on the new process.
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
    // writeFile's mode does not tighten an existing path after host rotation.
    fs.chmodSync(session.mcpConfigPath, 0o600);
    return session.mcpHost;
  }
  async ensureStreamingProcess(
    session: ClaudeCodeSession,
    request: ClaudeCodeTurnRequest,
    effectiveSystemPrompt: string,
    useResume: boolean,
  ): Promise<ClaudeCodeProcessState> {
    const mcpHost = await this.ensureMcpHost(session, request);
    const launchConfig = this.buildProcessLaunchConfig(
      session,
      request,
      effectiveSystemPrompt,
      mcpHost,
    );
    // The config the owner's active Claude account is signed in to here
    // (null: the CLI's default config). A change restarts the process.
    const claudeConfig = await getClaudeCodeConfig();
    const claudeConfigDir = claudeConfig.configDir ?? null;
    if (
      session.process &&
      !session.process.closed &&
      // Dying-process fence: a child that has been signaled (`killed` is
      // "signal sent") or already terminated must never take new prompts —
      // a late reuse would write into a process the kill ladder is tearing
      // down. Its exit handler rejects the pendings and clears
      // `session.process`; respawning below (same resume id) is the
      // correct successor.
      !session.process.child.killed &&
      !processIsDead(session.process.child)
    ) {
      if (
        session.process.launchConfig === launchConfig &&
        session.process.claudeConfigDir === claudeConfigDir
      ) {
        return session.process;
      }
      if (session.process.pending.length > 0) {
        // Prompts are still in flight on the old configuration; swapping
        // now would fail them. Keep the process — the next idle step
        // picks the new configuration up.
        return session.process;
      }
      // The request wants a different CLI configuration (the user changed
      // the model / effort mid-session, or the mode flipped). Restart the
      // process; `useResume` continues the same CLI conversation on the
      // new configuration.
      this.resetStreamingProcess(request.sessionKey, session);
    }
    const executablePath = resolveExternalCliPath("claude");
    const effortLevel = request.effortLevel?.trim();
    const childEnv = buildExternalCliChildEnv(executablePath, process.env, {
      ...(request.cliBridgeSocketPath
        ? { cliBridgeSocketPath: request.cliBridgeSocketPath }
        : {}),
    });
    // Claude Code prefers an API key or an injected token over its own
    // login, so a stray one in the environment would run on something other
    // than the login the user chose. Stella never injects a credential.
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    if (request.shellEnv) Object.assign(childEnv, request.shellEnv);
    if (claudeConfigDir) {
      childEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
    }
    if (effortLevel) {
      childEnv.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
    }
    session.claudeLoginEmail = claudeConfig.email;
    if (
      Number.isFinite(request.autoCompactWindowTokens) &&
      (request.autoCompactWindowTokens ?? 0) > 0
    ) {
      childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.floor(request.autoCompactWindowTokens!),
      );
    }
    if (
      Number.isFinite(request.autoCompactTriggerPct) &&
      (request.autoCompactTriggerPct ?? 0) > 0
    ) {
      childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(
        Math.min(100, Math.max(1, Math.floor(request.autoCompactTriggerPct!))),
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
    const processState: ClaudeCodeProcessState = {
      child,
      stdoutBuffer: "",
      stdoutDecoder: new StringDecoder("utf8"),
      stderrText: "",
      finalSessionId: session.sessionId,
      pending: [],
      closed: false,
      compacting: false,
      compactionCount: 0,
      launchConfig,
      claudeConfigDir,
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
        if (
          typeof parsedLine.session_id === "string" &&
          parsedLine.session_id.trim()
        ) {
          processState.finalSessionId = parsedLine.session_id.trim();
          session.sessionId = processState.finalSessionId;
          session.resumeReady = true;
          request.onSessionId?.(session.sessionId);
        }
        if (parsedLine.type === "user" && parsedLine.isReplay === true) {
          this.noteInjectionConsumed(session, processState, parsedLine.uuid);
          continue;
        }
        // The init event names the model the CLI actually resolved the
        // requested alias to (e.g. default -> claude-opus-4-8[1m]).
        if (
          parsedLine.type === "system" &&
          parsedLine.subtype === "init" &&
          request.onProtocolInit
        ) {
          request.onProtocolInit({
            tools: Array.isArray(parsedLine.tools)
              ? parsedLine.tools.filter(
                  (entry: unknown): entry is string =>
                    typeof entry === "string",
                )
              : [],
            mcpServers: Array.isArray(parsedLine.mcp_servers)
              ? parsedLine.mcp_servers.map((entry: unknown) => {
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
          // Count discrete compactions (compacting -> running transitions),
          // not every compaction-related stream event.
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
        // The CLI switched the session to the --fallback-model (configured
        // model overloaded). The switch is sticky for the session, so
        // surface it once as a heads-up toast (latch on the session so we
        // don't spam).
        const modelFallback =
          getClaudeCodeModelFallbackFromStreamEvent(parsedLine);
        const current = processState.pending[0];
        if (current) {
          const modelRound = getClaudeCodeModelRoundFromStreamEvent(parsedLine);
          if (modelRound) {
            try {
              current.request.onModelRound?.(modelRound);
            } catch {
              // Diagnostic observers must never disrupt the engine stream.
            }
          }
          // Feed the native tool_use correlator. The MCP host consults it for
          // every inbound call (integrity gate, 750ms fail-open settle) and
          // for image_gen's durable identity (5s claim), so an unfed
          // correlator taxes every call and refuses every image_gen.
          const correlator = session.activeNativeToolUseCorrelator;
          if (correlator) {
            observeFinalizedClaudeToolUses(parsedLine, correlator.observe);
            // Record the stop_reason verdict BEFORE the MCP gate can consult
            // it, and shout when a tool call's arguments were cut mid-value.
            // The gate rejects the call when it wins the race with the CLI's
            // HTTP dispatch; this notice makes the loss visible otherwise.
            const truncatedToolUse =
              correlator.observeAssistantMessage(parsedLine);
            if (truncatedToolUse) {
              current.request.onStatusChange?.({
                state: "running",
                text: `⚠ Truncated tool call — ${describeClaudeToolUseTruncation(truncatedToolUse)} Stella blocked or flagged it; the instruction was NOT delivered in full.`,
              });
            }
            correlator.observeStreamEvent(parsedLine);
          }
          if (
            updateClaudeCodeNativeToolActivity(
              parsedLine,
              current.activeNativeToolUseIds,
            )
          ) {
            this.refreshPendingIdleTimer(processState, current);
          }
          if (!current.request.vanilla) {
            observeNativeToolCalls(parsedLine, current);
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
          const current = processState.pending[0];
          if (
            current &&
            parsedLine.is_error !== true &&
            hasUnconsumedInjection(current)
          ) {
            this.reportIntermediateResult(
              session,
              processState,
              current,
              parsedLine,
            );
            continue;
          }
          const completed = processState.pending.shift();
          if (!completed) {
            continue;
          }
          if (hasUnconsumedInjection(completed)) {
            // An error result with steering still waiting on this CLI's stdin.
            // Stop the process before that steering goes back to the host
            // queue, so it can't also run here against the next prompt.
            processState.closed = true;
            if (session.process === processState) {
              this.resetStreamingProcess(request.sessionKey, session);
            }
          }
          this.detachAbortListener(completed);
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
      // A restart may already have registered a replacement child under this
      // session key; only remove OUR child from tracking.
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
      // A restart may already have registered a replacement child under this
      // session key; only remove OUR child from tracking.
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
            : new ClaudeCodeProcessEndedError(message, code, pending.mcpCalls),
        );
      }
    });
    // Claude accepts stdin before it has discovered the private MCP catalog.
    // Do not let the first tool-bearing prompt race that discovery.
    if (mcpHost && request.tools.length > 0) {
      await mcpHost.waitForClientReady(request.abortSignal);
    }
    return processState;
  }
  async sendStreamingPrompt(
    session: ClaudeCodeSession,
    processState: ClaudeCodeProcessState,
    request: ClaudeCodeTurnRequest,
    prompt: string,
    promptImages: ClaudeCodeImage[] = [],
  ): Promise<ClaudeCodeStepResult> {
    if (processState.closed || processState.child.stdin.destroyed) {
      throw new ClaudeCodeProcessEndedError("Claude Code stream is closed.");
    }
    return await new Promise<ClaudeCodeStepResult>((resolve, reject) => {
      const pending: PendingStep = {
        request,
        resolve,
        reject: (error) => {
          // A steering query failed after this turn's own answer was
          // delivered. Every recovery path (respawn, reseed, nudge, model
          // fallback) would resend the original prompt and re-answer it, so
          // recovery here is scoped to the unfinished steering query.
          if (pending.intermediateResult && !request.abortSignal?.aborted) {
            const unfinishedCalls = pending.mcpCalls.slice(
              pending.answeredMcpCallCount,
            );
            if (unfinishedCalls.length === 0) {
              // No Stella tool ran for it yet: settle with that answer and
              // requeue the steering no completed query answered, so it runs
              // next as its own prompt (and meets any persistent error there).
              dropInjections(pending, (injection) => !injection.answered);
              resolve({ ...pending.intermediateResult, delivered: true });
              return;
            }
            // The unfinished steering query already made tool calls. Recovery
            // reconciles it instead of replaying it; only untaken steering
            // requeues.
            dropInjections(pending, (injection) => !injection.consumed);
            if (error instanceof ClaudeCodeCompactionLoopError) {
              reject(new ClaudeCodeCompactionLoopError(unfinishedCalls));
            } else if (error instanceof ClaudeCodeProcessEndedError) {
              reject(
                new ClaudeCodeProcessEndedError(
                  error.message,
                  error.exitCode,
                  unfinishedCalls,
                ),
              );
            } else if (error instanceof ClaudeCodeMalformedResultError) {
              reject(
                new ClaudeCodeMalformedResultError(
                  error.message,
                  error.kind,
                  unfinishedCalls,
                ),
              );
            } else {
              reject(error);
            }
            return;
          }
          reject(error);
        },
        emitStreamDelta: createClaudeCodeStreamEmitter(request.onStream),
        mcpCalls: [],
        activeNativeToolUseIds: new Set(),
        /** Built-in tool calls seen on the stream, keyed by tool_use id. */
        nativeToolCalls: new Map(),
        injections: new Map(),
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
      const payload = buildStreamJsonUserMessage(
        session.sessionId,
        prompt,
        promptImages,
      );
      processState.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        const index = processState.pending.indexOf(pending);
        if (index >= 0) {
          processState.pending.splice(index, 1);
        }
        this.detachAbortListener(pending);
        // A failed stdin write means the process died under us (EPIPE);
        // classify it as process-ended so the step recovery can respawn.
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
            inject: (input) =>
              this.injectIntoPendingTurn(session, processState, pending, input),
          });
        } catch {
          // A host-side steering observer must not break the engine turn.
        }
      }
    });
  }
  detachAbortListener(pending: PendingStep) {
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
    // The turn ended without the CLI taking these in (abort, process death,
    // a recovery restart), so the next prompt or the abnormal-end replies
    // carry them instead.
    dropInjections(pending, (injection) => !injection.consumed);
  }
  /**
   * Write steering input into the query that is still running, the way the
   * interactive CLI handles a message typed mid-turn. Claude Code folds it in
   * at its next tool boundary, or runs it as the next query on this stream if
   * the current one is already answering. `--replay-user-messages` echoes each
   * message back by uuid once the CLI takes it into context, which is what
   * `onConsumed` reports and what keeps this pending open across that extra
   * query. Returns false when the turn can no longer take input, so the caller
   * keeps the message queued for its next prompt instead.
   */
  injectIntoPendingTurn(
    session: ClaudeCodeSession,
    processState: ClaudeCodeProcessState,
    pending: PendingStep,
    input: ClaudeCodeInjectInput,
  ) {
    if (
      processState.closed ||
      processState.child.stdin.destroyed ||
      !processState.pending.includes(pending) ||
      pending.request.abortSignal?.aborted
    ) {
      return false;
    }
    const uuid = crypto.randomUUID();
    pending.injections.set(uuid, {
      consumed: false,
      onConsumed: input.onConsumed,
      onDropped: input.onDropped,
      text: input.text,
    });
    processState.child.stdin.write(
      `${buildStreamJsonUserMessage(
        session.sessionId,
        input.text,
        input.images ?? [],
        uuid,
      )}\n`,
      () => {},
    );
    return true;
  }
  noteInjectionConsumed(
    session: ClaudeCodeSession,
    processState: ClaudeCodeProcessState,
    uuid: unknown,
  ) {
    if (typeof uuid !== "string") return;
    for (const pending of processState.pending) {
      const injection = pending.injections?.get(uuid);
      if (!injection || injection.consumed) continue;
      injection.consumed = true;
      if (injection.text) {
        session.consumedSteeringTexts!.push(injection.text);
      }
      try {
        injection.onConsumed?.();
      } catch {
        // A host-side steering observer must not break the engine turn.
      }
      return;
    }
  }
  /**
   * The query ended while steering input was still waiting in the CLI, which
   * now runs it as the next query on this stream. The pending turn stays open
   * for that query's result; this answer is handed to the host as its own
   * reply.
   */
  reportIntermediateResult(
    session: ClaudeCodeSession,
    processState: ClaudeCodeProcessState,
    pending: PendingStep,
    parsedLine: ClaudeStreamEvent,
  ) {
    let stepResult: ClaudeCodeStepResult;
    try {
      stepResult = this.parseResultPayload(
        session,
        parsedLine,
        processState.stderrText,
        true,
      );
    } catch {
      return;
    }
    // Every query that took steering in so far has now been answered.
    for (const injection of pending.injections.values()) {
      if (injection.consumed) injection.answered = true;
    }
    pending.answeredMcpCallCount = pending.mcpCalls.length;
    pending.intermediateResult = stepResult;
    if (!stepResult.message) return;
    try {
      pending.request.onIntermediateResult?.(stepResult);
    } catch {
      // A host-side steering observer must not break the engine turn.
    }
  }
  refreshPendingIdleTimer(
    processState: ClaudeCodeProcessState,
    pending: PendingStep,
  ) {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
    }
    pending.idleTimer = undefined;
    // Vanilla Claude Code runs native tools inside the CLI. Their stream-json
    // lifecycle is edge-triggered, so a silent Bash/Task invocation is still
    // confirmed live work and must not be mistaken for a dead output stream.
    // We cannot cancel an individual native tool from out here, so instead of
    // disarming entirely (an unresolved tool_use would hang the session
    // forever), arm the watchdog with the much longer tool ceiling.
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
  parseResultPayload(
    session: ClaudeCodeSession,
    parsed: ClaudeStreamEvent,
    stderrText: string,
    allowEmptyFinal = false,
  ): ClaudeCodeStepResult {
    let resultError: string | undefined;
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
  /**
   * Kill a session process stuck in a compaction loop and fail its in-flight
   * prompts with a recognizable error so `executeStepWithMode` can
   * restart the turn on a fresh session seeded from the checkpoint history.
   */
  failCompactionLoop(
    sessionKey: string,
    session: ClaudeCodeSession,
    processState: ClaudeCodeProcessState,
  ) {
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
      // Typed: the reseed path must know which MCP calls this step already
      // made so it reconciles instead of replaying them.
      pending.reject(new ClaudeCodeCompactionLoopError(pending.mcpCalls));
    }
  }
  resetStreamingProcess(sessionKey: string, session: ClaudeCodeSession) {
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
export const isClaudeCodeModel = (modelId: string) =>
  modelId.trim().startsWith(CLAUDE_CODE_MODEL_PREFIX);
export const runClaudeCodeTurn = async (request: ClaudeCodeTurnRequest) =>
  await runtime.runTurn(request);
/** Diagnostic/test hook: is a live CLI process tracked for this session key? */
export const claudeCodeSessionHasActiveProcess = (sessionKey: string) =>
  runtime.hasActiveProcess(sessionKey);
export const claudeCodeResumableSessionId = (
  sessionKey: string,
  cwd: string | undefined,
) => runtime.resumableSessionId(sessionKey, cwd);
export const closeClaudeCodeSessionWhenIdle = (sessionKey: string) => {
  runtime.closeSessionWhenIdle(sessionKey);
};
export const scheduleClaudeCodeSessionCloseWhenIdle = (
  sessionKey: string,
  timeoutMs: number,
) => {
  runtime.scheduleSessionCloseWhenIdle(sessionKey, timeoutMs);
};
type ClaudeCodeModelOption = {
  id: string;
  displayName: string;
  description?: string;
  source: "alias" | "anthropic";
};
export const listClaudeCodeModels = async (
  auth: { apiKey?: string } | null | undefined,
  stellaAppDir?: string,
) => {
  const models = new Map<string, ClaudeCodeModelOption>();
  const resolvedModels: Record<string, string> = stellaAppDir
    ? readClaudeCodeResolvedModels(stellaAppDir)
    : {};
  for (const alias of CLAUDE_CODE_ALIASES) {
    const labels = CLAUDE_CODE_ALIAS_LABELS[alias];
    const resolved = resolvedModels[alias];
    models.set(alias, {
      id: alias,
      // Show the CLI-reported real model behind the alias when we've seen
      // one (e.g. "Default · Opus 4.8 (1M context)").
      displayName: resolved
        ? `${labels.displayName} · ${formatClaudeCodeResolvedModel(resolved)}`
        : labels.displayName,
      description: labels.description,
      source: "alias",
    });
  }
  // Only an API key lists the endpoint's models. A subscription sign-in
  // belongs to the Claude Code CLI, so it gets the aliases above.
  const apiKey = auth?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { models: [...models.values()] };
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
    });
    if (!response.ok) return { models: [...models.values()] };
    const parsed = (await response.json()) as {
      data?: { id?: unknown; display_name?: unknown }[];
    };
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
