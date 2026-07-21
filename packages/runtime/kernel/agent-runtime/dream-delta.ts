/**
 * Deterministic orchestrator-delta projection for Dream's staged shadow path.
 * It reads raw persisted messages, never compaction overlays, and advances a
 * timestamp watermark only through bytes included in the bounded transcript.
 */

import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import { redactMemoryText } from "../memory/redaction.js";
import { parseThreadCheckpoint } from "../thread-runtime.js";

export const DREAM_DELTA_MAX_CHARS = 60_000;
export const DREAM_DELTA_MESSAGE_MAX_CHARS = 4_000;
export const DREAM_DELTA_LOAD_LIMIT = 2_000;

const DELTA_CUSTOM_TYPES = new Set([
  "runtime.task_lifecycle",
  "runtime.task_update",
]);

export type DreamDeltaSourceMessage = {
  timestamp: number;
  role: RuntimeThreadMessage["role"];
  content: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: {
    customType: string;
    content: unknown;
    display: boolean;
    eventId?: string;
  };
};

export type DreamDeltaTranscript = {
  transcript: string;
  includedMessages: number;
  coveredThroughTs: number;
  newestMessageTs: number;
  truncated: boolean;
};

const textFromParts = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: string; mimeType?: string };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image")
        return `[Image: ${block.mimeType ?? "image"}]`;
      return "";
    })
    .join("\n")
    .trim();
};

const assistantText = (
  payload: Extract<PersistedRuntimeThreadPayload, { role: "assistant" }>,
): string =>
  payload.content
    .flatMap((block) =>
      block.type === "text" && block.text.trim() ? [block.text] : [],
    )
    .join("\n\n")
    .trim();

export const formatDeltaEntry = (
  message: DreamDeltaSourceMessage,
): string | null => {
  if (message.role === "user") {
    const raw =
      message.payload?.role === "user"
        ? textFromParts(message.payload.content)
        : message.content;
    const text = redactMemoryText(raw.trim());
    return text ? `[User]\n${text}` : null;
  }
  if (message.role === "assistant") {
    const raw =
      message.payload?.role === "assistant"
        ? assistantText(message.payload)
        : message.content;
    const trimmed = raw.trim();
    if (!trimmed || parseThreadCheckpoint(trimmed) !== null) return null;
    const text = redactMemoryText(trimmed);
    return text ? `[Assistant]\n${text}` : null;
  }
  if (
    message.customMessage &&
    DELTA_CUSTOM_TYPES.has(message.customMessage.customType)
  ) {
    const raw =
      textFromParts(message.customMessage.content) || message.content.trim();
    const text = redactMemoryText(raw);
    if (!text) return null;
    return `${
      message.customMessage.customType === "runtime.task_update"
        ? "[Task update]"
        : "[Task report]"
    }\n${text}`;
  }
  return null;
};

const truncateCodePoints = (value: string, max: number): string => {
  const points = Array.from(value);
  if (points.length <= max) return value;
  const marker = Array.from("\n…[truncated]");
  if (max <= marker.length) return marker.slice(0, Math.max(0, max)).join("");
  return `${points.slice(0, max - marker.length).join("")}${marker.join("")}`;
};

export const buildDreamDeltaTranscript = (
  messages: DreamDeltaSourceMessage[],
  sinceMessageTs: number,
  options?: { maxChars?: number; messageMaxChars?: number },
): DreamDeltaTranscript => {
  const maxChars = Math.max(
    1,
    Math.floor(options?.maxChars ?? DREAM_DELTA_MAX_CHARS),
  );
  const messageMaxChars = Math.min(
    maxChars,
    Math.max(
      1,
      Math.floor(options?.messageMaxChars ?? DREAM_DELTA_MESSAGE_MAX_CHARS),
    ),
  );
  const entries: string[] = [];
  let chars = 0;
  let includedMessages = 0;
  let coveredThroughTs = 0;
  let newestMessageTs = 0;
  let truncated = false;
  let earliestExcludedTs = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (
      !Number.isFinite(message.timestamp) ||
      message.timestamp <= sinceMessageTs
    ) {
      continue;
    }
    const formatted = formatDeltaEntry(message);
    if (formatted === null) continue;
    newestMessageTs = Math.max(newestMessageTs, message.timestamp);
    const entry = truncateCodePoints(formatted, messageMaxChars);
    const entryChars = Array.from(entry).length;
    const separatorChars = includedMessages > 0 ? 2 : 0;
    if (truncated || chars + separatorChars + entryChars > maxChars) {
      truncated = true;
      earliestExcludedTs = Math.min(earliestExcludedTs, message.timestamp);
      continue;
    }
    entries.push(entry);
    chars += separatorChars + entryChars;
    includedMessages += 1;
    coveredThroughTs = Math.max(coveredThroughTs, message.timestamp);
  }
  if (truncated && Number.isFinite(earliestExcludedTs)) {
    coveredThroughTs = Math.min(coveredThroughTs, earliestExcludedTs - 1);
  }
  return {
    transcript: entries.join("\n\n"),
    includedMessages,
    coveredThroughTs,
    newestMessageTs,
    truncated,
  };
};

