/**
 * The desktop's prompt material: the served prompt bundle, and the user's
 * personality, memory and skills under the Stella home (`~/.stella`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutionContextSnapshot,
  type ExecutionDestination,
  type MediaAccess,
} from "@stella/contracts/execution-context";
import { STELLA_PROMPTS_PATH } from "@stella/contracts/stella-api";
import { readOrSeedPersonality } from "@stella/runtime/kernel/personality/personality";
import { renderSkillCatalogBlock } from "@stella/runtime/kernel/shared/skill-catalog";
import type { StellaAgentPromptId, StellaContextSources, StellaMemory } from "../stella/context.ts";

const BUNDLED_PROMPTS = fileURLToPath(new URL("../../../runtime/extensions/stella-runtime/", import.meta.url));

const bundledPath = (id: StellaAgentPromptId): string =>
  path.join(BUNDLED_PROMPTS, "agent-metadata", id.replace(/^agents\//, ""));

const readOptional = async (file: string): Promise<string | undefined> => {
  try {
    const text = await readFile(file, "utf8");
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
};

type ServedPrompts = { revision: string; prompts: Map<string, string> };

/** The backend's prompt bundle, fetched once per process and refreshed in the background. */
function servedPrompts(backendUrl: string | undefined) {
  let current: ServedPrompts | undefined;
  let pending: Promise<void> | undefined;
  const refresh = async () => {
    if (!backendUrl) return;
    try {
      const response = await fetch(`${backendUrl.replace(/\/+$/, "")}${STELLA_PROMPTS_PATH}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { revision: string; prompts: { id: string; content: string }[] };
      current = { revision: body.revision, prompts: new Map(body.prompts.map((prompt) => [prompt.id, prompt.content])) };
    } catch {
      // Offline: the bundled prompt serves until the next refresh.
    }
  };
  return async (id: string): Promise<string | undefined> => {
    if (current === undefined) await (pending ??= refresh().finally(() => (pending = undefined)));
    return current?.prompts.get(id);
  };
}

export type DesktopSourcesOptions = {
  /** The Stella home, `~/.stella` in the installed app. */
  stellaHome: string;
  backendUrl?: string;
  memoryEnabled?: () => boolean;
  /** This device, where a desktop conversation runs. */
  destination: ExecutionDestination;
  media?: () => MediaAccess | undefined;
};

export function desktopContextSources(options: DesktopSourcesOptions): StellaContextSources {
  const served = servedPrompts(options.backendUrl);
  return {
    env: "desktop",
    agentPrompt: async (id) => (await served(id)) ?? (await readOptional(bundledPath(id))),
    personality: async () => readOrSeedPersonality(options.stellaHome) || undefined,
    memory: async (): Promise<StellaMemory> => {
      if (options.memoryEnabled?.() === false) return { enabled: false };
      const [core, profile, index] = await Promise.all([
        readOptional(path.join(options.stellaHome, "core-memory.md")),
        readOptional(path.join(options.stellaHome, "memories", "profile.md")),
        readOptional(path.join(options.stellaHome, "memories", "index.md")),
      ]);
      return { enabled: true, ...(core ? { core } : {}), ...(profile ? { profile } : {}), ...(index ? { index } : {}) };
    },
    skillsCatalog: async () => renderSkillCatalogBlock(options.stellaHome),
    executionContext: async () =>
      createExecutionContextSnapshot({
        devices: null,
        destination: options.destination,
        media: options.media?.(),
      }),
  };
}
