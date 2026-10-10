import { useEffect, useMemo } from "react";
import { UserAskSecureInputCard } from "./UserAskCard";
import { refreshUserAsks, useConversationUserAsks } from "./user-ask-store";

export function UserAskList({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const asks = useConversationUserAsks(conversationId);
  const secureAsks = useMemo(
    () => asks.filter((ask) => ask.detail.kind === "secure_input"),
    [asks],
  );

  useEffect(() => {
    void refreshUserAsks();
  }, []);

  if (secureAsks.length === 0) return null;

  return (
    <>
      {secureAsks.map((ask) =>
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
