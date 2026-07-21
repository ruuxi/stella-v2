/**
 * Dream Protocol scheduler.
 *
 * Dream consolidation is driven by orchestrator context growth, not by
 * per-event pings:
 *   - `token_interval`  — the orchestrator thread has grown ~`tokenInterval`
 *                         tokens since the last run (default 20k). Keeps
 *                         durable memory reasonably fresh during normal use.
 *   - `pre_compaction`  — the orchestrator thread is about to compact; flush a
 *                         consolidation so anything accumulated since the last
 *                         interval is folded before the middle is summarized.
 *   - `startup_catchup` — app just started; drain anything left over from a
 *                         previous session that ended before consolidating.
 *   - `manual`          — user clicked "Run Dream now".
 *
 * Eligibility: there must be unprocessed Dream-inbox rows (thread summaries,
 * memory notes, chronicle digests). `token_interval` additionally requires the
 * ~`tokenInterval` growth; `pre_compaction`, `startup_catchup`, and `manual`
 * run whenever anything is pending. Dream reads the durable inbox (not the
 * live transcript), so its cadence is independent of compaction — the
 * orchestrator already holds recent context in-window, so nothing needs to be
 * forced into durable memory until it grows past the interval or is about to
 * compact.
 *
 * Single-flight: only one Dream run may execute at a time, via a mkdir lock
 * under `.stella/locks/dream/`.
 *
 * Most callers `void maybeSpawnDreamRun(...)` and never await it. The bounded
 * pre-compaction ordering is the deliberate exception: it may join the
 * supervised completion promise, but can never wait past its hard timeout.
 * The spawned run is not an orphan: it executes under a supervising fiber
 * (`SupervisedScope`) keyed by data dir. `shutdownDreamRuns` interrupts the
 * in-flight run (aborting its LLM calls) and joins its teardown — the
 * `finally` below releases the filesystem lock and clears `inFlight` before
 * shutdown proceeds.
 */

import fs from "node:fs";
import path from "node:path";

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../../ai/types.js";
import {
  ensureDreamMemoryLayout,
  memoryFilePath,
  memoryMapPath,
  memoryShadowPath,
  memoriesRoot,
  MEMORY_MAP_FILE,
  MEMORY_MAP_MAX_CHARS,
  MEMORY_MAP_MAX_ENTRIES,
  MEMORY_MAP_STALE_DAYS,
} from "../memory/dream-storage.js";
import { rotateMemoryFileIfNeeded } from "../memory/memory-rotation.js";
import {
  getResolvedLlmApiKey,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import { dreamTool } from "../tools/defs/dream.js";
import { readTool } from "../tools/defs/read.js";
import { strReplaceTool } from "../tools/defs/str-replace.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { readHomePrompt } from "../prompts/home-prompts.js";
import {
  createSupervisedScope,
  type SupervisedScope,
} from "../shared/supervised-scope.js";
import { buildDurableMemoryReference } from "../thread-runtime.js";
import {
  appendToShadowLog,
  buildDreamDeltaTranscript,
  buildDreamShadowSystemPrompt,
  buildDreamShadowUserPrompt,
  DREAM_DELTA_LOAD_LIMIT,
  formatShadowLogEntry,
  shadowWindowIdentity,
  type DreamDeltaSourceMessage,
} from "./dream-delta.js";
import {
  canonicalFileWriteLockPath,
  withFileWriteLock,
  writeFileAtomicWithVerify,
} from "../tools/file-write-lock.js";

const logger = createRuntimeLogger("agent-runtime.dream-scheduler");

const DEFAULT_TOKEN_INTERVAL = 20_000;
const MAX_ITERATIONS = 12;

/**
 * Batch 6 rollout gates. Shadow validation is staged on; the production
 * delta path is deliberately compile-time disabled and cannot be enabled by
 * config until a later certified cutover batch changes this constant.
 */
export const DREAM_DELTA_SHADOW_DEFAULT_ENABLED = true;
export const DREAM_PRODUCTION_DELTA_CUTOVER_ENABLED = false;

/**
 * Supervising fiber scope per data dir. Recreated lazily after a shutdown so
 * a restarted runner can schedule Dream again.
 */
const DREAM_SCOPES = new Map<string, SupervisedScope>();

const dreamScopeFor = (stellaDataDir: string): SupervisedScope => {
  const existing = DREAM_SCOPES.get(stellaDataDir);
  if (existing && !existing.closed()) return existing;
  const scope = createSupervisedScope(`dream:${stellaDataDir}`);
  DREAM_SCOPES.set(stellaDataDir, scope);
  return scope;
};

/**
 * Interrupt any in-flight Dream run for `stellaDataDir` (all dirs when
 * omitted) and resolve once its teardown — lock release, `inFlight` clear —
 * has completed. Called from runner shutdown.
 */
export const shutdownDreamRuns = async (
  stellaDataDir?: string,
): Promise<void> => {
  const closing: Array<Promise<void>> = [];
  for (const [dir, scope] of DREAM_SCOPES) {
    if (stellaDataDir !== undefined && dir !== stellaDataDir) continue;
    DREAM_SCOPES.delete(dir);
    closing.push(scope.close("runtime-shutdown"));
  }
  await Promise.all(closing);
};

type DreamConfig = {
  enabled: boolean;
  tokenInterval: number;
  deltaShadow: boolean;
};

type DreamRunOutcome = {
  /** True only when the provider pass reached a clean terminal response. */
  completed: boolean;
};

type DreamRuntimeState = {
  inFlight: boolean;
  lastRunAt: number;
  /** Orchestrator token estimate captured at the last Dream run. */
  tokensAtLastRun: number;
  baselineHydrated: boolean;
  /** Settled or live run handle; never rejects. */
  completion: Promise<DreamRunOutcome> | null;
};

const RUNTIME_STATE = new Map<string, DreamRuntimeState>();

const stateFor = (stellaDataDir: string): DreamRuntimeState => {
  let state = RUNTIME_STATE.get(stellaDataDir);
  if (!state) {
    state = {
      inFlight: false,
      lastRunAt: 0,
      tokensAtLastRun: 0,
      baselineHydrated: false,
      completion: null,
    };
    RUNTIME_STATE.set(stellaDataDir, state);
  }
  return state;
};

const lockDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "locks", "dream");

