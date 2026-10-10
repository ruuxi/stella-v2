import { useEffect, useMemo } from "react";
import { UserAskSecureInputCard } from "./UserAskCard";
import { UserAskDeck } from "./UserAskDeck";
import { refreshUserAsks, useConversationUserAsks } from "./user-ask-store";

export function UserAskList({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const asks = useConversationUserAsks(conversationId);
  const questionAsks = useMemo(
    () => asks.filter((ask) => ask.detail.kind === "question"),
    [asks],
  );

  useEffect(() => {
    void refreshUserAsks();
  }, []);

  if (asks.length === 0) return null;

  return (
    <>
      {questionAsks.length > 0 ? <UserAskDeck asks={questionAsks} /> : null}
      {asks.map((ask) =>
        ask.detail.kind === "secure_input" ? (
          <UserAskSecureInputCard
            key={ask.askId}
            ask={ask}
            detail={ask.detail}
          />
        ) : null,
      )}
    </>
  );
}
