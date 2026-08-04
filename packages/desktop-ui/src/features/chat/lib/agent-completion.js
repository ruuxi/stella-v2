import { fallbackTaskDescription, isAgentCompletedEvent, isAgentStartedEvent, } from "./event-transforms";
import { deriveAgentFilesMap } from "@/features/workspace-display/agent-files";
import { isDeclaredOutputPath } from "@/features/workspace-display/path-to-viewer";
const asNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
/**
 * Declared deliverables (`~/.stella/outputs/**`) lead the pill list; the pill
 * cap then truncates incidental writes (worktree scratch, intermediate
 * assets) instead of the files the user actually asked for. Stable within
 * each group, so `deriveConversationFiles`' most-recent-first order is
 * preserved among peers. Entries are already deduped by path upstream
 * (`deriveConversationFiles` keys its map by path).
 */
const rankDeliverablesFirst = (entries) => [
    ...entries.filter((entry) => isDeclaredOutputPath(entry.path)),
    ...entries.filter((entry) => !isDeclaredOutputPath(entry.path)),
];
/**
 * Fold every `agent-started` event across the loaded window into a per-agent
 * metadata map. The first non-empty value for each field wins so a later
 * `send_input` re-activation (which reuses the original description) doesn't
 * clobber a richer earlier label.
 */
export function buildAgentMetaMap(events) {
    const byId = new Map();
    for (const event of events) {
        if (!isAgentStartedEvent(event))
            continue;
        const agentId = asNonEmptyString(event.payload.agentId);
        if (!agentId)
            continue;
        const existing = byId.get(agentId) ?? {};
        const next = { ...existing };
        if (!next.description) {
            next.description = asNonEmptyString(event.payload.description);
        }
        if (!next.agentType) {
            next.agentType = asNonEmptyString(event.payload.agentType);
        }
        byId.set(agentId, next);
    }
    return byId;
}
/**
 * Group a single row's `agent-completed` events by `agentId` and derive each
 * agent's produced files through the shared `deriveAgentFilesMap` /
 * `deriveConversationFiles` derivation (same path the sidebar Activity tray
 * uses), so the pill list dedupes by path exactly like everywhere else.
 * Restricted to `agent-completed` events — orchestrator-direct `tool_result`
 * files keep their own inline rendering and never become agent pills.
 */
export function deriveAgentCompletionFiles(toolEvents) {
    return deriveAgentFilesMap(toolEvents, isAgentCompletedEvent);
}
/** Cap for the fileless-section summary excerpt (whitespace-collapsed). */
const SUMMARY_MAX_CHARS = 200;
/** How far below the cap a word boundary may sit and still be preferred. */
const SUMMARY_BOUNDARY_SLACK = 32;
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
/**
 * Truncate to at most `max` UTF-16 units without splitting a grapheme
 * cluster — a blind `slice` can cut a surrogate pair (emoji, rare CJK) in
 * half and render a replacement character at the excerpt's edge.
 */
const truncateAtGrapheme = (value, max) => {
    if (value.length <= max)
        return value;
    if (!graphemeSegmenter) {
        // Fallback: only guard the surrogate-pair case at the cut point.
        const cut = value.slice(0, max);
        return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    }
    let end = 0;
    for (const { index, segment } of graphemeSegmenter.segment(value)) {
        if (index + segment.length > max)
            break;
        end = index + segment.length;
    }
    return value.slice(0, end);
};
/**
 * Reduce a markdown result to inline-only markdown before the excerpt is
 * collapsed to one line. The excerpt renders through the chat `Markdown`
 * component, but it's a muted one-liner, not a document: block constructs
 * would either render at document scale (headings) or — worse — turn into
 * stray literals once newlines collapse (`## Heading` mid-line renders as a
 * literal "##"). Strip them line-by-line while newline context still
 * exists; inline emphasis / code spans pass through untouched.
 */
