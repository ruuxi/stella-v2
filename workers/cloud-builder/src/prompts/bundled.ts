/**
 * The bundled prompt set, read and rendered for cloud turns.
 *
 * `defaults.generated.ts` holds the raw sources desktop Stella also renders;
 * every cloud consumer goes through `renderCloudAgentPrompt` with the tools
 * its turn really has, so an edit to `agents/*.md` reaches the cloud
 * orchestrator, both cloud General paths and their engines with one deploy.
 */
import {
  renderStellaPrompt,
  stellaPromptTools,
} from "@stella/contracts/stella-prompts";

import { STELLA_PROMPT_DEFAULTS } from "./defaults.generated.js";

export const bundledPrompt = (id: string): string => {
  const prompt = STELLA_PROMPT_DEFAULTS.prompts.find(
    (candidate) => candidate.id === id,
  );
  if (!prompt) throw new Error(`Bundled prompt ${id} is missing.`);
  return prompt.content;
};

/** A cloud General agent's prompt; only the orchestrator carries `memory`. */
export const renderCloudAgentPrompt = (
  id: "agents/general.md",
  tools: Readonly<{ names: Iterable<string>; history: boolean }>,
): string =>
  renderStellaPrompt(bundledPrompt(id), {
    env: "cloud",
    tools: stellaPromptTools(tools.names, {
      history: tools.history,
      memory: false,
    }),
  });
