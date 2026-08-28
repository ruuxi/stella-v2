import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { ExtensionServices } from "../../../kernel/extensions/services.js";
import { detectLinkCliInvocation } from "../../../kernel/wallet/detect.js";

export const createLinkSpendNotifyHook = (
  services: Pick<ExtensionServices, "notifyLinkSpendApproval">,
): HookDefinition<"before_tool"> => ({
  event: "before_tool",
  filter: { tool: "exec_command" },
  async handler(payload) {
    const command =
      typeof payload.args.cmd === "string" ? payload.args.cmd : "";
    if (!command) return;
    const detected = detectLinkCliInvocation(command);
    if (
      detected?.kind !== "spend_request" ||
      !detected.requestsApproval ||
      !services.notifyLinkSpendApproval
    ) {
      return;
    }
    await services.notifyLinkSpendApproval({
      ...(detected.merchantName ? { merchantName: detected.merchantName } : {}),
      ...(detected.amountCents !== undefined
        ? { amountCents: detected.amountCents }
        : {}),
      ...(payload.context.conversationId
        ? { conversationId: payload.context.conversationId }
        : {}),
    });
  },
});