const stripBlockMarkdown = (text) => text
    .split(/\r?\n/)
    // Drop fence delimiter lines; fenced content stays as plain text.
    .filter((line) => !/^\s*(?:```|~~~)/.test(line))
    .map((line) => line
    // ATX headings (`## Title`) → plain text.
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    // Blockquote markers (possibly nested).
    .replace(/^\s*(?:>\s?)+/, "")
    // Bullet / ordered list markers.
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
    // Horizontal rules become nothing.
    .replace(/^\s*(?:[-*_]\s*){3,}$/, ""))
    .join("\n");
const removeLastOccurrence = (text, marker) => {
    const index = text.lastIndexOf(marker);
    if (index === -1)
        return text;
    return text.slice(0, index) + text.slice(index + marker.length);
};
const countOccurrences = (text, marker) => text.split(marker).length - 1;
/**
 * The excerpt cut can land mid-construct, leaving an unclosed `**` /
 * `` ` `` / `~~` / `*` that would style (or, for a code span, swallow) the
 * rest of the rendered excerpt. Drop the dangling opener so the truncated
 * tail renders as plain text. Approximate on purpose: pair-counting is
 * exact enough for a one-line 200-char excerpt and avoids a full inline-
 * markdown parse. Underscores are deliberately left alone — they're
 * overwhelmingly `snake_case` identifiers here, and intraword `_` never
 * triggers emphasis anyway.
 */
const dropDanglingInlineMarkers = (text) => {
    let out = text;
    if (countOccurrences(out, "`") % 2 === 1) {
        out = removeLastOccurrence(out, "`");
    }
    if (countOccurrences(out, "**") % 2 === 1) {
        out = removeLastOccurrence(out, "**");
    }
    if (countOccurrences(out, "~~") % 2 === 1) {
        out = removeLastOccurrence(out, "~~");
    }
    const singleStars = countOccurrences(out, "*") - 2 * countOccurrences(out, "**");
    if (singleStars % 2 === 1) {
        out = removeLastOccurrence(out, "*");
    }
    return out;
};
const toSummaryExcerpt = (result) => {
    const compact = stripBlockMarkdown(result).replace(/\s+/g, " ").trim();
    if (compact.length <= SUMMARY_MAX_CHARS) {
        return dropDanglingInlineMarkers(compact);
    }
    // Prefer a word boundary near the cap; otherwise cut between graphemes.
    const head = truncateAtGrapheme(compact, SUMMARY_MAX_CHARS);
    const lastSpace = head.lastIndexOf(" ");
    const cut = lastSpace >= SUMMARY_MAX_CHARS - SUMMARY_BOUNDARY_SLACK
        ? head.slice(0, lastSpace)
        : head;
    return `${dropDanglingInlineMarkers(cut.trimEnd()).trimEnd()}…`;
};
/**
 * Build the sectioned completion card for a row: one section per agent that
 * COMPLETED at this point, in first-completion order. Deliberately not
 * gated on produced files: an agent that finished without any observable
 * file output (purely investigative work, or an engine whose writes Stella
 * can't track — e.g. vanilla Claude Code Bash-side writes) still gets its
 * "done" card; files enrich the card when present, and a fileless section
 * carries a compact `summary` excerpt of the agent's result instead.
 *
 * Deliberately NO reserved-builtin denylist here (unlike the spawn
 * breadcrumb): an agent-produced FILE is a user-facing deliverable no matter
 * which agent made it, and before the completion-card consolidation these
 * files rendered inline for every agent type. Reserved builtins that run in
 * hidden conversations (fashion, dream, chronicle) never land in the visible
 * transcript anyway; ones that run in the user's conversation (e.g. the
 * schedule subagent, whose toolset is not restricted away from file-writing
 * tools) keep their files visible as pills. This also keeps behavior
 * identical whether or not the agent's `agent-started` (and thus its
 * `agentType`) aged out of the loaded event window.
 */
export function buildAgentCompletionSections(toolEvents, agentMetaById) {
    const files = deriveAgentCompletionFiles(toolEvents);
    // Enumerate completed agents from the row's `agent-completed` events (in
    // first-completion order), tracking each agent's latest completion
    // timestamp and the result excerpt from that latest completion.
    const completedAgentIds = [];
    const completedAtByAgent = new Map();
    const completionEventIdByAgent = new Map();
    const rootRunIdByAgent = new Map();
    const summaryByAgent = new Map();
    for (const event of toolEvents) {
        if (!isAgentCompletedEvent(event))
            continue;
        const agentId = asNonEmptyString(event.payload.agentId);
        if (!agentId)
            continue;
        const prev = completedAtByAgent.get(agentId);
        if (prev === undefined)
            completedAgentIds.push(agentId);
        if (prev === undefined || event.timestamp >= prev) {
            completedAtByAgent.set(agentId, Math.max(prev ?? 0, event.timestamp));
            completionEventIdByAgent.set(agentId, event._id);
            const rootRunId = asNonEmptyString(event.payload.rootRunId);
            if (rootRunId)
                rootRunIdByAgent.set(agentId, rootRunId);
            else
                rootRunIdByAgent.delete(agentId);
            const result = asNonEmptyString(event.payload.result);
            // The summary always mirrors the LATEST completion: a re-run that
            // finishes without a result clears the older excerpt rather than
            // leaving stale text attributed to the newer completion.
            if (result)
                summaryByAgent.set(agentId, toSummaryExcerpt(result));
            else
                summaryByAgent.delete(agentId);
        }
    }
    const sections = [];
    for (const agentId of completedAgentIds) {
        const meta = agentMetaById.get(agentId);
        const title = meta?.description?.trim() ||
            fallbackTaskDescription(agentId);
        const entries = files.get(agentId) ?? [];
        const summary = summaryByAgent.get(agentId);
        sections.push({
            agentId,
            ...(meta?.agentType ? { agentType: meta.agentType } : {}),
            title,
            completedAtMs: completedAtByAgent.get(agentId) ?? 0,
            ...(completionEventIdByAgent.get(agentId)
                ? { completionEventId: completionEventIdByAgent.get(agentId) }
                : {}),
            ...(rootRunIdByAgent.get(agentId)
                ? { rootRunId: rootRunIdByAgent.get(agentId) }
                : {}),
            files: rankDeliverablesFirst([...entries]),
            ...(summary ? { summary } : {}),
        });
    }
    return sections;
}
