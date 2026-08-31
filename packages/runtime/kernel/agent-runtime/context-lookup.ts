import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { HostAppBrowserContextSnapshot } from "@stella/contracts/protocol";
import type { LocalContextEvent } from "../storage/shared.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import {
  sanitizePromptContext,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import type {
  RuntimeStore,
  TranscriptSearchHit,
} from "../storage/runtime-store.js";
import { tokenizeSearchQuery } from "../storage/runtime-store.js";
import { formatDateTimeReminder } from "@stella/contracts/message-timestamp";
import {
  deriveRuntimeThreadLiveState,
  formatRuntimeThreadStatusSuffix,
  runtimeThreadLastActiveAt,
} from "../runtime-threads.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { loadLocalPreferences } from "../preferences/local-preferences.js";
import {
  RecallTelemetryCollector,
  type RecallTelemetryRecord,
  type RecallTelemetrySeed,
  type RecallTelemetrySourceKind,
} from "./recall-telemetry.js";
import type { RecallModelRoute } from "./recall-route.js";
import { resolvedLlmSupportsCredentiallessCalls } from "../model-routing.js";
import type { ResolvedLlmRoute } from "../model-routing.js";

/**
 * Recall's synthesis pass runs at LOW reasoning. Models that expose no
 * reasoning/effort setting get no reasoning param at all (i.e. off/none) — the
 * completion option only carries positive ThinkingLevels, so omitting it is how
 * "off" is expressed on the wire.
 */
export const recallSynthesisReasoning = (
  model: ResolvedLlmRoute["model"],
): "low" | undefined => (model.reasoning === true ? "low" : undefined);

/**
 * Resolve the synthesis credential for a native (in-process) Recall route.
 * Mirrors the utility-route / one-shot contract: only routes that explicitly
 * declare `credentialless` (the `local/` provider, origin-verified proxies)
 * need no key, while every other route must produce one. Returns the key
 * (or undefined for a credentialless route) and throws an actionable error
 * naming the model when a key is genuinely required — never a silent keyless
 * request that would surface as the provider's raw
 * "No API key for provider: …" failure.
 */
export const resolveRecallSynthesisApiKey = async (
  resolvedLlm: ResolvedLlmRoute,
): Promise<string | undefined> => {
  const apiKey = (await resolvedLlm.getApiKey())?.trim();
  if (apiKey) return apiKey;
  if (resolvedLlmSupportsCredentiallessCalls(resolvedLlm)) return undefined;
  throw new Error(
    `Recall synthesis has no usable credential for model "${resolvedLlm.model.provider}/${resolvedLlm.model.id}". Add or repair the matching provider key in Settings → Models (or sign in to Stella) so the lookup can run.`,
  );
};

/** Hard ceiling for assembled Recall evidence, including headings. */
const RECALL_SEED_MAX_CHARS = 12_000;
const SEED_TRUNCATION_MARKER = "\n...[seed section truncated]";
const MAX_MEMORY_SEARCH_TERMS = 12;
const MAX_MEMORY_SEARCH_TERM_CHARS = 120;
const MAX_MEMORY_SEARCH_MATCHES = 40;
const MAX_MEMORY_SEARCH_CONTEXT_LINES = 1;
const MAX_MEMORY_SEARCH_RESULTS_CHARS = 16_000;

/**
 * Hard cap on rendered thread-search results. The candidate pool is EVERY
 * thread ever run (the SQL searches all of them); the query narrows, this
 * cap bounds what a single page renders — never more, regardless of the
 * model-provided limit.
 */
export const MAX_THREAD_SEARCH_RESULTS = 16;

/** Latest live progress phrases surfaced per ACTIVE thread. */
const MAX_LIVE_AGENT_MESSAGES = 3;

type ContextLookupStore = Pick<
  RuntimeStore,
  | "listAgentAssistantMessages"
  | "searchThreads"
  | "searchTranscripts"
  | "listTranscriptNeighbors"
  | "listThreadResultExcerpts"
  | "threadSummaryStore"
>;

/** The one legitimate no-result answer — everything else is an error. */
export const RECALL_NO_MATCH_TEXT = "Nothing relevant found.";
export const isRecallNoMatchBrief = (brief: string): boolean =>
  brief.trim().toLocaleLowerCase().startsWith("nothing relevant found");

export type RecallIntent = "multi_source";

type UnifiedRecallSource =
  | "durable_memory"
  | "delegated_work"
  | "episodic"
  | "live_context";

