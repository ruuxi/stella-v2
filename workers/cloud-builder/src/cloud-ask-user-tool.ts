import type { TSchema } from "@sinclair/typebox";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  clampUserAskTimeoutMs,
  userAskDefaultedResolution,
  type UserAskAnswer,
  type UserAskDetail,
  type UserAskQuestion,
  type UserAskResolution,
  type UserAskState,
  type UserAskUrgencyLevel,
} from "@stella/contracts/user-ask";
import {
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_LABEL,
  ASK_USER_TOOL_NAME,
  ASK_USER_TOOL_PARAMETERS,
  ASK_USER_TOOL_WORKING_TEXT,
  prepareAskUser,
  userAskResolutionResult,
} from "@stella/runtime/kernel/tools/defs/ask-user-def.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import type { OwnerInternalCall } from "./owner-store/registry.js";

const CLOUD_ORCHESTRATOR_ASK_THREAD_ID = AGENT_IDS.ORCHESTRATOR;

const FIRST_POLL_MS = 1_000;
const POLL_MS = 2_000;

type AnswerRead = {
  askId: string;
  state: UserAskState;
  answer?: UserAskAnswer;
  late?: boolean;
  answeredAt?: number;
};

export type CloudAskUserToolContext = Readonly<{
  conversationId: string;
  ownerInternal: OwnerInternalCall;
}>;

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const answered = (
  askId: string,
  read: AnswerRead,
  deadlineAt: number,
): UserAskResolution | null => {
  const answer = read.answer;
  if (!answer || answer.kind !== "questions") return null;
  const answeredAt = read.answeredAt ?? Date.now();
  if (read.late || answeredAt >= deadlineAt) return null;
  return {
    outcome: "answered",
    askId,
    responses: answer.responses,
    answeredAt,
  };
};

const askOnOwner = async (
  context: CloudAskUserToolContext,
  request: {
    questions: readonly UserAskQuestion[];
    timeoutMs?: number;
    urgency: UserAskUrgencyLevel;
  },
  toolCallId: string,
  signal: AbortSignal | undefined,
): Promise<UserAskResolution> => {
  const timeoutMs = clampUserAskTimeoutMs(request.timeoutMs);
  const detail: UserAskDetail = { kind: "question", questions: request.questions };
  const askId = crypto.randomUUID();
  const registered = (await context.ownerInternal("userAsks.turnRegister", {
    askId,
    kind: "question",
    conversationId: context.conversationId,
    threadId: CLOUD_ORCHESTRATOR_ASK_THREAD_ID,
    toolCallId: toolCallId.slice(0, 160),
    agentLabel: "Stella",
    urgency: request.urgency,
    blocking: false,
    timeoutMs,
    detail,
  })) as { ask?: { deadlineAt?: number } } | null;
  const deadlineAt = registered?.ask?.deadlineAt ?? Date.now() + timeoutMs;
  const defaulted = () => userAskDefaultedResolution(askId, detail, Date.now());
  let delay = FIRST_POLL_MS;
  while (true) {
    if (signal?.aborted) {
      await context.ownerInternal("userAsks.turnCancel", { askId }).catch(() => undefined);
      return {
        outcome: "canceled",
        askId,
        at: Date.now(),
        note: "The turn stopped before the question was answered.",
      };
    }
    const now = Date.now();
    const last = now >= deadlineAt;
    if (!last) {
      await sleep(Math.max(250, Math.min(delay, deadlineAt - now)), signal);
      delay = POLL_MS;
      if (signal?.aborted) continue;
    }
    let read: AnswerRead;
    try {
      read = (await context.ownerInternal("userAsks.turnAnswer", { askId })) as AnswerRead;
    } catch (error) {
      if (last) return defaulted();
      return {
        outcome: "canceled",
        askId,
        at: Date.now(),
        note: `That question could not be kept open: ${(error as Error).message}`,
      };
    }
    const resolution = answered(askId, read, deadlineAt);
    if (resolution) return resolution;
    if (last || read.state === "defaulted" || read.answer) return defaulted();
    if (read.state === "canceled" || read.state === "expired") {
      return {
        outcome: read.state,
        askId,
        at: Date.now(),
        note:
          read.state === "canceled"
            ? "The user dismissed that question without answering."
            : "That question went unanswered long enough that it expired.",
      };
    }
  }
};

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  details: null,
  isError: true,
});

export const createCloudAskUserTool = (
  context: CloudAskUserToolContext,
): CloudCodeSourceAgentTool => ({
  name: ASK_USER_TOOL_NAME,
  label: ASK_USER_TOOL_LABEL,
  workingText: ASK_USER_TOOL_WORKING_TEXT,
  replay: "unsafe",
  description: ASK_USER_TOOL_DESCRIPTION,
  parameters: ASK_USER_TOOL_PARAMETERS as unknown as TSchema,
  execute: async (toolCallId, params, signal) => {
    const prepared = prepareAskUser((params ?? {}) as Record<string, unknown>, {
      orchestrator: true,
    });
    if (!prepared.ok) return failure(prepared.error);
    let resolution: UserAskResolution;
    try {
      resolution = await askOnOwner(context, prepared, toolCallId, signal);
    } catch (error) {
      return failure((error as Error).message || "The ask failed.");
    }
    const { result } = userAskResolutionResult(resolution, prepared.questions);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
});
