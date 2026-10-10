import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { UserAsk } from "@stella/contracts/user-ask";
import {
  EMPTY_USER_ASK_DRAFT,
  nextUnansweredIndex,
  pickUserAskOption,
  skipUserAskQuestion,
  typeUserAskText,
  userAskDeckAnswers,
  userAskDeckComplete,
  userAskDeckEntries,
  userAskRecordFromAnswer,
  type UserAskDeckEntry,
  type UserAskDraft,
  type UserAskDrafts,
} from "@stella/contracts/user-ask-deck";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
} from "@/ui/icons";
import { useT } from "@/shared/i18n";
import {
  answerUserAsk,
  recordUserAskAnswer,
  useUserAskRemainingMs,
} from "./user-ask-store";
import { formatRemaining } from "./format-remaining";
import "./user-ask-card.css";

function DeckTiming({ ask }: { ask: UserAsk }) {
  const t = useT();
  const remainingMs = useUserAskRemainingMs(
    ask.blocking ? undefined : ask.deadlineAt,
  );
  if (remainingMs === null) return null;
  return (
    <span
      className="user-ask__timing"
      role="timer"
      aria-label={t("userAsk.deadline.remaining", {
        time: formatRemaining(remainingMs),
      })}
    >
      <Clock size={13} aria-hidden="true" />
      {formatRemaining(remainingMs)}
    </span>
  );
}

