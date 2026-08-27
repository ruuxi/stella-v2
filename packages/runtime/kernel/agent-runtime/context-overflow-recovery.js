import { isContextOverflow } from "../../ai/utils/overflow.js";
import {
  buildHistorySource,
  persistThreadCustomMessage,
} from "./thread-memory.js";
import {
  estimateProviderPayloadTokens,
  getLastProviderPayloadTokens,
  providerInputBudgetTokens,
  withForcedThreadCompaction,
} from "./context-budget.js";
import { classifyAgentRunFailure } from "./agent-run-retry.js";
import { runCompactionWithHooks } from "./run-completion.js";
import { getThreadTokenEstimate } from "../thread-runtime.js";
import { resetSkillReadDedup } from "../tools/skill-read-dedup.js";

const generatedContent = (message) =>
  message.content?.some((block) => {
    if (block.type === "toolCall") return true;
    if (block.type === "text") return Boolean(block.text?.trim());
    if (block.type === "thinking") return Boolean(block.thinking?.trim());
    return true;
  }) ?? false;

const recoveryProgressMarker = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "length") &&
      !generatedContent(message)
    ) {
      continue;
    }
    return [
      index,
      message?.role ?? "unknown",
      message?.timestamp ?? 0,
      message?.toolCallId ?? "",
    ].join(":");
  }
  return "empty";
};

const isSafePreGenerationOverflow = (execution, agent, contextWindow) => {
  if (!execution?.errorMessage) return false;
  const preflightRejected = execution.errorMessage.includes(
    "Context preflight context_length_exceeded before provider dispatch",
  );
  if (preflightRejected) return true;
  const last = agent.state.messages.at(-1);
  if (
    !last ||
    last.role !== "assistant" ||
    (last.stopReason !== "error" && last.stopReason !== "length") ||
    generatedContent(last)
  ) {
    return false;
  }
  const outputTokens = Number(last.usage?.output ?? 0);
  if (Number.isFinite(outputTokens) && outputTokens > 0) return false;
  if (isContextOverflow(last, contextWindow)) return true;
  return isOverBudgetHardFailure(execution, agent, contextWindow);
};

const isOverBudgetHardFailure = (execution, agent, contextWindow) => {
  const inputBudget = providerInputBudgetTokens(contextWindow);
  if (!inputBudget) return false;
  const failure = classifyAgentRunFailure(execution.errorMessage);
  if (failure.category !== "non_retryable") {
    return false;
  }
  const estimatedTokens = estimateProviderPayloadTokens(
    {
      systemPrompt: agent.state.systemPrompt,
      messages: agent.state.messages,
    },
    inputBudget,
  );
  return estimatedTokens >= inputBudget;
};

const errorMessage = (error) => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const executeRecoverableAttempt = async (args, resume = false) => {
  try {
    return await (resume ? args.execute(true) : args.execute());
  } catch (error) {
    if (args.opts.abortSignal?.aborted) throw error;
    const execution = { finalText: "", errorMessage: errorMessage(error) };
    const contextWindow = Number(args.opts.resolvedLlm.model.contextWindow);
    if (!isSafePreGenerationOverflow(execution, args.agent, contextWindow)) {
      throw error;
    }
    return execution;
  }
};

const messageText = (message) => {
  if (message.payload?.role === "user") {
    return typeof message.payload.content === "string"
      ? message.payload.content
      : message.payload.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  }
  return typeof message.content === "string" ? message.content : "";
};

