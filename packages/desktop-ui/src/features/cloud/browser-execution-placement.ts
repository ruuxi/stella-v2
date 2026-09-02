import {
  PLACEMENT_PROTOCOL,
  type DispatchPayload,
  type DispatchSubmitRequest,
  type DispatchSummary,
  type ExecutionTargetMode,
} from "@stella/contracts/turn-plane/placement";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { PendingCloudTurnSubmission } from "./conversation-store";
import type { DesktopExecutionTarget } from "../execution-placement/execution-target-store";

/** The gate's dispatch row, as the browser reads it. */
export type BrowserExecutionDispatch = DispatchSummary;

const routingFields = (
  target?: DesktopExecutionTarget,
): { targetMode: ExecutionTargetMode; targetDeviceId?: string } => {
  const selected = target ?? { mode: "automatic" as const };
  return {
    targetMode: selected.mode,
    ...(selected.mode === "device"
      ? { targetDeviceId: selected.deviceId }
      : {}),
  };
};

/** Only the four fields the gate carries, in a stable key order. */
const canonicalExecution = (
  execution: CloudExecutionSelection | null,
): CloudExecutionSelection | null =>
  execution
    ? ({
        engine: execution.engine,
        provider: execution.provider,
        model: execution.model,
        reasoningEffort: execution.reasoningEffort,
      } as CloudExecutionSelection)
    : null;

/**
 * Exactly the bytes an executing device receives. The owner gate hashes this
 * object, hands it to whichever computer claims the offer, and deletes its
 * copy on ack — so an idempotent retry must rebuild it identically.
 */
export const browserExecutionPayload = (args: {
  clientMsgId: string;
  conversationId: string;
  submission: PendingCloudTurnSubmission;
}): DispatchPayload => {
  if (args.submission.requestedConversationId !== args.conversationId) {
    throw new Error(
      "Reliable browser execution changed conversation authority.",
    );
  }
  const execution = canonicalExecution(args.submission.execution);
  return {
    schemaVersion: 1,
    prompt: args.submission.prompt,
    conversationId: args.conversationId,
    clientMsgId: args.clientMsgId,
    ...(args.submission.locale ? { locale: args.submission.locale } : {}),
    ...(args.submission.imagePaths.length
      ? { attachments: [...args.submission.imagePaths] }
      : {}),
    ...(execution ? { execution } : {}),
  };
};

export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** The `POST /owners/me/dispatches` body for one browser-originated turn. */
export const browserExecutionSubmitArgs = async (args: {
  clientMsgId: string;
  conversationId: string;
  submission: PendingCloudTurnSubmission;
}): Promise<DispatchSubmitRequest> => ({
  protocol: PLACEMENT_PROTOCOL,
  idempotencyKey: args.clientMsgId,
  kind: "chat",
  ingress: "browser",
  subject: "cloud",
  conversationId: args.conversationId,
  requiredCapabilities: ["chat"],
  ...routingFields(args.submission.executionTarget),
  payload: browserExecutionPayload(args),
});

export const browserExecutionCancelArgs = (dispatchId: string) => ({
  dispatchId,
  cancelRequestId: `cancel:${dispatchId}`,
  reason: "Canceled by the user.",
});

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "blocked"]);

export type BrowserExecutionWaitResult =
  | { status: "started"; dispatch: BrowserExecutionDispatch; turnId: string }
  | { status: "terminal"; dispatch: BrowserExecutionDispatch }
  | { status: "stale" };

/**
 * Polls the owner gate until placement produces a turn to subscribe to, or
 * the dispatch settles. The caller injects the authenticated status reader.
 */
export const waitForBrowserExecutionTurn = async (args: {
  dispatchId: string;
  queryStatus: (dispatchId: string) => Promise<BrowserExecutionDispatch | null>;
  isCurrentAccount: () => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}): Promise<BrowserExecutionWaitResult> => {
  const delay =
    args.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, args.attempts ?? 240);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!args.isCurrentAccount()) return { status: "stale" };
    const dispatch = await args.queryStatus(args.dispatchId);
    if (!args.isCurrentAccount()) return { status: "stale" };
    if (!dispatch) {
      throw new Error("That cloud turn is no longer available.");
    }
    if (TERMINAL_STATES.has(dispatch.state)) {
      return { status: "terminal", dispatch };
    }
    if (dispatch.cloudTurnId) {
      return {
        status: "started",
        dispatch,
        turnId: dispatch.cloudTurnId,
      };
    }
    if (attempt + 1 < attempts) await delay(250);
  }
  throw new Error(
    "Stella accepted that turn but is still starting it. Retry to check again.",
  );
};
