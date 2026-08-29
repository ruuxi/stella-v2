/**
 * Per-message action row rendered below a chat message.
 *
 * - User messages get a single Copy action.
 * - Assistant messages get Copy + Read aloud (on-demand TTS) — but only a
 *   turn's FINAL assistant message. Intra-turn segments (preambles that
 *   ended in a tool call) never mount this row at all (see the
 *   `isIntraTurn` gate in `AssistantMessageRow`).
 *
 * The row reserves its height at all times and only fades in on row hover /
 * keyboard focus (or while its read-aloud is active) so revealing it never
 * shifts surrounding row geometry, which the chat's scroll-follow logic
 * depends on.
 *
 * It is mounted for an assistant message's whole lifetime, so its reserved
 * height is present from the first painted line and nothing later causes a
 * layout jump.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  GitBranch,
  LoaderCircle,
  RotateCcw,
  Square,
  Volume2,
} from "@/ui/icons";
import {
  toggleManualReadAloud,
  useManualReadAloudStatus,
} from "@/features/voice/services/read-aloud/manual-read-aloud";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { useT } from "@/shared/i18n";
import "./message-actions.css";

const COPIED_RESET_MS = 1600;

// Rewind is destructive (drops the message + everything after it), so it
// takes two clicks: the first arms a "Click again to rewind" state, the
// second within this window performs it. Mirrors the two-step confirm used
// by the top bar's new-chat / delete-conversation controls
// (HISTORY_*_CONFIRM_TIMEOUT_MS in ConversationTopBar).
const REWIND_CONFIRM_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} MessageActionsProps
 * @property {string} text
 * @property {string} messageKey
 * @property {boolean} [showReadAloud]
 * @property {"start" | "end"} [align]
 * @property {(() => void)} [onRewind] Rewind action (user rows only).
 * @property {(() => void)} [onFork] Fork action (user rows only).
 * @property {boolean} [actionsDisabled] Greys out Rewind/Fork while a turn is busy.
 * @property {number} [timestampMs] Message created time (epoch ms); renders a
 *   muted local-time "h:mm AM/PM" stamp alongside the actions on hover.
 * @property {{ path?: string, url?: string, mimeType?: string, kind?: string, name?: string }} [copyAttachment]
 *   Attachment to copy when the message has no text (image → clipboard image,
 *   file → path as text). Text always takes priority when present.
 */

