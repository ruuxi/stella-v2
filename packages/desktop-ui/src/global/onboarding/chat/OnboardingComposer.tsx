/**
 * The onboarding composer: the real composer's shell, field, and send
 * button (same primitives, same classes, same spring-animated pill), without
 * the chat-runtime-bound extras (context chips, dictation, model picker,
 * the activity pill). Anything typed here ends onboarding and becomes the
 * first message of the real conversation.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ComposerAddButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import { useT } from "@/shared/i18n";
import "@/app/chat/full-shell.composer.css";
import "@/features/chat/composer-primitives.css";

type OnboardingComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
};

export function OnboardingComposer({
  value,
  onChange,
  onSend,
  disabled = false,
}: OnboardingComposerProps) {
  const t = useT();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const canSubmit = value.trim().length > 0 && !disabled;

  useAnimatedComposerShell({ shellRef, contentRef, formRef });

  useEffect(() => {
    updateComposerTextareaExpansion(textareaRef.current, setExpanded);
  }, [value]);

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!canSubmit) return;
      onSend();
    },
    [canSubmit, onSend],
  );

  return (
    <div className="composer">
      <div ref={shellRef} className="composer-shell">
        <div ref={contentRef} className="composer-shell-content">
          <form
            ref={formRef}
            data-testid="onboarding-composer"
            className={`composer-form${expanded ? " expanded" : ""}`}
            onSubmit={submit}
          >
            <ComposerAddButton
              className="composer-add-button"
              title={t("app.chat.composer.add")}
              disabled
            />
            <ComposerTextarea
              ref={textareaRef}
              className="composer-input"
              value={value}
              placeholder={t("onboarding.chat.composerPlaceholder")}
              disabled={disabled}
              rows={1}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left" />
              <div className="composer-toolbar-right">
                <ComposerSubmitButton
                  className="composer-submit"
                  disabled={!canSubmit}
                  aria-label={t("onboarding.chat.send")}
                  animated
                />
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