const extractExactRecallPhrases = (prompt: string): string[] => {
  const phrases = new Set<string>();
  for (const match of prompt.matchAll(/["“]([^"”]{3,})["”]/g)) {
    const phrase = match[1]?.replace(/\s+/g, " ").trim();
    if (phrase) phrases.add(phrase);
  }
  const marker = prompt.match(
    /\b(?:exact (?:phrase|text)|verbatim(?: phrase)?)\s+(.+?)(?:[?.!]|$)/i,
  )?.[1];
  if (marker) {
    const phrase = marker
      .replace(/^["“]|["”]$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (phrase) phrases.add(phrase);
  }
  return [...phrases];
};

const isBareRepoLookup = (prompt: string): boolean => {
  const value = prompt.normalize("NFKC").trim();
  if (!/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?$/i.test(value)) return false;
  return (
    value.includes("/") ||
    value.includes("-") ||
    value.includes(".") ||
    /^stella(?:-v?\d+)?$/i.test(value)
  );
};

/**
 * Failure outcomes get texts DISTINCT from the no-match answer so the
 * orchestrator can tell "searched and found nothing" from "the lookup
 * itself failed" — the latter previously masqueraded as a confident miss.
 */
export const RECALL_EMPTY_BRIEF_TEXT =
  "Recall failed: the model returned an empty brief. This is a lookup failure, NOT evidence that nothing exists — retry with concrete anchors (thread ids, file names, exact phrases).";

export class RecallRetrievalError extends Error {
  override readonly name = "RecallRetrievalError";
}

/**
 * Recall internals go to stderr as JSON lines (the same channel as the
 * working-indicator traces, landing in runtime.log), so a bad answer is
 * reconstructable after the fact: which searches ran, how big each
 * observation was, and how the run ended. Before this, only the final brief
 * was persisted and every miss was undiagnosable.
 *
 * The always-on trace is structural only, so runtime.log never accumulates
 * memory or transcript content.
 */
const logRecallTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  try {
    process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
  } catch {
    // Tracing must never break a lookup.
  }
};

const truncateExact = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= SEED_TRUNCATION_MARKER.length) {
    return SEED_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - SEED_TRUNCATION_MARKER.length)}${SEED_TRUNCATION_MARKER}`;
};

type RecallSeedSection = {
  heading: string;
  intro?: string;
  body: string;
  maxBodyChars: number;
};

/** Deterministically assemble ranked evidence within the Recall input cap. */
const renderCappedRecallSeed = (
  sections: readonly RecallSeedSection[],
  priority: readonly number[],
): string => {
  const emptyBodies = sections.map((section) =>
    [section.heading, ...(section.intro ? [section.intro] : []), ""].join("\n"),
  );
  let remaining = Math.max(
    0,
    RECALL_SEED_MAX_CHARS - emptyBodies.join("\n\n").length,
  );
  const bodyBudgets = sections.map(() => 0);
  for (const index of priority) {
    const section = sections[index];
    if (!section || remaining <= 0) continue;
    const budget = Math.min(
      section.body.length,
      section.maxBodyChars,
      remaining,
    );
    bodyBudgets[index] = budget;
    remaining -= budget;
  }
  return sections
    .map((section, index) =>
      [
        section.heading,
        ...(section.intro ? [section.intro] : []),
        truncateExact(section.body, bodyBudgets[index] ?? 0),
      ].join("\n"),
    )
    .join("\n\n");
};

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const formatLatestLocalContext = (events: LocalContextEvent[]): string => {
  const rows: string[] = [];
  for (
    let index = events.length - 1;
    index >= 0 && rows.length < 5;
    index -= 1
  ) {
    const payload = asObject(events[index]?.payload);
    const metadata = asObject(payload.metadata);
    const context = asObject(metadata.context);
    const parts: string[] = [];
    const windowLabel = context.windowLabel;
    const appSelectionLabel = context.appSelectionLabel;
    const windowPreviewImageUrl = context.windowPreviewImageUrl;
    const browserUrl = context.browserUrl;
    if (typeof windowLabel === "string" && windowLabel.trim()) {
      parts.push(`active window: ${windowLabel.trim()}`);
    }
    if (typeof appSelectionLabel === "string" && appSelectionLabel.trim()) {
      parts.push(`selected area: ${appSelectionLabel.trim()}`);
    }
    if (
      typeof windowPreviewImageUrl === "string" &&
      windowPreviewImageUrl.trim()
    ) {
      parts.push("active-window screenshot was attached");
    }
    if (typeof browserUrl === "string" && browserUrl.trim()) {
      parts.push(`browser URL: ${browserUrl.trim()}`);
    }
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.length
      : 0;
    if (attachments > 0) {
      parts.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
    }
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No app, browser, selection, or attachment metadata is available.";
};

const formatLiveAppBrowserContext = (
  snapshot: HostAppBrowserContextSnapshot | undefined,
): string => {
  const rows: string[] = [];
  const tab = snapshot?.activeBrowserTab;
  if (tab) {
    rows.push(
      [
        "- active browser tab:",
        `  browser: ${tab.browser}`,
        ...(tab.title?.trim() ? [`  title: ${tab.title.trim()}`] : []),
        `  url: ${tab.url}`,
      ].join("\n"),
    );
  }
  for (const app of snapshot?.apps ?? []) {
    const parts = [
      app.isActive ? "frontmost" : "recent",
      app.name,
      app.windowTitle?.trim() ? `window: ${app.windowTitle.trim()}` : "",
      app.bundleId?.trim() ? `bundle: ${app.bundleId.trim()}` : "",
    ].filter(Boolean);
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No live app or browser-tab snapshot is available.";
};

const normalizeMemorySearchTerms = (terms?: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const term of terms ?? []) {
    const trimmed = term.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const capped = trimmed.slice(0, MAX_MEMORY_SEARCH_TERM_CHARS);
    const key = capped.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(capped);
    if (normalized.length >= MAX_MEMORY_SEARCH_TERMS) break;
  }
  return normalized;
};

type MemoryFileSource = {
  displayPath: string;
  paths: string[];
  includeByDefault: boolean;
};

const MEMORY_FILE_SOURCES = (stellaDataDir: string): MemoryFileSource[] => [
  {
    displayPath: "~/.stella/memories/profile.md",
    paths: [path.join(stellaDataDir, "memories", "profile.md")],
    includeByDefault: true,
  },
  {
    displayPath: "~/.stella/core-memory.md",
    paths: [
      path.join(stellaDataDir, "core-memory.md"),
      path.join(stellaDataDir, "CORE_MEMORY.MD"),
    ],
    includeByDefault: true,
  },
];

const readMemorySource = async (
  source: MemoryFileSource,
): Promise<string | null> => {
  for (const candidate of source.paths) {
    const content = await readOptionalTextFile(candidate);
    if (content) return content;
  }
  return null;
};

const RECALL_ANCHOR_CONTINUATION_RE = /[\p{L}\p{N}_./-]/u;
const RECALL_ANCHOR_WORD_RE = /[\p{L}\p{N}_]/u;

const codePointBefore = (value: string, index: number): string | undefined => {
  if (index <= 0) return undefined;
  const trailingUnit = value.charCodeAt(index - 1);
  if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff && index >= 2) {
    const leadingUnit = value.charCodeAt(index - 2);
    if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) {
      return value.slice(index - 2, index);
    }
  }
  return value[index - 1];
};

const codePointAt = (value: string, index: number): string | undefined => {
  if (index < 0 || index >= value.length) return undefined;
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
};

const hasRecallBoundaryMatch = (value: string, anchor: string): boolean => {
  const normalizedValue = value.normalize("NFKC").toLocaleLowerCase();
  const normalizedAnchor = anchor.normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalizedAnchor) return false;

  let fromIndex = 0;
  while (fromIndex <= normalizedValue.length - normalizedAnchor.length) {
    const index = normalizedValue.indexOf(normalizedAnchor, fromIndex);
    if (index < 0) return false;
    const before = codePointBefore(normalizedValue, index);
    const afterIndex = index + normalizedAnchor.length;
    const after = codePointAt(normalizedValue, afterIndex);
    const beforeContinues =
      before === "."
        ? Boolean(
            codePointBefore(normalizedValue, index - before.length)?.match(
              RECALL_ANCHOR_WORD_RE,
            ),
          )
        : Boolean(before?.match(RECALL_ANCHOR_CONTINUATION_RE));
    const afterContinues =
      after === "."
        ? Boolean(
            codePointAt(normalizedValue, afterIndex + after.length)?.match(
              RECALL_ANCHOR_WORD_RE,
            ),
          )
        : Boolean(after?.match(RECALL_ANCHOR_CONTINUATION_RE));
    if ((!before || !beforeContinues) && (!after || !afterContinues)) {
      return true;
    }
    fromIndex = index + 1;
  }
  return false;
};

const lineMatchesTerms = (
  line: string,
  normalizedTerms: string[],
): string[] => {
  return normalizedTerms.filter((term) => hasRecallBoundaryMatch(line, term));
};

const formatLineRange = (start: number, end: number): string =>
  start === end ? String(start) : `${start}-${end}`;

const readMemorySearchResults = async (
  stellaDataDir: string,
  searchTerms?: readonly string[],
): Promise<string> => {
  const terms = normalizeMemorySearchTerms(searchTerms);
  if (terms.length === 0) {
    return "No memory search terms provided.";
  }

  const blocks: string[] = [
    `<memory_search terms="${escapeAttribute(terms.join(", "))}">`,
  ];
  let matchCount = 0;
  let truncated = false;

  for (const file of MEMORY_FILE_SOURCES(stellaDataDir)) {
    const content = await readMemorySource(file);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const usedRanges: Array<{ start: number; end: number }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const matchedTerms = lineMatchesTerms(lines[index] ?? "", terms);
      if (matchedTerms.length === 0) continue;

      const start = Math.max(0, index - MAX_MEMORY_SEARCH_CONTEXT_LINES);
      const end = Math.min(
        lines.length - 1,
        index + MAX_MEMORY_SEARCH_CONTEXT_LINES,
      );
      const previous = usedRanges[usedRanges.length - 1];
      if (previous && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
        continue;
      }
      usedRanges.push({ start, end });
    }

    for (const range of usedRanges) {
      if (matchCount >= MAX_MEMORY_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      const numbered = lines
        .slice(range.start, range.end + 1)
        .map((line, offset) => `${range.start + offset + 1}: ${line}`)
        .join("\n");
      const rangeText = formatLineRange(range.start + 1, range.end + 1);
      blocks.push(
        [
          `<match path="${escapeAttribute(file.displayPath)}" lines="${rangeText}">`,
          sanitizeToolVisibleText(numbered),
          "</match>",
        ].join("\n"),
      );
      matchCount += 1;
      if (blocks.join("\n\n").length > MAX_MEMORY_SEARCH_RESULTS_CHARS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (matchCount === 0) {
    blocks.push("No matching memory lines found.");
  }
  if (truncated) {
    blocks.push(
      `[truncated after ${matchCount} matches; narrow or change the search terms for more precise recall]`,
    );
  }
  blocks.push("</memory_search>");
  return blocks.join("\n\n");
};

const formatClockTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

/**
 * Live-update lines for one thread: recent assistant prose authored by the
 * agent itself and already persisted in its runtime transcript.
 */
const formatThreadLiveUpdateLines = (
  store: Pick<ContextLookupStore, "listAgentAssistantMessages">,
  thread: { threadId: string; agentStatus?: unknown },
): string[] => {
  if (
    deriveRuntimeThreadLiveState(
      thread as Parameters<typeof deriveRuntimeThreadLiveState>[0],
    ) !== "active"
  ) {
    return [];
  }
  let entries: Array<{ text: string; atMs: number }>;
  try {
    entries = store.listAgentAssistantMessages(
      thread.threadId,
      MAX_LIVE_AGENT_MESSAGES,
    );
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  return [
    "  agent updates (newest last):",
    ...entries.map(
      (entry) =>
        `    - [${formatClockTime(entry.atMs)}] ${sanitizeToolVisibleText(
          entry.text,
        )}`,
    ),
  ];
};

const formatAbsoluteTimestamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateCodePoints = (
  value: string,
  maxChars: number,
  marker = "\n...[truncated]",
): string => {
  const points = Array.from(value);
  if (points.length <= maxChars) return value;
  const markerPoints = Array.from(marker);
  return `${points.slice(0, Math.max(0, maxChars - markerPoints.length)).join("")}${marker}`;
};

/**
 * Search every delegated agent thread across all conversations and ages.
 * Relevance picks which threads make the bounded page; the page renders
 * newest-first with resumable IDs, status, and final result/error excerpts.
 */
export const formatThreadSearchResults = (
  store: Pick<
    ContextLookupStore,
    "searchThreads" | "listAgentAssistantMessages" | "listThreadResultExcerpts"
  >,
  conversationId: string,
  query: string | undefined,
  limit?: number,
): string => {
  const cappedLimit = Math.max(
    1,
    Math.min(
      MAX_THREAD_SEARCH_RESULTS,
      Math.floor(limit ?? MAX_THREAD_SEARCH_RESULTS),
    ),
  );
  const trimmedQuery = query?.trim();
  const threads = store.searchThreads({
    conversationId,
    // An empty query tokenizes to nothing, which takes the LIKE browse path.
    query: trimmedQuery ?? "",
    limit: cappedLimit,
  });
  if (threads.length === 0) {
    return trimmedQuery
      ? "No agent threads matched. Try fewer/different concrete terms, or omit the query to browse the most recent work."
      : "No past agent work recorded yet.";
  }
  let excerpts: ReturnType<ContextLookupStore["listThreadResultExcerpts"]>;
  try {
    excerpts = store.listThreadResultExcerpts(
      threads.map((thread) => thread.threadId),
    );
  } catch {
    excerpts = new Map();
  }
  const ordered = [...threads].sort(
    (a, b) =>
      runtimeThreadLastActiveAt(b) - runtimeThreadLastActiveAt(a) ||
      a.threadId.localeCompare(b.threadId),
  );
  const rendered = ordered.map((thread) => {
    const sameConversation = thread.conversationId === conversationId;
    const excerpt = excerpts.get(thread.threadId);
    const name = thread.name ? collapseWhitespace(thread.name) : "";
    const lines = [
      `- ${thread.threadId} | last active ${formatAbsoluteTimestamp(
        runtimeThreadLastActiveAt(thread),
      )} (${formatRuntimeThreadStatusSuffix(thread)}) | from ${
        sameConversation ? "this conversation" : "another conversation"
      }${name ? ` | ${sanitizeToolVisibleText(name)}` : ""}`,
    ];
    // Names are minted from descriptions, so most pairs are identical — only
    // render a description that adds information.
    const description = thread.description?.trim()
      ? collapseWhitespace(thread.description)
      : "";
    if (description && description !== name) {
      lines.push(`  description: ${sanitizeToolVisibleText(description)}`);
    }
    const summary = thread.summary?.trim()
      ? collapseWhitespace(thread.summary).slice(0, 300)
      : "";
    if (summary) lines.push(`  summary: ${sanitizeToolVisibleText(summary)}`);
    if (excerpt?.resultExcerpt) {
      lines.push(
        `  result: ${sanitizeToolVisibleText(collapseWhitespace(excerpt.resultExcerpt))}`,
      );
    }
    if (excerpt?.errorExcerpt) {
      lines.push(
        `  error: ${sanitizeToolVisibleText(collapseWhitespace(excerpt.errorExcerpt))}`,
      );
    }
    lines.push(...formatThreadLiveUpdateLines(store, thread));
    return lines.join("\n");
  });
  return ["[newest → oldest by last activity]", ...rendered].join("\n");
};

const formatDurableThreadSummaryResults = (
  store: Pick<ContextLookupStore, "threadSummaryStore">,
  query: string | undefined,
  limit = MAX_THREAD_SEARCH_RESULTS,
): string => {
  const rows = store.threadSummaryStore.searchThreadSummaries(
    tokenizeSearchQuery(query ?? ""),
    { limit: Math.max(1, Math.min(MAX_THREAD_SEARCH_RESULTS, limit)) },
  );
  if (rows.length === 0) return "No durable thread summaries matched.";
  return [
    "[durable thread summaries, newest → oldest]",
    ...rows.map(
      (row) =>
        `- ${sanitizeToolVisibleText(row.threadId)} | last active ${formatAbsoluteTimestamp(
          row.sourceUpdatedAt,
        )} (durable summary) | run_id ${sanitizeToolVisibleText(row.runId)}\n  summary: ${sanitizeToolVisibleText(
          truncateCodePoints(collapseWhitespace(row.content), 1_600, "..."),
        )}`,
    ),
  ].join("\n");
};

const MESSAGE_SNIPPET_CHAR_BUDGET = 360;

const formatSnippetDate = (atMs: number): string =>
  new Date(atMs).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

/** Window a matched transcript text around its first matching token. */
const buildMessageSnippet = (text: string, tokens: string[]): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MESSAGE_SNIPPET_CHAR_BUDGET) return collapsed;
  const lower = collapsed.toLocaleLowerCase();
  let matchIndex = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.toLocaleLowerCase());
    if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
      matchIndex = index;
    }
  }
  const center = matchIndex === -1 ? 0 : matchIndex;
  const start = Math.max(
    0,
    center - Math.floor(MESSAGE_SNIPPET_CHAR_BUDGET / 2),
  );
  const end = Math.min(collapsed.length, start + MESSAGE_SNIPPET_CHAR_BUDGET);
  return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${
    end < collapsed.length ? "…" : ""
  }`;
};

