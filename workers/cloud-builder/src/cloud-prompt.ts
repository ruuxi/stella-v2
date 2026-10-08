/**
 * Canonical cloud prompt assembly.
 *
 * The prompt set is bundled into this worker (`prompts/defaults.generated.ts`,
 * generated from the runtime sources desktop Stella ships), so a turn reads
 * it from the module with no fetch. Publishing a prompt change is a deploy.
 *
 * `orchestrator.md` is one source for every environment: what differs in the
 * cloud sits in its `<!-- when cloud -->` fences and in tool fences that
 * follow this turn's real tools (`memory` and `history` exist only while
 * cloud memory is on), so nothing here overrides or rewrites it. Everything
 * else the model reads (personality, memory, skills, execution context) is
 * placed by the same resident registry as on the desktop.
 */

import { renderStellaPrompt } from "@stella/contracts/stella-prompts";

import type { SystemPromptSection } from "@stella/runtime/kernel/agent-runtime/frozen-context.js";
import { responseLanguageSection } from "@stella/runtime/kernel/runner/locale-prompt.js";
import {
  residentMemoryFromDocs,
  type ResidentContext,
} from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";

import type { CloudSkillCatalogSnapshot } from "./cloud-home-store.js";
import { buildCloudSkillsBlock } from "./cloud-skills.js";
import { bundledPrompt } from "./prompts/bundled.js";

export type CanonicalPrompts = {
  /** The raw `agents/orchestrator.md` source; rendered per turn. */
  orchestratorBody: string;
  personalityBody: string;
  /** The summarizer's system prompt, as on the desktop. */
  compactionSystemPrompt: string;
};

export const CANONICAL_PROMPTS: CanonicalPrompts = {
  orchestratorBody: bundledPrompt("agents/orchestrator.md"),
  personalityBody: bundledPrompt("prompts/personality.md"),
  compactionSystemPrompt: bundledPrompt("prompts/thread-compaction.md"),
};

/**
 * The orchestrator's system prompt sections, named as on the desktop. The
 * personality, memory, skills and execution context are not here: they are
 * resident blocks (`resident-context.js`), appended to the thread like on
 * every other host, so a change appends instead of rewriting the prompt.
 */
export const buildCloudSystemPromptSections = (args: {
  canonicalBody: string;
  /** This turn's tools, as `stellaPromptTools` builds them. */
  tools: ReadonlySet<string>;
  locale: string | undefined;
  /** The conversation id, which is the orchestrator's thread id. */
  threadId: string;
}): SystemPromptSection[] => {
  const language = responseLanguageSection(args.locale);
  return [
    {
      id: "instructions",
      text: renderStellaPrompt(args.canonicalBody, {
        env: "cloud",
        tools: args.tools,
      }).trim(),
    },
    ...(language ? [language] : []),
    { id: "thread-id", text: `Thread ID: ${args.threadId}` },
  ];
};

/**
 * This turn's resident values for the shared registry: the same fields a
 * desktop orchestrator turn fills, from the owner's cloud home.
 */
export const cloudResidentContext = (args: {
  personality: string;
  memoryDocuments: ReadonlyArray<{ displayPath: string; content: string }>;
  skillCatalog: CloudSkillCatalogSnapshot;
  executionContext: ExecutionContextSnapshot;
  /** Rendered roster; supplied only where the context starts. */
  agentRoster?: string;
}): Omit<ResidentContext, "threadHistory"> => ({
  personality: args.personality,
  ...residentMemoryFromDocs(args.memoryDocuments),
  skillsCatalog: buildCloudSkillsBlock(args.skillCatalog) || undefined,
  executionContext: args.executionContext,
  ...(args.agentRoster ? { agentRoster: args.agentRoster } : {}),
});
