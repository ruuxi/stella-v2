import { X } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import "./assistant-reply-peek.css";

export type AssistantReplyPeekProps = {
  text: string;
  onJumpToBottom: () => void;
  onDismiss: () => void;
};

export function AssistantReplyPeek({
  text,
  onJumpToBottom,
  onDismiss,
}: AssistantReplyPeekProps) {
  const t = useT();
  return (
    <div className="assistant-reply-peek" role="status" aria-live="polite">
      <button
        type="button"
        className="assistant-reply-peek__body"
        onClick={onJumpToBottom}
        title={t("app.chat.replyPeek.jumpToLatest")}
      >
        <span className="assistant-reply-peek__text">{text}</span>
      </button>
      <button
        type="button"
        className="assistant-reply-peek__dismiss"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        aria-label={t("app.chat.replyPeek.dismiss")}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
