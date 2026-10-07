import { useEffect } from "react";
import { UserAskCard } from "./UserAskCard";
import { refreshUserAsks, useConversationUserAsks } from "./user-ask-store";

export function UserAskList({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const asks = useConversationUserAsks(conversationId);

  useEffect(() => {
    void refreshUserAsks();
  }, []);

  if (asks.length === 0) return null;

  return (
    <>
      {asks.map((ask) => (
        <UserAskCard key={ask.askId} ask={ask} />
      ))}
    </>
  );
}
