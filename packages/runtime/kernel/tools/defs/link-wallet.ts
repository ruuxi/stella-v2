import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { LinkWalletSnapshot } from "@stella/contracts/link-wallet";
import type { ToolDefinition } from "../types.js";

export const LINK_WALLET_TOOL_NAME = "link_wallet";

export type LinkWalletConnectionRequester = (
  payload: {
    conversationId?: string;
    reason?: string;
  },
  signal?: AbortSignal,
) => Promise<
  | {
      ok: true;
      status: "connected" | "already_connected";
      snapshot?: LinkWalletSnapshot;
    }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    }
>;

export type LinkWalletToolOptions = {
  requestLinkWalletConnection?: LinkWalletConnectionRequester;
};

const summarizeSnapshot = (snapshot: LinkWalletSnapshot): string => {
  if (snapshot.status !== "connected") {
    return "Link is not connected.";
  }
  const cards =
    snapshot.paymentMethods.length === 0
      ? "no cards on file"
      : snapshot.paymentMethods
          .map(
            (method) =>
              `${method.brand} •••• ${method.last4}${method.isDefault ? " (default)" : ""}`,
          )
          .join(", ");
  return `Link is connected. Cards: ${cards}. Spend history: ${snapshot.spends.length} item${snapshot.spends.length === 1 ? "" : "s"}. Pay with the link-wallet skill (\`npx --yes @stripe/link-cli\`) using \`--request-approval\`. Do not paste card numbers into chat.`;
};

export const createLinkWalletTool = (
  options: LinkWalletToolOptions,
): ToolDefinition => ({
  name: LINK_WALLET_TOOL_NAME,
  label: "Link wallet",
  workingText: "Checking Link",
  agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL],
  description:
    "Check whether the user's Link wallet is connected, and if not, show an inline connect card (same consent pattern as OAuth). Deterministic — the card is the user's consent, so don't ask permission before calling. Blocks until they connect, decline, or the card times out. Do not run Link CLI `auth login` yourself; this tool owns login UX. Not Stella product billing and not the Stripe Connect connector.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          'Optional one-line, user-facing context shown on the card (e.g. "To pay for this order").',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, context, extras) => {
    if (!options.requestLinkWalletConnection) {
      return {
        error:
          "Link wallet connect is unavailable in this session. The user can connect from Settings → Wallet.",
        details: { status: "unavailable" },
      };
    }
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : undefined;
    const outcome = await options.requestLinkWalletConnection(
      {
        ...(reason ? { reason } : {}),
        ...(context?.conversationId
          ? { conversationId: context.conversationId }
          : {}),
      },
      extras?.signal,
    );
    if (outcome.ok) {
      const summary = outcome.snapshot
        ? summarizeSnapshot(outcome.snapshot)
        : "Link is connected.";
      return {
        result:
          outcome.status === "already_connected"
            ? summary
            : `${summary} The user just approved the connect card — continue the original task immediately.`,
        details: { status: "connected" },
      };
    }
    if (outcome.reason === "declined") {
      return {
        result:
          "The user declined connecting Link. Mention once that they can connect from Settings → Wallet later, then proceed without paying. Do not offer Link again this turn.",
        details: { status: "declined" },
      };
    }
    if (outcome.reason === "cancelled" && extras?.signal?.aborted) {
      return {
        result: "The turn was cancelled before the user answered the Link connect card.",
        details: { status: "not_connected", reason: "turn_cancelled" },
      };
    }
    if (outcome.reason === "cancelled" || outcome.reason === "timeout") {
      return {
        result: `The Link connect card was ${outcome.reason === "timeout" ? "not answered in time" : "dismissed"}. Mention once that Link is available in Settings → Wallet, and proceed without paying.`,
        details: {
          status: "not_connected",
          reason: outcome.reason === "timeout" ? "timeout" : "dismissed",
        },
      };
    }
    if (outcome.reason === "already_pending") {
      return {
        result:
          "A Link connect card is already on screen. Wait for the user to finish it.",
        details: { status: "not_connected", reason: "already_pending" },
      };
    }
    return {
      error: `Could not run the Link connect flow: ${outcome.reason}. It is not connected.`,
      details: { status: "not_connected", reason: outcome.reason },
    };
  },
});
