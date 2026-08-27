import { createContext, useContext } from "react";
import type { UserRowViewModel } from "@/features/chat/conversation-row-types";

export type UserMessageActions = {
  rewind: (row: UserRowViewModel) => void;
  fork?: (row: UserRowViewModel) => void;
};

export const UserMessageActionsContext =
  createContext<UserMessageActions | null>(null);

export const useUserMessageActions = (): UserMessageActions | null =>
  useContext(UserMessageActionsContext);

export const UserMessageActionsBusyContext = createContext<boolean>(false);

export const useUserMessageActionsBusy = (): boolean =>
  useContext(UserMessageActionsBusyContext);
