import { promises as fs } from "node:fs";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import {
  isReminderShownInActiveWindow,
  recordReminderShown,
  type ReminderWindowStore,
} from "../../../kernel/runner/reminder-window-gate.js";
import { BUYING_KEYWORD_RE } from "../../../kernel/wallet/detect.js";
import { parseAuthStatus, parseJsonObject } from "../../../kernel/wallet/parse.js";
import { linkWalletAuthFile } from "../../../kernel/wallet/paths.js";

export const LINK_WALLET_REMINDER_CUSTOM_TYPE = "runtime.link_wallet_reminder";
export const LINK_WALLET_DISCONNECTED_REMINDER_KEY = "link-wallet-offer";
export const LINK_WALLET_CONNECTED_REMINDER_KEY = "link-wallet-connected";

export const LINK_WALLET_DISCONNECTED_REMINDER_TEXT =
  "The user asked about buying or paying. Link is not connected. Call the `link_wallet` tool so they see the connect card. Do not run Link CLI `auth login` yourself. After they connect, use the link-wallet skill to pay.";

export const LINK_WALLET_CONNECTED_REMINDER_TEXT =
  "The user asked about buying or paying. Link is connected. Use the link-wallet skill (`npx --yes @stripe/link-cli`) with `--request-approval` for spend requests. Do not paste card numbers into chat. This is not Stella product billing and not the Stripe Connect connector.";

const isLinkConnected = async (stellaDataDir: string): Promise<boolean> => {
  try {
    const raw = await fs.readFile(linkWalletAuthFile(stellaDataDir), "utf8");
    return parseAuthStatus(parseJsonObject(raw)).authenticated;
  } catch {
    return false;
  }
};

export const createLinkWalletReminderHook = (options: {
  stellaDataDir: string;
  store: ReminderWindowStore;
}): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    if (payload.agentType !== AGENT_IDS.ORCHESTRATOR) return;
    if (payload.isUserTurn === false) return;
    const prompt = payload.userPrompt?.trim();
    if (!prompt || !BUYING_KEYWORD_RE.test(prompt)) return;
    const threadKey = payload.threadKey ?? payload.conversationId;
    if (!threadKey) return;

    const connected = await isLinkConnected(options.stellaDataDir);
    const key = connected
      ? LINK_WALLET_CONNECTED_REMINDER_KEY
      : LINK_WALLET_DISCONNECTED_REMINDER_KEY;
    const shown = await isReminderShownInActiveWindow({
      stellaDataDir: options.stellaDataDir,
      store: options.store,
      threadKey,
      key,
    }).catch(() => true);
    if (shown) return;

    await recordReminderShown({
      stellaDataDir: options.stellaDataDir,
      threadKey,
      key,
    }).catch(() => undefined);

    return {
      prependMessages: [
        {
          text: wrapSystemReminder(
            connected
              ? LINK_WALLET_CONNECTED_REMINDER_TEXT
              : LINK_WALLET_DISCONNECTED_REMINDER_TEXT,
          ),
          uiVisibility: "hidden" as const,
          messageType: "message" as const,
          customType: LINK_WALLET_REMINDER_CUSTOM_TYPE,
        },
      ],
    };
  },
});
