/**
 * Live, per-turn read of an agent's shipped system prompt body from the
 * bundled `stella-runtime/agent-metadata/<id>.md` definition.
 *
 * System prompts are a product surface, not a user customization point: the
 * bundle is the single source of truth, prompts ship with the app, and no
 * user file can override them. Reading live (mtime+size gated) keeps dev
 * iteration instant — editing a bundled agent file applies on the next turn
 * without an extension reload. Frontmatter is stripped; capability metadata
 * (tools, model, maxAgentDepth) always comes from the registered agent.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";
import { statSignature } from "../shared/fs-signature.js";

type CachedPrompt = { sig: string; body: string | undefined };

const promptCache = new Map<string, CachedPrompt>();

const agentMetadataDir = (): string =>
  process.env.STELLA_AGENT_METADATA_DIR?.trim() ||
  resolveRuntimeSourceAsset("extensions", "stella-runtime", "agent-metadata");

export const loadAgentSystemPrompt = async (
  agentType: string,
): Promise<string | undefined> => {
  const filePath = path.join(agentMetadataDir(), `${agentType}.md`);

  const sig = await statSignature(filePath);
  if (sig === null) {
    promptCache.delete(filePath);
    return undefined;
  }

  const cached = promptCache.get(filePath);
  if (cached && cached.sig === sig) {
    return cached.body;
  }

  let body: string | undefined;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = extractFrontmatter(raw).body.trim();
    body = parsed.length > 0 ? parsed : undefined;
  } catch {
    body = undefined;
  }

  promptCache.set(filePath, { sig, body });
  return body;
};
