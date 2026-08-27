import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { PendingCloudTurnSubmission } from "./conversation-store";

export type BrowserExecutionDispatch = {
  dispatchId: string;
  idempotencyKey: string;
  kind: "chat" | "agent";
  ingress: string;
  subject: string;
  conversationId: string;
  state: string;
  placement?: "computer" | "cloud";
  cloudTurnId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type BrowserExecutionSubmitArgs = {
  idempotencyKey: string;
  expectedOwnerGeneration: string;
  payloadJson: string;
  payloadHash: string;
  kind: "chat";
  subject: "cloud";
  conversationId: string;
  requiredCapabilities: ["chat"];
};

const canonicalExecution = (
  execution: CloudExecutionSelection | null,
): {
  engine: string;
  provider: string;
  model: string;
  reasoningEffort: string;
} | null =>
  execution
    ? {
        engine: execution.engine,
        provider: execution.provider,
        model: execution.model,
        reasoningEffort: execution.reasoningEffort,
      }
    : null;

/** Exact bytes fingerprinted by Convex and reused by an idempotent retry. */
export const browserExecutionPayloadJson = (args: {
  clientMsgId: string;
  expectedOwnerGeneration: string;
  conversationId: string;
  submission: PendingCloudTurnSubmission;
}): string => {
  if (args.submission.requestedConversationId !== args.conversationId) {
    throw new Error(
      "Reliable browser execution changed conversation authority.",
    );
  }
  return JSON.stringify({
    schemaVersion: 1,
    prompt: args.submission.prompt,
    expectedOwnerGeneration: args.expectedOwnerGeneration,
    conversationId: args.conversationId,
    clientMsgId: args.clientMsgId,
    locale: args.submission.locale,
    attachments: [...args.submission.imagePaths],
    execution: canonicalExecution(args.submission.execution),
  });
};

export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const browserExecutionSubmitArgs = async (args: {
  clientMsgId: string;
  expectedOwnerGeneration: string;
  conversationId: string;
  submission: PendingCloudTurnSubmission;
}): Promise<BrowserExecutionSubmitArgs> => {
  const payloadJson = browserExecutionPayloadJson(args);
  return {
    idempotencyKey: args.clientMsgId,
    expectedOwnerGeneration: args.expectedOwnerGeneration,
    payloadJson,
    payloadHash: await sha256Hex(payloadJson),
    kind: "chat",
    subject: "cloud",
    conversationId: args.conversationId,
    requiredCapabilities: ["chat"],
  };
};

export const browserExecutionCancelArgs = (dispatchId: string) => ({
  dispatchId,
  cancelRequestId: `cancel:${dispatchId}`,
  reason: "Canceled by the user.",
});

const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

export type BrowserExecutionWaitResult =
  | { status: "started"; dispatch: BrowserExecutionDispatch; turnId: string }
  | { status: "terminal"; dispatch: BrowserExecutionDispatch }
  | { status: "stale" };

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
