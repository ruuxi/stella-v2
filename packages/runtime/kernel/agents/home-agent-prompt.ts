/**
 * Live, per-turn composition of an agent's system prompt from the system
 * mirror plus the user's customization files.
 *
 * Resolution order for agent `<id>`:
 *
 *   1. `~/.stella/agents/<id>.replace.md` — full replacement. The user (or an
 *      agent acting for them) owns the whole prompt; shipped updates to this
 *      agent no longer apply until the file is removed.
 *   2. `~/.stella/system/agents/<id>.md` — the shipped base body, plus
 *      `~/.stella/agents/<id>.md` appended under a "# User customizations"
 *      heading when present. This is the default, always-update-safe route.
 *   3. `~/.stella/agents/<id>.md` alone — a user-defined agent with no shipped
 *      counterpart.
 *
 * Every file is read live, gated by an mtime+size signature so unchanged
 * files are never re-read. Frontmatter in any of these files is stripped —
 * capability metadata (tools, model, maxAgentDepth) always comes from the
 * registered agent.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { statSignature } from "../shared/fs-signature.js";

const AGENTS_DIR_NAME = "agents";
const SYSTEM_DIR_NAME = "system";
const AGENT_PROMPT_EXTENSION = ".md";
const REPLACE_EXTENSION = ".replace.md";
const OVERLAY_HEADING = "# User customizations";

type CachedPrompt = { sig: string; body: string | undefined };

const promptCache = new Map<string, CachedPrompt>();

const readBody = async (filePath: string): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = extractFrontmatter(raw).body.trim();
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const loadHomeAgentSystemPrompt = async (
  stellaDataDir: string,
  agentType: string,
): Promise<string | undefined> => {
  const replacePath = path.join(
    stellaDataDir,
    AGENTS_DIR_NAME,
    `${agentType}${REPLACE_EXTENSION}`,
  );
  const basePath = path.join(
    stellaDataDir,
    SYSTEM_DIR_NAME,
    AGENTS_DIR_NAME,
    `${agentType}${AGENT_PROMPT_EXTENSION}`,
  );
  const overlayPath = path.join(
    stellaDataDir,
    AGENTS_DIR_NAME,
    `${agentType}${AGENT_PROMPT_EXTENSION}`,
  );

  const [replaceSig, baseSig, overlaySig] = await Promise.all([
    statSignature(replacePath),
    statSignature(basePath),
    statSignature(overlayPath),
  ]);
  const sig = `${replaceSig ?? "-"}|${baseSig ?? "-"}|${overlaySig ?? "-"}`;
  const cacheKey = `${stellaDataDir}\0${agentType}`;

  if (replaceSig === null && baseSig === null && overlaySig === null) {
    promptCache.delete(cacheKey);
    return undefined;
  }

  const cached = promptCache.get(cacheKey);
  if (cached && cached.sig === sig) {
    return cached.body;
  }

  let body: string | undefined;
  if (replaceSig !== null) {
    body = await readBody(replacePath);
  }
  if (body === undefined) {
    const [base, overlay] = await Promise.all([
      baseSig !== null ? readBody(basePath) : undefined,
      overlaySig !== null ? readBody(overlayPath) : undefined,
    ]);
    if (base && overlay) {
      body = `${base}\n\n${OVERLAY_HEADING}\n\n${overlay}`;
    } else {
      body = base ?? overlay;
    }
  }

  promptCache.set(cacheKey, { sig, body });
  return body;
};