const truncate = (value, maxChars) => {
  const text = value?.trim() ?? "";
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[truncated; full record remains durable]`;
};

const buildRecoverableHandoff = (args) => {
  let history = args.history ?? [];
  let children = [];
  if (!args.history) {
    try {
      history = args.store.loadThreadMessages(args.threadKey);
    } catch {

    }
  }
  try {
    children = args.store
      .listThreadActivity(args.conversationId)
      .filter((entry) => entry.parentAgentId === args.threadKey);
  } catch {

  }

  const latestUser = [...history]
    .reverse()
    .find((message) => message.role === "user");
  const checkpoint = [...history]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.startsWith("[[THREAD_CHECKPOINT]]"),
    );
  const childLines = children.map((child) => {
    const detail = truncate(child.result || child.error || "", 600);
    return `- ${child.threadId}: ${child.status}${detail ? ` - ${detail}` : ""}`;
  });

  return [
    "Context compaction failed: the history could not be compressed to fit the current model's context window, and no further provider retry or tool replay was attempted.",
    `thread_id: ${args.threadKey}`,
    `model: ${args.resolvedLlm.model.provider}/${args.resolvedLlm.model.id}`,
    ...(args.reason ? [`reason: ${args.reason}`] : []),
    "Recovery: the raw thread and child records remain stored as source of truth. The user can send their message again to retry compaction (or switch to a larger-context model); Stella will resume from this durable handoff in a clean General turn.",
    "",
    "Latest user instruction:",
    truncate(
      latestUser ? messageText(latestUser) : "Unavailable in projection",
      4_000,
    ),
    "",
    "Durable checkpoint:",
    truncate(
      checkpoint?.content ||
        "No checkpoint was available; inspect the durable thread directly.",
      12_000,
    ),
    "",
    "Direct child threads:",
    ...(childLines.length > 0
      ? childLines
      : ["- Inspect durable Activity records for this parent thread."]),
  ].join("\n");
};

const isBootstrapMessage = (message) =>
  message?.role === "runtimeInternal" &&
  message.customMessage?.customType?.startsWith("bootstrap.");

const resetThreadToRecoverableHandoff = (args, text, history) => {
  if (typeof args.store.compactThread !== "function") return false;
  const compactable = history.filter(
    (message) => message?.entryId && !isBootstrapMessage(message),
  );
  const first = compactable.at(0);
  const last = compactable.at(-1);
  if (!first?.entryId || !last?.entryId) return false;
  args.store.compactThread({
    threadKey: args.threadKey,
    summary: text,
    fromEntryId: first.entryId,
    toEntryId: last.entryId,
    tokensBefore: getThreadTokenEstimate(history),
    details: {
      kind: "context-overflow-recovery",
      runId: args.runId,
    },
  });
  if (typeof args.store.updateThreadSummary === "function") {
    args.store.updateThreadSummary(args.threadKey, text);
  }
  args.session?.notifyCompacted?.();
  return true;
};

const persistRecoverableHandoff = (args) => {
  let history = [];
  try {
    history = args.store.loadThreadMessages(args.threadKey);
  } catch {

  }
  let text = buildRecoverableHandoff({ ...args, history });
  let historyReset = false;
  try {
    historyReset = resetThreadToRecoverableHandoff(args, text, history);
  } catch (error) {
    text += `\n\nAutomatic clean-turn reset failed: ${error instanceof Error ? error.message : String(error)}. Start a new General conversation and use this handoff.`;
  }
  try {
    persistThreadCustomMessage(args.store, {
      threadKey: args.threadKey,
      customType: "context-overflow.recovery-handoff",
      content: [{ type: "text", text }],
      display: true,
      eventId: `context-overflow-recovery:${args.runId}`,
    });
  } catch (error) {
    text += `\n\nDurable handoff persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { kind: "handoff", text, historyReset };
};

const getThreadTokenEstimateSafely = (storedMessages) => {
  try {
    return getThreadTokenEstimate(storedMessages);
  } catch {
    return undefined;
  }
};

const dropFailedOverflowTailFromStore = (args) => {
  if (typeof args.store.removeThreadMessageEntry !== "function") return;
  let stored;
  try {
    stored = args.store.loadThreadMessages(args.threadKey);
  } catch {
    return;
  }
  const last = stored.at(-1);
  const payload = last?.payload;
  if (
    !last?.entryId ||
    payload?.role !== "assistant" ||
    (payload.stopReason !== "error" && payload.stopReason !== "length") ||
    generatedContent(payload)
  ) {
    return;
  }
  try {
    args.store.removeThreadMessageEntry(args.threadKey, last.entryId);
  } catch {

  }
};

const compactedPayloadFitsBudget = (args) => {
  const budget = args.inputBudget;
  if (!budget) return true;
  if (
    typeof args.lastPayloadTokens === "number" &&
    typeof args.historyBefore === "number" &&
    typeof args.historyAfter === "number"
  ) {
    const reduction = Math.max(0, args.historyBefore - args.historyAfter);
    return args.lastPayloadTokens - reduction < budget;
  }
  const estimate = estimateProviderPayloadTokens(
    {
      systemPrompt: args.agent?.state?.systemPrompt,
      messages: args.refreshed,
    },
    budget,
  );
  return estimate < budget;
};

