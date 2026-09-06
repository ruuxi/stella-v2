import type {
  AutomaticExecutionAdmissionInput,
  AutomaticExecutionStatusSnapshot,
} from "./execution-placement-core";

/** A landed attachment, as the placement decision needs to see it. */
export type PlacementAttachment = { path: string; kind: "image" | "file" };

/**
 * Both placements read the same drive paths, but only one of them can read a
 * document. A cloud turn hydrates the drive into its world, so the agent opens
 * `uploads/…/lease.pdf` with Read. A computer-placed turn has no drive mirror:
 * the desktop resolves each path to a signed GET, and the runtime materializes
 * an image from one but has nowhere to put a PDF and no tool that reaches the
 * drive by path.
 *
 * So a document names the hosted subject rather than being offered to a
 * desktop that would answer about a file it never opened. Placement stays
 * invisible either way, which is the whole reason it is safe to decide here.
 */
export const attachmentsNeedHostedSubject = (
  attachments: readonly PlacementAttachment[],
): boolean => attachments.some((entry) => entry.kind !== "image");

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
 * - A turn carrying a document names the hosted subject, which the policy
 *   commits straight to cloud. See `attachmentsNeedHostedSubject`.
 */
export const unifiedChatPlacementAdmission = (args: {
  dispatchId: string;
  userMessageEventId?: string;
  conversationId: string;
  prompt: string;
  attachments?: readonly PlacementAttachment[];
}): AutomaticExecutionAdmissionInput => {
  const attachments = args.attachments ?? [];
  return {
    idempotencyKey: args.dispatchId,
    ...(args.userMessageEventId ? { userMessageEventId: args.userMessageEventId } : {}),
    conversationId: args.conversationId,
    kind: "chat",
    prompt: args.prompt,
    subject: attachmentsNeedHostedSubject(attachments) ? "cloud" : "computer",
    requiredCapabilities: attachments.length ? ["chat", "attachments"] : ["chat"],
    ...(attachments.length
      ? { attachments: attachments.map((entry) => entry.path) }
      : {}),
  };
};

/**
 * Placement is an implementation detail. Leave ordinary in-flight states to
 * the working indicator's friendly thinking/tool copy; only cancellation
 * needs an explicit status.
 */
export const unifiedChatPlacementStatusText = (
  dispatch: AutomaticExecutionStatusSnapshot,
): string | undefined =>
  dispatch.state === "cancel_pending" ? "Stopping" : undefined;