/**
 * How many distinct EPISODES get surrounding-context lines (episode dedupe
 * below keeps same-hour repeat hits from burning slots, so in practice this
 * covers nearly every distinct episode in a 12-result page).
 */
const MESSAGE_CONTEXT_TOP_HITS = 8;
const MESSAGE_CONTEXT_LINE_CHAR_BUDGET = 170;
// The follow-through usually comes AFTER the matched message (ask for
// directions → go → react, sometimes an hour later), so the exchange
// window leans hard forward; the store also time-boxes it to the episode.
const MESSAGE_CONTEXT_BEFORE = 2;
const MESSAGE_CONTEXT_AFTER = 8;
// Two hits this close together in one conversation are the same episode —
// one exchange covers both, so the second hit's slot goes to a new episode.
const MESSAGE_EPISODE_WINDOW_MS = 45 * 60 * 1000;

/**
 * Search what the user and Stella actually said across all conversations.
 * Relevance decides which hits receive surrounding context; the bounded page
 * renders oldest to newest so episodic evidence remains a readable timeline.
 */
export const formatTranscriptSearchResults = (
  store: Pick<
    ContextLookupStore,
    "searchTranscripts" | "listTranscriptNeighbors"
  >,
  conversationId: string,
  query: string | undefined,
  limit?: number,
  listNeighborsBatch?: (
    targets: readonly { conversationId: string; atMs: number }[],
    options?: { before?: number; after?: number; windowMs?: number },
  ) => TranscriptSearchHit[][],
): string => {
  const cappedLimit = Math.max(1, Math.min(25, Math.floor(limit ?? 12)));
  const tokens = tokenizeSearchQuery(query ?? "");
  if (tokens.length === 0) {
    return "No usable search terms — pass concrete nouns (names, places, file paths, slugs, error text).";
  }
  const hits = store.searchTranscripts({
    query: query ?? "",
    limit: cappedLimit,
  });
  if (hits.length === 0) {
    return "Nothing matched in past conversation transcripts. Try fewer/different concrete words.";
  }

  // Hits arrive relevance-ranked; relevance decides WHICH hits get their
  // surrounding exchange, but hits inside an already-expanded episode don't
  // burn a second slot.
  const expandable = new Set<TranscriptSearchHit>();
  for (const hit of hits) {
    if (expandable.size >= MESSAGE_CONTEXT_TOP_HITS) break;
    const withinExpandedEpisode = [...expandable].some(
      (other) =>
        other.conversationId === hit.conversationId &&
        Math.abs(other.atMs - hit.atMs) <= MESSAGE_EPISODE_WINDOW_MS,
    );
    if (withinExpandedEpisode) continue;
    expandable.add(hit);
  }

  const expandableHits = [...expandable];
  let batchedNeighbors: TranscriptSearchHit[][] | undefined;
  if (listNeighborsBatch && expandableHits.length > 0) {
    try {
      batchedNeighbors = listNeighborsBatch(
        expandableHits.map((hit) => ({
          conversationId: hit.conversationId,
          atMs: hit.atMs,
        })),
        { before: MESSAGE_CONTEXT_BEFORE, after: MESSAGE_CONTEXT_AFTER },
      );
    } catch {
      batchedNeighbors = undefined;
    }
  }
  const expandableIndex = new Map(
    expandableHits.map((hit, index) => [hit, index] as const),
  );

  // Expand a message hit with the surrounding exchange: the matched message
  // names the thing, but the neighbors are usually the event itself.
  const renderHit = (hit: TranscriptSearchHit): string => {
    const sameConversation = hit.conversationId === conversationId;
    // A short conversation tag (instead of a bare "another conversation")
    // lets the model tell that several hits came from the SAME earlier
    // conversation — that co-location is often the story ("that evening").
    const scope = sameConversation
      ? "this conversation"
      : `conversation …${hit.conversationId.slice(-6)}`;
    const rendered = `- [${formatSnippetDate(hit.atMs)}] ${
      hit.role === "user" ? "User" : "Stella"
    } (${scope}): ${sanitizeToolVisibleText(buildMessageSnippet(hit.text, tokens))}`;
    if (!expandable.has(hit)) return rendered;
    let neighbors: ReturnType<ContextLookupStore["listTranscriptNeighbors"]>;
    try {
      const batchIndex = expandableIndex.get(hit);
      neighbors =
        batchIndex !== undefined && batchedNeighbors
          ? (batchedNeighbors[batchIndex] ?? [])
          : store.listTranscriptNeighbors({
              conversationId: hit.conversationId,
              atMs: hit.atMs,
              before: MESSAGE_CONTEXT_BEFORE,
              after: MESSAGE_CONTEXT_AFTER,
            });
    } catch {
      return rendered;
    }
    if (neighbors.length === 0) return rendered;
    const contextLines = neighbors.map((neighbor) => {
      const collapsed = neighbor.text.replace(/\s+/g, " ").trim();
      const clipped =
        collapsed.length <= MESSAGE_CONTEXT_LINE_CHAR_BUDGET
          ? collapsed
          : `${collapsed.slice(0, MESSAGE_CONTEXT_LINE_CHAR_BUDGET)}…`;
      return `    [${formatSnippetDate(neighbor.atMs)}] ${
        neighbor.role === "user" ? "User" : "Stella"
      }: ${sanitizeToolVisibleText(clipped)}`;
    });
    return [rendered, "  surrounding exchange:", ...contextLines].join("\n");
  };

  const ordered = [...hits].sort((a, b) => a.atMs - b.atMs);
  return [
    "[oldest → newest — read as a timeline]",
    ...ordered.map(renderHit),
  ].join("\n");
};

