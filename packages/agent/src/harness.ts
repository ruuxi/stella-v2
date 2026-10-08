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
  type Extension,
  type HarnessOptions,
  type HarnessSettings,
  type ModelRef,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { STELLA_PROVIDER_ID, stellaModelId } from "./provider/stella.ts";
import type { StellaContextSources } from "./stella/context.ts";
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

export type StellaHarnessOptions = {
  storage: Storage;
  models: Models;
  sources: StellaContextSources;
  /** Tool and agent extensions the host offers, after the prompt extension. */
  extensions?: readonly Extension[];
  env?: HarnessOptions["env"];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
};

export type OpenStellaHarness = { harness: Harness; registry: Registry };

export async function openStellaHarness(options: StellaHarnessOptions, context: Context): Promise<OpenStellaHarness> {
  const registry = createRegistry();
  registry.install(stellaPromptExtension(options.sources));
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
  return { harness, registry };
}
