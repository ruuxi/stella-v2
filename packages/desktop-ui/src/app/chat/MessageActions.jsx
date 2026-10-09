/**
 * Per-message actions, as a vertical-ellipsis button beside the bubble.
 *
 * This used to be a row of icon buttons rendered BELOW the message. That row
 * reserved its height at all times (the reveal had to not move the bubble, so
 * it could not be `display: none`), which meant every single message paid ~32px
 * of empty vertical space — the "huge gap between messages". The control is now
 * one 24px button in the message's own horizontal line, to the side of the
 * bubble: it costs nothing vertically, so the gap between messages is purely
 * the timeline's own rhythm (see the ROW_GAP family in ChatTimeline.tsx).
 *
 * - User messages: Copy.
 * - Assistant messages: Copy + Read aloud (on-demand TTS) — but only a turn's
 *   FINAL assistant message. Intra-turn segments (preambles that ended in a
 *   tool call) never mount this control at all (see the `isIntraTurn` gate in
 *   `AssistantMessageRow`).
 *
 * The button only fades in on row hover / keyboard focus (or while its menu is
 * open, or its read-aloud is active). It never changes its own footprint, so
 * revealing it cannot shift row geometry, which the chat's scroll-follow logic
 * depends on. The exact send time rides along as the menu's header — per-message
 * stamps under the bubble are gone, replaced by the periodic centered divider
 * the timeline renders (see ChatTimeDivider).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  LoaderCircle,
  MoreVertical,
  Reply,
  Square,
  Volume2,
} from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  toggleManualReadAloud,
  useManualReadAloudStatus,
} from "@/features/voice/services/read-aloud/manual-read-aloud";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { useT } from "@/shared/i18n";
import "./message-actions.css";

const COPIED_RESET_MS = 1600;

/** How long "Copied" stays on screen before the menu dismisses itself. */
const COPIED_MENU_CLOSE_MS = 700;

/**
 * @typedef {Object} MessageActionsProps
 * @property {string} text
 * @property {string} messageKey
 * @property {boolean} [showReadAloud]
 * @property {"start" | "end"} [align] Which side of the bubble the button sits
 *   on: `start` (assistant, button right of the bubble) or `end` (user, button
 *   left of the right-aligned bubble).
 * @property {number} [timestampMs] Message created time (epoch ms); shown as the
 *   menu's header in local "h:mm AM/PM" form.
 * @property {{ path?: string, url?: string, mimeType?: string, kind?: string, name?: string }} [copyAttachment]
 *   Attachment to copy when the message has no text (image → clipboard image,
 *   file → path as text). Text always takes priority when present.
 * @property {((text: string) => void)} [onReply]
 */

/** @param {MessageActionsProps} props */
function MessageActionsImpl({
  text,
  messageKey,
  showReadAloud = false,
  align = "start",
  timestampMs = undefined,
  copyAttachment = undefined,
  onReply = undefined,
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const readAloudStatus = useManualReadAloudStatus(messageKey);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const handleOpenChange = useCallback((next) => {
    setOpen(next);
    if (!next && closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const handleCopySelect = useCallback(
    async (event) => {
      // Hold the menu open just long enough to show the "Copied" state.
      event.preventDefault();
      const value = text.trim();
      let ok = false;
      if (value) {
        // Text takes priority, including mixed text + attachment messages.
        ok = await copyTextToClipboard(value);
      } else if (copyAttachment) {
        // Attachment-only message: hand it to main, which writes an image
        // (from the on-disk path or data URL) or falls back to the file
        // path as text.
        const result =
          await window.electronAPI?.media?.copyAttachment?.(copyAttachment);
        ok = Boolean(result?.ok);
      } else {
        return;
      }
      if (!ok) {
        console.warn("[message-actions] copy failed");
        setOpen(false);
        return;
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(
        () => setCopied(false),
        COPIED_RESET_MS,
      );
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setOpen(false);
      }, COPIED_MENU_CLOSE_MS);
    },
    [text, copyAttachment],
  );

  const handleReadAloudSelect = useCallback(() => {
    void toggleManualReadAloud(messageKey, text);
  }, [messageKey, text]);

  const isPlaying = readAloudStatus !== "idle";
  const hasCopyable = Boolean(text.trim() || copyAttachment);

  // Local-timezone "h:mm AM/PM" (e.g. "3:07 PM") for the menu header, so the
  // exact time of one message stays reachable without a per-message stamp.
  const timestampLabel =
    typeof timestampMs === "number" && Number.isFinite(timestampMs)
      ? new Date(timestampMs).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  const handleReplyClick = useCallback(() => {
    onReply?.(text);
  }, [onReply, text]);

  const canReply = Boolean(onReply && text.trim());

  return (
    <div
      className={`message-actions-rail message-actions-rail--${align}`}
      data-open={open ? "true" : undefined}
    >
      <div className="message-actions-rail__stack">
        {canReply && (
          <button
            type="button"
            className="message-actions message-actions--reply"
            aria-label={t("app.chat.messageActions.reply")}
            title={t("app.chat.messageActions.reply")}
            onClick={handleReplyClick}
          >
            <Reply size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`message-actions message-actions--${align}`}
              data-open={open ? "true" : undefined}
              data-active={isPlaying ? "true" : undefined}
              aria-label={t("app.chat.messageActions.more")}
              title={t("app.chat.messageActions.more")}
            >
              <MoreVertical size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="message-actions-menu"
            align={align === "end" ? "end" : "start"}
            sideOffset={6}
            collisionPadding={12}
          >
            {timestampLabel && (
              <DropdownMenuLabel className="message-actions-menu__time">
                {timestampLabel}
              </DropdownMenuLabel>
            )}
            {hasCopyable && (
              <DropdownMenuItem onSelect={handleCopySelect}>
                <span data-slot="dropdown-menu-item-icon">
                  {copied ? (
                    <Check size={16} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Copy size={16} strokeWidth={2} aria-hidden="true" />
                  )}
                </span>
                {copied
                  ? t("app.chat.messageActions.copied")
                  : t("app.chat.messageActions.copy")}
              </DropdownMenuItem>
            )}
            {showReadAloud && (
              <DropdownMenuItem onSelect={handleReadAloudSelect}>
                <span data-slot="dropdown-menu-item-icon">
                  {readAloudStatus === "loading" ? (
                    <LoaderCircle
                      className="message-actions__spinner"
                      size={16}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  ) : readAloudStatus === "playing" ? (
                    <Square
                      size={14}
                      strokeWidth={2}
                      fill="currentColor"
                      aria-hidden="true"
                    />
                  ) : (
                    <Volume2 size={16} strokeWidth={2} aria-hidden="true" />
                  )}
                </span>
                {isPlaying
                  ? t("app.chat.messageActions.stopReading")
                  : t("app.chat.messageActions.readAloud")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export const MessageActions = memo(MessageActionsImpl);
