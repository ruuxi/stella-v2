import { memo } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import { ChevronRight } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { openConversationFocus } from "@/features/chat/services/conversation-focus-store";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import "./reply-preview.css";

/** A context label only; adjacency is resolved by the timeline projection. */
export const ReplyPreview = memo(function ReplyPreview({ refs, conversationId }: {
  refs: readonly ReplyRef[];
  conversationId: string;
}) {
  const t = useT();
  const ref = refs[0];
  const activity = useThreadActivityRecords(conversationId,
    ref?.kind === "agent" ? [ref.threadId] : []);
  if (!ref) return null;
  const title = ref.kind === "agent"
    ? activity.get(ref.threadId)?.description?.trim() ||
      (ref.title !== ref.threadId ? ref.title.trim() : "") || t("app.chat.focus.agentFallback")
    : ref.preview || t("app.chat.focus.messageFallback");
  return <div className="reply-context" data-testid="reply-preview">
    <button type="button" className="reply-context__link" onClick={() => openConversationFocus({
      conversationId,
      root: ref.kind === "agent" ? { kind: "agent", threadId: ref.threadId } : { kind: "message", id: ref.id },
      title,
    })}>
      <span>{title}</span><ChevronRight size={12} aria-hidden="true" />
    </button>
  </div>;
});
