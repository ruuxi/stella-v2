import { createContext } from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";

export const ChatMessagesContext = createContext<MessageRecord[] | null>(null);
