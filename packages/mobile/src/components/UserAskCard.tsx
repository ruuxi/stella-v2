import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import {
  USER_ASK_SOMETHING_ELSE_OPTION_ID,
  withSomethingElseOption,
  type UserAsk,
  type UserAskAnswerFieldValue,
  type UserAskField,
  type UserAskOption,
  type UserAskQuestionDetail,
  type UserAskSecureInputDetail,
} from "@stella/contracts/user-ask";
import { tapLight } from "../lib/haptics";
import {
  answerUserAsk,
  cancelUserAsk,
  useConversationUserAsk,
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
  const ask = useConversationUserAsk(conversationId);
  useResolveFocusedUserAsk(ask?.askId ?? null);
  if (!ask) return null;
  return <UserAskSurface ask={ask} key={ask.askId} />;
}

function UserAskSurface({ ask }: { ask: UserAsk }) {
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

  const detail = ask.detail;
  const defaultOption =
    detail.kind === "question" && detail.defaultChoiceId
      ? detail.options.find((option) => option.id === detail.defaultChoiceId)
      : undefined;

  const title = detail.kind === "question" ? detail.question : detail.purpose;

  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.header}>
        <View style={[styles.icon, ask.blocking && styles.iconBlocking]}>
          <Icon
            name={ask.kind === "secure_input" ? "eye-off" : "message-square"}
            size={16}
            color={ask.blocking ? colors.accent : colors.text}
          />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{title}</Text>
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
              : defaultOption
                ? t("mobile.userAsk.deadlineWithDefault", {
                    time: formatRemaining(remaining),
                    option: defaultOption.label,
                  })
                : t("mobile.userAsk.deadline", {
                    time: formatRemaining(remaining),
                  })}
          </Text>
        ) : null}
      </View>

      {detail.kind === "question" ? (
        <QuestionBody
          ask={ask}
          detail={detail}
          busy={busy}
          styles={styles}
          colors={colors}
          t={t}
          onAnswer={submit}
        />
      ) : (
        <SecureInputBody
          ask={ask}
          detail={detail}
          busy={busy}
          styles={styles}
          colors={colors}
          t={t}
          onAnswer={submit}
        />
      )}

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

