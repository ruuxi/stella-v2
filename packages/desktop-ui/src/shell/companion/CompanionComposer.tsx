/**
 * The companion's prompt bar — the chat composer's pill, built from the same
 * primitives (textarea, send/stop). Mic and voice live on the arc around the
 * mark, so the pill carries only the input and its send button; while a
 * dictation is recording the pill shows the live transcript bar instead.
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import type { useDictation } from "@/features/dictation/hooks/use-dictation";
import { useT } from "@/shared/i18n";

type Dictation = ReturnType<typeof useDictation>;

type CompanionComposerProps = {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  dictation: Dictation;
  isStreaming: boolean;
  focusRequestId: number;
  onSend: () => void;
  onStop: () => void;
  onEscape: () => void;
};

export function CompanionComposer({
  message,
  setMessage,
  dictation,
  isStreaming,
  focusRequestId,
  onSend,
  onStop,
  onEscape,
}: CompanionComposerProps) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasText = message.trim().length > 0;
  const dictationInFlight = dictation.isRecording || dictation.isTranscribing;
  const canSubmit = hasText || dictationInFlight;

  useEffect(() => {
    if (dictation.isRecording) return;
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [dictation.isRecording, focusRequestId]);

  const submit = () => {
    if (dictationInFlight) {
      dictation.commitAndSend();
      return;
    }
    if (!hasText) return;
    onSend();
  };

  return (
    <form
      className="companion-composer"
      data-recording={dictation.isRecordingVisible || undefined}
      data-testid="companion-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {dictation.isRecordingVisible ? (
        <DictationRecordingBar
          levels={dictation.levels}
          elapsedMs={dictation.elapsedMs}
          transcriptPreview={dictation.transcriptPreview}
          onCancel={dictation.cancel}
          onConfirm={dictation.toggle}
          onSend={dictation.commitAndSend}
          showControls={dictation.showControls}
        />
      ) : (
        <>
          <ComposerTextarea
            ref={textareaRef}
            className="companion-composer__input"
            value={message}
            rows={1}
            placeholder={t("companion.composer.placeholder")}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                onEscape();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="companion-composer__actions">
            {isStreaming ? (
              <ComposerStopButton
                className="companion-composer__icon companion-composer__stop"
                onClick={onStop}
                title={t("app.chat.composer.stop")}
                aria-label={t("app.chat.composer.stop")}
              />
            ) : (
              <ComposerSubmitButton
                className="companion-composer__icon companion-composer__submit"
                disabled={!canSubmit}
              />
            )}
          </div>
        </>
      )}
    </form>
  );
}
