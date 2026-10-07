import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type {
  UserAsk,
  UserAskAnswerFieldValue,
  UserAskField,
  UserAskOption,
  UserAskQuestionDetail,
  UserAskSecureInputDetail,
} from "@stella/contracts/user-ask";
import {
  USER_ASK_SOMETHING_ELSE_OPTION_ID,
  withSomethingElseOption,
} from "@stella/contracts/user-ask";
import { AlertCircle, CircleQuestionMark, Clock, Eye, Lock } from "@/ui/icons";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import {
  answerUserAsk,
  setUserAskFieldSensitive,
  useUserAskRemainingMs,
} from "./user-ask-store";
import "./user-ask-card.css";

type Translate = ReturnType<typeof useT>;

const formatRemaining = (remainingMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(remainingMs / 1000));
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}:${String(minutes).padStart(2, "0")}:00`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const inputTypeForField = (field: UserAskField): string =>
  field.type === "secret" ? "password" : "text";

const questionOptions = (
  detail: UserAskQuestionDetail,
  t: Translate,
): readonly UserAskOption[] =>
  withSomethingElseOption(
    detail.options,
    t("userAsk.question.somethingElse"),
  );

function UserAskHeader({
  ask,
  title,
  detail,
}: {
  ask: UserAsk;
  title: string;
  detail?: string;
}) {
  const t = useT();
  const remainingMs = useUserAskRemainingMs(
    ask.blocking ? undefined : ask.deadlineAt,
  );
  const askDetail = ask.detail;
  const isQuestion = askDetail.kind === "question";
  const defaultOption =
    askDetail.kind === "question"
      ? askDetail.options.find(
          (option) => option.id === askDetail.defaultChoiceId,
        )
      : undefined;

  const timing = ask.blocking
    ? t("userAsk.blocking")
    : remainingMs === null
      ? null
      : defaultOption
        ? remainingMs === 0
          ? t("userAsk.deadline.continuesNow", { option: defaultOption.label })
          : t("userAsk.deadline.continues", {
              option: defaultOption.label,
              time: formatRemaining(remainingMs),
            })
        : remainingMs === 0
          ? t("userAsk.deadline.closing")
          : t("userAsk.deadline.closes", { time: formatRemaining(remainingMs) });

  return (
    <div className="user-ask__head">
      <span className="user-ask__icon" aria-hidden="true">
        {isQuestion ? <CircleQuestionMark size={15} /> : <Lock size={15} />}
      </span>
      <div className="user-ask__heading">
        <p className="user-ask__eyebrow">
          {ask.agentLabel ??
            t(
              isQuestion
                ? "userAsk.eyebrow.question"
                : "userAsk.eyebrow.secureInput",
            )}
        </p>
        <p className="user-ask__title">{title}</p>
        {detail ? <p className="user-ask__detail">{detail}</p> : null}
      </div>
      {timing ? (
        <span
          className={`user-ask__timing${ask.blocking ? " user-ask__timing--blocking" : ""}`}
        >
          {ask.blocking ? null : <Clock size={12} aria-hidden="true" />}
          {timing}
        </span>
      ) : null}
    </div>
  );
}

function UserAskQuestionBody({
  detail,
  busy,
  onAnswer,
}: {
  detail: UserAskQuestionDetail;
  busy: boolean;
  onAnswer: (choiceId: string, text?: string) => void;
}) {
  const t = useT();
  const [freeTextOpen, setFreeTextOpen] = useState(false);
  const [freeText, setFreeText] = useState("");
  const options = useMemo(() => questionOptions(detail, t), [detail, t]);

  return (
    <div className="user-ask__body">
      <div className="user-ask__options" role="group">
        {options.map((option) => {
          const isSomethingElse =
            option.id === USER_ASK_SOMETHING_ELSE_OPTION_ID;
          const isDefault = option.id === detail.defaultChoiceId;
          return (
            <Button
              key={option.id}
              type="button"
              variant={isDefault ? "primary" : "ghost"}
              className={`pill-btn${isDefault ? " pill-btn--primary" : ""} user-ask__option`}
              disabled={busy}
              aria-pressed={isSomethingElse ? freeTextOpen : undefined}
              title={option.hint}
              onClick={() => {
                if (isSomethingElse) {
                  setFreeTextOpen((open) => !open);
                  return;
                }
                onAnswer(option.id);
              }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {freeTextOpen ? (
        <form
          className="user-ask__free-text"
          onSubmit={(event) => {
            event.preventDefault();
            const text = freeText.trim();
            if (!text) return;
            onAnswer(USER_ASK_SOMETHING_ELSE_OPTION_ID, text);
          }}
        >
          <TextField
            label={t("userAsk.question.somethingElseLabel")}
            placeholder={t("userAsk.question.somethingElsePlaceholder")}
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            autoFocus
            multiline
            rows={2}
          />
          <div className="user-ask__actions">
            <Button
              type="submit"
              variant="primary"
              className="pill-btn pill-btn--primary"
              disabled={busy || !freeText.trim()}
            >
              {busy
                ? t("userAsk.question.sending")
                : t("userAsk.question.send")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function UserAskFieldRow({
  ask,
  field,
  value,
  sensitive,
  busy,
  onValueChange,
  onSensitiveChange,
}: {
  ask: UserAsk;
  field: UserAskField;
  value: string;
  sensitive: boolean;
  busy: boolean;
  onValueChange: (next: string) => void;
  onSensitiveChange: (next: boolean) => void;
}) {
  const t = useT();
  const label = field.optional
    ? `${field.label} · ${t("userAsk.secureInput.optional")}`
    : field.label;

  return (
    <div className="user-ask__field" data-field-type={field.type}>
      {field.type === "choice" ? (
        <Select
          label={label}
          value={value}
          placeholder={t("userAsk.secureInput.choosePlaceholder")}
          disabled={busy}
          className="user-ask__field-select"
          options={(field.choices ?? []).map((choice) => ({
            value: choice.id,
            label: choice.label,
          }))}
          onValueChange={onValueChange}
        />
      ) : (
        <TextField
          label={label}
          description={field.hint}
          type={inputTypeForField(field)}
          inputMode={field.type === "code" ? "numeric" : undefined}
          autoComplete={field.type === "secret" ? "off" : undefined}
          spellCheck={false}
          maxLength={field.type === "code" ? 12 : undefined}
          className={
            field.type === "code" ? "user-ask__field-code" : undefined
          }
          placeholder={field.placeholder}
          value={value}
          disabled={busy}
          onChange={(event) => onValueChange(event.target.value)}
        />
      )}
      <div className="user-ask__field-privacy">
        <span
          className={`user-ask__badge${sensitive ? " user-ask__badge--private" : ""}`}
        >
          {sensitive ? (
            <Lock size={11} aria-hidden="true" />
          ) : (
            <Eye size={11} aria-hidden="true" />
          )}
          {t(
            sensitive
              ? "userAsk.secureInput.privateBadge"
              : "userAsk.secureInput.sharedBadge",
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="pill-btn user-ask__badge-toggle"
          disabled={busy}
          onClick={() => {
            onSensitiveChange(!sensitive);
            void setUserAskFieldSensitive(ask.askId, field.id, !sensitive);
          }}
        >
          {t(
            sensitive
              ? "userAsk.secureInput.makeShared"
              : "userAsk.secureInput.makePrivate",
          )}
        </Button>
      </div>
    </div>
  );
}

function UserAskSecureInputBody({
  ask,
  detail,
  busy,
  onAnswerFields,
}: {
  ask: UserAsk;
  detail: UserAskSecureInputDetail;
  busy: boolean;
  onAnswerFields: (fields: readonly UserAskAnswerFieldValue[]) => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    setOverrides({});
  }, [ask.revision]);

  const sensitiveFor = useCallback(
    (field: UserAskField) => overrides[field.id] ?? field.sensitive,
    [overrides],
  );

  const anySensitive = detail.fields.some(sensitiveFor);
  const anyShared = detail.fields.some((field) => !sensitiveFor(field));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const blank = detail.fields.find(
      (field) => !field.optional && !(values[field.id] ?? "").trim(),
    );
    if (blank) {
      setMissing(t("userAsk.secureInput.required", { label: blank.label }));
      return;
    }
    setMissing(null);
    onAnswerFields(
      detail.fields
        .map((field) => ({ field, value: (values[field.id] ?? "").trim() }))
        .filter((entry) => entry.value.length > 0)
        .map(
          (entry): UserAskAnswerFieldValue => ({
            fieldId: entry.field.id,
            kind: "plain",
            value: entry.value,
          }),
        ),
    );
  };

  return (
    <form className="user-ask__body" onSubmit={submit}>
      <div className="user-ask__fields">
        {detail.fields.map((field) => (
          <UserAskFieldRow
            key={field.id}
            ask={ask}
            field={field}
            busy={busy}
            value={values[field.id] ?? ""}
            sensitive={sensitiveFor(field)}
            onValueChange={(next) =>
              setValues((current) => ({ ...current, [field.id]: next }))
            }
            onSensitiveChange={(next) =>
              setOverrides((current) => ({ ...current, [field.id]: next }))
            }
          />
        ))}
      </div>
      <div className="user-ask__notes">
        {anySensitive ? (
          <p className="user-ask__footnote user-ask__footnote--private">
            <Lock size={11} aria-hidden="true" />
            {t("userAsk.secureInput.privateNote")}
          </p>
        ) : null}
        {anyShared ? (
          <p className="user-ask__footnote">
            <Eye size={11} aria-hidden="true" />
            {t("userAsk.secureInput.sharedNote")}
          </p>
        ) : null}
      </div>
      {missing ? (
        <p className="user-ask__error" role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          {missing}
        </p>
      ) : null}
      <div className="user-ask__actions">
        <Button
          type="submit"
          variant="primary"
          className="pill-btn pill-btn--primary"
          disabled={busy}
        >
          {busy
            ? t("userAsk.secureInput.submitting")
            : t("userAsk.secureInput.submit")}
        </Button>
      </div>
    </form>
  );
}

export function UserAskCard({ ask }: { ask: UserAsk }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (
      payload:
        | { kind: "choice"; choiceId: string; text?: string }
        | { kind: "fields"; fields: readonly UserAskAnswerFieldValue[] },
    ) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      const ok = await answerUserAsk({
        askId: ask.askId,
        revision: ask.revision,
        ...payload,
      });
      if (!ok) {
        setError(t("userAsk.errors.answer"));
        setBusy(false);
      }
    },
    [ask.askId, ask.revision, busy, t],
  );

  const title =
    ask.detail.kind === "question" ? ask.detail.question : ask.detail.purpose;

  return (
    <section
      className="user-ask"
      data-ask-id={ask.askId}
      data-ask-kind={ask.detail.kind}
      aria-live="polite"
    >
      <UserAskHeader ask={ask} title={title} detail={ask.detail.detail} />
      {ask.detail.kind === "question" ? (
        <UserAskQuestionBody
          detail={ask.detail}
          busy={busy}
          onAnswer={(choiceId, text) =>
            void send({
              kind: "choice",
              choiceId,
              ...(text ? { text } : {}),
            })
          }
        />
      ) : (
        <UserAskSecureInputBody
          ask={ask}
          detail={ask.detail}
          busy={busy}
          onAnswerFields={(fields) => void send({ kind: "fields", fields })}
        />
      )}
      {error ? (
        <p className="user-ask__error" role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
