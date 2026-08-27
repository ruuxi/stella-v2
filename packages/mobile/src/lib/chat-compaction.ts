import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";

const CHECKPOINT_KEY = "stella-mobile-chat-checkpoint-v1";

const EST_CHARS_PER_TOKEN = 4;

export const COMPACTION_TRIGGER_TOKENS = 6_000;

export const KEEP_RECENT_TOKENS = 2_000;

export const PROTECT_HEAD_MESSAGES = 2;

export const MIN_TAIL_MESSAGES = 4;

export type ChatCheckpoint = {

  summary: string;

  coveredIds: string[];
  updatedAt: number;
};

export type HistoryTurn = { role: ChatMessage["role"]; text: string };

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / EST_CHARS_PER_TOKEN);

const messageTokens = (message: Pick<ChatMessage, "text">): number =>
  estimateTokens(message.text ?? "");

export const uncoveredMessages = (
  messages: ChatMessage[],
  checkpoint: ChatCheckpoint | null,
): ChatMessage[] => {
  if (!checkpoint || checkpoint.coveredIds.length === 0) return messages;
  const covered = new Set(checkpoint.coveredIds);
  return messages.filter((message) => !covered.has(message.id));
};

export const contextTokenEstimate = (
  messages: ChatMessage[],
  checkpoint: ChatCheckpoint | null,
): number => {
  const summaryTokens = checkpoint ? estimateTokens(checkpoint.summary) : 0;
  const tail = uncoveredMessages(messages, checkpoint);
  return summaryTokens + tail.reduce((sum, m) => sum + messageTokens(m), 0);
};

export async function loadCheckpoint(): Promise<ChatCheckpoint | null> {
  try {
    const raw = await AsyncStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const summary =
      typeof record.summary === "string" ? record.summary.trim() : "";
    const coveredIds = Array.isArray(record.coveredIds)
      ? record.coveredIds.filter((id): id is string => typeof id === "string")
      : [];
    if (!summary || coveredIds.length === 0) return null;
    return {
      summary,
      coveredIds,
      updatedAt:
        typeof record.updatedAt === "number" &&
        Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0,
    };
  } catch {
    return null;
  }
}

export async function saveCheckpoint(
  checkpoint: ChatCheckpoint,
): Promise<void> {
  await AsyncStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

export async function clearCheckpoint(): Promise<void> {
  await AsyncStorage.removeItem(CHECKPOINT_KEY);
}

export type CompactionPlan = {

  middle: ChatMessage[];

  previousSummary: string | undefined;

  nextCoveredIds: string[];
};

export function planCompaction(
  messages: ChatMessage[],
  checkpoint: ChatCheckpoint | null,
): CompactionPlan | null {
  if (contextTokenEstimate(messages, checkpoint) < COMPACTION_TRIGGER_TOKENS) {
    return null;
  }
  const tail = uncoveredMessages(messages, checkpoint);

  const compressionStart = checkpoint
    ? 0
    : Math.min(PROTECT_HEAD_MESSAGES, tail.length);

  let accumulated = 0;
  let tailStart = tail.length;
  for (let index = tail.length - 1; index >= compressionStart; index -= 1) {
    const tokens = messageTokens(tail[index]!);
    if (accumulated + tokens > KEEP_RECENT_TOKENS && tailStart < tail.length) {
      break;
    }
    accumulated += tokens;
    tailStart = index;
  }

  const minTailStart = tail.length - MIN_TAIL_MESSAGES;
  if (minTailStart >= compressionStart) {
    tailStart = Math.min(tailStart, minTailStart);
  }

  const middle = tail.slice(compressionStart, tailStart);
  if (middle.length === 0) return null;

  const nextCoveredIds = [
    ...(checkpoint?.coveredIds ?? []),
    ...middle.map((message) => message.id),
  ];
  return {
    middle,
    previousSummary: checkpoint?.summary,
    nextCoveredIds,
  };
}

const SUMMARY_STRUCTURE = `## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now - what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]`;

const SUMMARY_GUIDELINES =
  "Guidelines:\n- Preserve durable facts about the user (name, location, stable preferences, ongoing situation) that were stated in these turns.\n- Quote any question you asked the user that was left unanswered, verbatim, under Open Items.\n- Be factual - only include information explicitly discussed. Do not invent details.";

export const formatMessagesForCompaction = (
  messages: ChatMessage[],
): string =>
  messages
    .map((message) => {
      const who = message.role === "user" ? "User" : "Assistant";
      return `${who}: ${message.text.trim()}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");

export const computeSummaryBudget = (middle: ChatMessage[]): number => {
  const tokens = middle.reduce((sum, m) => sum + messageTokens(m), 0);
  return Math.max(80, Math.floor(tokens * 0.3));
};

export function buildSummaryPrompt(
  formattedConversation: string,
  previousSummary: string | undefined,
  budget: number,
): string {
  const footer = `${SUMMARY_GUIDELINES}\n\nTarget ~${budget} tokens. Write only the summary body.`;
  if (previousSummary?.trim()) {
    return `You are updating a conversation summary. A previous summary exists below. New conversation turns have occurred since then and need to be incorporated.\n\nPREVIOUS SUMMARY:\n${previousSummary.trim()}\n\nNEW TURNS TO INCORPORATE:\n${formattedConversation}\n\nUpdate the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if it is clearly obsolete.\n\n${SUMMARY_STRUCTURE}\n\n${footer}`;
  }
  return `Create a concise summary of this conversation that preserves the important information for future context.\n\nCONVERSATION TO SUMMARIZE:\n${formattedConversation}\n\nUse this structure:\n\n${SUMMARY_STRUCTURE}\n\n${footer}`;
}

export async function runCompaction(args: {
  messages: ChatMessage[];
  checkpoint: ChatCheckpoint | null;
  summarize: (prompt: string) => Promise<string>;
}): Promise<ChatCheckpoint | null> {
  const plan = planCompaction(args.messages, args.checkpoint);
  if (!plan) return null;
  const prompt = buildSummaryPrompt(
    formatMessagesForCompaction(plan.middle),
    plan.previousSummary,
    computeSummaryBudget(plan.middle),
  );
  let summary = "";
  try {
    summary = (await args.summarize(prompt)).trim();
  } catch {

    return null;
  }
  if (!summary) return null;
  const checkpoint: ChatCheckpoint = {
    summary,
    coveredIds: plan.nextCoveredIds,
    updatedAt: Date.now(),
  };
  await saveCheckpoint(checkpoint);
  return checkpoint;
}

export function buildCompactedContext(
  messages: ChatMessage[],
  checkpoint: ChatCheckpoint | null,
): { summary: string; history: HistoryTurn[] } {
  const tail = uncoveredMessages(messages, checkpoint);
  return {
    summary: checkpoint?.summary ?? "",
    history: tail
      .map((message) => ({ role: message.role, text: message.text.trim() }))
      .filter((turn) => turn.text.length > 0),
  };
}
