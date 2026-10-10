import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  UserAsk,
  UserAskAnswerFieldValue,
  UserAskField,
  UserAskSecureInputDetail,
} from "@stella/contracts/user-ask";
import { AlertCircle, Clock, Eye, Lock } from "@/ui/icons";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import {
  answerUserAsk,
  setUserAskFieldSensitive,
  useUserAskRemainingMs,
} from "./user-ask-store";
import { formatRemaining } from "./format-remaining";
import "./user-ask-card.css";

const inputTypeForField = (field: UserAskField): string =>
  field.type === "secret" ? "password" : "text";

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
  const timing = ask.blocking
    ? t("userAsk.blocking")
    : remainingMs === null
      ? null
      : remainingMs === 0
        ? t("userAsk.deadline.closing")
        : t("userAsk.deadline.closes", { time: formatRemaining(remainingMs) });

  return (
    <div className="user-ask__head">
      <span className="user-ask__icon" aria-hidden="true">
        <Lock size={16} />
      </span>
      <div className="user-ask__heading">
        <p className="user-ask__eyebrow">
          {ask.agentLabel ?? t("userAsk.eyebrow.secureInput")}
        </p>
        <h3 className="user-ask__title">{title}</h3>
        {detail ? <p className="user-ask__detail">{detail}</p> : null}
      </div>
      {timing ? (
        <span
          className={`user-ask__timing${ask.blocking ? " user-ask__timing--blocking" : ""}`}
        >
          {ask.blocking ? null : <Clock size={13} aria-hidden="true" />}
          {timing}
        </span>
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

export function UserAskSecureInputCard({
  ask,
  detail,
}: {
  ask: UserAsk;
  detail: UserAskSecureInputDetail;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (fields: readonly UserAskAnswerFieldValue[]) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      const ok = await answerUserAsk({
        askId: ask.askId,
        revision: ask.revision,
        kind: "fields",
        fields,
      });
      if (!ok) {
        setError(t("userAsk.errors.answer"));
        setBusy(false);
      }
    },
    [ask.askId, ask.revision, busy, t],
  );

  return (
    <section
      className="user-ask"
      data-ask-id={ask.askId}
      data-ask-kind="secure_input"
      aria-live="polite"
    >
      <UserAskHeader ask={ask} title={detail.purpose} detail={detail.detail} />
      <UserAskSecureInputBody
        ask={ask}
        detail={detail}
        busy={busy}
        onAnswerFields={(fields) => void send(fields)}
      />
      {error ? (
        <p className="user-ask__error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
