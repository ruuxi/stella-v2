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

const REWIND_CONFIRM_TIMEOUT_MS = 3000;

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

  const handleRewindKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape") disarmRewind();
    },
    [disarmRewind],
  );

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

      ok = await copyTextToClipboard(value);
    } else if (copyAttachment) {

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