export const recoverContextOverflow = async (args) => {
  const contextWindow = Number(args.resolvedLlm.model.contextWindow);
  if (!isSafePreGenerationOverflow(args.execution, args.agent, contextWindow)) {
    return { kind: "not-overflow" };
  }

  const progressMarker = recoveryProgressMarker(args.agent.state.messages);
  if (
    args.previousRecoveryProgressMarker !== undefined &&
    args.previousRecoveryProgressMarker === progressMarker
  ) {
    return persistRecoverableHandoff({
      ...args,
      reason:
        "the compacted retry overflowed again before any new model output or tool result",
    });
  }

  const failedAssistant = args.agent.state.messages.at(-1);
  if (
    failedAssistant?.role === "assistant" &&
    (failedAssistant.stopReason === "error" ||
      failedAssistant.stopReason === "length") &&
    !generatedContent(failedAssistant)
  ) {
    args.agent.state.messages.pop();
  }
  while (args.compactionScheduler?.pending(args.threadKey)) {
    await args.compactionScheduler.pending(args.threadKey);
  }

  dropFailedOverflowTailFromStore(args);
  let threadTokenEstimate;
  try {
    threadTokenEstimate = getThreadTokenEstimate(
      args.store.loadThreadMessages(args.threadKey),
    );
  } catch {
    threadTokenEstimate = undefined;
  }
  const runCompaction = () =>
    withForcedThreadCompaction(args.threadKey, () =>
      runCompactionWithHooks({
        opts: args.opts,
        threadKey: args.threadKey,
        runId: args.runId,
        messageCount: args.agent.state.messages.length,
        ...(threadTokenEstimate !== undefined
          ? { orchestratorTokenEstimate: threadTokenEstimate }
          : {}),
      }),
    );
  const lastPayloadTokens = getLastProviderPayloadTokens(args.threadKey);
  const result = await runCompaction();
  if (result.compacted) {
    resetSkillReadDedup(args.threadKey);
    args.session?.notifyCompacted();
  }

  const storedAfter = args.store.loadThreadMessages(args.threadKey);
  const refreshed = buildHistorySource({ threadHistory: storedAfter });
  const failedTail = refreshed.at(-1);
  if (
    failedTail?.role === "assistant" &&
    (failedTail.stopReason === "error" || failedTail.stopReason === "length") &&
    !generatedContent(failedTail)
  ) {
    refreshed.pop();
  }
  const resumeTail = refreshed.at(-1);
  if (refreshed.length === 0 || resumeTail?.role === "assistant") {

    return persistRecoverableHandoff(args);
  }
  if (
    !compactedPayloadFitsBudget({
      inputBudget: providerInputBudgetTokens(contextWindow),
      lastPayloadTokens,
      historyBefore: threadTokenEstimate,
      historyAfter: getThreadTokenEstimateSafely(storedAfter),
      agent: args.agent,
      refreshed,
    })
  ) {

    return persistRecoverableHandoff({
      ...args,
      reason: "the compacted history still exceeds the model input budget",
    });
  }
  args.agent.state.messages = refreshed;
  return {
    kind: "compacted",
    progressMarker: recoveryProgressMarker(refreshed),
  };
};

export const executeWithContextOverflowRecovery = async (args) => {
  let execution = await executeRecoverableAttempt(args);
  let previousRecoveryProgressMarker;
  while (true) {
    let overflowRecovery;
    try {
      overflowRecovery = await recoverContextOverflow({
        execution,
        agent: args.agent,
        store: args.opts.store,
        threadKey: args.threadKey,
        conversationId: args.opts.conversationId,
        resolvedLlm: args.opts.resolvedLlm,
        compactionScheduler: args.opts.compactionScheduler,
        opts: args.opts,
        runId: args.runId,
        session: args.session,
        ...(previousRecoveryProgressMarker !== undefined
          ? { previousRecoveryProgressMarker }
          : {}),
      });
    } catch (error) {
      overflowRecovery = persistRecoverableHandoff({
        store: args.opts.store,
        threadKey: args.threadKey,
        conversationId: args.opts.conversationId,
        resolvedLlm: args.opts.resolvedLlm,
        runId: args.runId,
        session: args.session,
        reason: `forced compaction failed: ${errorMessage(error)}`,
      });
    }

    if (overflowRecovery.kind === "handoff") {
      return {
        finalText: overflowRecovery.text,
        errorMessage: overflowRecovery.historyReset
          ? "Context compaction failed; the thread was reset to a durable handoff. Sending your message again retries compaction and continues in a clean General turn."
          : "Context compaction failed and the active thread could not be reset. Retry your message, or start a new General conversation using the durable handoff.",
      };
    }
    if (overflowRecovery.kind !== "compacted") return execution;

    previousRecoveryProgressMarker = overflowRecovery.progressMarker;
    args.opts.callbacks?.onStatus?.(
      args.runEvents.recordStatus(
        "Context compacted before overflow; retrying",
        "compacting",
      ),
    );
    execution = await executeRecoverableAttempt(args, true);
  }
};
