import type { RuntimeStore } from "./storage/runtime-store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRuntimeLogger } from "./debug.js";
import {
  clearProviderUsage,
  getBilledContextTokens,
  getLastProviderPayloadTokens,
  isThreadCompactionForced,
} from "./agent-runtime/context-budget.js";
import { buildResidentFold } from "./agent-runtime/resident-context.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  QUARANTINE_PLACEHOLDER,
  parseQuarantineRecord,
  toolResultQuarantineKey,
} from "./agent-runtime/provider-abort-containment.js";
import { loadLocalPreferences } from "./preferences/local-preferences.js";
import {
  MIN_TAIL_MESSAGES,
  MIN_TRIGGER_TOKENS,
  contextWindowTokens,
  formatCheckpointText,
  orchestratorCompactionTriggerTokens,
  orchestratorKeepRecentTokens,
  pinnedInstructionText,
} from "./agent-runtime/orchestrator-compaction.js";
import {
  ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  GENERAL_COMPACTION_KEEP_RECENT_TOKENS,
  MAX_ACTIVE_THREAD_IMAGES,
  THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
  countLeadingBootstrapStartupDocs,
  getThreadImageHistoryStats,
  getThreadTokenEstimate,
  parseThreadCheckpoint,
  splitGeneralThreadMessagesForCompaction,
  splitThreadMessagesForCompaction,
  splitThreadMessagesForImagePressure,
  storedMessageImageBlocks,
  type StoredThreadMessage,
  type ThreadCheckpoint,
  type ThreadCompactionSplitPolicy,
  type ThreadImageReceipt,
} from "./thread-compaction-plan.js";
import {
  buildDurableMemoryReference,
  collectFileOperations,
  formatFileOperationsForSummary,
  generateThreadSummary,
  generateThreadSummaryWithoutElision,
} from "./thread-compaction-summary.js";

// The thread-runtime surface other runtime modules read these through.
export {
  ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  MAX_ACTIVE_THREAD_IMAGES,
  getThreadTokenEstimate,
  parseThreadCheckpoint,
};

const logger = createRuntimeLogger("thread-runtime");

/** A data-dir-relative file reader for the resident fold; null when absent. */
const readStellaDataFile =
  (stellaDataDir: string) =>
  (relativePath: string): string | null => {
    try {
      return fs.readFileSync(path.join(stellaDataDir, relativePath), "utf-8");
    } catch {
      return null;
    }
  };

/**
 * General/subagent compaction trigger. Deliberately not pi-mono's
 * `window - 16k` and not the orchestrator's 50%.
 */
const GENERAL_COMPACTION_TRIGGER_PCT = 0.6;
/**
 * Smallest compatibility guard for a fixed 20k tail on tiny windows: if
 * keeping 20k would leave fewer than this many tokens for the checkpoint
 * summary and remaining head, shrink the tail so compaction can still free
 * space. Never used on typical 80k+ windows and not the orchestrator's 10%
 * policy.
 */
const GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS = 4_096;

const quarantinedToolResultKeys = (
  messages: StoredThreadMessage[],
): Set<string> =>
  new Set(
    messages.flatMap((message) => {
      if (message.customMessage?.customType !== QUARANTINE_CUSTOM_TYPE) {
        return [];
      }
      const record = parseQuarantineRecord(message.customMessage.content);
      return record ? [record.key] : [];
    }),
  );

const latestCheckpointQuarantineKeys = (
  messages: StoredThreadMessage[],
): Set<string> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (parseThreadCheckpoint(message.content)) {
      return new Set(message.checkpointQuarantineKeys ?? []);
    }
  }
  return new Set();
};

const maskQuarantinedCompactionMessages = (
  messages: StoredThreadMessage[],
  quarantinedKeys: Set<string>,
): StoredThreadMessage[] => {
  if (quarantinedKeys.size === 0) return messages;
  return messages.map((message) => {
    const payload = message.payload;
    if (
      payload?.role !== "toolResult" ||
      !quarantinedKeys.has(toolResultQuarantineKey(payload))
    ) {
      return message;
    }
    return {
      ...message,
      content: QUARANTINE_PLACEHOLDER,
      payload: {
        ...payload,
        content: [{ type: "text", text: QUARANTINE_PLACEHOLDER }],
      },
    };
  });
};