/** @param {MessageActionsProps} props */
function MessageActionsImpl({
  text,
  messageKey,
  showReadAloud = false,
  align = "start",
  onRewind,
  onFork,
  actionsDisabled = false,
  timestampMs = undefined,
  copyAttachment = undefined,
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  const readAloudStatus = useManualReadAloudStatus(messageKey);

  // Two-step confirm state for the destructive Rewind action.
  const [rewindArmed, setRewindArmed] = useState(false);
  const rewindTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (rewindTimerRef.current) clearTimeout(rewindTimerRef.current);
    },
    [],
  );

  const disarmRewind = useCallback(() => {
    if (rewindTimerRef.current) {
      clearTimeout(rewindTimerRef.current);
      rewindTimerRef.current = null;
    }
    setRewindArmed(false);
  }, []);

  // First click arms + shows the confirm state (auto-resets after the
  // timeout); second click within the window performs the rewind.
  const handleRewindClick = useCallback(() => {
    if (!onRewind) return;
    if (rewindTimerRef.current) {
      clearTimeout(rewindTimerRef.current);
      rewindTimerRef.current = null;
    }
    if (rewindArmed) {
      setRewindArmed(false);
      onRewind();
      return;
    }
    setRewindArmed(true);
    rewindTimerRef.current = setTimeout(() => {
      rewindTimerRef.current = null;
      setRewindArmed(false);
    }, REWIND_CONFIRM_TIMEOUT_MS);
  }, [onRewind, rewindArmed]);

  // Escape disarms without executing (mirrors the top bar's armed confirm
  // controls).
  const handleRewindKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape") disarmRewind();
    },
    [disarmRewind],
  );

  // Reset the armed state when the turn becomes busy (the button also
  // disables) or the window loses focus, matching "click away / lose
  // focus / timeout" resets on the existing confirm controls.
  useEffect(() => {
    if (actionsDisabled) disarmRewind();
  }, [actionsDisabled, disarmRewind]);

  useEffect(() => {
    if (!rewindArmed) return;
    const onWindowBlur = () => disarmRewind();
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [rewindArmed, disarmRewind]);

  const handleCopy = useCallback(async () => {
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
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(
      () => setCopied(false),
      COPIED_RESET_MS,
    );
  }, [text, copyAttachment]);

  const handleReadAloud = useCallback(() => {
    void toggleManualReadAloud(messageKey, text);
  }, [messageKey, text]);

  const isPlaying = readAloudStatus !== "idle";

  // Local-timezone "h:mm AM/PM" (e.g. "3:07 PM"); the strip only reveals on
  // hover, so the stamp inherits that hover-only visibility for free.
  const timestampLabel =
    typeof timestampMs === "number" && Number.isFinite(timestampMs)
      ? new Date(timestampMs).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <div
      className={`message-actions message-actions--${align}`}
      data-active={isPlaying ? "true" : undefined}
      // While the destructive Rewind is armed, hold the strip fully revealed
      // (even off-hover) so the confirm affordance can't silently vanish.
      data-confirming={rewindArmed ? "true" : undefined}
      onMouseLeave={onRewind ? disarmRewind : undefined}
    >
      <button
        type="button"
        className="message-actions__btn"
        onClick={handleCopy}
        aria-label={
          copied
            ? t("app.chat.messageActions.copied")
            : t("app.chat.messageActions.copy")
        }
        title={
          copied
            ? t("app.chat.messageActions.copied")
            : t("app.chat.messageActions.copy")
        }
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      {onRewind && (
        <button
          type="button"
          className="message-actions__btn"
          data-action="rewind"
          onClick={handleRewindClick}
          onKeyDown={handleRewindKeyDown}
          onBlur={disarmRewind}
          disabled={actionsDisabled}
          aria-disabled={actionsDisabled || undefined}
          data-armed={rewindArmed ? "true" : undefined}
          // Expose the two-step control to assistive tech.
          aria-expanded={rewindArmed || undefined}
          aria-label={
            rewindArmed
              ? t("app.chat.messageActions.rewindConfirm")
              : t("app.chat.messageActions.rewind")
          }
          title={
            rewindArmed
              ? t("app.chat.messageActions.rewindConfirm")
              : t("app.chat.messageActions.rewind")
          }
        >
          {rewindArmed ? (
            <>
              <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
              <span
                className="message-actions__confirm-hint"
                aria-hidden="true"
              >
                {t("app.chat.messageActions.rewindConfirm")}
              </span>
            </>
          ) : (
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
      {onFork && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={onFork}
          disabled={actionsDisabled}
          aria-disabled={actionsDisabled || undefined}
          aria-label={t("app.chat.messageActions.fork")}
          title={t("app.chat.messageActions.fork")}
        >
          <GitBranch size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {showReadAloud && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={handleReadAloud}
          aria-label={
            isPlaying
              ? t("app.chat.messageActions.stopReading")
              : t("app.chat.messageActions.readAloud")
          }
          title={
            isPlaying
              ? t("app.chat.messageActions.stopReading")
              : t("app.chat.messageActions.readAloud")
          }
          aria-pressed={isPlaying}
        >
          {readAloudStatus === "loading" ? (
            <LoaderCircle
              className="message-actions__spinner"
              size={14}
              strokeWidth={2}
              aria-hidden="true"
            />
          ) : readAloudStatus === "playing" ? (
            <Square
              size={12}
              strokeWidth={2}
              fill="currentColor"
              aria-hidden="true"
            />
          ) : (
            <Volume2 size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
      {timestampLabel && (
        <span className="message-actions__timestamp">{timestampLabel}</span>
      )}
    </div>
  );
}

export const MessageActions = memo(MessageActionsImpl);
