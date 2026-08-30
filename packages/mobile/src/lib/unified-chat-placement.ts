import type {
  AutomaticExecutionAdmissionInput,
  AutomaticExecutionStatusSnapshot,
} from "./execution-placement-core";

/**
 * The one chat has no placement control. Every turn is offered to the paired
 * computer and the placement service falls back to cloud on its own, so this
 * describes a preference rather than a destination:
 *
 * - Subject "computer" asks the service to offer the turn to the desktop first.
 *   A mobile ingress always keeps the cloud fallback, so an offer that nobody
 *   claims still runs.
 * - The capability list stays "chat" for the same reason. Requiring
 *   "computer-use" would make any desktop that does not advertise it (a Linux
 *   host, an older build) ineligible for ordinary chat work.
 * - A turn with attachments adds "attachments", which a desktop only
 *   advertises once it can resolve a drive path. That gates the old builds out
 *   of attachment turns specifically, rather than out of chat entirely, and the
 *   cloud provides the capability itself so the turn still runs.
 */
export const unifiedChatPlacementAdmission = (args: {
  dispatchId: string;
  conversationId: string;
  prompt: string;
  attachments?: readonly string[];
}): AutomaticExecutionAdmissionInput => ({
  idempotencyKey: args.dispatchId,
  conversationId: args.conversationId,
  kind: "chat",
  prompt: args.prompt,
  subject: "computer",
  requiredCapabilities: args.attachments?.length
    ? ["chat", "attachments"]
    : ["chat"],
  ...(args.attachments?.length ? { attachments: args.attachments } : {}),
});

/**
 * The only trace placement leaves on the surface: one line of status copy while
 * the turn is in flight. It names where the work ended up because a phone that
 * woke a sleeping desktop should be able to tell, but the user never chose it
 * and there is nothing to act on.
 */
export const unifiedChatPlacementStatusText = (
  dispatch: AutomaticExecutionStatusSnapshot,
): string | undefined => {
  switch (dispatch.state) {
    case "queued":
    case "offering":
    case "computer_claimed":
      return "Choosing where to run";
    case "computer_accepted":
    case "computer_running":
      return "Running on your computer";
    case "cloud_committed":
    case "cloud_running":
      return "Running in Stella Cloud";
    case "cancel_pending":
      return "Stopping";
    case "reconciliation_required":
      return "Reconnecting to your computer";
    default:
      return undefined;
  }
};
