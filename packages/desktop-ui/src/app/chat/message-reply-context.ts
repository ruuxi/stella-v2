import { createContext, useContext } from "react";

export type MessageReply = (text: string) => void;

export const MessageReplyContext = createContext<MessageReply | null>(null);

export const useMessageReply = (): MessageReply | null =>
  useContext(MessageReplyContext);