type RecallSourceReference = {
  kind: "memory" | "thread" | "transcript" | "live";
  summaryId?: number;
  threadId?: string;
  runId?: string;
};

type RecallReadQueries = {
  getFtsHealth: () => {
    healthy: boolean;
    transcriptReady: boolean;
    threadsReady: boolean;
    reason?: string;
  };
  listTranscriptNeighborsBatch: (
    targets: readonly { conversationId: string; atMs: number }[],
    options?: { before?: number; after?: number; windowMs?: number },
  ) => TranscriptSearchHit[][];
};

const splitRecallEvidenceUnits = (
  kind: UnifiedRecallSource,
  value: string,
): string[] => {
  if (kind === "durable_memory") {
    const matches = value.match(/<match\b[^>]*>[\s\S]*?<\/match>/g) ?? [];
    return matches.flatMap((match) => {
      const lines = match.split("\n");
      const opening = lines[0] ?? "<match>";
      const body = lines.slice(1, -1);
      const groups: string[][] = [];
      for (const line of body) {
        if (/^\d+:\s+(?:- |##\s)/.test(line) || groups.length === 0) {
          groups.push([line]);
        } else {
          groups[groups.length - 1]!.push(line);
        }
      }
      return groups
        .filter((group) => group.some((line) => line.trim()))
        .map((group) => [opening, ...group, "</match>"].join("\n"));
    });
  }
  const pattern =
    kind === "delegated_work"
      ? /^- [^\n]+[\s\S]*?(?=^- |^# Live status|(?![\s\S]))/gm
      : kind === "episodic"
        ? /^- \[[^\n]+\][\s\S]*?(?=^- \[|(?![\s\S]))/gm
        : /^- [\s\S]*?(?=^- |(?![\s\S]))/gm;
  const units = value
    .match(pattern)
    ?.map((unit) => unit.trim())
    .filter(Boolean);
  return units?.length ? units : [value.trim()].filter(Boolean);
};

const hasSubstantiveRecallEvidence = (value: string): boolean =>
  value.split("\n").some((line) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith("#")) return false;
    return !/^(?:nothing relevant found|no\b.*\b(?:found|available|matched|matches|results?))\.?$/i.test(
      normalized,
    );
  });

const UNIFIED_RECALL_EVIDENCE_MAX_CHARS = 12_000;
const UNIFIED_RECALL_BRIEF_MAX_CHARS = 6_000;
const UNIFIED_RECALL_CANDIDATE_MAX_CHARS = 3_000;

type UnifiedRecallCandidate = {
  parts: Map<UnifiedRecallSource, string>;
  fingerprints: Set<string>;
  sourceKinds: Set<UnifiedRecallSource>;
  threadIds: Set<string>;
  matchedGroups: number;
  exactPhraseMatches: number;
  score: number;
  latestAtMs: number;
};

const recallCandidateThreadIds = (
  kind: UnifiedRecallSource,
  value: string,
): Set<string> => {
  const threadIds = new Set<string>();
  if (kind !== "delegated_work") return threadIds;
  for (const match of value.matchAll(/^- ([^\s|]+) \|/gm)) {
    if (match[1]) threadIds.add(match[1]);
  }
  return threadIds;
};

const recallCandidateFingerprints = (
  kind: UnifiedRecallSource,
  value: string,
): Set<string> => {
  const fingerprints = new Set<string>();
  for (const rawLine of value.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("<")) continue;
    if (kind === "delegated_work") {
      const detail = line.match(
        /^(?:description|summary|result|error):\s*(.+)$/i,
      );
      if (!detail?.[1]) continue;
      line = detail[1];
    } else if (kind === "episodic") {
      line = line.replace(/^-?\s*\[[^\]]+\]\s+[^:]+(?:\([^)]*\))?:\s*/, "");
    } else if (kind === "durable_memory") {
      line = line.replace(/^\d+:\s*(?:[-*+]\s*)?/, "");
    }
    const normalized = line
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^[\s'"`]+|[\s'"`.,;:!?]+$/g, "")
      .trim();
    if (normalized.length >= 3) fingerprints.add(normalized);
  }
  return fingerprints;
};

