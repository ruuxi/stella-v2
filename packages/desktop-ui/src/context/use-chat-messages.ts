import { useContext } from "react";
import { ChatMessagesContext } from "@/context/chat-messages-context";
import type { MessageRecord } from "@stella/contracts/local-chat";

export function useChatMessages(): MessageRecord[] {
  const ctx = useContext(ChatMessagesContext);
  if (ctx === null) {
    throw new Error("useChatMessages must be used within ChatRuntimeProvider");
  }
  return ctx;
}
