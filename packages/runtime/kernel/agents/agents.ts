import path from "node:path";

import type { ParsedAgent } from "./types.js";
import { loadParsedAgentsFromDir } from "./markdown-agent-loader.js";

/** The engine ships no agent definitions; Stella's home extension owns them. */
export const loadBundledAgents = (): ParsedAgent[] => [];

/**
 * Join user-editable home prompt bodies with extension-owned capability
 * metadata. Kept in the engine as a generic loader primitive so home extension
 * code never imports repo-relative parser modules.
 */
export const loadHomeAgentsWithMetadata = (
  stellaDataDir: string,
  agentMetadataDir: string | URL,
): ParsedAgent[] => {
  const metadataById = new Map(
    loadParsedAgentsFromDir(agentMetadataDir).map((agent) => [agent.id, agent]),
  );
  return loadParsedAgentsFromDir(path.join(stellaDataDir, "agents")).map(
    (homeAgent) => {
      const metadata = metadataById.get(homeAgent.id);
      if (!metadata) return homeAgent;
      return {
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        systemPrompt: homeAgent.systemPrompt,
        agentTypes: metadata.agentTypes,
        ...(metadata.toolsAllowlist
          ? { toolsAllowlist: metadata.toolsAllowlist }
          : {}),
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(typeof metadata.maxAgentDepth === "number"
          ? { maxAgentDepth: metadata.maxAgentDepth }
          : {}),
      };
    },
  );
};

const agentKeys = (agent: ParsedAgent): Set<string> =>
  new Set([agent.id, ...agent.agentTypes]);

const agentsOverlap = (left: ParsedAgent, right: ParsedAgent): boolean => {
  const leftKeys = agentKeys(left);
  for (const key of agentKeys(right)) {
    if (leftKeys.has(key)) {
      return true;
    }
  }
  return false;
};

export const mergeBundledAndExtensionAgents = (
  extensionAgents: readonly ParsedAgent[],
): ParsedAgent[] => {
  const merged = loadBundledAgents();
  for (const extensionAgent of extensionAgents) {
    const index = merged.findIndex((agent) =>
      agentsOverlap(agent, extensionAgent),
    );
    if (index >= 0) {
      merged[index] = extensionAgent;
      continue;
    }
    merged.push(extensionAgent);
  }
  return merged;
};

/** Resolved when `agentType` is internal-only (not in `loadBundledAgents`). */
export const getBundledCoreAgentFallback = (
  _agentType: string,
): ParsedAgent | undefined => undefined;
