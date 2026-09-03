/**
 * The "N replies" affordance iMessage puts under an original message. Sits
 * under a user bubble (or on an inline agent card) once at least one reply
 * cited it, and opens focus on that target.
 */
import { memo } from "react";
import { useTPlural } from "@/shared/i18n";
import "./reply-preview.css";

type ReplyCountBadgeProps = {
  count: number;
  onOpen: () => void;
  /** Right-align under a user bubble. */
  align?: "start" | "end";
};

export const ReplyCountBadge = memo(function ReplyCountBadge({
  count,
  onOpen,
  align = "start",
}: ReplyCountBadgeProps) {
  const tPlural = useTPlural();
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className={`reply-count${align === "end" ? " reply-count--end" : ""}`}
      onClick={onOpen}
      data-testid="reply-count"
      data-reply-count={count}
    >
      <span className="reply-count__dot" aria-hidden="true" />
      {tPlural("app.chat.replyCount.label", count)}
    </button>
  );
});