export const buildDreamShadowSystemPrompt = (): string =>
  [
    "You are Stella's Dream delta derivation running in SHADOW mode.",
    "Derive what durable memory should change from the orchestrator delta. You have no tools and write nothing; your output is diagnostic only.",
    "Prefer user statements over task reports over assistant prose. Do not include secrets or delegated internals absent from a terminal report.",
    "Output sections: ## Proposed MEMORY.md blocks, ## Proposed memory_map updates, ## Derived constraints. Use '- None.' where empty.",
    "If nothing is durable, respond exactly: Nothing to consolidate.",
  ].join("\n\n");

export const buildDreamShadowUserPrompt = (args: {
  transcript: string;
  sinceIso: string;
  alreadyKnown?: string;
}): string =>
  [
    ...(args.alreadyKnown?.trim()
      ? ["ALREADY KNOWN (do not re-propose):", args.alreadyKnown.trim(), ""]
      : []),
    `ORCHESTRATOR DELTA (messages since ${args.sinceIso}):`,
    "",
    args.transcript,
  ].join("\n");

export const SHADOW_LOG_ENTRY_MARKER = "<!-- DREAM:SHADOW_PASS";
export const SHADOW_LOG_MAX_CHARS = 262_144;
const SHADOW_LOG_HEADER = `<!-- memory_shadow.md: staged Dream delta proposals.
Never injected, never searched by Recall, never edited by Dream. -->\n`;

export const shadowWindowIdentity = (args: {
  conversationId: string;
  sinceTs: number;
  coveredThroughTs: number;
}): string =>
  `<!-- DREAM:SHADOW_WINDOW ${encodeURIComponent(args.conversationId)} ${args.sinceTs} ${args.coveredThroughTs} -->`;

export const formatShadowLogEntry = (args: {
  nowIso: string;
  conversationId: string;
  sinceTs: number;
  coveredThroughTs: number;
  includedMessages: number;
  transcriptChars: number;
  truncated: boolean;
  liveMemoryChanged: boolean;
  liveMapChanged: boolean;
  proposal: string;
}): string =>
  [
    `${SHADOW_LOG_ENTRY_MARKER} ${args.nowIso} -->`,
    shadowWindowIdentity(args),
    `## Shadow pass ${args.nowIso}`,
    `- conversation: ${args.conversationId}`,
    `- delta window: ${new Date(args.sinceTs).toISOString()} → ${new Date(args.coveredThroughTs).toISOString()} (${args.includedMessages} messages, ${args.transcriptChars} chars${args.truncated ? ", truncated" : ""})`,
    `- live pass: MEMORY.md ${args.liveMemoryChanged ? "changed" : "unchanged"}, memory_map.md ${args.liveMapChanged ? "changed" : "unchanged"}`,
    "",
    redactMemoryText(args.proposal.trim()),
    "",
  ].join("\n");

export const appendToShadowLog = (
  existing: string | null,
  entry: string,
): string => {
  const base = existing?.startsWith("<!-- memory_shadow.md")
    ? existing
    : `${SHADOW_LOG_HEADER}${existing ?? ""}`;
  let combined = `${base.trimEnd()}\n\n${entry}`;
  while (Array.from(combined).length > SHADOW_LOG_MAX_CHARS) {
    const first = combined.indexOf(SHADOW_LOG_ENTRY_MARKER);
    const second =
      first < 0
        ? -1
        : combined.indexOf(
            SHADOW_LOG_ENTRY_MARKER,
            first + SHADOW_LOG_ENTRY_MARKER.length,
          );
    if (second < 0) {
      const points = Array.from(combined);
      combined = `${SHADOW_LOG_HEADER}${points
        .slice(-(SHADOW_LOG_MAX_CHARS - SHADOW_LOG_HEADER.length))
        .join("")}`;
      break;
    }
    combined = `${combined.slice(0, first)}${combined.slice(second)}`;
  }
  return combined;
};
