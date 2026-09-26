import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import { X } from "@/ui/icons";
import {
  hasQueuedMessageEntryPlayed,
  markQueuedMessageEntryPlayed,
} from "@/features/chat/lib/message-entry-animation-state";
import { UserMessageBody } from "./UserMessageBody";
import { useT } from "@/shared/i18n";

const EXIT_MS = 100;

type VisibleItem = QueuedUserMessage & { leaving: boolean };

/**
 * Legend may reconstruct a keyed virtual item while adjacent streaming rows
 * and measurements settle. Keep the playback record outside the item subtree
 * so that reconstruction cannot replay the queued bubble's CSS animation.
 * Message ids are renderer-owned and remain stable through queue reconciliation
 * and the queued-to-sent handoff.
 */
const toVisibleItem = (message: QueuedUserMessage): VisibleItem => ({
  ...message,
  leaving: false,
});

type ComposerQueuedMessagesProps = {
  messages: QueuedUserMessage[];
  /**
   * When provided, each queued bubble can cancel its message and restore
   * the text to the composer.
   */
  onCancel?: (message: QueuedUserMessage) => void;
};

/**
 * One queued message, rendered with the sent user bubble's exact markup so
 * a queued message is visually indistinguishable from a sent one. The only
 * queue-specific affordance is the hover-reveal cancel control beside it.
 */
function QueuedMessageBubble({
  item,
  onCancel,
}: {
  item: VisibleItem;
  onCancel?: (message: QueuedUserMessage) => void;
}) {
  const t = useT();
  // Latched for this bubble's mount so the entrance plays through once even
  // though the id is registered as played right after commit; a Legend
  // reconstruction of an already-seen message mounts settled, and the sent
  // row skips its own entrance for an id that already appeared here.
  const enteringRef = useRef(!hasQueuedMessageEntryPlayed(item.id));
  useLayoutEffect(() => {
    markQueuedMessageEntryPlayed(item.id);
  }, [item.id]);

  return (
    <div
      style={
        !enteringRef.current && !item.leaving ? { animation: "none" } : undefined
      }
      className={
        "composer-queued-message" +
        (item.leaving ? " composer-queued-message--leaving" : "")
      }
    >
      {onCancel && !item.leaving ? (
        <button
          type="button"
          className="composer-queued-message__cancel"
          aria-label={t("app.chat.queuedMessages.cancel")}
          title={t("app.chat.queuedMessages.cancelAndEdit")}
          onClick={() => onCancel(item)}
        >
          <X size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ) : null}
      <div className="event-item user chat-bubble-text">
        <UserMessageBody text={item.text} />
      </div>
    </div>
  );
}

export function ComposerQueuedMessages({
  messages,
  onCancel,
}: ComposerQueuedMessagesProps) {
  const [visible, setVisible] = useState<VisibleItem[]>(() =>
    messages.map(toVisibleItem),
  );
  const exitTimersRef = useRef(new Map<string, number>());

  useEffect(() => {
    const incomingById = new Map(
      messages.map((message) => [message.id, message]),
    );

    setVisible((current) => {
      const seenIds = new Set<string>();
      const next: VisibleItem[] = [];

      for (const item of current) {
        const fresh = incomingById.get(item.id);
        if (fresh) {
          seenIds.add(item.id);
          const exitTimer = exitTimersRef.current.get(item.id);
          if (exitTimer) {
            window.clearTimeout(exitTimer);
            exitTimersRef.current.delete(item.id);
          }
          next.push({ ...fresh, leaving: false });
          continue;
        }

        if (item.leaving) {
          next.push(item);
          continue;
        }

        next.push({ ...item, leaving: true });
        if (!exitTimersRef.current.has(item.id)) {
          const timeoutId = window.setTimeout(() => {
            exitTimersRef.current.delete(item.id);
            setVisible((entries) =>
              entries.filter((entry) => entry.id !== item.id),
            );
          }, EXIT_MS);
          exitTimersRef.current.set(item.id, timeoutId);
        }
      }

      for (const message of messages) {
        if (!seenIds.has(message.id)) {
          next.push(toVisibleItem(message));
        }
      }

      next.sort((a, b) => {
        if (a.leaving !== b.leaving) {
          return a.leaving ? -1 : 1;
        }
        return a.queueOrder - b.queueOrder || a.timestamp - b.timestamp;
      });
      return next;
    });
  }, [messages]);

  useEffect(
    () => () => {
      for (const timeoutId of exitTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      exitTimersRef.current.clear();
    },
    [],
  );

  if (visible.length === 0) return null;

  const activeCount = visible.filter((item) => !item.leaving).length;

  return (
    <div
      className="composer-queued-stack"
      aria-live="polite"
      data-queue-count={activeCount}
    >
      {visible.map((item) => (
        <QueuedMessageBubble key={item.id} item={item} onCancel={onCancel} />
      ))}
    </div>
  );
}