const latestTimestampInRecallCandidate = (value: string): number => {
  let latest = 0;
  for (const match of value.matchAll(
    /(?:last active |\[)([A-Z][a-z]{2} \d{1,2}, \d{4},? at \d{1,2}:\d{2}:\d{2} [AP]M|\d{4}-\d{2}-\d{2}T[^\]\s]+)/g,
  )) {
    const parsed = Date.parse(match[1] ?? "");
    if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
  }
  return latest;
};

const recallSourceRank = (kind: UnifiedRecallSource): number =>
  kind === "delegated_work"
    ? 4
    : kind === "episodic"
      ? 3
      : kind === "durable_memory"
        ? 2
        : 1;

const scoreUnifiedRecallCandidate = (
  candidate: UnifiedRecallCandidate,
  terms: readonly string[],
  exactPhrases: readonly string[],
): void => {
  const haystack = [...candidate.parts.values()]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase();
  const groups = terms.flatMap((term) => {
    const normalized = term.normalize("NFKC").trim().toLocaleLowerCase();
    if (!normalized) return [];
    const tokens = tokenizeSearchQuery(normalized).filter(
      (token) => token.length >= 2,
    );
    return tokens.length > 0 ? [tokens] : [];
  });
  candidate.matchedGroups = groups.filter((group) =>
    group.every((token) => hasRecallBoundaryMatch(haystack, token)),
  ).length;
  candidate.exactPhraseMatches = exactPhrases.filter((phrase) =>
    hasRecallBoundaryMatch(haystack, phrase),
  ).length;
  const sourceScore = [...candidate.sourceKinds].reduce(
    (total, kind) => total + recallSourceRank(kind),
    0,
  );
  const recencyScore = candidate.latestAtMs
    ? Math.max(
        0,
        5 -
          Math.floor(
            (Date.now() - candidate.latestAtMs) / (90 * 24 * 60 * 60 * 1000),
          ),
      )
    : 0;
  candidate.score =
    candidate.matchedGroups * 12 +
    candidate.exactPhraseMatches * 40 +
    sourceScore +
    recencyScore +
    Math.max(0, candidate.sourceKinds.size - 1) * 8;
};

