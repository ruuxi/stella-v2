import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
  type WorkingIndicatorState,
} from "../components/working-indicator-state";
import type { JournalRecord } from "@stella/contracts/conversation-protocol";
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
  /**
   * Whether every row the journal has promised is applied. While it is not,
   * the retained records are a prefix of the truth, and a turn that looks
   * unfinished in them may have ended a thousand rows later.
   */
  caughtUp?: boolean;
  /** The journal owner's own answer to "is this conversation working?". */
  authoritativeActivity?: "idle" | "running";
}): { sending: boolean; workingIndicator: WorkingIndicatorState } {
  // Mid-replay the record fold is not evidence: every `started` row without its
  // terminal row yet reads as running, so deriving the button from it made the
  // composer flip between send and stop for as long as catching up took. The
  // conversation's owner knows the answer without the transcript, so take it
  // from there until the view is whole.
  const trustRecords = args.caughtUp !== false;
  const runningTurnId = trustRecords
    ? activeCloudTurnId(args.records, args.live)
    : args.authoritativeActivity === "running"
      ? (args.live?.turnId ?? activeCloudTurnId(args.records, args.live))
      : null;
  // `ready` can name a running conversation and then immediately `reset`, which
  // drops both the retained rows and the live turn — so there is nothing left to
  // point at even though the authority just said work is in flight. Showing Send
  // there is the same wrong answer as the flicker, arrived at from the other
  // side, so the activity alone is enough to keep Stop until the view is whole.
  const authoritativeRunning =
    !trustRecords && args.authoritativeActivity === "running";
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
  const sending =
    localPending ||
    Boolean(runningTurnId) ||
    authoritativeRunning ||
    Boolean(args.hasQueuedSend);
  if (localPending && !localTurnId) {
    // A new prompt has no canonical echo yet. An old answer must not hide it.
    return { sending, workingIndicator: args.localIndicator };
  }
  const turnId = localPending ? localTurnId : runningTurnId;
  const journal = cloudTurnActivity(args.records, turnId);
  const live = args.live?.turnId === turnId ? args.live : null;
  // Admission does not replace the device stream. Keep its in-flight tool
  // until canonical answer/terminal evidence takes over.
  const deviceTool = localPending && !journal.answerLanded
    ? args.localIndicator.toolName : undefined;
  return {
    sending,
    workingIndicator: buildWorkingIndicatorState({
      sending,
      activity: turnId ? {
        ...journal,
        // The prior answer is visible, but a later prompt is already waiting.
        answerLanded: journal.answerLanded && !args.hasQueuedSend,
        ...((!journal.answerLanded || args.hasQueuedSend) && live?.toolName ? { toolName: live.toolName } : {}),
        ...((!journal.answerLanded || args.hasQueuedSend) && live?.toolLabel ? { statusText: live.toolLabel } : {}),
        ...(deviceTool ? { toolName: deviceTool,
          toolCallId: args.localIndicator.toolCallId,
          statusText: args.localIndicator.status } : {}),
        hasToolActivity: journal.hasToolActivity || Boolean(live?.toolName),
      } : { ...IDLE_WORKING_ACTIVITY, answerLanded: localTerminal && !args.hasQueuedSend },
    }),
  };
}
