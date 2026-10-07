/**
 * Accounts, inside the conversation.
 *
 * A guest is offered a Stella account (the existing sign-in screen; the
 * onboarding resumes on this message when they come back), and everyone is
 * offered their own Claude or ChatGPT subscription for Stella's cloud
 * through the same paste-back flow Settings uses (Claude: the cloud's own
 * `claude auth login`; the phone never signs in to Claude itself). All of it
 * is optional.
 */
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import {
  isEngineConnectionUsable,
  type EngineConnection,
  type EngineProvider,
} from "@stella/contracts/backend/engines";
import { useT } from "../../../i18n";
import { useBackendView } from "../../../lib/backend";
import { notifySuccess, tapLight } from "../../../lib/haptics";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { useColors } from "../../../theme/theme-context";
import { useEngineConnect } from "../../EngineAccountsSettings";
import { Icon, type IconName } from "../../Icon";
import { fadeEntering, rowEntering, springLayout, SpringPressable } from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SecondaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";

type EngineSpec = {
  provider: EngineProvider;
  icon: IconName;
  name: string;
  descKey: string;
  pasteHintKey: string;
};

const ENGINES: EngineSpec[] = [
  {
    provider: "anthropic",
    icon: "sparkles",
    name: "Claude",
    descKey: "mobile.onboarding.account.claudeDesc",
    pasteHintKey: "mobile.engineAccounts.pasteHintClaude",
  },
  {
    provider: "chatgpt",
    icon: "message-square",
    name: "ChatGPT",
    descKey: "mobile.onboarding.account.chatgptDesc",
    pasteHintKey: "mobile.engineAccounts.pasteHintChatgpt",
  },
];

type AccountCardProps = {
  active: boolean;
  answered: "done" | "skipped" | undefined;
  /** Signed in to a real (non-anonymous) Stella account. */
  signedIn: boolean;
  email: string | null;
  onSignIn: () => void;
  onAnswer: (answer: "done" | "skipped") => void;
};

