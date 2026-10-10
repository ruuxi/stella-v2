import type { MessageRecord } from "@stella/contracts/local-chat";

export const acceptedUserMessageIds = (
  messages: readonly Pick<MessageRecord, "_id" | "type" | "payload">[],
): Set<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    ids.add(message._id);
    if (message.type !== "user_message") continue;
    const origin = message.payload?.originUserMessageId;
    if (typeof origin === "string" && origin) ids.add(origin);
  }
  return ids;
};