function QuestionBody({
  ask,
  detail,
  busy,
  styles,
  colors,
  t,
  onAnswer,
}: {
  ask: UserAsk;
  detail: UserAskQuestionDetail;
  busy: boolean;
  styles: AskStyles;
  colors: Colors;
  t: Translate;
  onAnswer: (run: () => Promise<void>, failureKey: string) => Promise<void>;
}) {
  const [elsewhere, setElsewhere] = useState(false);
  const [note, setNote] = useState("");

  const options = useMemo(
    () =>
      withSomethingElseOption(
        detail.options,
        t("mobile.userAsk.somethingElse"),
      ),
    [detail.options, t],
  );

  const answerChoice = useCallback(
    (option: UserAskOption) => {
      if (option.id === USER_ASK_SOMETHING_ELSE_OPTION_ID) {
        tapLight();
        setElsewhere(true);
        return;
      }
      tapLight();
      void onAnswer(
        () =>
          answerUserAsk({
            askId: ask.askId,
            revision: ask.revision,
            kind: "choice",
            choiceId: option.id,
          }),
        "mobile.userAsk.answerFailed",
      );
    },
    [ask.askId, ask.revision, onAnswer],
  );

  const sendNote = useCallback(() => {
    const text = note.trim();
    if (!text) return;
    tapLight();
    void onAnswer(
      () =>
        answerUserAsk({
          askId: ask.askId,
          revision: ask.revision,
          kind: "choice",
          choiceId: USER_ASK_SOMETHING_ELSE_OPTION_ID,
          text,
        }),
      "mobile.userAsk.answerFailed",
    );
  }, [ask.askId, ask.revision, note, onAnswer]);

  return (
    <View style={styles.body}>
      {options.map((option) => {
        const isElsewhere = option.id === USER_ASK_SOMETHING_ELSE_OPTION_ID;
        const selected = isElsewhere && elsewhere;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, selected }}
            disabled={busy}
            key={option.id}
            onPress={() => answerChoice(option)}
            style={({ pressed }) => [
              styles.option,
              selected && styles.optionSelected,
              pressed && styles.pressed,
              busy && styles.disabled,
            ]}
          >
            <View style={styles.optionCopy}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.hint ? (
                <Text style={styles.optionHint}>{option.hint}</Text>
              ) : null}
            </View>
            {option.id === detail.defaultChoiceId ? (
              <Text style={styles.optionTag}>
                {t("mobile.userAsk.defaultOption")}
              </Text>
            ) : null}
          </Pressable>
        );
      })}

      {elsewhere ? (
        <View style={styles.noteRow}>
          <AskTextInput
            autoFocus
            colors={colors}
            multiline
            onChangeText={setNote}
            placeholder={t("mobile.userAsk.somethingElsePlaceholder")}
            accessibilityLabel={t("mobile.userAsk.somethingElse")}
            style={styles.inputMultiline}
            value={note}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || note.trim().length === 0}
            onPress={sendNote}
            style={({ pressed }) => [
              styles.primaryAction,
              pressed && styles.pressed,
              (busy || note.trim().length === 0) && styles.disabled,
            ]}
          >
            <Text style={styles.primaryActionText}>
              {busy ? t("mobile.userAsk.sending") : t("mobile.userAsk.send")}
            </Text>
          </Pressable>
        </View>
      ) : null}
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
      borderRadius: 7,
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      overflow: "hidden",
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    body: {
      gap: 8,
    },
    card: {
      alignSelf: "stretch",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
      padding: 11,
    },
    choice: {
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 11,
      paddingVertical: 6,
    },
    choiceRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    choiceSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
    },
    choiceText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
    },
    choiceTextSelected: {
      color: colors.text,
    },
    countdown: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    declineRow: {
      alignSelf: "flex-start",
      paddingVertical: 4,
    },
    declineText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
    detail: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
    },
    disabled: {
      opacity: 0.4,
    },
    field: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 12,
      gap: 6,
      padding: 10,
    },
    fieldHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    fieldHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      lineHeight: 15,
    },
    fieldLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
    },
    fieldOptional: {
      color: colors.textWeaker,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    header: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 10,
    },
    headerCopy: {
      flex: 1,
      gap: 2,
    },
    icon: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 10,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    iconBlocking: {
      backgroundColor: colors.accentSoft,
    },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      minHeight: 38,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    inputCode: {
      fontFamily: fonts.mono.regular,
      letterSpacing: 3,
    },
    inputMultiline: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      maxHeight: 110,
      minHeight: 58,
      paddingHorizontal: 11,
      paddingVertical: 8,
      textAlignVertical: "top",
    },
    inputRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    issue: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
    meta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    noteRow: {
      gap: 7,
    },
    option: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    optionCopy: {
      flex: 1,
      gap: 1,
    },
    optionHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      lineHeight: 15,
    },
    optionLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    optionSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
    },
    optionTag: {
      color: colors.textWeaker,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    pressed: {
      opacity: 0.72,
    },
    redirect: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 12,
      gap: 6,
      padding: 11,
    },
    redirectBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
    },
    redirectField: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      lineHeight: 16,
    },
    redirectFields: {
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 1,
      paddingTop: 7,
    },
    redirectTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    primaryAction: {
      alignItems: "center",
      alignSelf: "flex-end",
      backgroundColor: colors.accent,
      borderRadius: 16,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: 14,
    },
    primaryActionText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13,
    },
    primaryActionWide: {
      alignSelf: "stretch",
      minHeight: 42,
    },
    reveal: {
      alignItems: "center",
      height: 34,
      justifyContent: "center",
      width: 30,
    },
    sensitiveRow: {
      alignItems: "center",
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      paddingTop: 7,
    },
    sensitiveText: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      lineHeight: 15,
    },
    statusRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
      lineHeight: 19,
    },
  });
