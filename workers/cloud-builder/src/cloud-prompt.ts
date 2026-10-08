/**
 * Canonical cloud prompt assembly.
 *
 * The prompt set is bundled into this worker (`prompts/defaults.generated.ts`,
 * generated from the runtime sources desktop Stella ships), so a turn reads
 * it from the module with no fetch. Publishing a prompt change is a deploy.
 *
 * `orchestrator.md` is one source for every environment: what differs in the
 * cloud sits in its `<!-- when cloud -->` fences and in tool fences that
 * follow this turn's real tools (`Remember` and `history` exist only while
 * cloud memory is on), so nothing here overrides or rewrites it.
 */

import { renderStellaPrompt } from "@stella/contracts/stella-prompts";

import { buildStartupDocBlock } from "./agent-home.js";
import { bundledPrompt } from "./prompts/bundled.js";

export type CanonicalPrompts = {
  /** The raw `agents/orchestrator.md` source; rendered per turn. */
  orchestratorBody: string;
  personalityBody: string;
};

export const CANONICAL_PROMPTS: CanonicalPrompts = {
  orchestratorBody: bundledPrompt("agents/orchestrator.md"),
  personalityBody: bundledPrompt("prompts/personality.md"),
};

export const buildCloudSystemPrompt = (args: {
  canonicalBody: string;
  /** This turn's tools, as `stellaPromptTools` builds them. */
  tools: ReadonlySet<string>;
  personalityBody: string | null;
  localeDirective: string | undefined;
  residentSection: string;
  skillSection?: string;
  /** The conversation id, which is the orchestrator's thread id. */
  threadId: string;
}): string =>
  [
    renderStellaPrompt(args.canonicalBody, {
      env: "cloud",
      tools: args.tools,
    }).trimEnd(),
    args.localeDirective ?? "",
    args.personalityBody
      ? buildStartupDocBlock("~/.stella/PERSONALITY.md", args.personalityBody)
      : "",
    args.residentSection,
    args.skillSection ?? "",
    `Thread ID: ${args.threadId}`,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
