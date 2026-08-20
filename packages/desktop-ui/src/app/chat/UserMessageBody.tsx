import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ModelMentionText } from "./ModelMentionText";
import { useT } from "@/shared/i18n";
import {
  isUserMessageOverflowing,
  shouldShowUserMessageToggle,
} from "./user-message-clamp";

interface UserMessageBodyProps {
  text: string;
}

/**
 * Renders a user message bubble's text body with collapse/expand for long
 * messages.
 *
 * The visible text is clamped via CSS (`-webkit-line-clamp`) using
 * `--user-message-clamp-lines` (4 rendered lines on every chat surface).
 * Overflow is detected by comparing the laid-out scrollHeight to the
 * clamped clientHeight, and a "Show more" / "Show less" toggle is rendered
 * only when truncation actually occurs at the current width.
 */
export function UserMessageBody({ text }: UserMessageBodyProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setExpanded(false);
    setIsOverflowing(false);
  }, [text]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => {
      if (expanded) return;
      const overflows = isUserMessageOverflowing({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      setIsOverflowing((prev) => (prev === overflows ? prev : overflows));
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const showToggle = shouldShowUserMessageToggle({
    overflowing: isOverflowing,
    expanded,
  });

  return (
    <div className="event-user-body" data-expanded={expanded}>
      <div ref={bodyRef} className="event-body">
        <ModelMentionText text={text} />
      </div>
      {showToggle && (
        <button
          type="button"
          className="event-user-toggle"
          onClick={toggle}
          aria-expanded={expanded}
        >
          {expanded
            ? t("app.chat.userMessage.showLess")
            : t("app.chat.userMessage.showMore")}
        </button>
      )}
    </div>
  );
}
