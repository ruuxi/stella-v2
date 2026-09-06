import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
  type WorkingIndicatorState,
} from "../components/working-indicator-state";
import type { JournalRecord } from "./cloud-conversation-protocol";
import type { LiveTurn } from "./cloud-conversation-store";
import { activeCloudTurnId, cloudTurnActivity } from "./cloud-journal-projection";

/** The journal can finish a visible turn before its placement poll returns. */
export function canonicalWorkingState(args: {
  records: readonly JournalRecord[];
  live: LiveTurn | null;
  localSending: boolean;
  localIndicator: WorkingIndicatorState;
  activeDispatchId: string | null;
  activeSendMessageId?: string | null;
  /** Unsent user rows waiting behind the active placement waiter. */
  hasQueuedSend?: boolean;
}): { sending: boolean; workingIndicator: WorkingIndicatorState } {
  const runningTurnId = activeCloudTurnId(args.records, args.live);
  const localTurnId = args.activeDispatchId || args.activeSendMessageId
    ? args.records.find((record) =>
        record.kind === "message" && record.role === "user" &&
        ((Boolean(args.activeDispatchId) && record.clientMsgId === args.activeDispatchId) ||
          (Boolean(args.activeSendMessageId) && record.payload.originUserMessageId === args.activeSendMessageId)))?.turnId ?? null
    : null;
  const localTerminal = Boolean(localTurnId && args.records.some((record) =>
    record.kind === "turn" && record.turnId === localTurnId &&
    record.phase !== "started"));
  const localPending = args.localSending && !localTerminal;
  const sending = localPending || Boolean(runningTurnId) || Boolean(args.hasQueuedSend);
  if (localPending && !localTurnId) {
    // A new prompt has no canonical echo yet. An old answer must not hide it.
    return { sending, workingIndicator: args.localIndicator };
  }
  const turnId = localPending ? localTurnId : runningTurnId;
  const journal = cloudTurnActivity(args.records, turnId);
  const live = args.live?.turnId === turnId ? args.live : null;
  return {
    sending,
    workingIndicator: buildWorkingIndicatorState({
      sending,
      activity: turnId ? {
        ...journal,
        // The prior answer is visible, but a later prompt is already waiting.
        answerLanded: journal.answerLanded && !args.hasQueuedSend,
        ...(live?.toolName ? { toolName: live.toolName } : {}),
        ...(live?.toolLabel ? { statusText: live.toolLabel } : {}),
        hasToolActivity: journal.hasToolActivity || Boolean(live?.toolName),
      } : { ...IDLE_WORKING_ACTIVITY, answerLanded: localTerminal && !args.hasQueuedSend },
    }),
  };
}
