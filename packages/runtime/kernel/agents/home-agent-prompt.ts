import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { getPromptPresetSelection } from "../preferences/local-preferences.js";
import {
  DEFAULT_PROMPT_PRESET_ID,
  promptSelectionAgentId,
} from "../prompts/prompt-presets.js";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";
import { statSignature } from "../shared/fs-signature.js";

type CachedPrompt = { sig: string; body: string | undefined };

const promptCache = new Map<string, CachedPrompt>();

const agentMetadataDir = (): string =>
  process.env.STELLA_AGENT_METADATA_DIR?.trim() ||
  resolveRuntimeSourceAsset("extensions", "stella-runtime", "agent-metadata");

const readBody = async (filePath: string): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = extractFrontmatter(raw).body.trim();
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const selectedPresetPath = (
  stellaDataDir: string | undefined,
  agentType: string,
): string | null => {
  if (!stellaDataDir) return null;
  const selectionAgentId = promptSelectionAgentId(agentType);
  if (!selectionAgentId) return null;
  let presetId: string;
  try {
    presetId = getPromptPresetSelection(stellaDataDir, selectionAgentId);
  } catch {
    return null;
  }
  if (!presetId || presetId === DEFAULT_PROMPT_PRESET_ID) return null;
  return path.join(
    stellaDataDir,
    "prompts",
    selectionAgentId,
    `${presetId}.md`,
  );
};

export const loadAgentSystemPrompt = async (
  agentType: string,
  stellaDataDir?: string,
): Promise<string | undefined> => {
  const bundledPath = path.join(agentMetadataDir(), `${agentType}.md`);
  const presetPath = selectedPresetPath(stellaDataDir, agentType);

  const [bundledSig, presetSig] = await Promise.all([
    statSignature(bundledPath),
    presetPath ? statSignature(presetPath) : Promise.resolve(null),
  ]);
  if (bundledSig === null && presetSig === null) {
    promptCache.delete(bundledPath);
    return undefined;
  }

  const cacheKey = `${bundledPath}\0${presetPath ?? ""}`;
  const sig = `${bundledSig ?? "-"}|${presetSig ?? "-"}`;
  const cached = promptCache.get(cacheKey);
  if (cached && cached.sig === sig) {
    return cached.body;
  }

  let body: string | undefined;
  if (presetPath && presetSig !== null) {
    body = await readBody(presetPath);
  }
  if (body === undefined && bundledSig !== null) {
    body = await readBody(bundledPath);
  }

  promptCache.set(cacheKey, { sig, body });
  return body;
};
