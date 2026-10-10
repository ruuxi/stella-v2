import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import type {
  UserAsk,
  UserAskAnswerFieldValue,
  UserAskField,
  UserAskSecureInputDetail,
} from "@stella/contracts/user-ask";
import {
  EMPTY_USER_ASK_DRAFT,
  nextUnansweredIndex,
  pickUserAskOption,
  skipUserAskQuestion,
  typeUserAskText,
  userAskDeckAnswers,
  userAskDeckComplete,
  userAskDeckEntries,
  userAskDeckKey,
  userAskRecordFromAnswer,
  type UserAskDeckEntry,
  type UserAskRecord,
  type UserAskDraft,
  type UserAskDrafts,
} from "@stella/contracts/user-ask-deck";
import { tapLight } from "../lib/haptics";
import {
  answerUserAsk,
  cancelUserAsk,
  recordUserAskAnswer,
  useConversationUserAsks,
  useResolveFocusedUserAsk,
  useUserAskOriginLabel,
  useUserAskSync,
} from "../lib/user-asks";
import { canSealUserAskValue, sealUserAskValue } from "../lib/user-ask-seal";
import { useT } from "../i18n";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";
import { GlassToggle } from "./glass";
import { Icon } from "./Icon";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      seconds,
    ).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const useRemaining = (deadlineAt: number | undefined): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineAt === undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [deadlineAt]);
  return deadlineAt === undefined ? null : Math.max(0, deadlineAt - now);
};

