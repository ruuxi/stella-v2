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
 * It is mounted *throughout* an assistant message's lifetime — including
 * while it is still streaming — so its reserved height is present from the
 * first painted line and finalizing the message causes NO layout jump. While
 * `streaming` is true the row is held invisible and made `inert` (not
 * focusable, not clickable, hidden from the accessibility tree); it cannot
 * reveal on hover/focus until the message settles. The CSS that suppresses
 * the reveal keys off the row's `.event-row--streaming` ancestor (see
 * `message-actions.css`).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, Square, Volume2 } from "@/ui/icons";
import { toggleManualReadAloud, useManualReadAloudStatus, } from "@/features/voice/services/read-aloud/manual-read-aloud";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { useT } from "@/shared/i18n";
import "./message-actions.css";
const COPIED_RESET_MS = 1600;
function MessageActionsImpl({ text, messageKey, showReadAloud = false, align = "start", streaming = false, }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const copiedTimerRef = useRef(null);
    const readAloudStatus = useManualReadAloudStatus(messageKey);
    useEffect(() => () => {
        if (copiedTimerRef.current)
            clearTimeout(copiedTimerRef.current);
    }, []);
    const handleCopy = useCallback(async () => {
        const value = text.trim();
        if (!value)
            return;
        const ok = await copyTextToClipboard(value);
        if (!ok) {
            console.warn("[message-actions] copy failed");
            return;
        }
        setCopied(true);
        if (copiedTimerRef.current)
            clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    }, [text]);
    const handleReadAloud = useCallback(() => {
        void toggleManualReadAloud(messageKey, text);
    }, [messageKey, text]);
    const isPlaying = readAloudStatus !== "idle";
    return (<div className={`message-actions message-actions--${align}`} data-active={isPlaying ? "true" : undefined} data-streaming={streaming ? "true" : undefined}
    // `inert` keeps the still-streaming (invisible) row out of the tab
    // order and the accessibility tree and blocks pointer interaction —
    // belt-and-suspenders with the CSS that holds it at opacity:0.
    inert={streaming || undefined}>
      <button type="button" className="message-actions__btn" onClick={handleCopy} aria-label={copied ? t("app.chat.messageActions.copied") : t("app.chat.messageActions.copy")} title={copied ? t("app.chat.messageActions.copied") : t("app.chat.messageActions.copy")}>
        {copied ? (<Check size={14} strokeWidth={2} aria-hidden="true"/>) : (<Copy size={14} strokeWidth={2} aria-hidden="true"/>)}
      </button>
      {showReadAloud && (<button type="button" className="message-actions__btn" onClick={handleReadAloud} aria-label={isPlaying ? t("app.chat.messageActions.stopReading") : t("app.chat.messageActions.readAloud")} title={isPlaying ? t("app.chat.messageActions.stopReading") : t("app.chat.messageActions.readAloud")} aria-pressed={isPlaying}>
          {readAloudStatus === "loading" ? (<LoaderCircle className="message-actions__spinner" size={14} strokeWidth={2} aria-hidden="true"/>) : readAloudStatus === "playing" ? (<Square size={12} strokeWidth={2} fill="currentColor" aria-hidden="true"/>) : (<Volume2 size={14} strokeWidth={2} aria-hidden="true"/>)}
        </button>)}
    </div>);
}
export const MessageActions = memo(MessageActionsImpl);
