/**
 * The orchestrator's memory and scheduling tools.
 *
 * `Remember` writes the R2 agent home. Schedules remain in Convex so
 * owner-wide listing, billing, deletion, and dispatch share one control-plane
 * authority.
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
  /** POST to a Convex HTTP route with the builder service secret. */
  post: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Response>;
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

export const createMemoryTools = (
  context: OrchestratorToolContext,
): OrchestratorAgentTool[] => [
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