const fileMtimeMs = (filePath: string): number => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
};

const acquireLock = (stellaDataDir: string): (() => void) | null => {
  const dir = lockDir(stellaDataDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    return () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      logger.debug("dream.lock-error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    // Stale lock check: remove if older than 30 min.
    try {
      const stat = fs.statSync(dir);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        return acquireLock(stellaDataDir);
      }
    } catch {
      // ignore
    }
    return null;
  }
};

const readPendingFrontierSafe = (store: RuntimeStore): number => {
  try {
    const frontier = store.dreamInboxStore.pendingFrontier();
    return Number.isFinite(frontier) && frontier > 0 ? frontier : 0;
  } catch {
    return 0;
  }
};

const readProcessedFrontierSafe = (
  store: RuntimeStore,
  sinceMs: number,
): number | null => {
  try {
    const value =
      store.dreamInboxStore.maxProcessedSourceUpdatedAtSince(sinceMs);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return null;
  }
};

const readDeltaWatermarkSafe = (
  store: RuntimeStore,
  conversationId: string,
): number | null => {
  try {
    const value = store.dreamInboxStore.readDeltaWatermark(conversationId);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
};

const advanceDeltaWatermarkSafe = (
  store: RuntimeStore,
  conversationId: string,
  throughTs: number,
): void => {
  try {
    store.dreamInboxStore.advanceDeltaWatermark(conversationId, throughTs);
  } catch (error) {
    logger.debug("dream.delta-watermark-write-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const loadRawOrchestratorMessagesSafe = (
  store: RuntimeStore,
  conversationId: string,
): DreamDeltaSourceMessage[] => {
  try {
    return store.loadRawThreadMessagesWithEntryTypes(
      conversationId,
      DREAM_DELTA_LOAD_LIMIT,
    );
  } catch {
    return [];
  }
};

const readDreamConfig = (stellaDataDir: string): DreamConfig => {
  const configPath = path.join(stellaDataDir, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { dream?: Partial<DreamConfig> };
    const dream = parsed.dream ?? {};
    return {
      // Dream is on by default and consolidates the Dream inbox into the
      // durable on-disk memory layout. It is independent of Live Memory
      // (Chronicle screen capture); the only way it stays off is if the
      // user explicitly sets `dream.enabled: false` in `.stella/config.json`.
      enabled: dream.enabled !== false,
      tokenInterval:
        typeof dream.tokenInterval === "number" && dream.tokenInterval > 0
          ? Math.floor(dream.tokenInterval)
          : DEFAULT_TOKEN_INTERVAL,
      deltaShadow: dream.deltaShadow !== false,
    };
  } catch {
    return {
      enabled: true,
      tokenInterval: DEFAULT_TOKEN_INTERVAL,
      deltaShadow: DREAM_DELTA_SHADOW_DEFAULT_ENABLED,
    };
  }
};

export const buildDreamSystemPrompt = (stellaDataDir: string): string =>
  [
    readHomePrompt(stellaDataDir, "dream-scheduled") ?? "",
    [
      `Routing map contract (authoritative — supersedes any earlier instructions about memory_summary.md or memory_index.md): maintain ~/.stella/memories/${MEMORY_MAP_FILE} on every consolidation pass.`,
      "memory_summary.md and memory_index.md are retired and read-only; never write to them. The map replaced both.",
      `${MEMORY_MAP_FILE} is pointer-only routing: what memory contains and where to find it. Durable facts stay in MEMORY.md; profile.md stays exclusively Remember-owned.`,
      `Stage unpromoted durable constraints only under "## Derived constraints", tagged [derived YYYY-MM-DD]; never edit profile.md.`,
      `Hard budget: at most ${MEMORY_MAP_MAX_ENTRIES} entries and ${MEMORY_MAP_MAX_CHARS} injected characters; both caps are mechanically enforced. Over-cap writes are rejected. On every pass, merge or prune entries older than ${MEMORY_MAP_STALE_DAYS} days unless current inbox usage_count/last_usage proves they remain useful.`,
      "Edit only between DREAM:MAP_START / DREAM:MAP_END and DREAM:DERIVED_START / DREAM:DERIVED_END with StrReplace. Prefer entries with higher usage_count or recent last_usage.",
      "Never put secrets, credentials, tokens, private keys, auth headers, or sensitive personal data in the map.",
    ].join(" "),
    [
      "MEMORY.md lifecycle contract: supersede, don't append. Keep one active block per workstream and rewrite it in place as outcomes evolve.",
      "Text removed from MEMORY.md is preserved automatically in memories/archive/MEMORY-superseded.md before the edit lands, so do not retain stale duplicate blocks as a backup.",
      "The runtime rotates old dated blocks into quarterly memories/archive files when MEMORY.md exceeds its size threshold. Archive files are Recall-visible and read-only to you; never edit or delete them.",
    ].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

const buildDreamTools = (): Tool[] =>
  [dreamTool, readTool, strReplaceTool].map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters as Tool["parameters"],
  }));

const toToolResultMessage = (
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  isError,
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const runDream = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  /** Aborts in-flight LLM calls and stops the loop on runner shutdown. */
  abortSignal?: AbortSignal;
}): Promise<DreamRunOutcome> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: args.stellaDataDir,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : await getResolvedLlmApiKey(args.resolvedLlm);
  if (
    !useClaudeCode &&
    !apiKey &&
    !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
  ) {
    logger.debug("dream.skipped.no-api-key");
    return { completed: false };
  }

  await ensureDreamMemoryLayout(args.stellaDataDir);

  const tools = buildDreamTools();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: 'Run the Dream consolidation pass. Start by calling Dream with action="list".',
        },
      ],
      timestamp: Date.now(),
    },
  ];
  let totalToolCalls = 0;

  if (useClaudeCode) {
    try {
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaDataDir,
        agentType: AGENT_IDS.DREAM,
        stellaModel: args.resolvedLlm.model.id,
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
        context: {
          systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
          messages,
          tools,
        },
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          totalToolCalls += 1;
          const dispatch = await dispatchLocalTool(toolName, toolArgs, {
            conversationId: "dream",
            store: {
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: { stellaDataDir: args.stellaDataDir },
          });
          if (!dispatch.handled) {
            return {
              error: JSON.stringify({
                success: false,
                error: `Tool ${toolName} not available to the Dream agent.`,
              }),
            };
          }
          return { result: dispatch.text };
        },
      });
      logger.debug("dream.completed", {
        iterations: 1,
        toolCalls: totalToolCalls,
        finalText: finalText.slice(0, 80),
      });
      return { completed: true };
    } catch (error) {
      logger.debug("dream.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    }
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    if (args.abortSignal?.aborted) {
      logger.debug("dream.aborted", { iterations: iteration });
      return { completed: false };
    }
    const context: Context = {
      systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
      messages,
      tools,
    };

    let response: AssistantMessage;
    try {
      response = await completeSimple(args.resolvedLlm.model, context, {
        ...(apiKey ? { apiKey } : {}),
        ...(args.abortSignal ? { signal: args.abortSignal } : {}),
      });
    } catch (error) {
      logger.debug("dream.completeSimple.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    }

    if (response.stopReason !== "stop" && response.stopReason !== "toolUse") {
      logger.debug("dream.unclean-terminal", {
        stopReason: response.stopReason,
        error: response.errorMessage,
      });
      return { completed: false };
    }

    messages.push(response);

    const toolCalls = response.content.filter(
      (part): part is ToolCall => part.type === "toolCall",
    );

    if (toolCalls.length === 0) {
      if (response.stopReason !== "stop") {
        logger.debug("dream.terminal-without-tool-call", {
          stopReason: response.stopReason,
        });
        return { completed: false };
      }
      logger.debug("dream.completed", {
        iterations: iteration + 1,
        toolCalls: totalToolCalls,
        finalText: readAssistantText(response).slice(0, 80),
      });
      return { completed: true };
    }
    if (response.stopReason !== "toolUse") {
      logger.debug("dream.tool-call-without-tool-terminal", {
        stopReason: response.stopReason,
        toolCalls: toolCalls.length,
      });
      return { completed: false };
    }

    for (const toolCall of toolCalls) {
      if (args.abortSignal?.aborted) {
        logger.debug("dream.aborted", { iterations: iteration + 1 });
        return { completed: false };
      }
      totalToolCalls += 1;
      try {
        const dispatch = await dispatchLocalTool(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          {
            conversationId: "dream",
            store: {
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: { stellaDataDir: args.stellaDataDir },
          },
        );
        if (!dispatch.handled) {
          messages.push(
            toToolResultMessage(
              toolCall,
              JSON.stringify({
                success: false,
                error: `Tool ${toolCall.name} not available to the Dream agent.`,
              }),
              true,
            ),
          );
          continue;
        }
        messages.push(toToolResultMessage(toolCall, dispatch.text, false));
      } catch (error) {
        messages.push(
          toToolResultMessage(
            toolCall,
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            true,
          ),
        );
      }
    }
  }

  logger.debug("dream.iteration-cap", {
    iterations: MAX_ITERATIONS,
    toolCalls: totalToolCalls,
  });
  return { completed: false };
};

export type SpawnDreamTrigger =
  | "token_interval"
  | "pre_compaction"
  | "startup_catchup"
  | "manual";

export type SpawnDreamArgs = {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  trigger: SpawnDreamTrigger;
  /**
   * Orchestrator thread token estimate for this finalize. Required for
   * `token_interval` gating (growth since the last run); ignored by other
   * triggers, which run whenever anything is pending.
   */
  orchestratorTokenEstimate?: number;
  /** Root orchestrator conversation whose raw durable delta is shadowed. */
  conversationId?: string;
};

export type SpawnDreamResultReason =
  | "scheduled"
  | "disabled"
  | "in_flight"
  | "count_failed"
  | "no_inputs"
  | "below_threshold"
  | "lock_busy"
  | "no_api_key"
  | "unavailable";

export type SpawnDreamResult = {
  scheduled: boolean;
  reason: SpawnDreamResultReason;
  pendingItems: number;
  detail?: string;
};

/**
 * Decide whether to fire a Dream run, then fire it asynchronously. Never
 * throws; never blocks the caller.
 */
export const maybeSpawnDreamRun = async (
  args: SpawnDreamArgs,
): Promise<SpawnDreamResult> => {
  const config = readDreamConfig(args.stellaDataDir);
  if (!config.enabled && args.trigger !== "manual") {
    return {
      scheduled: false,
      reason: "disabled",
      pendingItems: 0,
    };
  }

  const state = stateFor(args.stellaDataDir);
  if (state.inFlight) {
    return {
      scheduled: false,
      reason: "in_flight",
      pendingItems: 0,
    };
  }

  let pendingItems = 0;
  try {
    pendingItems = args.store.dreamInboxStore.countUnprocessed();
  } catch (error) {
    logger.debug("dream.count-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      scheduled: false,
      reason: "count_failed",
      pendingItems: 0,
    };
  }

  if (pendingItems === 0) {
    return {
      scheduled: false,
      reason: "no_inputs",
      pendingItems,
    };
  }

  // `token_interval` is the only gated trigger; `pre_compaction`,
  // `startup_catchup`, and `manual` run whenever there is pending material.
  // The interval baseline follows compaction down: if the estimate dropped
  // below the last baseline (a compaction shrank the thread), reset the
  // baseline so growth is measured from the new floor rather than never
  // re-arming.
  if (args.trigger === "token_interval") {
    if (!state.baselineHydrated) {
      state.baselineHydrated = true;
      try {
        state.tokensAtLastRun =
          args.store.dreamInboxStore.readTokenBaseline() ??
          state.tokensAtLastRun;
      } catch {
        // Scheduling-only state; a missing baseline safely costs one pass.
      }
    }
    const estimate = args.orchestratorTokenEstimate;
    if (typeof estimate === "number" && estimate < state.tokensAtLastRun) {
      state.tokensAtLastRun = estimate;
      try {
        args.store.dreamInboxStore.writeTokenBaseline(estimate);
      } catch {
        // scheduling bookkeeping only
      }
    }
    const growth =
      typeof estimate === "number" ? estimate - state.tokensAtLastRun : 0;
    if (growth < config.tokenInterval) {
      return {
        scheduled: false,
        reason: "below_threshold",
        pendingItems,
      };
    }
  }

  const apiKey = await getResolvedLlmApiKey(args.resolvedLlm);
  if (!apiKey && !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)) {
    logger.debug("dream.skipped.no-api-key");
    return {
      scheduled: false,
      reason: "no_api_key",
      pendingItems,
    };
  }

  const release = acquireLock(args.stellaDataDir);
  if (!release) {
    logger.debug("dream.lock-busy");
    return {
      scheduled: false,
      reason: "lock_busy",
      pendingItems,
    };
  }
  state.inFlight = true;

  const controller = new AbortController();
  const memoryMtimeBefore = fileMtimeMs(memoryFilePath(args.stellaDataDir));
  const mapMtimeBefore = fileMtimeMs(memoryMapPath(args.stellaDataDir));
  const frontierAtStart = readPendingFrontierSafe(args.store);
  const passStartedAt = Date.now();
  const completion = runDream({
    stellaDataDir: args.stellaDataDir,
    store: args.store,
    resolvedLlm: args.resolvedLlm,
    abortSignal: controller.signal,
  })
    .catch((error): DreamRunOutcome => {
      logger.debug("dream.run-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { completed: false };
    })
    .then(async (outcome) => {
      if (outcome.completed && frontierAtStart > 0) {
        const processedFrontier = readProcessedFrontierSafe(
          args.store,
          passStartedAt,
        );
        const advanceTo =
          processedFrontier === null
            ? frontierAtStart
            : Math.min(frontierAtStart, processedFrontier);
        try {
          if (advanceTo > 0) {
            args.store.dreamInboxStore.writeConsolidationWatermark({
              frontier: advanceTo,
            });
          }
        } catch (error) {
          logger.debug("dream.watermark-write-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          const rotation = await rotateMemoryFileIfNeeded(args.stellaDataDir);
          if (rotation) logger.info("dream.memory-rotation", rotation);
        } catch (error) {
          logger.warn("dream.memory-rotation-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (outcome.completed) {
        try {
          const { deleted } = args.store.dreamInboxStore.gcProcessedRows();
          if (deleted > 0) logger.info("dream.inbox-gc", { deleted });
        } catch (error) {
          logger.debug("dream.inbox-gc-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcome;
    })
    .finally(() => {
      state.inFlight = false;
      state.lastRunAt = Date.now();
      if (typeof args.orchestratorTokenEstimate === "number") {
        state.tokensAtLastRun = args.orchestratorTokenEstimate;
        try {
          args.store.dreamInboxStore.writeTokenBaseline(
            args.orchestratorTokenEstimate,
          );
        } catch {
          // scheduling bookkeeping only
        }
      }
      const memoryChanged =
        fileMtimeMs(memoryFilePath(args.stellaDataDir)) !== memoryMtimeBefore;
      const mapChanged =
        fileMtimeMs(memoryMapPath(args.stellaDataDir)) !== mapMtimeBefore;
      if (memoryChanged && !mapChanged) {
        logger.warn("dream.memory-map.stale", {
          detail: `Dream updated MEMORY.md without updating ${MEMORY_MAP_FILE}`,
        });
      }
      release();
    });
  state.completion = completion;
  // The caller still never awaits the run, but it is supervised: shutdown
  // interrupts it (aborting the LLM calls) and joins the `finally` above so
  // the lock and in-flight flag are released before teardown continues.
  dreamScopeFor(args.stellaDataDir).supervise({
    label: `dream-run:${args.trigger}`,
    abort: (reason) => controller.abort(reason),
    settled: completion,
  });

  // Shadow-only staged delta: outside the live completion so compaction never
  // waits on diagnostics. It starts only after a clean inbox pass and uses a
  // separate supervised abort handle. The compile-time production cutover
  // gate above remains false; no shadow proposal can mutate durable memory.
  if (config.deltaShadow && args.conversationId) {
    const shadowController = new AbortController();
    const shadow = completion
      .then(async (outcome) => {
        if (!outcome.completed) return;
        await runDreamDeltaShadow({
          stellaDataDir: args.stellaDataDir,
          store: args.store,
          resolvedLlm: args.resolvedLlm,
          conversationId: args.conversationId!,
          liveMemoryChanged:
            fileMtimeMs(memoryFilePath(args.stellaDataDir)) !==
            memoryMtimeBefore,
          liveMapChanged:
            fileMtimeMs(memoryMapPath(args.stellaDataDir)) !== mapMtimeBefore,
          abortSignal: shadowController.signal,
        });
      })
      .catch((error) => {
        logger.debug("dream.delta-shadow.spawn-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    dreamScopeFor(args.stellaDataDir).supervise({
      label: "dream-delta-shadow",
      abort: (reason) => shadowController.abort(reason),
      settled: shadow,
    });
  }

  return {
    scheduled: true,
    reason: "scheduled",
    pendingItems,
  };
};

export type DreamShadowOutcome =
  | "completed"
  | "bootstrapped"
  | "skipped_empty"
  | "skipped_busy"
  | "skipped_unsupported"
  | "timed_out"
  | "aborted"
  | "failed";

export const DREAM_SHADOW_TIMEOUT_MS = 180_000;
const SHADOW_IN_FLIGHT = new Set<string>();

const raceShadow = async <T>(args: {
  promise: Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T | "timed_out" | "aborted"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const competitors: Array<Promise<T | "timed_out" | "aborted">> = [
    args.promise,
    new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), args.timeoutMs);
    }),
  ];
  if (args.signal) {
    competitors.push(
      new Promise<"aborted">((resolve) => {
        if (args.signal?.aborted) return resolve("aborted");
        onAbort = () => resolve("aborted");
        args.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(competitors);
  } finally {
    clearTimeout(timer);
    if (onAbort) args.signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Shadow validation only. It derives a bounded proposal from raw messages,
 * atomically records it, and then advances coverage. The write-before-
 * watermark order makes restart recovery at-least-once; a stable window
 * identity makes the retry idempotent if the crash landed the log first.
 */
export const runDreamDeltaShadow = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  conversationId: string;
  liveMemoryChanged: boolean;
  liveMapChanged: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<DreamShadowOutcome> => {
  let scopeKey: string;
  try {
    scopeKey = fs.realpathSync(args.stellaDataDir);
  } catch {
    scopeKey = path.resolve(args.stellaDataDir);
  }
  if (SHADOW_IN_FLIGHT.has(scopeKey)) return "skipped_busy";
  SHADOW_IN_FLIGHT.add(scopeKey);
  try {
    if (args.abortSignal?.aborted) return "aborted";
    const watermark = readDeltaWatermarkSafe(args.store, args.conversationId);
    if (watermark === null) return "skipped_unsupported";
    const messages = loadRawOrchestratorMessagesSafe(
      args.store,
      args.conversationId,
    );
    if (messages.length === 0) return "skipped_empty";
    if (watermark === 0) {
      const bootstrap = buildDreamDeltaTranscript(messages, 0);
      if (bootstrap.newestMessageTs > 0) {
        advanceDeltaWatermarkSafe(
          args.store,
          args.conversationId,
          bootstrap.newestMessageTs,
        );
      }
      logger.info("dream.delta-shadow.bootstrapped", {
        conversationId: args.conversationId,
        watermark: bootstrap.newestMessageTs,
      });
      return "bootstrapped";
    }

    const delta = buildDreamDeltaTranscript(messages, watermark);
    if (!delta.transcript || delta.coveredThroughTs <= watermark) {
      return "skipped_empty";
    }
    const identity = shadowWindowIdentity({
      conversationId: args.conversationId,
      sinceTs: watermark,
      coveredThroughTs: delta.coveredThroughTs,
    });
    const shadowPath = memoryShadowPath(args.stellaDataDir);
    try {
      const landed = await fs.promises.readFile(shadowPath, "utf-8");
      if (landed.includes(identity)) {
        advanceDeltaWatermarkSafe(
          args.store,
          args.conversationId,
          delta.coveredThroughTs,
        );
        logger.info("dream.delta-shadow.recovered-landed-window", {
          conversationId: args.conversationId,
          watermarkTo: delta.coveredThroughTs,
        });
        return "completed";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
      stellaAppDir: args.stellaDataDir,
      modelId: args.resolvedLlm.model.id,
    });
    const apiKey = useClaudeCode
      ? undefined
      : await getResolvedLlmApiKey(args.resolvedLlm);
    if (
      !useClaudeCode &&
      !apiKey &&
      !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
    ) {
      return "failed";
    }
    const systemPrompt = buildDreamShadowSystemPrompt();
    const messagesForModel: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildDreamShadowUserPrompt({
              transcript: delta.transcript,
              sinceIso: new Date(watermark).toISOString(),
              alreadyKnown: buildDurableMemoryReference(args.stellaDataDir),
            }),
          },
        ],
        timestamp: Date.now(),
      },
    ];
    const derive = async (): Promise<string> => {
      if (useClaudeCode) {
        return await runClaudeCodeAgentTextCompletion({
          stellaAppDir: args.stellaDataDir,
          agentType: AGENT_IDS.DREAM,
          stellaModel: args.resolvedLlm.model.id,
          ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
          context: { systemPrompt, messages: messagesForModel, tools: [] },
        });
      }
      const response = await completeSimple(
        args.resolvedLlm.model,
        { systemPrompt, messages: messagesForModel, tools: [] },
        {
          ...(apiKey ? { apiKey } : {}),
          ...(args.abortSignal ? { signal: args.abortSignal } : {}),
        },
      );
      if (response.stopReason !== "stop") {
        throw new Error(`unclean shadow terminal: ${response.stopReason}`);
      }
      return readAssistantText(response);
    };
    const derivation = derive();
    void derivation.catch(() => undefined);
    const raced = await raceShadow({
      promise: derivation,
      timeoutMs: Math.max(1, args.timeoutMs ?? DREAM_SHADOW_TIMEOUT_MS),
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
    });
    if (raced === "timed_out" || raced === "aborted") return raced;
    if (!raced.trim()) return "failed";

    const entry = formatShadowLogEntry({
      nowIso: new Date().toISOString(),
      conversationId: args.conversationId,
      sinceTs: watermark,
      coveredThroughTs: delta.coveredThroughTs,
      includedMessages: delta.includedMessages,
      transcriptChars: Array.from(delta.transcript).length,
      truncated: delta.truncated,
      liveMemoryChanged: args.liveMemoryChanged,
      liveMapChanged: args.liveMapChanged,
      proposal: raced,
    });
    await fs.promises.mkdir(memoriesRoot(args.stellaDataDir), {
      recursive: true,
    });
    const lockPath = await canonicalFileWriteLockPath(shadowPath);
    await withFileWriteLock(lockPath, async () => {
      let existing: string | null = null;
      try {
        existing = await fs.promises.readFile(lockPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing?.includes(identity)) return;
      await writeFileAtomicWithVerify(
        lockPath,
        appendToShadowLog(existing, entry),
      );
    });
    advanceDeltaWatermarkSafe(
      args.store,
      args.conversationId,
      delta.coveredThroughTs,
    );
    logger.info("dream.delta-shadow.completed", {
      conversationId: args.conversationId,
      watermarkFrom: watermark,
      watermarkTo: delta.coveredThroughTs,
      includedMessages: delta.includedMessages,
      truncated: delta.truncated,
      productionCutover: DREAM_PRODUCTION_DELTA_CUTOVER_ENABLED,
    });
    return "completed";
  } catch (error) {
    logger.debug("dream.delta-shadow.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return args.abortSignal?.aborted ? "aborted" : "failed";
  } finally {
    SHADOW_IN_FLIGHT.delete(scopeKey);
  }
};

export const DREAM_PRE_COMPACTION_TIMEOUT_MS = 180_000;

export type PreCompactionConsolidationOutcome =
  | "consolidated"
  | "incomplete"
  | "timed_out"
  | "aborted"
  | "skipped_fresh"
  | "not_started"
  | "failed";

export type PreCompactionConsolidationResult = {
  outcome: PreCompactionConsolidationOutcome;
  pendingItems: number;
  waitedMs: number;
  detail?: string;
};

const raceDreamCompletion = async (args: {
  completion: Promise<DreamRunOutcome>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<DreamRunOutcome | "timed_out" | "aborted"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const competitors: Array<
      Promise<DreamRunOutcome | "timed_out" | "aborted">
    > = [
      args.completion,
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), args.timeoutMs);
      }),
    ];
    if (args.abortSignal) {
      competitors.push(
        new Promise<"aborted">((resolve) => {
          if (args.abortSignal?.aborted) {
            resolve("aborted");
            return;
          }
          onAbort = () => resolve("aborted");
          args.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(competitors);
  } finally {
    clearTimeout(timer);
    if (onAbort) args.abortSignal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Give Dream one bounded opportunity to consolidate the pending frontier
 * before durable history is folded. Every result authorizes compaction to
 * continue; a timed-out Dream run remains supervised and may finish later.
 */
export const awaitPreCompactionConsolidation = async (args: {
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  conversationId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<PreCompactionConsolidationResult> => {
  const startedAt = Date.now();
  const finish = (
    outcome: PreCompactionConsolidationOutcome,
    pendingItems: number,
    detail?: string,
  ): PreCompactionConsolidationResult => {
    const result = {
      outcome,
      pendingItems,
      waitedMs: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
    };
    logger.info("dream.pre-compaction", result);
    return result;
  };

  try {
    let pendingItems = 0;
    try {
      pendingItems = args.store.dreamInboxStore.countUnprocessed();
    } catch {
      return finish("skipped_fresh", 0, "inbox unavailable");
    }
    const frontier = readPendingFrontierSafe(args.store);
    if (pendingItems === 0 || frontier === 0) {
      return finish("skipped_fresh", pendingItems, "nothing pending");
    }
    let watermark: { frontier: number } | null = null;
    try {
      watermark = args.store.dreamInboxStore.readConsolidationWatermark();
    } catch {
      watermark = null;
    }
    if (watermark && watermark.frontier >= frontier) {
      return finish(
        "skipped_fresh",
        pendingItems,
        "completed pass covers pending frontier",
      );
    }

    const state = stateFor(args.stellaDataDir);
    const completionBeforeSpawn = state.completion;
    let completion = state.inFlight ? state.completion : null;
    let joined = completion !== null;
    if (!completion) {
      const spawn = await maybeSpawnDreamRun({
        stellaDataDir: args.stellaDataDir,
        store: args.store,
        resolvedLlm: args.resolvedLlm,
        trigger: "pre_compaction",
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      });
      if (spawn.scheduled) {
        completion = state.completion;
      } else if (
        state.completion &&
        state.completion !== completionBeforeSpawn
      ) {
        completion = state.completion;
        joined = true;
      } else {
        return finish("not_started", pendingItems, spawn.reason);
      }
    }
    if (!completion) {
      return finish("not_started", pendingItems, "no completion handle");
    }

    const raced = await raceDreamCompletion({
      completion,
      timeoutMs: Math.max(1, args.timeoutMs ?? DREAM_PRE_COMPACTION_TIMEOUT_MS),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });
    if (raced === "timed_out") {
      return finish(
        "timed_out",
        pendingItems,
        joined ? "joined run still in flight" : "spawned run still in flight",
      );
    }
    if (raced === "aborted") {
      return finish("aborted", pendingItems, "compaction scheduler aborted");
    }
    return raced.completed
      ? finish("consolidated", pendingItems)
      : finish("incomplete", pendingItems);
  } catch (error) {
    return finish(
      "failed",
      0,
      error instanceof Error ? error.message : String(error),
    );
  }
};
