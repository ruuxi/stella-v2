/**
 * The orchestrator's memory and scheduling tools.
 *
 * `Remember` and the document half of `Recall` talk straight to the R2 agent
 * home. The transcript half of `Recall` reads through the canonical journal in
 * this conversation's Durable Object. Schedules remain in Convex so owner-wide
 * listing, billing, deletion, and dispatch share one control-plane authority.
 *
 * Tool definitions are pinned here in code and passed to the loop by the DO —
 * nothing about the orchestrator's execution surface is data-driven.
 */

import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import type { TSchema } from "@sinclair/typebox";
import {
  AgentHomeUnavailableError,
  buildStartupDocBlock,
  type AgentHome,
  type ProfileAction,
} from "./agent-home.js";
import { sha256Hex } from "./hash.js";
import { extractMessageText } from "./journal.js";
import type { JournalRecord } from "./conversation-types.js";

export type OrchestratorAgentTool = AgentTool & {
  codeEligibility?: "read_only";
};

export type OrchestratorToolContext = {
  ownerId: string;
  ownerGeneration: string;
  /**
   * The conversation this turn is running in. A schedule created here fires
   * back into it, so the run shows up where the user set it up instead of
   * starting a conversation they never opened.
   */
  conversationId: string;
  agentHome: AgentHome;
  recall: {
    search: (terms: readonly string[], limit: number) => RecallHit[];
    hydrate: (
      seq: number,
      before: number,
      after: number,
    ) => Promise<JournalRecord[]>;
  };
  /** POST to a Convex HTTP route with the builder service secret. */
  post: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Response>;
};

/**
 * Convex rejects anything tighter than this, so the tool has to say so up
 * front rather than let the model promise the user a one-minute loop.
 */
const MIN_EVERY_MINUTES = 15;

const RECALL_DOCUMENT_BUDGET = 6_000;
const RECALL_DEFAULT_LIMIT = 12;
const RECALL_MAX_LIMIT = 30;
const RECALL_TRANSCRIPT_BUDGET = 12_000;
const RECALL_MESSAGE_MAX_CHARS = 1_500;
const RECALL_WINDOW_BEFORE = 2;
const RECALL_WINDOW_AFTER = 2;

export type RecallHit = Readonly<{
  seq: number;
  turnId: string;
  role: string;
  createdAt: number;
  snippet: string;
  rank: number;
}>;

type HydratedRecallHit = Readonly<{
  hit: RecallHit;
  records: JournalRecord[];
}>;

const isoTime = (createdAt: number): string => {
  if (!Number.isFinite(createdAt)) return "unknown time";
  try {
    return new Date(createdAt).toISOString().replace(".000Z", "Z");
  } catch {
    return "unknown time";
  }
};

const readJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const renderHydratedHits = (hydrated: readonly HydratedRecallHit[]): string => {
  let budget = RECALL_TRANSCRIPT_BUDGET;
  const blocks: string[] = [];
  const seen = new Set<number>();
  for (const { hit, records } of [...hydrated].sort(
    (left, right) => left.hit.seq - right.hit.seq,
  )) {
    const lines = [`[${isoTime(hit.createdAt)}] ${hit.role} #${hit.seq}`];
    for (const record of [...records].sort(
      (left, right) => left.seq - right.seq,
    )) {
      if (record.kind !== "message" || seen.has(record.seq)) continue;
      seen.add(record.seq);
      const text = extractMessageText(record.payload)
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, RECALL_MESSAGE_MAX_CHARS);
      if (text) lines.push(`#${record.seq} ${record.role}: ${text}`);
    }
    const block = lines.join("\n");
    const separatorChars = blocks.length > 0 ? 2 : 0;
    if (block.length + separatorChars <= budget) {
      blocks.push(block);
      budget -= block.length + separatorChars;
      continue;
    }
    const remaining = budget - separatorChars;
    if (remaining > 0) blocks.push(block.slice(0, remaining));
    break;
  }
  return blocks.join("\n\n");
};