function DeckQuestion({
  entry,
  draft,
  busy,
  onPick,
  onType,
  onConfirmText,
}: {
  entry: UserAskDeckEntry;
  draft: UserAskDraft;
  busy: boolean;
  onPick: (choiceId: string) => void;
  onType: (text: string) => void;
  onConfirmText: () => void;
}) {
  const t = useT();
  const { question } = entry;
  const typed = draft.text.trim().length > 0;
  const textChosen = !draft.choiceId && !draft.skipped && typed;

  return (
    <div className="user-ask__step">
      <h3 className="user-ask__title">{question.question}</h3>
      {question.detail ? (
        <p className="user-ask__detail">{question.detail}</p>
      ) : null}
      <div className="user-ask__options" role="radiogroup" aria-label={question.question}>
        {question.options.map((option) => {
          const selected = draft.choiceId === option.id;
          const isDefault = option.id === question.defaultChoiceId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="user-ask__option"
              data-selected={selected || undefined}
              disabled={busy}
              onClick={() => onPick(option.id)}
            >
              <span className="user-ask__option-copy">
                <span className="user-ask__option-label">{option.label}</span>
                {option.hint ? (
                  <span className="user-ask__option-hint">{option.hint}</span>
                ) : null}
              </span>
              {isDefault && !selected ? (
                <span className="user-ask__option-tag">
                  {t("userAsk.question.default")}
                </span>
              ) : null}
              {selected ? (
                <Check
                  size={16}
                  className="user-ask__option-check"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
        <div
          className="user-ask__other"
          data-selected={textChosen || undefined}
        >
          <textarea
            className="user-ask__other-input"
            rows={1}
            value={draft.text}
            placeholder={t("userAsk.question.somethingElse")}
            aria-label={t("userAsk.question.somethingElse")}
            disabled={busy}
            onChange={(event) => onType(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (typed) onConfirmText();
              }
            }}
          />
          {typed ? (
            <button
              type="button"
              className="user-ask__other-confirm"
              aria-label={t("userAsk.question.confirm")}
              disabled={busy}
              onClick={onConfirmText}
            >
              <Check size={16} strokeWidth={2.5} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function UserAskDeck({ asks }: { asks: readonly UserAsk[] }) {
  const t = useT();
  const entries = useMemo(() => userAskDeckEntries(asks), [asks]);
  const [drafts, setDrafts] = useState<UserAskDrafts>({});
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const found = entries.findIndex((entry) => entry.key === currentKey);
  const index =
    found >= 0 ? found : (nextUnansweredIndex(entries, drafts, -1) ?? 0);
  const entry = entries[index];
  const total = entries.length;
  const entryKey = entry?.key ?? null;

  useEffect(() => {
    if (entryKey && entryKey !== currentKey) setCurrentKey(entryKey);
  }, [currentKey, entryKey]);
  const complete = userAskDeckComplete(entries, drafts);

  const keepFocus = useCallback(() => {
    const root = rootRef.current;
    if (!root || !root.contains(document.activeElement)) return;
    requestAnimationFrame(() => {
      if (!root.contains(document.activeElement) || document.activeElement === document.body) {
        root.focus({ preventScroll: true });
      }
    });
  }, []);

  const submit = useCallback(
    async (finalDrafts: UserAskDrafts) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      const answers = userAskDeckAnswers(entries, finalDrafts);
      const results = await Promise.all(answers.map(answerUserAsk));
      answers.forEach((answer, index) => {
        if (!results[index]) return;
        const ask = entries.find((entry) => entry.ask.askId === answer.askId)?.ask;
        if (ask) {
          recordUserAskAnswer(
            ask.conversationId,
            userAskRecordFromAnswer(entries, finalDrafts, ask),
          );
        }
      });
      setBusy(false);
      if (results.some((ok) => !ok)) setError(t("userAsk.errors.answer"));
    },
    [busy, entries, t],
  );

  const goTo = useCallback(
    (nextIndex: number) => {
      const target = entries[nextIndex];
      if (!target) return;
      setCurrentKey(target.key);
      keepFocus();
    },
    [entries, keepFocus],
  );

  const commit = useCallback(
    (draft: UserAskDraft) => {
      if (!entry || busy) return;
      const nextDrafts = { ...drafts, [entry.key]: draft };
      setDrafts(nextDrafts);
      const next = nextUnansweredIndex(entries, nextDrafts, index);
      if (next === null) {
        void submit(nextDrafts);
        return;
      }
      goTo(next);
    },
    [busy, drafts, entries, entry, goTo, index, submit],
  );

  if (!entry) return null;
  const draft = drafts[entry.key] ?? EMPTY_USER_ASK_DRAFT;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      goTo(index - 1);
      return;
    }
    if (event.key === "ArrowRight" && index < total - 1) {
      event.preventDefault();
      goTo(index + 1);
      return;
    }
    const option = /^[1-9]$/.test(event.key)
      ? entry.question.options[Number(event.key) - 1]
      : undefined;
    if (option) {
      event.preventDefault();
      commit(pickUserAskOption(draft, option.id));
    }
  };

  return (
    <section
      ref={rootRef}
      className="user-ask user-ask--deck"
      data-ask-id={entry.ask.askId}
      data-ask-kind="question"
      tabIndex={-1}
      aria-live="polite"
      onKeyDown={onKeyDown}
    >
      <DeckQuestion
        key={entry.key}
        entry={entry}
        draft={draft}
        busy={busy}
        onPick={(choiceId) => commit(pickUserAskOption(draft, choiceId))}
        onType={(text) =>
          setDrafts((current) => ({
            ...current,
            [entry.key]: typeUserAskText(text),
          }))
        }
        onConfirmText={() => commit(typeUserAskText(draft.text))}
      />
      {error ? (
        <p className="user-ask__error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          {error}
        </p>
      ) : null}
      <div className="user-ask__footer">
        <div className="user-ask__footer-start">
          <DeckTiming ask={entry.ask} />
        </div>
        {total > 1 ? (
          <div className="user-ask__pager">
            <button
              type="button"
              className="user-ask__nav"
              aria-label={t("userAsk.question.previous")}
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span className="user-ask__progress">
              {t("userAsk.question.progress", {
                current: index + 1,
                total,
              })}
            </span>
            <button
              type="button"
              className="user-ask__nav"
              aria-label={t("userAsk.question.next")}
              disabled={index === total - 1}
              onClick={() => goTo(index + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="user-ask__footer-actions">
          <button
            type="button"
            className="user-ask__skip"
            aria-pressed={draft.skipped === true}
            disabled={busy}
            onClick={() => commit(skipUserAskQuestion(draft))}
          >
            {draft.skipped ? (
              <>
                <Check size={14} aria-hidden="true" />
                {t("userAsk.question.skipped")}
              </>
            ) : (
              t("userAsk.question.skip")
            )}
          </button>
          {total > 1 && complete ? (
            <button
              type="button"
              className="user-ask__submit"
              disabled={busy}
              onClick={() => void submit(drafts)}
            >
              {busy ? t("userAsk.question.sending") : t("userAsk.question.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