const mergeAndRankRecallEvidence = (
  evidence: Array<{ kind: UnifiedRecallSource; value: string }>,
  terms: readonly string[],
  exactPhrases: readonly string[],
): UnifiedRecallCandidate[] => {
  const candidates: UnifiedRecallCandidate[] = [];
  const byFingerprint = new Map<string, UnifiedRecallCandidate>();
  for (const { kind, value } of evidence) {
    for (const unit of splitRecallEvidenceUnits(kind, value)) {
      if (!hasSubstantiveRecallEvidence(unit)) continue;
      const fingerprints = recallCandidateFingerprints(kind, unit);
      let candidate = [...fingerprints]
        .map((key) => byFingerprint.get(key))
        .find((match): match is UnifiedRecallCandidate => Boolean(match));
      if (!candidate) {
        candidate = {
          parts: new Map(),
          fingerprints: new Set(),
          sourceKinds: new Set(),
          threadIds: new Set(),
          matchedGroups: 0,
          exactPhraseMatches: 0,
          score: 0,
          latestAtMs: 0,
        };
        candidates.push(candidate);
      }
      if (!candidate.parts.has(kind)) candidate.parts.set(kind, unit);
      candidate.sourceKinds.add(kind);
      for (const threadId of recallCandidateThreadIds(kind, unit)) {
        candidate.threadIds.add(threadId);
      }
      candidate.latestAtMs = Math.max(
        candidate.latestAtMs,
        latestTimestampInRecallCandidate(unit),
      );
      for (const fingerprint of fingerprints) {
        candidate.fingerprints.add(fingerprint);
        byFingerprint.set(fingerprint, candidate);
      }
    }
  }
  for (const candidate of candidates) {
    scoreUnifiedRecallCandidate(candidate, terms, exactPhrases);
  }
  return candidates
    .filter(
      (candidate) =>
        candidate.matchedGroups > 0 || candidate.exactPhraseMatches > 0,
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.latestAtMs - a.latestAtMs ||
        [...a.fingerprints][0]?.localeCompare([...b.fingerprints][0] ?? "") ||
        0,
    );
};

const renderUnifiedRecallCandidate = (
  candidate: UnifiedRecallCandidate,
): string => {
  const sourceKinds = [...candidate.sourceKinds].sort(
    (a, b) => recallSourceRank(b) - recallSourceRank(a),
  );
  const primaryKind = sourceKinds[0]!;
  const primary = candidate.parts.get(primaryKind) ?? "";
  const corroboration = sourceKinds.slice(1);
  return [
    `sources: ${sourceKinds.join(", ")} | rank: ${candidate.score}`,
    truncateCodePoints(primary, UNIFIED_RECALL_CANDIDATE_MAX_CHARS),
    ...(corroboration.length > 0
      ? [`[overlap deduplicated; corroborated by ${corroboration.join(", ")}]`]
      : []),
  ].join("\n");
};

const recallSourceReferenceKind = (
  kind: UnifiedRecallSource,
): RecallSourceReference["kind"] =>
  kind === "durable_memory"
    ? "memory"
    : kind === "delegated_work"
      ? "thread"
      : kind === "episodic"
        ? "transcript"
        : "live";