export const createMemoryTools = (
  context: OrchestratorToolContext,
): OrchestratorAgentTool[] => [
  {
    name: "Recall",
    label: "Recall",
    description:
      "Look up memory and past work that isn't currently in your context. Reads the user's memory documents and searches this conversation's full history for the terms you give. " +
      'Use it when the user references something from before ("yesterday", "that", "the thing I was doing"), asks about prior work, or the request is ambiguous and earlier context could change the answer. ' +
      "You do NOT need it for the user's name, location, or stable preferences — those are already in your context from their profile. The result carries a status: found, no_match, or retrieval_error. Do not blindly retry the same lookup after no_match.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            'What you are trying to find or resolve, in your own words. e.g. "what was the user working on yesterday afternoon".',
        },
        memorySearchTerms: {
          type: "array",
          items: { type: "string" },
          description:
            "2-8 concrete search terms from the user's wording: names, project or app names, feature names, dates, file names, error text. These are matched against past conversation text.",
        },
        limit: {
          type: "number",
          description: `Maximum transcript hits to hydrate. Defaults to ${RECALL_DEFAULT_LIMIT}; capped at ${RECALL_MAX_LIMIT}.`,
        },
      },
      required: ["prompt", "memorySearchTerms"],
    } as unknown as TSchema,
    codeEligibility: "read_only",
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const args = params as {
        prompt?: string;
        memorySearchTerms?: unknown;
        limit?: unknown;
      };
      const prompt = args.prompt?.trim() ?? "";
      if (!prompt) throw new Error("Recall needs a prompt.");
      const terms = Array.isArray(args.memorySearchTerms)
        ? args.memorySearchTerms
            .filter((term): term is string => typeof term === "string")
            .map((term) => term.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      if (terms.length === 0) {
        throw new Error(
          "memorySearchTerms is required: pass 2-8 concrete terms (names, project names, dates, file names, error text) so the search has something to match.",
        );
      }
      const requestedLimit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.trunc(args.limit)
          : RECALL_DEFAULT_LIMIT;
      const limit = Math.min(RECALL_MAX_LIMIT, Math.max(1, requestedLimit));

      const documents = await context.agentHome.readDocuments();
      signal?.throwIfAborted();
      let documentBudget = RECALL_DOCUMENT_BUDGET;
      const renderedDocuments: string[] = [];
      for (const document of documents) {
        if (document.content.length > documentBudget) continue;
        documentBudget -= document.content.length;
        renderedDocuments.push(
          buildStartupDocBlock(document.displayPath, document.content),
        );
      }

      let hits: RecallHit[] = [];
      let hydrated: HydratedRecallHit[] = [];
      let status: "found" | "no_match" | "retrieval_error" = "no_match";
      let failure = "";
      try {
        hits = context.recall.search(terms, limit).slice(0, limit);
        for (const hit of hits) {
          const records = await context.recall.hydrate(
            hit.seq,
            RECALL_WINDOW_BEFORE,
            RECALL_WINDOW_AFTER,
          );
          signal?.throwIfAborted();
          hydrated.push({ hit, records });
        }
        status = hits.length > 0 ? "found" : "no_match";
      } catch (error) {
        // A turn cancellation is control flow, not a failed memory lookup. If
        // it is flattened into retrieval_error the agent loop can continue
        // after its caller has already canceled the turn.
        signal?.throwIfAborted();
        status = "retrieval_error";
        failure =
          error instanceof Error
            ? `Searching this conversation failed: ${error.message}`
            : "Searching this conversation failed.";
      }
      if (status === "no_match" && renderedDocuments.length > 0) {
        status = "found";
      }

      const sections: string[] = [`status: ${status}`];
      if (renderedDocuments.length > 0) {
        sections.push(`Memory documents:\n${renderedDocuments.join("\n\n")}`);
      }
      if (hydrated.length > 0) {
        const renderedTranscript = renderHydratedHits(hydrated);
        if (renderedTranscript) {
          sections.push(
            `Conversation transcript matches (${hits.length}):\n${renderedTranscript}`,
          );
        }
      }
      if (failure) sections.push(failure);
      if (sections.length === 1) {
        sections.push(
          "Nothing stored matches those terms. There may simply be no prior context for this.",
        );
      }
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: {
          status,
          documentCount: renderedDocuments.length,
          matchCount: hits.length,
        },
      };
    },
  },
  {
    name: "Remember",
    label: "Remember",
    description:
      "Persist a durable fact about the user into their profile (name, location, stable preferences, ongoing situation). These facts are injected into your context at the start of every conversation, so use this for things the user would expect you to still know later — not transient task state. " +
      "action=add stores a new fact; action=replace swaps an outdated one (provide old_content); action=remove forgets one. Keep each fact short and high-signal; the profile has a size cap.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "remove"],
          description:
            "add = store a new durable fact. replace = update an existing fact (needs old_content). remove = forget a fact.",
        },
        content: {
          type: "string",
          description:
            'The durable fact, in a short self-contained sentence. e.g. "The user goes by Bob". Required for add/replace; for remove, the fact to forget.',
        },
        old_content: {
          type: "string",
          description:
            "replace only: the existing fact to overwrite (matched loosely against stored entries).",
        },
      },
      required: ["action"],
    } as unknown as TSchema,
    execute: async (toolCallId, params) => {
      const args = params as {
        action?: string;
        content?: string;
        old_content?: string;
      };
      const action = args.action?.trim() as ProfileAction | undefined;
      if (action !== "add" && action !== "replace" && action !== "remove") {
        throw new Error("action must be 'add', 'replace', or 'remove'.");
      }
      try {
        const idempotencyKey = `remember:${await sha256Hex(
          `remember\0${context.ownerGeneration}\0${context.conversationId}\0${toolCallId}`,
        )}`;
        const result = await context.agentHome.applyProfileOperation({
          action,
          ...(args.content ? { content: args.content } : {}),
          ...(args.old_content ? { oldContent: args.old_content } : {}),
          // A lost response retries the exact same write, while an owner reset
          // moves otherwise-identical conversation/tool ids into a disjoint
          // receipt namespace.
          idempotencyKey,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            success: result.ok,
            entryCount: result.entryCount,
            bytes: result.bytes,
          },
        };
      } catch (error) {
        if (error instanceof AgentHomeUnavailableError) {
          throw new Error(
            "Stella can't save memories in the cloud yet. Tell the user plainly instead of pretending it was stored.",
          );
        }
        throw error;
      }
    },
  },
];

