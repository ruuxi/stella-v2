/**
 * The conversation socket is shared with desktop
 * (`@stella/contracts/conversation-socket`). Mobile adds no glue of its own:
 * the store passes the native foreground gate as `isActive`. This module keeps
 * the historical import path for the mobile test suite.
 */
export {
  ConversationSocket,
  type ConversationSocketCursor,
  type ConversationSocketEvent,
  type ConversationSocketOptions,
  type SocketStatus,
  type SocketStatusEvent,
} from "@stella/contracts/conversation-socket";
