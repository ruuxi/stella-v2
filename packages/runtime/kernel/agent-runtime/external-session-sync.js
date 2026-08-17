import { createRuntimeLogger } from "../debug.js";
import {
  formatThreadMessagesForCompaction,
  summarizeCanonicalCatchUp,
} from "../thread-runtime.js";
import {
  estimateCanonicalTextTokens,
  resolveCanonicalContextWindow,
} from "./canonical-history-budget.js";

const logger = createRuntimeLogger("agent-runtime.external-session-sync");
const CATCH_UP_RESERVE_TOKENS = 16_000;
const RECENT_REFERENT_TOKENS = 12_000;
const CATCH_UP_WRAPPER_RESERVE_TOKENS = 256;

const promptMessageText = (message) =>
  typeof message?.text === "string" ? message.text.trim() : "";

const isPortableCanonicalMessage = (message) => {
  if (message.sourceEntryType !== "custom_message") return true;
  const customType = String(
    message.customType ?? message.customMessage?.customType ?? "",
  );
  return !(
    customType.startsWith("bootstrap.") ||
    customType.startsWith("runtime.context_delta.") ||
    customType === "runtime.stale_user_reminder" ||
    customType === "runtime.stella_thread_updates"
  );
};

const serializeEntries = (messages) =>
  messages
    .map((message) => {
      const body = formatThreadMessagesForCompaction([message]).trim();
      if (!body) return "";
      const sequence = Number(message.sequence) || 0;
      const entryId = message.entryId ?? "unknown";
      return `[Canonical entry ${sequence}; id=${entryId}]\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");

const removeLivePromptDuplicates = (messages, promptMessages) => {
  const remaining = [...messages];
  const deliveredEntryIds = [];
  const liveUserTexts = promptMessages
    .filter((message) => message?.isVisible !== false)
    .map(promptMessageText)
    .filter(Boolean);
  for (
    let promptIndex = liveUserTexts.length - 1;
    promptIndex >= 0;
    promptIndex -= 1
  ) {
    const text = liveUserTexts[promptIndex];
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const message = remaining[index];
      if (message.role !== "user") continue;
      if (message.content.trim() !== text) break;
      if (message.entryId) deliveredEntryIds.push(message.entryId);
      remaining.splice(index, 1);
      break;
    }
  }
  return { messages: remaining, deliveredEntryIds };
};

const recentMessagesWithinBudget = (messages, maxTokens) => {
  const selected = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const serialized = serializeEntries([message]);
    const tokens = estimateCanonicalTextTokens(serialized);
    if (selected.length > 0 && used + tokens > maxTokens) break;
    selected.push(message);
    used += tokens;
    if (used >= maxTokens) break;
  }
  return selected.reverse();
};

const truncateMiddle = (value, maxChars) => {
  if (value.length <= maxChars) return value;
  const marker =
    "\n\n[Middle of the combined chunk summaries omitted to fit the target context.]\n\n";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  return `${value.slice(0, headChars)}${marker}${value.slice(-(available - headChars))}`;
};

export const prepareExternalSessionCatchUp = async (args) => {
  const rawMessages = args.store.loadRawThreadMessagesWithEntryTypes(
    args.threadKey,
  );
  const boundarySequence = rawMessages.reduce(
    (maximum, message) => Math.max(maximum, Number(message.sequence) || 0),
    0,
  );
  const delivery = args.nativeSessionId
    ? args.store.getExternalEngineSessionDelivery({
        threadKey: args.threadKey,
        engine: args.engine,
        provider: args.provider,
        model: args.model,
        nativeSessionId: args.nativeSessionId,
      })
    : undefined;
  const deliveredThroughSequence = delivery?.deliveredThroughSequence ?? 0;
  const deliveredEntryIds = new Set(delivery?.deliveredEntryIds ?? []);
  const missing = rawMessages.filter(
    (message) =>
      isPortableCanonicalMessage(message) &&
      (Number(message.sequence) || 0) > deliveredThroughSequence &&
      !deliveredEntryIds.has(message.entryId),
  );
  const deduplicated = removeLivePromptDuplicates(
    missing,
    args.promptMessages ?? [],
  );
  if (deduplicated.messages.length === 0) {
    return {
      promptMessage: undefined,
      boundarySequence,
      deliveredEntryIds: deduplicated.deliveredEntryIds,
      mode: "none",
      entryCount: missing.length,
    };
  }

  const serialized = serializeEntries(deduplicated.messages);
  const canonicalWindow = resolveCanonicalContextWindow(
    args.resolvedLlm?.model?.contextWindow,
  );
  const livePromptTokens = estimateCanonicalTextTokens(
    [
      args.systemPrompt,
      ...(args.promptMessages ?? []).map(promptMessageText),
    ].join("\n"),
  );
  const catchUpBudget = Math.min(
    canonicalWindow,
    Math.max(
      512,
      Math.floor(canonicalWindow * 0.7) -
        livePromptTokens -
        CATCH_UP_RESERVE_TOKENS,
    ),
  );
  let body = serialized;
  let mode = "delta";
  let chunkedSummary = false;
  if (
    estimateCanonicalTextTokens(serialized) >
    Math.max(1, catchUpBudget - CATCH_UP_WRAPPER_RESERVE_TOKENS)
  ) {
    const generated = await summarizeCanonicalCatchUp({
      threadKey: args.threadKey,
      messages: deduplicated.messages,
      resolvedLlm: args.resolvedLlm,
      ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    });
    if (!generated.text) {
      throw new Error(
        `Unable to compact external-engine catch-up: ${generated.reason ?? "summary generation failed"}`,
      );
    }
    const recentReferentBudget = Math.min(
      RECENT_REFERENT_TOKENS,
      Math.floor(catchUpBudget / 3),
    );
    const recentMessages = recentMessagesWithinBudget(
      deduplicated.messages,
      recentReferentBudget,
    );
    const recent = truncateMiddle(
      serializeEntries(recentMessages),
      Math.max(256, recentReferentBudget * 4),
    );
    const prefix =
      "[The missing canonical interval was compacted in ordered independent chunks.]";
    const recentBlock = recent
      ? `## Most recent canonical entries (verbatim; use these for pronouns and follow-ups)\n\n${recent}`
      : "";
    const summaryCharBudget = Math.max(
      1_000,
      catchUpBudget * 4 - prefix.length - recentBlock.length - 1_000,
    );
    body = [
      prefix,
      truncateMiddle(generated.text, summaryCharBudget),
      recentBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
    mode = "chunked_summary";
    chunkedSummary = true;
  }

  const firstSequence = Number(deduplicated.messages[0]?.sequence) || 0;
  const opening = [
    `<stella_thread_updates mode="${mode}" from_sequence="${firstSequence}" through_sequence="${boundarySequence}">`,
    "These are ordered canonical Stella thread updates that this native session has not received. Apply them before resolving the current user request.",
  ].join("\n\n");
  const closing = "</stella_thread_updates>";
  const boundedBody = truncateMiddle(
    body,
    Math.max(1, catchUpBudget * 4 - opening.length - closing.length - 4),
  );
  const promptMessage = {
    text: [opening, boundedBody, closing].join("\n\n"),
    customType: "runtime.stella_thread_updates",
    isVisible: false,
  };
  logger.info("external-session.catch-up-prepared", {
    threadKey: args.threadKey,
    engine: args.engine,
    provider: args.provider,
    model: args.model,
    nativeSessionId: args.nativeSessionId,
    deliveredThroughSequence,
    boundarySequence,
    entryCount: deduplicated.messages.length,
    mode,
    chunkedSummary,
    promptTokens: estimateCanonicalTextTokens(promptMessage.text),
  });
  return {
    promptMessage,
    boundarySequence,
    deliveredEntryIds: deduplicated.deliveredEntryIds,
    mode,
    entryCount: deduplicated.messages.length,
  };
};

export const commitExternalSessionDelivery = (args) => {
  if (!args.nativeSessionId) return;
  args.store.commitExternalEngineSessionDelivery({
    threadKey: args.threadKey,
    engine: args.engine,
    provider: args.provider,
    model: args.model,
    nativeSessionId: args.nativeSessionId,
    deliveredThroughSequence: args.boundarySequence,
    deliveredEntryIds: args.deliveredEntryIds,
  });
  logger.info("external-session.delivery-committed", {
    threadKey: args.threadKey,
    engine: args.engine,
    provider: args.provider,
    model: args.model,
    nativeSessionId: args.nativeSessionId,
    deliveredThroughSequence: args.boundarySequence,
    sparseEntryCount: args.deliveredEntryIds?.length ?? 0,
  });
};