const getContextWindow = (route: ResolvedLlmRoute): number =>
  contextWindowTokens(route.model.contextWindow);

export const resolveCompactionSplitPolicy = (
  agentType?: string,
): ThreadCompactionSplitPolicy =>
  !agentType || agentType === AGENT_IDS.ORCHESTRATOR
    ? "orchestrator"
    : "general";

export const getCompactionTriggerTokens = (
  route: ResolvedLlmRoute,
  agentType?: string,
): number =>
  resolveCompactionSplitPolicy(agentType) === "general"
    ? Math.max(
        MIN_TRIGGER_TOKENS,
        Math.floor(getContextWindow(route) * GENERAL_COMPACTION_TRIGGER_PCT),
      )
    : orchestratorCompactionTriggerTokens(getContextWindow(route));

const imageExtension = (mimeType: string): string => {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
};

const finiteImageDimension = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const promoteImageArtifact = (args: {
  data: string;
  mimeType: string;
  sourcePath?: string;
  stellaDataDir?: string;
}): Pick<ThreadImageReceipt, "id" | "decodedBytes" | "artifact"> => {
  const bytes = Buffer.from(args.data, "base64");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const id = `sha256:${hash}`;
  if (args.stellaDataDir) {
    const directory = path.join(
      args.stellaDataDir,
      "artifacts",
      "thread-images",
    );
    const artifactPath = path.join(
      directory,
      `${hash}.${imageExtension(args.mimeType)}`,
    );
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(artifactPath)) {
        const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
          fs.renameSync(temporaryPath, artifactPath);
        } catch (error) {
          try {
            fs.rmSync(temporaryPath, { force: true });
          } catch {
            // Best-effort cleanup; receipt fallback below remains explicit.
          }
          if (!fs.existsSync(artifactPath)) throw error;
        }
      }
      return {
        id,
        decodedBytes: bytes.length,
        artifact: { durability: "durable", path: artifactPath },
      };
    } catch (error) {
      logger.warn("thread.compaction.image-artifact-promotion-failed", {
        artifactId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const sourcePath = args.sourcePath?.trim();
  return {
    id,
    decodedBytes: bytes.length,
    artifact: {
      durability: "non-durable",
      ...(sourcePath ? { path: sourcePath } : {}),
      reason: args.stellaDataDir
        ? "durable artifact promotion failed"
        : sourcePath
          ? "source path was not promoted because no Stella data directory was available"
          : "inline image was evicted at checkpoint and no durable artifact directory was available",
    },
  };
};

export const collectThreadImageReceipts = (
  messages: StoredThreadMessage[],
  stellaDataDir?: string,
): ThreadImageReceipt[] => {
  const receipts: ThreadImageReceipt[] = [];
  for (const message of messages) {
    const payload = message.payload;
    for (const block of storedMessageImageBlocks(message)) {
      const dimensions = block as typeof block & {
        width?: number;
        height?: number;
        widthPx?: number;
        heightPx?: number;
      };
      const promoted = promoteImageArtifact({
        data: block.data,
        mimeType: block.mimeType,
        ...(block.sourcePath ? { sourcePath: block.sourcePath } : {}),
        ...(stellaDataDir ? { stellaDataDir } : {}),
      });
      const width = finiteImageDimension(
        dimensions.width ?? dimensions.widthPx,
      );
      const height = finiteImageDimension(
        dimensions.height ?? dimensions.heightPx,
      );
      receipts.push({
        ...promoted,
        mimeType: block.mimeType,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        origin: {
          timestamp: message.timestamp,
          role: message.role,
          ...(payload?.role === "toolResult"
            ? { toolName: payload.toolName }
            : {}),
        },
      });
    }
  }
  return receipts;
};

const latestDurableCheckpointImageReceipts = (
  messages: StoredThreadMessage[],
): ThreadImageReceipt[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!parseThreadCheckpoint(message.content)) continue;
    return (message.checkpointImageReceipts ?? []).filter(
      (receipt) => receipt.artifact.durability === "durable",
    );
  }
  return [];
};

const mergeThreadImageReceipts = (
  inherited: ThreadImageReceipt[],
  current: ThreadImageReceipt[],
): ThreadImageReceipt[] => {
  const byId = new Map<string, ThreadImageReceipt>();
  for (const receipt of [...inherited, ...current]) {
    const existing = byId.get(receipt.id);
    if (
      !existing ||
      (existing.artifact.durability !== "durable" &&
        receipt.artifact.durability === "durable")
    ) {
      byId.set(receipt.id, receipt);
    }
  }
  return [...byId.values()];
};

