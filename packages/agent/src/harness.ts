/**
 * The one Stella harness, whichever host opens it: the same registry,
 * settings and documents over the desktop's SQLite file or the
 * orchestrator Durable Object's SQLite.
 */
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type Agent,
  type Extension,
  type HarnessOptions,
  type HarnessSettings,
  type ModelRef,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { STELLA_PROVIDER_ID, stellaModelId } from "./provider/stella.ts";
import {
  stellaAgents,
  type AgentOrigin,
  type PlacedAgentResult,
  type PlacedAgentRun,
  type StellaAgentRecord,
  type StellaAgentsHost,
} from "./stella/agents.ts";
import { STELLA_CODING_EXTENSION, StellaCoding } from "./stella/coding.ts";
import type { StellaContextSources } from "./stella/context.ts";
import { STELLA_AGENT_TOOLS, stellaToolExtensions, type StellaToolHost } from "./stella/host-tools.ts";
import { stellaPromptExtension } from "./stella/prompt-extension.ts";

/**
 * The managed lane answers a whole completion at once, so one request may
 * legitimately run as long as the gateway lets a completion run.
 */
const MODEL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export const STELLA_DEFAULT_ALIAS = "stella/default";

export const stellaModelRef = (agentType: "orchestrator" | "general", alias = STELLA_DEFAULT_ALIAS): ModelRef => ({
  provider: STELLA_PROVIDER_ID,
  modelId: stellaModelId(agentType, alias),
});

/** Run policy shared by every Stella conversation. */
export const stellaHarnessSettings = (overrides: Partial<HarnessSettings> = {}): HarnessSettings => ({
  stream: { timeoutMs: MODEL_REQUEST_TIMEOUT_MS, maxRetries: 0 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 24_576 },
  ...overrides,
});

/** What the orchestrator runs with: its own tools, without an agent's file, shell and host tools. */
export const orchestratorAgent = (model: ModelRef) => ({
  model,
  tools: null,
  extensions: { remove: [StellaCoding, { name: STELLA_AGENT_TOOLS }] },
});

/** Whether a root conversation's agent still offers what an agent has (it was configured by an older build). */
export const offersAgentTools = (agent: Agent): boolean =>
  agent.extensions.some(
    (extension) => extension.name === STELLA_CODING_EXTENSION || extension.name === STELLA_AGENT_TOOLS,
  );

export type StellaHarnessOptions = {
  storage: Storage;
  models: Models;
  sources: StellaContextSources;
  /** Agents: where they may run and how their runs are admitted. */
  agents: StellaAgentsHost;
  /** Stella's own tools, run by the host. */
  tools?: StellaToolHost;
  /** Further extensions the host offers, after Stella's own. */
  extensions?: readonly Extension[];
  env?: HarnessOptions["env"];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
};

export type OpenStellaHarness = {
  harness: Harness;
  registry: Registry;
  /** Offer the host's tools as they are now (its catalog changed). */
  refreshTools(): void;
  /** Start an agent the host asked for (see `stellaAgents`). */
  startAgent(
    args: {
      key: string;
      description: string;
      prompt: string;
      threadId?: string;
      origin?: AgentOrigin;
      model?: ModelRef;
    },
    context: Context,
  ): Promise<{ threadId: string; existing: boolean }>;
  /** Pause one of the orchestrator's agents by thread id. */
  pauseAgent(threadId: string, context: Context): Promise<void>;
  /** The orchestrator's agents, as the app lists them. */
  agentRecords(context: Context): Promise<StellaAgentRecord[]>;
  /** A message from the user to one of the orchestrator's agents. */
  messageAgent(
    args: { key: string; threadId: string; message: string; fromOrchestrator?: boolean },
    context: Context,
  ): Promise<void>;
  /** An agent another host placed here, run to its answer. */
  runPlacedAgent(args: PlacedAgentRun, context: Context): Promise<PlacedAgentResult>;
  /** A message for an agent another host placed here; false when it is not here. */
  steerPlacedAgent(args: { key: string; agentKey: string; message: string }, context: Context): Promise<boolean>;
};

export async function openStellaHarness(options: StellaHarnessOptions, context: Context): Promise<OpenStellaHarness> {
  const registry = createRegistry();
  registry.install(stellaPromptExtension(options.sources));
  const agents = stellaAgents(options.agents);
  registry.install(agents.extension);
  registry.install(StellaCoding);
  const refreshTools = () => {
    for (const extension of stellaToolExtensions(options.tools)) registry.install(extension);
  };
  refreshTools();
  for (const extension of options.extensions ?? []) registry.install(extension);
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      settings: options.settings ?? stellaHarnessSettings(),
      ...(options.env ? { env: options.env } : {}),
      onReport: options.onReport ?? ((error) => console.error("[stella-agent]", error)),
    },
    context,
  );
  return {
    harness,
    registry,
    refreshTools,
    startAgent: (args, startContext) => agents.startAgent(harness, args, startContext),
    agentRecords: (recordsContext) => agents.agentRecords(harness, recordsContext),
    messageAgent: (args, messageContext) => agents.messageAgent(harness, args, messageContext),
    pauseAgent: (threadId, pauseContext) => agents.pauseAgentByThread(harness, threadId, pauseContext),
    runPlacedAgent: (args, runContext) => agents.runPlacedAgent(harness, args, runContext),
    steerPlacedAgent: (args, steerContext) => agents.steerPlacedAgent(harness, args, steerContext),
  };
}
