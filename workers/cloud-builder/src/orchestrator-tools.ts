import {
  RECALL_DESCRIPTION,
  RECALL_PARAMETERS,
  RECALL_CONTEXT_MESSAGES,
  recallRequest,
  renderRecallExchanges,
  type RecallExchange,
  type RecallMessage,
} from "@stella/contracts/recall";

/**
 * The orchestrator's memory and scheduling tools.
 *
 * `Remember` writes the R2 agent home. `Recall` reads the canonical journal in
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
  type AgentHome,
  type ProfileAction,
} from "./agent-home.js";
import { sha256Hex } from "./hash.js";
import { extractMessageText } from "./journal.js";
import type { JournalRecord } from "./conversation-types.js";

export type OrchestratorAgentTool = AgentTool;

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

export type RecallHit = Readonly<{
  seq: number;
  turnId: string;
  role: string;
  createdAt: number;
  snippet: string;
  matchTerms?: string[];
  rank: number;
}>;

type HydratedRecallHit = Readonly<{
  hit: RecallHit;
  records: JournalRecord[];
}>;

const readJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const renderHydratedHits = (
  hydrated: readonly HydratedRecallHit[],
  scope: string,
  terms: readonly string[],
): string => {
  const exchanges: RecallExchange[] = hydrated.map(({ hit, records }) => ({
    matchedIds: [`${hit.seq}/${hit.turnId}`],
    messages: records.flatMap((record): RecallMessage[] => {
      if (
        record.kind !== "message" ||
        record.hidden ||
        (record.role !== "user" && record.role !== "assistant")
      )
        return [];
      return [
        {
          scope,
          id: `${record.seq}/${record.turnId}`,
          order: record.seq,
          atMs: record.createdAtMs,
          role: record.role,
          text: extractMessageText(record.payload),
          ...(record.seq === hit.seq ? { matchTerms: hit.matchTerms } : {}),
        },
      ];
    }),
  }));
  return renderRecallExchanges(exchanges, terms);
};

export const createMemoryTools = (
  context: OrchestratorToolContext,
): OrchestratorAgentTool[] => [
  {
    name: "Recall",
    label: "Recall",
    description: RECALL_DESCRIPTION,
    parameters: RECALL_PARAMETERS as unknown as TSchema,
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const { terms, limit } = recallRequest(params);
      let hits: RecallHit[] = [];
      let hydrated: HydratedRecallHit[] = [];
      let status: "found" | "no_match" | "retrieval_error" = "no_match";
      let failure = "";
      try {
        hits = context.recall.search(terms, limit).slice(0, limit);
        for (const hit of hits) {
          const records = await context.recall.hydrate(hit.seq, 32, 32);
          signal?.throwIfAborted();
          if (
            !records.some(
              (record) =>
                record.seq === hit.seq &&
                record.turnId === hit.turnId &&
                record.kind === "message" &&
                !record.hidden,
            )
          ) {
            throw new Error(
              "A matching message could not be loaded from the transcript.",
            );
          }
          const visible = records
            .filter(
              (record) =>
                record.kind === "message" &&
                !record.hidden &&
                (record.role === "user" || record.role === "assistant") &&
                extractMessageText(record.payload).trim(),
            )
            .sort((a, b) => a.seq - b.seq);
          hydrated.push({
            hit,
            records: [
              ...visible
                .filter((record) => record.seq < hit.seq)
                .slice(-RECALL_CONTEXT_MESSAGES),
              ...visible.filter((record) => record.seq === hit.seq),
              ...visible
                .filter((record) => record.seq > hit.seq)
                .slice(0, RECALL_CONTEXT_MESSAGES),
            ],
          });
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
      const sections: string[] = [`status: ${status}`];
      if (hydrated.length > 0) {
        const renderedTranscript = renderHydratedHits(
          hydrated,
          context.conversationId,
          terms,
        );
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
