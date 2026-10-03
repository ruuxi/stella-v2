import type { CallArgs } from "@stella/contracts/backend/api";
import { backendClient } from "@/platform/backend/backend-client";

/** Hosted-browser handoffs, served by the owner's object (`browser.*`). */
export const cloudBrowserApi = {
  getInteraction: (args: CallArgs<"browser.detail">) =>
    backendClient.call("browser.detail", args),
  mintLiveView: (args: CallArgs<"browser.liveView">) =>
    backendClient.call("browser.liveView", args),
  decide: (args: CallArgs<"browser.decide">) =>
    backendClient.call("browser.decide", args),
  resetProfile: (args: CallArgs<"browser.resetProfile">) =>
    backendClient.call("browser.resetProfile", args),
};
