/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ComposerContextRow, useComposerContextSuggestions, } from "./ComposerContextRow";
import { ComposerLeadRow } from "./ComposerLeadRow";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { ComposerMicButton, ComposerRealtimeVoiceButton, ComposerStopButton, ComposerSubmitButton, } from "@/features/chat/ComposerPrimitives";
import { useComposerModelPinned } from "@/features/chat/composer-model-pin-store";
import { deriveComposerState, hasAttachedComposerChips, } from "@/features/chat/composer-context";
import { MiniModelPicker } from "./MiniModelPicker";
import { handleComposerPaste } from "@/features/chat/lib/paste-context";
import { useScreenshotPreview, ScreenshotPreviewOverlay, } from "./ScreenshotPreview";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import { updateComposerTextareaExpansion, useAnimatedComposerShell, } from "@/shared/hooks/use-animated-composer-shell";
import { applyComposerModelMention, ComposerModelMentionMenu, findComposerModelMentionTrigger, } from "./ComposerModelMentionMenu";
import { ComposerModelMentionTextarea } from "./ModelMentionText";
import { useUiState } from "@/context/ui-state";
import "./full-shell.composer.css";
function ComposerImpl({ message, setMessage, chatContext, setChatContext, selectedText, setSelectedText, isStreaming, canSubmit, focusRequestId, conversationId, onSend, onStop, onSelectArea, isDragOver = false, replyPeek, suggestionsActive = true, }) {
    const { state: uiState } = useUiState();
    const textareaRef = useRef(null);
    const formRef = useRef(null);
    const shellRef = useRef(null);
    const shellContentRef = useRef(null);
    const modelMentionMenuRef = useRef(null);
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [modelMentionTrigger, setModelMentionTrigger] = useState(null);
    const { screenshot: previewScreenshot, previewIndex: previewScreenshotIndex, setPreviewIndex: setPreviewScreenshotIndex, } = useScreenshotPreview(chatContext);
    const onSendRef = useRef(onSend);
    onSendRef.current = onSend;
    const dictation = useDictation({
        message,
        setMessage,
        // Dictation stays available even while the orchestrator is busy
        // (mid-turn / streaming) — the mic is intentionally NOT gated on
        // `isStreaming`. See `submitComposer` for the in-flight submit flow.
        onTranscriptCommitted: () => {
            requestAnimationFrame(() => {
                textareaRef.current?.focus();
            });
        },
        onCommit: () => {
            onSendRef.current();
        },
    });
    // Submitting while a recording/transcription is still in flight must not
    // race ahead of the dictated text. `commitAndSend` stops + finalizes the
    // recording, waits for the pending transcript to be appended to the
    // composer, and only then fires `onCommit` (→ onSend). For the idle case
    // it sends immediately. Transcription is time-bounded (see the dictation
    // service's per-segment timeout), so a stalled request fails into a
    // recoverable error and fires the commit instead of wedging submit.
    const submitComposer = () => {
        if (dictation.isRecording || dictation.isTranscribing) {
            dictation.commitAndSend();
            return;
        }
        onSend();
    };
    const composerState = deriveComposerState({
        message,
        chatContext,
        selectedText,
        conversationId,
        requireConversationId: true,
    });
    const { placeholder } = composerState;
    // A dictation in flight makes the composer submittable on its own: the
    // pending transcript is the content. Without this the submit arrow stays
    // disabled (canSubmit is false while the text is still empty), so a press
    // during transcription is swallowed and `submitComposer` never runs —
    // the transcription finishes but the message is never sent/queued.
    const dictationInFlight = dictation.isRecording || dictation.isTranscribing;
    const canSubmitWithDictation = canSubmit || dictationInFlight;
    const hasText = message.trim().length > 0;
    const dictationBelow = dictation.isRecordingVisible && hasText;
    const dictationInline = dictation.isRecordingVisible && !hasText;
    // A pinned model picker keeps the toolbar row visible even while the
    // textarea is empty (`updateComposerTextareaExpansion` only clears
    // `composerExpanded`, so the pin wins). Inline dictation replaces the
    // whole toolbar row, so the pin defers to it rather than expanding an
    // empty shell around the recording bar.
    const modelPinned = useComposerModelPinned();
    const isExpanded = composerExpanded || dictationBelow || (modelPinned && !dictationInline);
    useAnimatedComposerShell({
        shellRef,
        contentRef: shellContentRef,
        formRef,
    });
    useEffect(() => {
        if (!focusRequestId || dictation.isRecording)
            return;
        const raf = requestAnimationFrame(() => {
            textareaRef.current?.focus();
        });
        return () => cancelAnimationFrame(raf);
    }, [dictation.isRecording, focusRequestId]);
    // Keep the pill shape in sync when `message` changes outside of onChange
    // (e.g. cleared by the parent after send, or set by dictation).
    useEffect(() => {
        const raf = requestAnimationFrame(() => {
            updateComposerTextareaExpansion(textareaRef.current, setComposerExpanded);
        });
        return () => cancelAnimationFrame(raf);
    }, [message]);
    useEffect(() => {
        if (!suggestionsActive || !message) {
            setModelMentionTrigger(null);
        }
    }, [message, suggestionsActive]);
    const refreshModelMentionTrigger = useCallback((value, caret) => {
        if (!suggestionsActive) {
            setModelMentionTrigger(null);
            return;
        }
        setModelMentionTrigger(findComposerModelMentionTrigger(value, caret));
    }, [suggestionsActive]);
    const selectModelMention = useCallback((option) => {
        if (!modelMentionTrigger)
            return;
        const next = applyComposerModelMention(message, modelMentionTrigger, option.value);
        setMessage(next.value);
        setModelMentionTrigger(null);
        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            textarea?.focus();
            textarea?.setSelectionRange(next.caret, next.caret);
            updateComposerTextareaExpansion(textarea, setComposerExpanded);
        });
    }, [message, modelMentionTrigger, setMessage]);
    const hasAttachedChips = hasAttachedComposerChips(chatContext, selectedText);
    const showRealtimeVoice = Boolean(conversationId) &&
        !hasText &&
        !hasAttachedChips &&
        !dictationInFlight;
    const toggleRealtimeVoice = useCallback(() => {
        window.electronAPI?.pet?.requestVoice?.();
    }, []);
    const contextSuggestions = useComposerContextSuggestions(suggestionsActive, chatContext, setChatContext);
    return (<div className="composer">
      <ComposerLeadRow replyPeek={replyPeek} showActivityPill/>
      <div ref={shellRef} className={`composer-shell${isDragOver ? " composer-shell--drag-over" : ""}`}>
        <div ref={shellContentRef} className="composer-shell-content">
          {hasAttachedChips && (<div className="composer-attached-strip">
              <ComposerContextRow chatContext={chatContext} selectedText={selectedText} setChatContext={setChatContext} setSelectedText={setSelectedText} onPreviewScreenshot={setPreviewScreenshotIndex}/>
            </div>)}
          <form ref={formRef} data-composer-context-menu="native" className={`composer-form${isExpanded ? " expanded" : ""}`} aria-busy={isStreaming} onSubmit={(event) => {
            event.preventDefault();
            submitComposer();
        }}>
            <ComposerAddMenu className="composer-add-button" title="Add" setChatContext={setChatContext} onSelectArea={onSelectArea} contextSuggestions={contextSuggestions.suggestions} onSelectContextSuggestion={contextSuggestions.selectSuggestion}/>

            {dictationInline ? (<DictationRecordingBar levels={dictation.levels} elapsedMs={dictation.elapsedMs} onCancel={dictation.cancel} onConfirm={dictation.toggle} onSend={dictation.commitAndSend} showControls={dictation.showControls}/>) : (<>
                <ComposerModelMentionTextarea ref={textareaRef} className="composer-input" placeholder={placeholder} value={message} aria-autocomplete="list" aria-expanded={Boolean(modelMentionTrigger)} aria-controls={modelMentionTrigger
                ? "composer-model-mention-options"
                : undefined} onChange={(event) => {
                setMessage(event.target.value);
                refreshModelMentionTrigger(event.target.value, event.target.selectionStart);
                requestAnimationFrame(() => {
                    updateComposerTextareaExpansion(textareaRef.current, setComposerExpanded);
                });
            }} onKeyDown={(event) => {
                if (modelMentionMenuRef.current?.handleKeyDown(event) === true) {
                    return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitComposer();
                }
            }} onClick={(event) => {
                refreshModelMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
            }} onSelect={(event) => {
                refreshModelMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
            }} onBlur={() => setModelMentionTrigger(null)} onPaste={(event) => {
                handleComposerPaste(event, setChatContext);
            }} disabled={!conversationId} rows={1}/>

                <div className="composer-toolbar">
                  <div className="composer-toolbar-left">
                    <ComposerAddMenu className="composer-add-button composer-add-button--toolbar" title="Add" setChatContext={setChatContext} onSelectArea={onSelectArea} contextSuggestions={contextSuggestions.suggestions} onSelectContextSuggestion={contextSuggestions.selectSuggestion}/>
                  </div>

                  <div className="composer-toolbar-right">
                    {modelPinned && <MiniModelPicker />}
                    <div className="composer-voice-controls">
                      <ComposerMicButton className="composer-mic" isTranscribing={dictation.isTranscribing} disabled={dictation.isTranscribing} onClick={dictation.toggle} title={dictation.error
                ? `Dictation: ${dictation.error}`
                : undefined}/>
                      {showRealtimeVoice && (<ComposerRealtimeVoiceButton className="composer-realtime-voice" active={Boolean(uiState.isVoiceRtcActive)} onClick={toggleRealtimeVoice}/>)}
                    </div>
                    {isStreaming && (<ComposerStopButton className="composer-stop" onClick={onStop} title="Stop" aria-label="Stop"/>)}
                    {showRealtimeVoice ? null : (<ComposerSubmitButton className="composer-submit" disabled={!canSubmitWithDictation} animated/>)}
                  </div>
                </div>

                {dictationBelow && (<div className="composer-dictation-row">
                    <DictationRecordingBar levels={dictation.levels} elapsedMs={dictation.elapsedMs} onCancel={dictation.cancel} onConfirm={dictation.toggle} onSend={dictation.commitAndSend} showControls={dictation.showControls}/>
                  </div>)}
              </>)}
          </form>
        </div>
      </div>

      {previewScreenshot && previewScreenshotIndex !== null && (<ScreenshotPreviewOverlay screenshot={previewScreenshot} index={previewScreenshotIndex} onClose={() => setPreviewScreenshotIndex(null)}/>)}
      {modelMentionTrigger && suggestionsActive && (<ComposerModelMentionMenu ref={modelMentionMenuRef} trigger={modelMentionTrigger} textarea={textareaRef.current} onSelect={selectModelMention} onDismiss={() => setModelMentionTrigger(null)}/>)}
    </div>);
}
/**
 * Memoized so the chat surface re-rendering on every streamed frame (it
 * subscribes to the live message timeline) does not reconcile the whole
 * composer subtree. All props are shallow-comparable; during streaming they
 * stay referentially stable, so the composer only re-renders on real input
 * (typed text, context chips, focus requests, an active reply-peek).
 */
export const Composer = memo(ComposerImpl);
