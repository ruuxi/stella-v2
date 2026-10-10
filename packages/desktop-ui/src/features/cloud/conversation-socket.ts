/**
 * The desktop's binding of the shared conversation socket
 * (`@stella/contracts/conversation-socket`): the interior gateway origin, the
 * document's visibility as the foreground gate, and startup timing.
 */

import {
  ConversationSocket as SharedConversationSocket,
  type ConversationSocketOptions,
} from "@stella/contracts/conversation-socket";
import { reportCloudReadiness } from "./cloud-readiness-timing";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";

export type {
  ConversationSocketCursor,
  ConversationSocketEvent,
  SocketStatus,
} from "@stella/contracts/conversation-socket";

export class ConversationSocket extends SharedConversationSocket {
  constructor(
    options: Omit<
      ConversationSocketOptions,
      "socketBaseUrl" | "isActive" | "onReadiness"
    >,
  ) {
    super({
      ...options,
      socketBaseUrl: () => getStellaInteriorBridge()?.gatewayOrigin,
      isActive: () => typeof document === "undefined" || !document.hidden,
      onReadiness: (phase, startedAt) =>
        reportCloudReadiness(`cloud.${phase}`, {
          ...(startedAt === undefined ? {} : { startedAt }),
          outcome: "success",
        }),
    });
  }
}
