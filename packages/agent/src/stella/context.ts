/**
 * What a Stella conversation's prompt is made of, read from wherever the
 * host keeps it: `~/.stella` on the desktop, the owner's world in the cloud.
 * Every reader is called per model request and must return the same text
 * for the same state, or the provider prompt cache is lost (pi-durable
 * appends a system delta for any changed section).
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";
import type { StellaPromptEnvironment } from "@stella/contracts/stella-prompts";
import type { ConversationId } from "@earendil-works/pi-durable";

/** Prompt ids from the served bundle (`/api/stella/prompts`). */
export type StellaAgentPromptId = "agents/orchestrator.md" | "agents/general.md";

export type StellaMemory = {
  /** Memory is a user preference; when off, no memory text is shown. */
  enabled: boolean;
  /** `~/.stella/core-memory.md`. */
  core?: string;
  /** `~/.stella/memories/profile.md`. */
  profile?: string;
  /** `~/.stella/memories/index.md`. */
  index?: string;
};

export type StellaContextSources = {
  readonly env: StellaPromptEnvironment;
  /** The served prompt source (front matter included), else the bundled one. */
  agentPrompt(id: StellaAgentPromptId, context: Context): Promise<string | undefined>;
  /** The user's PERSONALITY.md, else Stella's default. */
  personality(context: Context): Promise<string | undefined>;
  memory(context: Context): Promise<StellaMemory>;
  /** The rendered `<skills>` catalog block. */
  skillsCatalog(context: Context): Promise<string | undefined>;
  /** Connected devices, this conversation's destination and media access. */
  executionContext(conversationId: ConversationId, context: Context): Promise<ExecutionContextSnapshot | undefined>;
};