const runArchitecturalRecall = async (args: {
  conversationId: string;
  lookupPrompt: string;
  seedTerms: readonly string[];
  stellaAppDir: string;
  stellaDataDir: string;
  store: RuntimeStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  resolveRecallRoute: () => Promise<RecallModelRoute>;
  recallReadQueries?: RecallReadQueries;
  memoryEnabled: boolean;
  telemetry: RecallTelemetryCollector;
  emitTelemetry: (outcome: string) => void;
  onResultMetadata?: (metadata: {
    intent: RecallIntent;
    fastPath: boolean;
    sources: RecallSourceReference[];
  }) => void;
  signal?: AbortSignal;
}): Promise<string> => {
  const intent: RecallIntent = "multi_source";
  const exactPhrases = extractExactRecallPhrases(args.lookupPrompt);
  args.telemetry.setIntent(intent, false);

  if (args.recallReadQueries) {
    const startedAt = performance.now();
    try {
      args.recallReadQueries.getFtsHealth();
    } catch {
      // Health telemetry is diagnostic only. The independent source reads
      // below remain authoritative and must still all run.
    } finally {
      args.telemetry.addSource(
        "retrieval.ftsHealth",
        "sql",
        performance.now() - startedAt,
      );
    }
  }

  const query = normalizeMemorySearchTerms(args.seedTerms).join(" ");
  args.telemetry.addRetrievalPass();
  const retrieveSource = async (
    kind: UnifiedRecallSource,
    telemetryName: string,
    transport: "file" | "sql" | "host",
    read: () => string | Promise<string>,
  ): Promise<{ kind: UnifiedRecallSource; value: string }> => {
    const startedAt = performance.now();
    let value = "";
    try {
      value = await read();
      return { kind, value };
    } finally {
      args.telemetry.addSource(
        `retrieval.${telemetryName}`,
        transport,
        performance.now() - startedAt,
        value.length,
      );
    }
  };

  const retrievals: Array<{
    kind: UnifiedRecallSource;
    label: string;
    promise: Promise<{ kind: UnifiedRecallSource; value: string }>;
  }> = [
    {
      kind: "delegated_work",
      label: "thread_results",
      promise: retrieveSource("delegated_work", "threadResults", "sql", () =>
        formatThreadSearchResults(args.store, args.conversationId, query),
      ),
    },
    {
      kind: "delegated_work",
      label: "thread_summaries",
      promise: retrieveSource("delegated_work", "threadSummaries", "sql", () =>
        formatDurableThreadSummaryResults(args.store, query),
      ),
    },
    {
      kind: "episodic",
      label: "transcripts",
      promise: retrieveSource("episodic", "transcripts", "sql", () =>
        formatTranscriptSearchResults(
          args.store,
          args.conversationId,
          query,
          undefined,
          args.recallReadQueries?.listTranscriptNeighborsBatch,
        ),
      ),
    },
    ...(args.memoryEnabled
      ? [
          {
            kind: "durable_memory" as const,
            label: "durable_memory",
            promise: retrieveSource(
              "durable_memory",
              "durableMemory",
              "file",
              () => readMemorySearchResults(args.stellaDataDir, args.seedTerms),
            ),
          },
        ]
      : []),
    {
      kind: "live_context",
      label: "live_context",
      promise: retrieveSource("live_context", "liveContext", "host", () =>
        [
          formatLiveAppBrowserContext(args.appBrowserContext),
          formatLatestLocalContext(args.localEvents),
        ].join("\n\n"),
      ),
    },
  ];
  const retrievalStartedAt = performance.now();
  const settled = await Promise.allSettled(
    retrievals.map((retrieval) => retrieval.promise),
  );
  args.telemetry.setSeedSearchMs(performance.now() - retrievalStartedAt);
  const evidence: Array<{ kind: UnifiedRecallSource; value: string }> = [];
  const failures: Array<{ label: string; message: string }> = [];
  settled.forEach((result, index) => {
    const retrieval = retrievals[index]!;
    if (result.status === "fulfilled") {
      evidence.push(result.value);
    } else {
      failures.push({
        label: retrieval.label,
        message: truncateCodePoints(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
          300,
          "...[truncated]",
        ),
      });
    }
  });

  const assemblyStartedAt = performance.now();
  const candidates = mergeAndRankRecallEvidence(
    evidence,
    args.seedTerms,
    exactPhrases,
  );
  if (candidates.length === 0 && failures.length > 0) {
    throw new RecallRetrievalError(
      `Recall retrieval incomplete with no valid evidence: ${failures
        .map(({ label, message }) => `${label}: ${message}`)
        .join("; ")}`,
    );
  }
  const failureNotice =
    failures.length > 0
      ? `# Partial source failure\n${failures
          .map(
            ({ label, message }) =>
              `- ${label}: ${sanitizeToolVisibleText(message)}`,
          )
          .join("\n")}`
      : "";
  const sections = candidates.slice(0, 16).map((candidate, index) => ({
    heading: `# Ranked evidence ${index + 1}`,
    body: renderUnifiedRecallCandidate(candidate),
    maxBodyChars: UNIFIED_RECALL_CANDIDATE_MAX_CHARS + 200,
  }));
  if (failureNotice) {
    sections.unshift({
      heading: "# Retrieval notice",
      body: failureNotice,
      maxBodyChars: 1_000,
    });
  }
  if (sections.length === 0) {
    sections.push({
      heading: "# No indexed evidence",
      body: "The unified thread and transcript sweep found no matching evidence.",
      maxBodyChars: 200,
    });
  }
  const evidenceText = truncateCodePoints(
    renderCappedRecallSeed(
      sections,
      sections.map((_, index) => index),
    ),
    UNIFIED_RECALL_EVIDENCE_MAX_CHARS,
  );
  args.telemetry.setSeedChars(candidates.length > 0 ? evidenceText.length : 0);
  args.telemetry.addAssemblyMs(performance.now() - assemblyStartedAt);

  const sourceKinds = new Set(
    candidates.flatMap((candidate) => [...candidate.sourceKinds]),
  );
  const sources: RecallSourceReference[] = [...sourceKinds].map((kind) => ({
    kind: recallSourceReferenceKind(kind),
  }));
  const threadIds = new Set<string>();
  for (const candidate of candidates) {
    for (const threadId of candidate.threadIds) threadIds.add(threadId);
  }
  if (threadIds.size > 0) {
    try {
      const rows = args.store.threadSummaryStore.findThreadSummariesByThreadIds(
        [...threadIds],
      );
      for (const row of rows) {
        if (!row.threadId || !row.runId || !threadIds.has(row.threadId))
          continue;
        sources.push({
          kind: "thread",
          summaryId: row.id,
          threadId: row.threadId,
          runId: row.runId,
        });
      }
    } catch {
      // Resumable metadata is best-effort enrichment. Its failure must not
      // erase ranked evidence already returned by an independent corpus.
    }
  }

  if (candidates.length === 0) {
    args.telemetry.setIntent(intent, true);
    args.onResultMetadata?.({ intent, fastPath: true, sources });
    args.emitTelemetry("no-match");
    return RECALL_NO_MATCH_TEXT;
  }

  const allGroupsMatched =
    args.seedTerms.length > 0 &&
    (candidates[0]?.matchedGroups ?? 0) >= args.seedTerms.length;
  const deterministicAnchor =
    exactPhrases.length > 0 ||
    isBareRepoLookup(args.lookupPrompt) ||
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(args.lookupPrompt) ||
    /(?:^|\s)(?:\/[\w./-]+|[\w.-]+\/[\w./-]+)|\b\d{4}-\d{2}-\d{2}\b|\b(?:thread[_ -]?id|error|crash(?:ed)?)\b/i.test(
      args.lookupPrompt,
    );
  const fastPath =
    candidates.length > 0 &&
    (failures.length > 0 ||
      deterministicAnchor ||
      (candidates.length === 1 && allGroupsMatched));
  if (fastPath) {
    args.telemetry.setIntent(intent, true);
    args.onResultMetadata?.({ intent, fastPath: true, sources });
    args.emitTelemetry(failures.length > 0 ? "partial-fast-path" : "fast-path");
    return evidenceText;
  }

  const recallRoute = await args.resolveRecallRoute();
  const useClaudeCode = recallRoute.executionEngine === "claude-code";
  args.telemetry.setRoute(
    useClaudeCode ? "claude-code" : "native",
    recallRoute.modelId,
  );
  const systemPrompt =
    "Synthesize the supplied unified Recall evidence into one concise factual brief. Cite dates and resumable thread ids present in evidence. Source type is ranking evidence, not a routing rule. Do not invent facts. If evidence is insufficient, answer exactly: Nothing relevant found.";
  const userPrompt = `${evidenceText}\n\n# Lookup request\n${truncateCodePoints(
    args.lookupPrompt.trim(),
    1_000,
  )}`;
  const modelStartedAt = performance.now();
  let brief = "";
  try {
    if (useClaudeCode) {
      brief = (
        await runClaudeCodeAgentTextCompletion({
          stellaAppDir: args.stellaDataDir,
          cwd: args.stellaAppDir,
          agentType: AGENT_IDS.ORCHESTRATOR,
          modelOverride: recallRoute.claudeCodeModel,
          effortLevel: "low",
          context: {
            systemPrompt,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: userPrompt }],
                timestamp: Date.now(),
              },
            ],
            tools: [],
          },
          abortSignal: args.signal,
        })
      ).trim();
    } else {
      const resolvedLlm = recallRoute.resolvedLlm;
      if (!resolvedLlm)
        throw new Error("Recall native route was not resolved.");
      const apiKey = await resolveRecallSynthesisApiKey(resolvedLlm);
      const reasoning = recallSynthesisReasoning(resolvedLlm.model);
      const response = await completeSimple(
        resolvedLlm.model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          ...(apiKey ? { apiKey } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(resolvedLlm.refreshApiKey
            ? { refreshApiKey: resolvedLlm.refreshApiKey }
            : {}),
          omitMaxTokens: true,
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted"
      ) {
        throw new Error(response.errorMessage ?? response.stopReason);
      }
      brief = readAssistantText(response).trim();
    }
  } finally {
    args.telemetry.addModelCall(performance.now() - modelStartedAt);
  }
  brief = truncateCodePoints(brief, UNIFIED_RECALL_BRIEF_MAX_CHARS);
  args.onResultMetadata?.({ intent, fastPath: false, sources });
  args.emitTelemetry(
    !brief
      ? "empty-brief"
      : isRecallNoMatchBrief(brief)
        ? "no-match"
        : failures.length > 0
          ? "partial-answer"
          : "answer",
  );
  return brief || RECALL_EMPTY_BRIEF_TEXT;
};