const scheduleFromArgs = (args: {
  when?: Record<string, unknown>;
}): { schedule: Record<string, unknown>; description: string } | null => {
  const when = args.when;
  if (!when || typeof when !== "object") return null;
  const kind = typeof when.kind === "string" ? when.kind : "";
  if (kind === "at") {
    const at = typeof when.at === "string" ? Date.parse(when.at) : Number.NaN;
    if (!Number.isFinite(at)) {
      throw new Error(
        "when.at must be an ISO-8601 timestamp, e.g. 2026-07-25T09:00:00Z.",
      );
    }
    if (at < Date.now()) {
      throw new Error("when.at is in the past.");
    }
    return {
      schedule: { kind: "at", atMs: at },
      description: `once at ${new Date(at).toISOString()}`,
    };
  }
  if (kind === "every") {
    const minutes = Number(when.every_minutes);
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES) {
      throw new Error(
        `when.every_minutes must be at least ${MIN_EVERY_MINUTES}; schedules cannot run more often than that.`,
      );
    }
    const everyMs = Math.round(minutes) * 60_000;
    return {
      // Convex anchors the first committed request. Omitting a client clock
      // keeps an exact retry's intent stable after a lost response.
      schedule: { kind: "every", everyMs },
      description: `every ${Math.round(minutes)} minutes`,
    };
  }
  if (kind === "cron") {
    const expr = typeof when.expr === "string" ? when.expr.trim() : "";
    if (!expr) throw new Error("when.expr is required for a cron schedule.");
    const tz = typeof when.tz === "string" ? when.tz.trim() : "";
    return {
      schedule: { kind: "cron", expr, ...(tz ? { tz } : {}) },
      description: `cron ${expr}${tz ? ` (${tz})` : ""}`,
    };
  }
  throw new Error('when.kind must be "at", "every", or "cron".');
};

/**
 * Schedule rows carry run times as epoch milliseconds, which the model cannot
 * read; handed those raw it reports a plausible-looking wrong calendar date to
 * the user. Render them as ISO strings alongside the rest of the row.
 */
const withReadableRunTimes = (row: unknown): unknown => {
  if (typeof row !== "object" || row === null) return row;
  const source = row as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const field of ["nextRunAt", "lastRunAt", "lastErrorAt"]) {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[field] = new Date(value).toISOString();
    }
  }
  return result;
};