export function UserAskCard({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  useUserAskSync(true);
  const { secureInput } = useConversationUserAsks(conversationId);
  useResolveFocusedUserAsk(secureInput?.askId ?? null);
  if (secureInput?.detail.kind !== "secure_input") return null;
  return (
    <SecureAskSurface
      ask={secureInput}
      detail={secureInput.detail}
      key={secureInput.askId}
    />
  );
}

export function UserAskInlineDeck({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const { questions, focused } = useConversationUserAsks(conversationId);
  useResolveFocusedUserAsk(
    focused?.kind === "question" ? focused.askId : null,
  );
  if (questions.length === 0) return null;
  return (
    <QuestionDeck
      asks={questions}
      focusedAskId={focused?.kind === "question" ? focused.askId : null}
    />
  );
}

export function UserAskRecordView({ record }: { record: UserAskRecord }) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.record}>
      {record.answers.map((answer, index) => (
        <View key={`${record.id}:${index}`} style={styles.recordItem}>
          <Text style={styles.recordQuestion}>{answer.question}</Text>
          <Text
            style={[
              styles.recordAnswer,
              answer.kind === "skipped" && styles.recordAnswerSkipped,
            ]}
          >
            {answer.kind === "skipped"
              ? t("userAsk.question.skipped")
              : answer.answer}
            {record.defaulted ? (
              <Text style={styles.recordTag}>
                {"  "}
                {t("userAsk.question.default")}
              </Text>
            ) : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DeckTiming({
  ask,
  colors,
  styles,
  t,
}: {
  ask: UserAsk;
  colors: Colors;
  styles: AskStyles;
  t: Translate;
}) {
  const remaining = useRemaining(ask.blocking ? undefined : ask.deadlineAt);
  if (remaining === null) return null;
  return (
    <View
      accessibilityLabel={t("userAsk.deadline.remaining", {
        time: formatRemaining(remaining),
      })}
      accessibilityRole="timer"
      style={styles.timingRow}
    >
      <Icon color={colors.textMuted} name="clock" size={14} />
      <Text numberOfLines={1} style={styles.timing}>
        {formatRemaining(remaining)}
      </Text>
    </View>
  );
}

function QuestionDeck({
  asks,
  focusedAskId,
}: {
  asks: readonly UserAsk[];
  focusedAskId: string | null;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const entries = useMemo(() => userAskDeckEntries(asks), [asks]);
  const [drafts, setDrafts] = useState<UserAskDrafts>({});
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);

  useEffect(() => {
    if (!focusedAskId) return;
    const target = entries.find((entry) => entry.ask.askId === focusedAskId);
    if (target) setCurrentKey(target.key);
  }, [entries, focusedAskId]);

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

  const submit = useCallback(
    async (finalDrafts: UserAskDrafts) => {
      if (busy) return;
      setBusy(true);
      setIssue(null);
      const answers = userAskDeckAnswers(entries, finalDrafts);
      const results = await Promise.allSettled(answers.map(answerUserAsk));
      answers.forEach((answer, index) => {
        if (results[index]?.status !== "fulfilled") return;
        const ask = entries.find((entry) => entry.ask.askId === answer.askId)?.ask;
        if (ask) {
          recordUserAskAnswer(
            ask.conversationId,
            userAskRecordFromAnswer(entries, finalDrafts, ask),
          );
        }
      });
      setBusy(false);
      if (results.some((result) => result.status === "rejected")) {
        setIssue(t("mobile.userAsk.answerFailed"));
      }
    },
    [busy, entries, t],
  );

  const goTo = useCallback(
    (nextIndex: number) => {
      const target = entries[nextIndex];
      if (target) setCurrentKey(target.key);
    },
    [entries],
  );

  const commit = useCallback(
    (draft: UserAskDraft) => {
      if (!entry || busy) return;
      tapLight();
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
  const { ask, question } = entry;
  const draft = drafts[entry.key] ?? EMPTY_USER_ASK_DRAFT;
  const typed = draft.text.trim().length > 0;
  const textChosen = !draft.choiceId && !draft.skipped && typed;

  return (
    <View style={[styles.card, styles.inlineCard]} accessibilityRole="summary">
      <View key={userAskDeckKey(ask.askId, question.id)} style={styles.step}>
        <Text style={styles.title}>{question.question}</Text>
        {question.detail ? (
          <Text style={styles.detail}>{question.detail}</Text>
        ) : null}

        <View style={styles.options} accessibilityRole="radiogroup">
          {question.options.map((option, optionIndex) => {
            const selected = draft.choiceId === option.id;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: busy }}
                disabled={busy}
                key={option.id}
                onPress={() => commit(pickUserAskOption(draft, option.id))}
                style={({ pressed }) => [
                  styles.option,
                  selected && styles.optionSelected,
                  pressed && styles.pressed,
                  busy && styles.disabled,
                ]}
              >
                <View
                  style={[styles.optionKey, selected && styles.optionKeySelected]}
                >
                  <Text
                    style={[
                      styles.optionKeyText,
                      selected && styles.optionKeyTextSelected,
                    ]}
                  >
                    {optionIndex + 1}
                  </Text>
                </View>
                <View style={styles.optionCopy}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.hint ? (
                    <Text style={styles.optionHint}>{option.hint}</Text>
                  ) : null}
                </View>
                {selected ? (
                  <Icon color={colors.accent} name="check" size={18} />
                ) : option.id === question.defaultChoiceId ? (
                  <Text style={styles.optionTag}>
                    {t("userAsk.question.default")}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}

          <View style={[styles.other, textChosen && styles.optionSelected]}>
            <AskTextInput
              accessibilityLabel={t("userAsk.question.somethingElse")}
              colors={colors}
              editable={!busy}
              multiline
              onChangeText={(text) =>
                setDrafts((current) => ({
                  ...current,
                  [entry.key]: typeUserAskText(text),
                }))
              }
              placeholder={t("userAsk.question.somethingElse")}
              style={styles.otherInput}
              submitBehavior="blurAndSubmit"
              onSubmitEditing={() => {
                if (typed) commit(typeUserAskText(draft.text));
              }}
              returnKeyType="done"
              value={draft.text}
            />
            <Pressable
              accessibilityLabel={t("userAsk.question.confirm")}
              accessibilityRole="button"
              disabled={busy || !typed}
              hitSlop={6}
              onPress={() => commit(typeUserAskText(draft.text))}
              style={({ pressed }) => [
                styles.otherConfirm,
                (busy || !typed) && styles.otherConfirmIdle,
                pressed && styles.pressed,
              ]}
            >
              <Icon
                color={typed ? colors.accentForeground : colors.textMuted}
                name="check"
                size={18}
              />
            </Pressable>
          </View>
        </View>
      </View>

      {issue ? <Text style={styles.issue}>{issue}</Text> : null}

      <View style={styles.footer}>
        <View style={styles.footerStart}>
          <DeckTiming ask={ask} colors={colors} styles={styles} t={t} />
        </View>
        {total > 1 ? (
          <View style={styles.pager}>
            <Pressable
              accessibilityLabel={t("userAsk.question.previous")}
              accessibilityRole="button"
              disabled={index === 0}
              hitSlop={6}
              onPress={() => {
                tapLight();
                goTo(index - 1);
              }}
              style={({ pressed }) => [styles.nav, pressed && styles.pressed]}
            >
              <Icon
                color={index === 0 ? colors.textWeaker : colors.text}
                name="chevron-left"
                size={20}
              />
            </Pressable>
            <Text style={styles.progress}>
              {t("userAsk.question.progress", { current: index + 1, total })}
            </Text>
            <Pressable
              accessibilityLabel={t("userAsk.question.next")}
              accessibilityRole="button"
              disabled={index === total - 1}
              hitSlop={6}
              onPress={() => {
                tapLight();
                goTo(index + 1);
              }}
              style={({ pressed }) => [styles.nav, pressed && styles.pressed]}
            >
              <Icon
                color={index === total - 1 ? colors.textWeaker : colors.text}
                name="chevron-right"
                size={20}
              />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.footerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: draft.skipped === true, disabled: busy }}
            disabled={busy}
            onPress={() => commit(skipUserAskQuestion(draft))}
            style={({ pressed }) => [
              styles.skip,
              draft.skipped && styles.skipSelected,
              pressed && styles.pressed,
              busy && styles.disabled,
            ]}
          >
            {draft.skipped ? (
              <Icon color={colors.text} name="check" size={15} />
            ) : null}
            <Text
              style={[styles.skipText, draft.skipped && styles.skipTextSelected]}
            >
              {draft.skipped
                ? t("userAsk.question.skipped")
                : t("userAsk.question.skip")}
            </Text>
          </Pressable>
          {total > 1 && complete ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                tapLight();
                void submit(drafts);
              }}
              style={({ pressed }) => [
                styles.primaryAction,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.primaryActionText}>
                {busy
                  ? t("userAsk.question.sending")
                  : t("userAsk.question.submit")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SecureAskSurface({
  ask,
  detail,
}: {
  ask: UserAsk;
  detail: UserAskSecureInputDetail;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const remaining = useRemaining(ask.deadlineAt);

  const submit = useCallback(
    async (run: () => Promise<void>, failureKey: string) => {
      if (busy) return;
      setBusy(true);
      setIssue(null);
      try {
        await run();
      } catch {
        setIssue(t(failureKey));
      } finally {
        setBusy(false);
      }
    },
    [busy, t],
  );

  const decline = useCallback(() => {
    tapLight();
    void submit(
      () => cancelUserAsk(ask.askId),
      "mobile.userAsk.cancelFailed",
    );
  }, [ask.askId, submit]);

  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.header}>
        <View style={[styles.icon, ask.blocking && styles.iconBlocking]}>
          <Icon
            name="eye-off"
            size={17}
            color={ask.blocking ? colors.accent : colors.text}
          />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{detail.purpose}</Text>
          {ask.agentLabel ? (
            <Text style={styles.meta}>
              {t("mobile.userAsk.askedBy", { label: ask.agentLabel })}
            </Text>
          ) : null}
        </View>
      </View>

      {detail.detail ? (
        <Text style={styles.detail}>{detail.detail}</Text>
      ) : null}

      <View style={styles.statusRow}>
        {ask.blocking ? (
          <Text style={styles.blockingBadge}>
            {t("mobile.userAsk.waitingBadge")}
          </Text>
        ) : null}
        {remaining !== null ? (
          <Text style={styles.countdown}>
            {remaining <= 0
              ? t("mobile.userAsk.deadlinePassed")
              : t("mobile.userAsk.deadline", {
                  time: formatRemaining(remaining),
                })}
          </Text>
        ) : null}
      </View>

      <SecureInputBody
        ask={ask}
        detail={detail}
        busy={busy}
        styles={styles}
        colors={colors}
        t={t}
        onAnswer={submit}
      />

      {issue ? <Text style={styles.issue}>{issue}</Text> : null}

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={decline}
        style={({ pressed }) => [
          styles.declineRow,
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
      >
        <Text style={styles.declineText}>
          {t("mobile.userAsk.cantRightNow")}
        </Text>
      </Pressable>
    </View>
  );
}

function SecureInputBody({
  ask,
  detail,
  busy,
  styles,
  colors,
  t,
  onAnswer,
}: {
  ask: UserAsk;
  detail: UserAskSecureInputDetail;
  busy: boolean;
  styles: AskStyles;
  colors: Colors;
  t: Translate;
  onAnswer: (run: () => Promise<void>, failureKey: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sensitiveOverrides, setSensitiveOverrides] = useState<
    Record<string, boolean>
  >({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [issue, setIssue] = useState<string | null>(null);

  const sealable = canSealUserAskValue(ask.recipientKey);
  const originLabel = useUserAskOriginLabel(ask.originDeviceId);

  const isSensitive = useCallback(
    (field: UserAskField) =>
      sealable ? (sensitiveOverrides[field.id] ?? field.sensitive) : field.sensitive,
    [sealable, sensitiveOverrides],
  );

  const missing = detail.fields.some(
    (field) => !field.optional && !(values[field.id] ?? "").trim(),
  );
  const needsComputer =
    !sealable && detail.fields.some((field) => field.sensitive);

  const send = useCallback(() => {
    setIssue(null);
    const payload: UserAskAnswerFieldValue[] = [];
    for (const field of detail.fields) {
      const raw = (values[field.id] ?? "").trim();
      if (!raw) {
        if (field.optional) continue;
        setIssue(t("mobile.userAsk.missingFields"));
        return;
      }
      if (!isSensitive(field)) {
        payload.push({ fieldId: field.id, kind: "plain", value: raw });
        continue;
      }
      if (!ask.recipientKey || !sealable) {
        setIssue(t("mobile.userAsk.sensitiveUnavailable"));
        return;
      }
      try {
        payload.push({
          fieldId: field.id,
          kind: "sealed",
          sealed: sealUserAskValue({
            askId: ask.askId,
            fieldId: field.id,
            value: raw,
            recipientKey: ask.recipientKey,
          }),
        });
      } catch {
        setIssue(t("mobile.userAsk.sealFailed"));
        return;
      }
    }
    tapLight();
    void onAnswer(
      () =>
        answerUserAsk({
          askId: ask.askId,
          revision: ask.revision,
          kind: "fields",
          fields: payload,
        }),
      "mobile.userAsk.answerFailed",
    );
  }, [
    ask.askId,
    ask.recipientKey,
    ask.revision,
    detail.fields,
    isSensitive,
    onAnswer,
    sealable,
    t,
    values,
  ]);

  if (needsComputer) {
    return (
      <View style={styles.body}>
        <View style={styles.redirect}>
          <Text style={styles.redirectTitle}>
            {originLabel
              ? t("mobile.userAsk.answerOnComputer", { device: originLabel })
              : ask.originDeviceId
                ? t("mobile.userAsk.answerOnComputer", {
                    device: t("mobile.userAsk.unnamedComputer", {
                      id: ask.originDeviceId.slice(0, 4).toUpperCase(),
                    }),
                  })
                : t("mobile.userAsk.answerOnComputerUnknown")}
          </Text>
          <Text style={styles.redirectBody}>
            {t("mobile.userAsk.answerOnComputerWhy")}
          </Text>
          <View style={styles.redirectFields}>
            {detail.fields.map((field) => (
              <Text key={field.id} style={styles.redirectField}>
                {field.label}
              </Text>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {detail.fields.map((field) => {
        const sensitive = isSensitive(field);
        const value = values[field.id] ?? "";
        const show = revealed[field.id] === true;
        return (
          <View key={field.id} style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              {field.optional ? (
                <Text style={styles.fieldOptional}>
                  {t("mobile.userAsk.optional")}
                </Text>
              ) : null}
            </View>
            {field.hint ? (
              <Text style={styles.fieldHint}>{field.hint}</Text>
            ) : null}

            {field.type === "choice" ? (
              <View style={styles.choiceRow}>
                {(field.choices ?? []).map((choice) => {
                  const selected = value === choice.id;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      disabled={busy}
                      key={choice.id}
                      onPress={() => {
                        tapLight();
                        setValues((prev) => ({
                          ...prev,
                          [field.id]: choice.id,
                        }));
                      }}
                      style={({ pressed }) => [
                        styles.choice,
                        selected && styles.choiceSelected,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.choiceText,
                          selected && styles.choiceTextSelected,
                        ]}
                      >
                        {choice.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <View style={styles.inputRow}>
                <AskTextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  colors={colors}
                  {...(field.type === "code"
                    ? {
                        keyboardType: "number-pad" as const,
                        maxLength: 12,
                        textContentType: "oneTimeCode" as const,
                      }
                    : {})}
                  accessibilityLabel={field.label}
                  onChangeText={(next) =>
                    setValues((prev) => ({ ...prev, [field.id]: next }))
                  }
                  placeholder={field.placeholder ?? ""}
                  secureTextEntry={field.type === "secret" && !show}
                  spellCheck={false}
                  style={[
                    styles.input,
                    field.type === "code" && styles.inputCode,
                  ]}
                  value={value}
                />
                {field.type === "secret" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      show
                        ? t("mobile.userAsk.hideSecret", { label: field.label })
                        : t("mobile.userAsk.revealSecret", {
                            label: field.label,
                          })
                    }
                    onPress={() =>
                      setRevealed((prev) => ({ ...prev, [field.id]: !show }))
                    }
                    style={({ pressed }) => [
                      styles.reveal,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Icon
                      color={colors.textMuted}
                      name={show ? "eye-off" : "eye"}
                      size={16}
                    />
                  </Pressable>
                ) : null}
              </View>
            )}

            <View style={styles.sensitiveRow}>
              <Text style={styles.sensitiveText}>
                {sensitive
                  ? t("mobile.userAsk.sensitive")
                  : t("mobile.userAsk.plain")}
              </Text>
              {sealable ? (
                <GlassToggle
                  accessibilityLabel={t("mobile.userAsk.sensitiveToggleA11y", {
                    label: field.label,
                  })}
                  onValueChange={(next) => {
                    tapLight();
                    setSensitiveOverrides((prev) => ({
                      ...prev,
                      [field.id]: next,
                    }));
                  }}
                  value={sensitive}
                />
              ) : null}
            </View>
          </View>
        );
      })}

      {issue ? <Text style={styles.issue}>{issue}</Text> : null}

      <Pressable
        accessibilityRole="button"
        disabled={busy || missing}
        onPress={send}
        style={({ pressed }) => [
          styles.primaryAction,
          styles.primaryActionWide,
          pressed && styles.pressed,
          (busy || missing) && styles.disabled,
        ]}
      >
        <Text style={styles.primaryActionText}>
          {busy
            ? t("mobile.userAsk.sending")
            : t("mobile.userAsk.sendSecurely")}
        </Text>
      </Pressable>
    </View>
  );
}

function AskTextInput({
  colors,
  ...props
}: TextInputProps & { colors: Colors }) {
  return (
    <TextInput
      placeholderTextColor={colors.textWeaker}
      selectionColor={colors.accent}
      {...props}
    />
  );
}

type AskStyles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    blockingBadge: {
      backgroundColor: colors.accentSoft,
      borderRadius: 8,
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      overflow: "hidden",
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    body: {
      gap: 10,
    },
    inlineCard: {
      alignSelf: "flex-start",
      backgroundColor: colors.assistantBubbleFillTop,
      borderRadius: 18,
      borderWidth: 0,
      width: "100%",
    },
    record: {
      alignSelf: "flex-start",
      backgroundColor: colors.assistantBubbleFillTop,
      borderRadius: 18,
      gap: 10,
      maxWidth: "100%",
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    recordAnswer: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 16,
      lineHeight: 21,
    },
    recordAnswerSkipped: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontStyle: "italic",
    },
    recordItem: {
      gap: 2,
    },
    recordQuestion: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 19,
    },
    recordTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      fontStyle: "normal",
    },
    card: {
      alignSelf: "stretch",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 14,
      paddingBottom: 12,
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    choice: {
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    choiceRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    choiceSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
    },
    choiceText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    choiceTextSelected: {
      color: colors.text,
    },
    countdown: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    declineRow: {
      alignSelf: "flex-start",
      paddingVertical: 4,
    },
    declineText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
    },
    detail: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 21,
      marginTop: 6,
    },
    disabled: {
      opacity: 0.4,
    },
    field: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 14,
      gap: 7,
      padding: 12,
    },
    fieldHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    fieldHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    fieldLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    fieldOptional: {
      color: colors.textWeaker,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    footer: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 38,
    },
    footerActions: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    },
    footerStart: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
    },
    header: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 12,
    },
    headerCopy: {
      flex: 1,
      gap: 3,
    },
    icon: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 11,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    iconBlocking: {
      backgroundColor: colors.accentSoft,
    },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    inputCode: {
      fontFamily: fonts.mono.regular,
      letterSpacing: 3,
    },
    inputRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    issue: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
    },
    meta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    nav: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      width: 32,
    },
    option: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 12,
      minHeight: 52,
      paddingLeft: 11,
      paddingRight: 14,
      paddingVertical: 10,
    },
    optionCopy: {
      flex: 1,
      gap: 2,
    },
    optionHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    optionKey: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 8,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    optionKeySelected: {
      backgroundColor: colors.accent,
    },
    optionKeyText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
    },
    optionKeyTextSelected: {
      color: colors.accentForeground,
    },
    optionLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 21,
    },
    optionSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
    },
    optionTag: {
      color: colors.textWeaker,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    options: {
      gap: 8,
      marginTop: 14,
    },
    other: {
      alignItems: "flex-end",
      backgroundColor: colors.surfaceInset,
      borderColor: colors.border,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      minHeight: 52,
      paddingLeft: 14,
      paddingRight: 8,
      paddingVertical: 8,
    },
    otherConfirm: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 18,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    otherConfirmIdle: {
      backgroundColor: colors.muted,
    },
    otherInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      lineHeight: 21,
      maxHeight: 120,
      minHeight: 36,
      paddingBottom: 7,
      paddingTop: 7,
      textAlignVertical: "center",
    },
    pager: {
      alignItems: "center",
      flexDirection: "row",
      gap: 2,
    },
    pressed: {
      opacity: 0.72,
    },
    primaryAction: {
      alignItems: "center",
      alignSelf: "flex-end",
      backgroundColor: colors.accent,
      borderRadius: 19,
      justifyContent: "center",
      minHeight: 38,
      paddingHorizontal: 16,
    },
    primaryActionText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
    },
    primaryActionWide: {
      alignSelf: "stretch",
      minHeight: 46,
    },
    progress: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      fontVariant: ["tabular-nums"],
      minWidth: 52,
      textAlign: "center",
    },
    redirect: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 14,
      gap: 7,
      padding: 12,
    },
    redirectBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    redirectField: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    redirectFields: {
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 2,
      paddingTop: 8,
    },
    redirectTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.1,
    },
    reveal: {
      alignItems: "center",
      height: 38,
      justifyContent: "center",
      width: 32,
    },
    sensitiveRow: {
      alignItems: "center",
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      paddingTop: 8,
    },
    sensitiveText: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    skip: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 19,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 5,
      justifyContent: "center",
      minHeight: 38,
      paddingHorizontal: 14,
    },
    skipSelected: {
      borderColor: colors.border,
    },
    skipText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    skipTextSelected: {
      color: colors.text,
    },
    statusRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    step: {
      gap: 0,
    },
    timingRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
    },
    timing: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      letterSpacing: -0.3,
      lineHeight: 24,
    },
  });