export function AccountCard({
  active,
  answered,
  signedIn,
  email,
  onSignIn,
  onAnswer,
}: AccountCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { value: engines } = useBackendView("engines.get", {});
  // A ChatGPT sign-in counts once Stella's cloud may use the plan.
  const connections = (engines?.connections ?? []).filter(isEngineConnectionUsable);
  const connectedNames = ENGINES.filter((spec) =>
    connections.some((row) => row.provider === spec.provider),
  ).map((spec) => spec.name);
  const anythingDone = signedIn || connectedNames.length > 0;

  if (answered) {
    const parts = [
      signedIn ? (email ?? "") : t("mobile.onboarding.account.guestSettled"),
      ...connectedNames,
    ].filter(Boolean);
    return (
      <SettledCard
        icon={signedIn ? "check" : "user"}
        tone={signedIn ? "success" : "neutral"}
        title={
          signedIn
            ? t("mobile.onboarding.account.settledSignedIn")
            : t("mobile.onboarding.account.settledGuest")
        }
        description={parts.join(" · ")}
      />
    );
  }

  return (
    <OnboardingCard>
      {signedIn ? (
        <Animated.View entering={fadeEntering(0, 240)} style={styles.signedRow}>
          <View style={styles.okBadge}>
            <Icon name="check" size={13} color={colors.ok} weight="bold" />
          </View>
          <View style={styles.flex}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {t("mobile.onboarding.account.settledSignedIn")}
            </Text>
            {email ? (
              <Text style={styles.rowDesc} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
        </Animated.View>
      ) : (
        <View style={styles.block}>
          <Text style={cardStyles.title}>{t("mobile.onboarding.account.signInTitle")}</Text>
          <Text style={cardStyles.body}>{t("mobile.onboarding.account.signInBody")}</Text>
          <PrimaryAction
            label={t("mobile.onboarding.account.signIn")}
            icon="user"
            onPress={() => {
              tapLight();
              onSignIn();
            }}
            disabled={!active}
          />
        </View>
      )}

      <View style={styles.divider} />

      <View style={styles.block}>
        <Text style={cardStyles.label}>{t("mobile.onboarding.account.subscriptionsLabel")}</Text>
        <Text style={cardStyles.body}>{t("mobile.onboarding.account.subscriptionsBody")}</Text>
      </View>

      <View style={styles.engines}>
        {ENGINES.map((spec, index) => (
          <Animated.View key={spec.provider} entering={rowEntering(index, 160)} layout={springLayout}>
            <EngineRow
              spec={spec}
              connection={connections.find((row) => row.provider === spec.provider && row.active) ??
                connections.find((row) => row.provider === spec.provider) ??
                null}
              disabled={!active}
            />
          </Animated.View>
        ))}
      </View>

      <View style={cardStyles.actions}>
        {anythingDone ? (
          <PrimaryAction
            label={t("mobile.common.continue")}
            onPress={() => onAnswer("done")}
            disabled={!active}
            style={styles.flex}
          />
        ) : (
          <SecondaryAction
            label={t("mobile.onboarding.account.skip")}
            onPress={() => onAnswer("skipped")}
            disabled={!active}
            style={styles.flex}
          />
        )}
      </View>
    </OnboardingCard>
  );
}

function EngineRow({
  spec,
  connection,
  disabled,
}: {
  spec: EngineSpec;
  connection: EngineConnection | null;
  disabled: boolean;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const connect = useEngineConnect(spec.provider, { onConnected: notifySuccess });
  const connected = connection !== null;

  return (
    <Animated.View layout={springLayout} style={styles.engine}>
      <View style={styles.engineRow}>
        <View style={[styles.engineIcon, connected && styles.engineIconConnected]}>
          <Icon
            name={connected ? "check" : spec.icon}
            size={15}
            color={connected ? colors.ok : colors.text}
            weight="semibold"
          />
        </View>
        <View style={styles.flex}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {spec.name}
          </Text>
          <Text style={styles.rowDesc} numberOfLines={2}>
            {connected
              ? t("mobile.onboarding.account.connectedAs", {
                  name: connection.email ?? connection.label,
                })
              : t(spec.descKey)}
          </Text>
        </View>
        {connected ? null : connect.busy && !connect.connectId ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : connect.connectId ? null : (
          <SpringPressable
            onPress={() => {
              tapLight();
              connect.startConnect();
            }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.onboarding.account.connectLabel", { name: spec.name })}
            hitSlop={6}
            pressScale={0.93}
            style={[styles.connectButton, disabled && styles.dimmed]}
          >
            <Text style={styles.connectText}>{t("mobile.onboarding.account.connect")}</Text>
          </SpringPressable>
        )}
      </View>

      {connect.connectId && !connected ? (
        <Animated.View entering={fadeEntering(0, 220)} style={styles.paste}>
          <Text style={styles.rowDesc}>{t(spec.pasteHintKey)}</Text>
          <View style={styles.pasteRow}>
            <TextInput
              value={connect.pasted}
              onChangeText={connect.setPasted}
              placeholder={
                spec.provider === "chatgpt"
                  ? t("mobile.engineAccounts.pastePlaceholderUrl")
                  : t("mobile.engineAccounts.pastePlaceholder")
              }
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.pasteInput}
            />
            <Pressable
              onPress={() => void connect.pasteFromClipboard()}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.link}>{t("mobile.engineAccounts.pasteFromClipboard")}</Text>
            </Pressable>
          </View>
          <View style={styles.pasteActions}>
            <Pressable
              onPress={connect.cancelConnect}
              disabled={connect.busy}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.rowDesc}>{t("mobile.common.cancel")}</Text>
            </Pressable>
            <Pressable
              onPress={connect.reopenAuthorizePage}
              disabled={connect.busy}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.rowDesc}>
                {spec.provider === "chatgpt"
                  ? t("mobile.engineAccounts.openChatgptAgain")
                  : t("mobile.engineAccounts.openClaudeAgain")}
              </Text>
            </Pressable>
            <Pressable
              onPress={connect.finishConnect}
              disabled={connect.busy || !connect.pasted.trim()}
              hitSlop={8}
              accessibilityRole="button"
              style={(connect.busy || !connect.pasted.trim()) && styles.dimmed}
            >
              <Text style={styles.link}>
                {connect.busy
                  ? t("mobile.engineAccounts.connecting")
                  : t("mobile.engineAccounts.finish")}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    block: { gap: 8 },
    divider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: -2,
    },
    signedRow: { alignItems: "center", flexDirection: "row", gap: 12 },
    okBadge: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    engines: { gap: 8 },
    engine: {
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
      padding: 12,
    },
    engineRow: { alignItems: "center", flexDirection: "row", gap: 11 },
    engineIcon: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    engineIconConnected: { backgroundColor: colors.accentSoft },
    rowTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.25,
    },
    rowDesc: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      lineHeight: 18,
    },
    connectButton: {
      alignItems: "center",
      borderColor: colors.selectBorder,
      borderRadius: 15,
      borderWidth: 1,
      height: 30,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    connectText: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13.5,
      letterSpacing: -0.2,
    },
    dimmed: { opacity: 0.5 },
    paste: { gap: 10 },
    pasteRow: { alignItems: "center", flexDirection: "row", gap: 12 },
    pasteInput: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    link: {
      color: colors.accent,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
    },
    pasteActions: { flexDirection: "row", gap: 20, justifyContent: "flex-end" },
  });