export const resolveOrchestratorThreadKey = (conversationId: string): string =>
  conversationId;

export const buildRuntimeThreadKey = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string => {
  const existing = args.threadId?.trim();
  if (existing) {
    return existing;
  }
  if (args.agentType === "orchestrator") {
    return resolveOrchestratorThreadKey(args.conversationId);
  }
  const threadKey = `run:${args.runId}`;
  return `${args.conversationId}::subagent::${args.agentType}::${threadKey}`;
};

export const formatThreadCheckpointMessage = (
  checkpoint: ThreadCheckpoint,
): string => formatCheckpointText(checkpoint.summary);

/**
 * Result of an attempted thread compaction.
 *
 * Returns `compacted: true` only when an overlay was actually written
 * to the store; every short-circuit path (empty thread, below trigger,
 * no valid cut point, summary generation produced an empty string)
 * returns `compacted: false` so the caller can avoid downstream
 * side-effects (e.g. flagging a long-lived `OrchestratorSession`'s
 * in-memory mirror as stale, which forces a full rebuild of
 * `agent.state.messages` from the store and defeats the prompt-cache
 * stability the long-lived session was meant to provide).
 */
const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

export type ThreadCompactionResult = {
  compacted: boolean;
};

/**
 * Head-message protection differs by agent role. Subagents are short-lived
 * task sessions, so we pin a fixed window of leading messages to keep their
 * task framing intact. The orchestrator is one long-lived conversation where
 * the first user turn is just old history — only its bootstrap startup docs
 * (personality + core memory) stay pinned at the top; everything after them is
 * fair game for compaction.
 */
export const resolveCompactionProtectHeadMessages = (
  agentType: string,
  messages: StoredThreadMessage[],
): number =>
  agentType === AGENT_IDS.ORCHESTRATOR
    ? countLeadingBootstrapStartupDocs(messages)
    : // Subagents pin their fixed task-framing window AND any leading
      // bootstrap docs (which can exceed the fixed window once a resident
      // fold has re-pinned the full doc set at the head).
      Math.max(
        THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
        countLeadingBootstrapStartupDocs(messages),
      );

/**
 * Retry schedule for the final overlay write. `compactThread` is a local
 * SQLite write; a busy/locked database is transient and must not fail a
 * compaction whose summary already generated successfully.
 */
const COMPACTION_STORE_WRITE_RETRY_DELAYS_MS = [250, 1_000];

const resolveKeepRecentTokens = (
  route: ResolvedLlmRoute,
  policy: ThreadCompactionSplitPolicy = "orchestrator",
): number => {
  if (policy === "orchestrator") {
    return orchestratorKeepRecentTokens(getContextWindow(route));
  }
  const window = getContextWindow(route);
  const triggerTokens = Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(window * GENERAL_COMPACTION_TRIGGER_PCT),
  );
  // Smallest compatibility guard: keep the fixed 20k tail on any window
  // where that tail still leaves room under the 60% trigger. Only shrink
  // when a 20k tail would itself sit at/above the trigger (tiny windows),
  // so compaction can still free space. This is not the orchestrator's 10%
  // policy.
  const maxKeep = Math.max(
    1,
    window - GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS,
  );
  let keep = Math.min(GENERAL_COMPACTION_KEEP_RECENT_TOKENS, maxKeep);
  if (keep >= triggerTokens) {
    keep = Math.max(
      1,
      triggerTokens - GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS,
    );
  }
  return keep;
};

export const resolveKeepRecentTokensForAgent = (
  route: ResolvedLlmRoute,
  agentType?: string,
): number =>
  resolveKeepRecentTokens(route, resolveCompactionSplitPolicy(agentType));