/**
 * Unified Recall searches durable thread evidence and transcripts on every
 * query, merges and ranks the results once, and performs at most one bounded
 * synthesis call when deterministic evidence is not enough.
 */
export const runRecall = async (args: {
  conversationId: string;
  lookupPrompt: string;
  memorySearchTerms?: readonly string[];
  stellaAppDir: string;
  stellaDataDir: string;
  store: RuntimeStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  resolveRecallRoute: () => Promise<RecallModelRoute>;
  recallReadQueries?: RecallReadQueries;
  telemetry?: RecallTelemetrySeed;
  onTelemetry?: (record: RecallTelemetryRecord) => void;
  onResultMetadata?: (metadata: {
    intent: RecallIntent;
    fastPath: boolean;
    sources: RecallSourceReference[];
  }) => void;
  signal?: AbortSignal;
}): Promise<string> => {
  const memoryEnabled =
    loadLocalPreferences(args.stellaDataDir).memoryEnabled !== false;
  const telemetry = new RecallTelemetryCollector(args.telemetry);
  let telemetryEmitted = false;
  const emitTelemetry = (outcome: string): void => {
    if (telemetryEmitted) return;
    telemetryEmitted = true;
    const record = telemetry.snapshot(args.conversationId, outcome);
    logRecallTrace("[stella:recall:telemetry]", record);
    try {
      args.onTelemetry?.(record);
    } catch {
      // Observers are diagnostic-only and must never break Recall.
    }
  };
  // The Recall tool requires search terms; for callers that still omit
  // them, tokenizing the lookup prompt keeps deterministic retrieval useful.
  const seedTerms = normalizeMemorySearchTerms(
    args.memorySearchTerms?.length
      ? args.memorySearchTerms
      : tokenizeSearchQuery(args.lookupPrompt),
  );
  try {
    return await runArchitecturalRecall({
      conversationId: args.conversationId,
      lookupPrompt: args.lookupPrompt,
      seedTerms,
      stellaAppDir: args.stellaAppDir,
      stellaDataDir: args.stellaDataDir,
      store: args.store,
      localEvents: args.localEvents,
      ...(args.appBrowserContext
        ? { appBrowserContext: args.appBrowserContext }
        : {}),
      resolveRecallRoute: args.resolveRecallRoute,
      ...(args.recallReadQueries
        ? { recallReadQueries: args.recallReadQueries }
        : {}),
      telemetry,
      emitTelemetry,
      memoryEnabled,
      ...(args.onResultMetadata
        ? { onResultMetadata: args.onResultMetadata }
        : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    emitTelemetry("thrown");
    throw error instanceof RecallRetrievalError
      ? error
      : new Error(error instanceof Error ? error.message : String(error));
  }
};