export const createScheduleTool = (
  context: OrchestratorToolContext,
): OrchestratorAgentTool => ({
  name: "Schedule",
  label: "Schedule",
  description:
    "Manage the user's scheduled runs: work you should do later or repeatedly without them asking again. A scheduled run wakes you in a fresh turn with the prompt you stored, so write that prompt as a standalone instruction to your future self. " +
    `action=list shows what's scheduled; create adds one; update changes a prompt, timing, or pauses/resumes it; remove deletes it. Timing is one of: a one-off ISO timestamp, a repeat interval in minutes (minimum ${MIN_EVERY_MINUTES} — nothing can run more often than that, and exact-second timing is not guaranteed), or a cron expression. ` +
    "Confirm the schedule with the user in your reply; do not silently create recurring work.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "update", "remove"],
        description: "What to do with the user's schedules.",
      },
      schedule_id: {
        type: "string",
        description:
          "Required for update and remove; comes from a prior list or create.",
      },
      prompt: {
        type: "string",
        description:
          "create/update: the instruction delivered to you when the schedule fires. Self-contained — the run has none of this conversation's context.",
      },
      description: {
        type: "string",
        description:
          "create/update: one short, user-facing sentence describing what this schedule does.",
      },
      when: {
        type: "object",
        description:
          'create/update: the timing. {"kind":"at","at":"2026-07-25T09:00:00Z"} | {"kind":"every","every_minutes":60} | {"kind":"cron","expr":"0 9 * * 1-5","tz":"America/Los_Angeles"}.',
        properties: {
          kind: { type: "string", enum: ["at", "every", "cron"] },
          at: { type: "string" },
          every_minutes: { type: "number" },
          expr: { type: "string" },
          tz: { type: "string" },
        },
        required: ["kind"],
      },
      status: {
        type: "string",
        enum: ["active", "paused"],
        description:
          "update only: pause a schedule without deleting it, or resume it.",
      },
    },
    required: ["action"],
  } as unknown as TSchema,
  execute: async (toolCallId, params, signal) => {
    const args = params as {
      action?: string;
      schedule_id?: string;
      prompt?: string;
      description?: string;
      when?: Record<string, unknown>;
      status?: string;
    };
    const action = args.action?.trim();
    if (
      action !== "list" &&
      action !== "create" &&
      action !== "update" &&
      action !== "remove"
    ) {
      throw new Error(
        'action must be "list", "create", "update", or "remove".',
      );
    }
    if (
      (action === "update" || action === "remove") &&
      !args.schedule_id?.trim()
    ) {
      throw new Error(`${action} needs a schedule_id.`);
    }
    if (action === "create" && !args.prompt?.trim()) {
      throw new Error(
        "create needs the prompt that will be delivered when it fires.",
      );
    }
    if (action === "create" && !args.when) {
      throw new Error("create needs a when.");
    }
    const timing = args.when ? scheduleFromArgs({ when: args.when }) : null;
    const requestId = await sha256Hex(
      `schedule\0${context.ownerGeneration}\0${context.conversationId}\0${toolCallId}`,
    );

    const response = await context.post(
      "/api/cloud/schedule",
      {
        ownerId: context.ownerId,
        ownerGeneration: context.ownerGeneration,
        action,
        ...(action === "list" ? {} : { requestId }),
        ...(args.schedule_id ? { scheduleId: args.schedule_id.trim() } : {}),
        ...(args.prompt ? { prompt: args.prompt.trim() } : {}),
        ...(args.description ? { description: args.description.trim() } : {}),
        ...(action === "create"
          ? { conversationId: context.conversationId }
          : {}),
        ...(timing ? { schedule: timing.schedule } : {}),
        ...(args.status ? { status: args.status } : {}),
      },
      signal,
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : `Scheduling failed (${response.status}).`,
      );
    }
    const rows = Array.isArray(payload.schedules)
      ? payload.schedules
      : payload.schedule
        ? [payload.schedule]
        : [];
    const rendered = JSON.stringify(rows.map(withReadableRunTimes)).slice(
      0,
      4_000,
    );
    const headline =
      action === "list"
        ? `${rows.length} scheduled run(s).`
        : action === "remove"
          ? "Removed."
          : `${action === "create" ? "Scheduled" : "Updated"}${
              timing ? `: ${timing.description}` : ""
            }.`;
    return {
      content: [{ type: "text", text: `${headline}\n${rendered}` }],
      details: { action, count: rows.length },
    };
  },
});