/** Plain text of a user message, preferring the persisted payload blocks. */
const extractUserMessageText = (message: StoredThreadMessage): string => {
  if (message.payload?.role === "user") {
    const content = message.payload.content;
    if (typeof content === "string") {
      return content;
    }
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return message.content;
};

export const maybeCompactRuntimeThread = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  overrideSummary?: string;
  preserveLastN?: number;
  /**
   * When set, the always-loaded durable-memory docs under this data dir are
   * passed to the summarizer as an "already known — do not repeat" reference.
   */
  stellaDataDir?: string;
  /** Stella's agent list for the folded head; orchestrator threads only. */
  readAgentRoster?: () => Promise<string | undefined>;
}): Promise<ThreadCompactionResult> => {
  const compactionStartedAt = Date.now();
  const forcedBeforeProbe = isThreadCompactionForced(args.threadKey);
  const narrowProbe =
    typeof args.store.getThreadContextPressureStats === "function"
      ? args.store.getThreadContextPressureStats(args.threadKey)
      : null;
  const initialRelevantQuarantineCount =
    narrowProbe?.complete === true ? narrowProbe.quarantineCount : null;
  if (
    !forcedBeforeProbe &&
    narrowProbe?.complete === true &&
    narrowProbe.quarantineCount === 0 &&
    narrowProbe.imageCount <= MAX_ACTIVE_THREAD_IMAGES &&
    narrowProbe.imageDecodedBytes <= ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET &&
    (getBilledContextTokens(args.threadKey) ??
      Math.max(
        narrowProbe.estimatedTokens,
        getLastProviderPayloadTokens(args.threadKey) ?? 0,
      )) < getCompactionTriggerTokens(args.resolvedLlm, args.agentType)
  ) {
    return { compacted: false };
  }
  let storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return { compacted: false };
  }
  const inheritedImageReceipts =
    latestDurableCheckpointImageReceipts(storedMessages);
  const checkpointQuarantineKeys =
    latestCheckpointQuarantineKeys(storedMessages);

  // A complete narrow probe distinguishes active/unresolved quarantine rows
  // from historical rows already masked by the effective checkpoint. Only the
  // former require reconstructing the append-only log; otherwise doing so
  // needlessly pages old chunked screenshot payloads back into memory.
  const inspectRawQuarantine =
    initialRelevantQuarantineCount === null ||
    initialRelevantQuarantineCount > 0;
  const rawStoredMessages =
    inspectRawQuarantine &&
    typeof args.store.loadRawThreadMessages === "function"
      ? args.store.loadRawThreadMessages(args.threadKey)
      : null;
  // Carry forward checkpoint-confirmed keys even when the cheap path can skip
  // raw history. Successor checkpoints must retain that proof so the same
  // covered records remain resolved on future probes.
  let quarantineKeys = new Set([
    ...checkpointQuarantineKeys,
    ...quarantinedToolResultKeys(rawStoredMessages ?? storedMessages),
  ]);
  const effectiveToolResultKeys = new Set(
    storedMessages
      .filter((message: any) => message.payload?.role === "toolResult")
      .map((message: any) => toolResultQuarantineKey(message)),
  );
  const rebuildUnsafeCheckpoint =
    quarantineKeys.size > 0 &&
    storedMessages.some((message: any) =>
      parseThreadCheckpoint(message.content),
    ) &&
    [...quarantineKeys].some(
      (key) =>
        !effectiveToolResultKeys.has(key) && !checkpointQuarantineKeys.has(key),
    );
  if (
    rebuildUnsafeCheckpoint &&
    typeof args.store.loadRawThreadMessages === "function"
  ) {
    // A checkpoint that covered a now-quarantined result may already summarize
    // the suspect provider payload. Rebuild from the append-only raw log so the
    // historical context is retained while the offending result is masked.
    storedMessages =
      rawStoredMessages ?? args.store.loadRawThreadMessages(args.threadKey);
    quarantineKeys = new Set([
      ...checkpointQuarantineKeys,
      ...quarantinedToolResultKeys(storedMessages),
    ]);
  }

  const policy = resolveCompactionSplitPolicy(args.agentType);
  const totalTokens = getThreadTokenEstimate(storedMessages);
  const forced = forcedBeforeProbe;
  const imageHistory = getThreadImageHistoryStats(storedMessages);
  // The trigger measures what the provider actually received: its billed
  // usage for the last response since the last compaction (as Pi does).
  // Without one, the last preflight estimate of the full outbound payload
  // (system prompt + tool schemas + resident context + history), floored by
  // the history-only estimate (e.g. the first turn after a worker restart).
  const measuredTokens =
    getBilledContextTokens(args.threadKey) ??
    Math.max(totalTokens, getLastProviderPayloadTokens(args.threadKey) ?? 0);
  if (
    !forced &&
    !imageHistory.overBudget &&
    !rebuildUnsafeCheckpoint &&
    measuredTokens <
      getCompactionTriggerTokens(args.resolvedLlm, args.agentType)
  ) {
    return { compacted: false };
  }

  const protectHead = resolveCompactionProtectHeadMessages(
    args.agentType,
    storedMessages,
  );
  const keepRecentTokens = resolveKeepRecentTokens(args.resolvedLlm, policy);
  // Ordinary turns remain byte-identical. Image removal happens only here,
  // at the already-cache-breaking checkpoint overlay, and the prospective
  // splitter is allowed to compact a single oversized newest message.
  let splitMessages = imageHistory.overBudget
    ? splitThreadMessagesForImagePressure(storedMessages)
    : policy === "general"
      ? splitGeneralThreadMessagesForCompaction(
          storedMessages,
          protectHead,
          keepRecentTokens,
        )
      : splitThreadMessagesForCompaction(
          storedMessages,
          protectHead,
          keepRecentTokens,
          Number.isFinite(args.preserveLastN) &&
            args.preserveLastN !== undefined
            ? Math.max(0, Math.floor(args.preserveLastN))
            : MIN_TAIL_MESSAGES,
        );
  if (
    !splitMessages &&
    (forced || rebuildUnsafeCheckpoint) &&
    !imageHistory.overBudget
  ) {
    // Emergency split for an overflow that the standard cut points cannot
    // relieve (e.g. a few enormous messages inside the protected head or
    // tail). Only the orchestrator's bootstrap docs stay pinned; everything
    // up to the last message is compactable.
    const emergencyHead = countLeadingBootstrapStartupDocs(storedMessages);
    splitMessages =
      policy === "general"
        ? splitGeneralThreadMessagesForCompaction(
            storedMessages,
            emergencyHead,
            0,
          )
        : splitThreadMessagesForCompaction(
            storedMessages,
            // Even in the emergency split, leading bootstrap docs stay pinned for
            // every agent type — they are resident context, and cutting through
            // them would anchor the overlay on a fold-synthetic entryId.
            emergencyHead,
            0,
            1,
          );
  }
  if (!splitMessages) {
    logger.error("thread.compaction.no-safe-split", {
      threadKey: args.threadKey,
      reason: imageHistory.overBudget ? "image-pressure" : "token-pressure",
      imageCount: imageHistory.count,
      imageDecodedBytes: imageHistory.decodedBytes,
    });
    return { compacted: false };
  }

  const triggerReason = imageHistory.overBudget
    ? "image-pressure"
    : rebuildUnsafeCheckpoint
      ? "quarantine-rebuild"
      : forced
        ? "forced"
        : "token-pressure";
  logger.info("thread.compaction.started", {
    threadKey: args.threadKey,
    model: args.resolvedLlm.model.id,
    reason: triggerReason,
    policy,
    cacheBoundary: "checkpoint-overlay",
    tokensBefore: totalTokens,
    measuredTokens,
    imageCountBefore: imageHistory.count,
    imageDecodedBytesBefore: imageHistory.decodedBytes,
    compactedMessageCount:
      splitMessages.middleMessages.length +
      (splitMessages.turnPrefixMessages?.length ?? 0),
  });

  const summaryMiddleMessages = maskQuarantinedCompactionMessages(
    splitMessages.middleMessages,
    quarantineKeys,
  );
  const summaryTurnPrefixMessages = maskQuarantinedCompactionMessages(
    splitMessages.turnPrefixMessages ?? [],
    quarantineKeys,
  );
  // This structured receipt is produced by the harness, not by the summary
  // model. The store renders it as a separate checkpoint section, so receipt
  // presence/content cannot depend on whether the model mentions an image.
  const imageReceipts = mergeThreadImageReceipts(
    inheritedImageReceipts,
    collectThreadImageReceipts(
      [...summaryMiddleMessages, ...summaryTurnPrefixMessages],
      args.stellaDataDir,
    ),
  );

  const durableMemoryReference =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildDurableMemoryReference(args.stellaDataDir)
      : undefined;
  // Hook summaries are produced outside this quarantine-aware snapshot and
  // may already contain suspect tool content. Regenerate from masked rows
  // whenever any quarantine is active.
  let summary =
    quarantineKeys.size === 0 ? args.overrideSummary?.trim() || null : null;
  if (!summary) {
    // One single-pass summary request. A middle too large for the current
    // model's summarizer window is normally prevented up front: a shrinking
    // model switch runs a blocking compaction on the previous (larger-window)
    // route before the new route takes over. If an oversized middle still
    // reaches this point, `capSummaryConversation` bounds the request to the
    // window and discloses the elided span rather than failing.
    const skipHistorySummary =
      policy === "general" && splitMessages.middleMessages.length === 0;
    const generated = skipHistorySummary
      ? {
          text: splitMessages.previousSummary?.trim() || null,
          reason: splitMessages.previousSummary?.trim()
            ? undefined
            : "empty formatted conversation",
        }
      : rebuildUnsafeCheckpoint
        ? await generateThreadSummaryWithoutElision({
            threadKey: args.threadKey,
            messages: summaryMiddleMessages,
            resolvedLlm: args.resolvedLlm,
            durableMemoryReference,
            policy,
          })
        : await generateThreadSummary({
            threadKey: args.threadKey,
            messages: summaryMiddleMessages,
            previousSummary: splitMessages.previousSummary,
            resolvedLlm: args.resolvedLlm,
            durableMemoryReference,
            policy,
          });
    summary = generated.text;
    if (
      policy === "general" &&
      splitMessages.isSplitTurn &&
      (splitMessages.turnPrefixMessages?.length ?? 0) > 0
    ) {
      const prefix = await generateThreadSummary({
        threadKey: args.threadKey,
        messages: summaryTurnPrefixMessages,
        resolvedLlm: args.resolvedLlm,
        policy,
        promptKind: "turnPrefix",
      });
      if (!prefix.text) {
        logger.error("thread.compaction.summary-failed-final", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          reason: prefix.reason,
          middleTokens: getThreadTokenEstimate(
            splitMessages.turnPrefixMessages ?? [],
          ),
          totalTokens,
        });
        return { compacted: false };
      }
      const historyText = summary?.trim() || "No prior history.";
      summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    }
    if (!summary) {
      logger.error("thread.compaction.summary-failed-final", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: generated.reason,
        middleTokens: getThreadTokenEstimate(splitMessages.middleMessages),
        totalTokens,
      });
      return { compacted: false };
    }
    if (policy === "general") {
      const fileOps = collectFileOperations([
        ...splitMessages.middleMessages,
        ...(splitMessages.turnPrefixMessages ?? []),
      ]);
      summary += formatFileOperationsForSummary(
        fileOps.readFiles,
        fileOps.modifiedFiles,
      );
    }
  }

  // Resident-block fold-in: compaction is the one moment the prompt-cache
  // prefix is legitimately dead, so re-render every resident block from
  // current state and carry the fresh copies on the compaction entry. The
  // overlay materializer (`storage/session-store.js`) pins exactly one
  // fresh copy of each block at the head of the rebuilt window and sweeps
  // all older copies + accumulated `runtime.context_delta.*` appends —
  // which also heals legacy threads that accumulated duplicate doc appends.
  // Best-effort: a fold failure must never fail a compaction.
  let agentRoster: string | undefined;
  if (policy === "orchestrator" && args.readAgentRoster) {
    try {
      agentRoster = await args.readAgentRoster();
    } catch (error) {
      logger.warn("thread.compaction.agent-roster-failed", {
        threadKey: args.threadKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let residentFold: unknown = null;
  try {
    residentFold = buildResidentFold({
      messages: storedMessages,
      ...(args.stellaDataDir
        ? { readDiskFile: readStellaDataFile(args.stellaDataDir) }
        : {}),
      refreshMemoryDocsFromDisk: args.stellaDataDir
        ? loadLocalPreferences(args.stellaDataDir).memoryEnabled !== false
        : false,
      ...(agentRoster ? { fresh: { agentRoster } } : {}),
    });
  } catch (error) {
    residentFold = null;
    logger.warn("thread.compaction.resident-fold-failed", {
      threadKey: args.threadKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Pin the latest user instruction across the checkpoint: the middle
  // (including that instruction) is summarized as usual, but the overlay
  // additionally re-emits one capped verbatim copy of it right after the
  // checkpoint message. Bounded by construction — the tail cut never moves.
  // Orchestrator-only: general/subagent compaction follows pi-mono and
  // does not emit a synthetic pin.
  const pinnedInstruction =
    policy === "orchestrator" && splitMessages.latestUserMessage
      ? pinnedInstructionText(
          extractUserMessageText(splitMessages.latestUserMessage),
        )
      : "";
  const generalFileOps =
    policy === "general"
      ? collectFileOperations([
          ...splitMessages.middleMessages,
          ...(splitMessages.turnPrefixMessages ?? []),
        ])
      : null;
  const details = {
    // Compaction replaces derived bootstrap context even when this particular
    // thread has no resident documents to fold.
    replaceDerivedContext: true,
    ...(residentFold ? { residentFold } : {}),
    ...(pinnedInstruction
      ? { pinnedUserInstruction: { text: pinnedInstruction } }
      : {}),
    ...(quarantineKeys.size > 0
      ? { quarantinedToolResultKeys: [...quarantineKeys].sort() }
      : {}),
    ...(generalFileOps
      ? {
          readFiles: generalFileOps.readFiles,
          modifiedFiles: generalFileOps.modifiedFiles,
        }
      : {}),
    ...(imageReceipts.length > 0 ? { imageReceipts } : {}),
  };

  // Quarantine can engage while the summary provider call is in flight. A
  // summary generated from the earlier snapshot is then unsafe to publish,
  // even though the quarantine row may have been appended before this write.
  // Re-check synchronously immediately before the synchronous SQLite write;
  // the next compaction will regenerate from the masked snapshot.
  for (
    let attempt = 0;
    attempt <= COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(COMPACTION_STORE_WRITE_RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      const latestNarrowProbe =
        typeof args.store.getThreadContextPressureStats === "function"
          ? args.store.getThreadContextPressureStats(args.threadKey)
          : null;
      const relevantQuarantineGrew =
        initialRelevantQuarantineCount !== null &&
        latestNarrowProbe?.complete === true
          ? latestNarrowProbe.quarantineCount > initialRelevantQuarantineCount
          : null;
      const latestQuarantineKeys =
        relevantQuarantineGrew === null
          ? quarantinedToolResultKeys(
              typeof args.store.loadRawThreadMessages === "function"
                ? args.store.loadRawThreadMessages(args.threadKey)
                : args.store.loadThreadMessages(args.threadKey),
            )
          : null;
      if (
        relevantQuarantineGrew === true ||
        (latestQuarantineKeys !== null &&
          [...latestQuarantineKeys].some((key) => !quarantineKeys.has(key)))
      ) {
        logger.warn("thread.compaction.quarantine-changed-before-write", {
          threadKey: args.threadKey,
          quarantineCountBefore:
            initialRelevantQuarantineCount ?? quarantineKeys.size,
          quarantineCountAfter:
            latestNarrowProbe?.complete === true
              ? latestNarrowProbe.quarantineCount
              : (latestQuarantineKeys?.size ?? 0),
        });
        return { compacted: false };
      }
      args.store.compactThread({
        threadKey: args.threadKey,
        summary,
        fromEntryId: splitMessages.fromEntryId,
        toEntryId: splitMessages.toEntryId,
        tokensBefore: totalTokens,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      });
      args.store.updateThreadSummary(args.threadKey, summary);
      clearProviderUsage(args.threadKey);
      const effectiveAfter = args.store.loadThreadMessages(args.threadKey);
      const imageHistoryAfter = getThreadImageHistoryStats(effectiveAfter);
      logger.info("thread.compaction.completed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: triggerReason,
        cacheBoundary: "checkpoint-overlay",
        durationMs: Date.now() - compactionStartedAt,
        tokensBefore: totalTokens,
        tokensAfter: getThreadTokenEstimate(effectiveAfter),
        imageCountBefore: imageHistory.count,
        imageCountAfter: imageHistoryAfter.count,
        imageDecodedBytesBefore: imageHistory.decodedBytes,
        imageDecodedBytesAfter: imageHistoryAfter.decodedBytes,
        imageReceiptCount: imageReceipts.length,
        postCheckpointImageBudgetSatisfied: !imageHistoryAfter.overBudget,
      });
      return { compacted: true };
    } catch (error) {
      if (attempt === COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      logger.warn("thread.compaction.store-write-retry", {
        threadKey: args.threadKey,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { compacted: true };
};
