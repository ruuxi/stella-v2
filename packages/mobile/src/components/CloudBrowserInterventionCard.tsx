import { useCallback, useEffect, useMemo, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  useCloudBrowserActions,
  useCurrentConversationBrowserInteraction,
  type CloudBrowserInteractionDetail,
} from "../lib/cloud-browser";
import { useT } from "../i18n";
import { useColors } from "../theme/theme-context";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";
import { CloudBrowserTakeoverModal } from "./CloudBrowserTakeoverModal";

const publicVerificationUrl = (
  detail: Extract<CloudBrowserInteractionDetail, { kind: "device_code" }>,
): string | null => {
  try {
    const url = new URL(
      detail.verificationUriComplete ?? detail.verificationUri,
    );
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
};

export function CloudBrowserInterventionCard({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { summary, detail } =
    useCurrentConversationBrowserInteraction(conversationId);
  const { decide } = useCloudBrowserActions();
  const [takeoverVisible, setTakeoverVisible] = useState(false);
  const [busyDecision, setBusyDecision] = useState<"done" | "cancel" | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);

  useEffect(() => {
    setTakeoverVisible(false);
    setBusyDecision(null);
    setCopied(false);
    setIssue(null);
  }, [summary?.interactionId]);

  const decideInteraction = useCallback(
    async (decision: "done" | "cancel") => {
      if (!summary || busyDecision) return;
      setBusyDecision(decision);
      setIssue(null);
      try {
        await decide({
          interactionId: summary.interactionId,
          expectedRevision: detail?.revision ?? summary.revision,
          decision,
        });
        setTakeoverVisible(false);
      } catch {
        setIssue(t("cloudBrowser.errors.decision"));
      } finally {
        setBusyDecision(null);
      }
    },
    [busyDecision, decide, detail?.revision, summary, t],
  );

  if (!summary) return null;
  const origin = summary.displayOrigin;
  const resuming = summary.state === "resuming";
  const loginDetail = detail?.kind === "login_takeover" ? detail : null;
  const device = detail?.kind === "device_code" ? detail : null;

  const openDeviceCode = async () => {
    if (!device) return;
    const url = publicVerificationUrl(device);
    if (!url) {
      setIssue(t("cloudBrowser.errors.verificationUrl"));
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      setIssue(t("cloudBrowser.errors.verificationUrl"));
    }
  };

  const copyDeviceCode = async () => {
    if (!device) return;
    try {
      setCopied(await Clipboard.setStringAsync(device.userCode));
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <View style={styles.card} accessibilityRole="summary">
        <View style={styles.icon}>
          <Icon
            name={resuming ? "check" : "globe"}
            size={17}
            color={colors.text}
          />
        </View>
        <View style={styles.body}>
          <Text style={styles.title}>
            {summary.kind === "device_code"
              ? t("cloudBrowser.deviceCode.title", { origin })
              : resuming
                ? t("cloudBrowser.takeover.checking", { origin })
                : t("cloudBrowser.takeover.title", { origin })}
          </Text>
          {summary.kind === "device_code" ? (
            device ? (
              <>
                <Text style={styles.code} selectable>
                  {device.userCode}
                </Text>
                <Text style={styles.description}>
                  {t("cloudBrowser.deviceCode.body")}
                </Text>
              </>
            ) : (
              <Text style={styles.description}>{t("common.loading")}</Text>
            )
          ) : (
            <Text style={styles.description}>
              {resuming
                ? t("cloudBrowser.takeover.resumingBody")
                : t("cloudBrowser.takeover.body")}
            </Text>
          )}
          {issue ? <Text style={styles.issue}>{issue}</Text> : null}
        </View>

        {!resuming ? (
          <View style={styles.actions}>
            {summary.kind === "login_takeover" ? (
              <Pressable
                accessibilityRole="button"
                disabled={!loginDetail}
                onPress={() => setTakeoverVisible(true)}
                style={({ pressed }) => [
                  styles.action,
                  styles.actionPrimary,
                  pressed && styles.actionPressed,
                  !loginDetail && styles.actionDisabled,
                ]}
              >
                <Text style={styles.actionPrimaryText}>
                  {t("common.continue")}
                </Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  disabled={!device}
                  onPress={() => void copyDeviceCode()}
                  style={({ pressed }) => [
                    styles.action,
                    pressed && styles.actionPressed,
                    !device && styles.actionDisabled,
                  ]}
                >
                  <Text style={styles.actionText}>
                    {copied
                      ? t("cloudBrowser.deviceCode.copied")
                      : t("cloudBrowser.deviceCode.copy")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!device}
                  onPress={() => void openDeviceCode()}
                  style={({ pressed }) => [
                    styles.action,
                    styles.actionPrimary,
                    pressed && styles.actionPressed,
                    !device && styles.actionDisabled,
                  ]}
                >
                  <Text style={styles.actionPrimaryText}>
                    {t("cloudBrowser.deviceCode.open")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={Boolean(busyDecision) || !device}
                  onPress={() => void decideInteraction("done")}
                  style={({ pressed }) => [
                    styles.action,
                    pressed && styles.actionPressed,
                    (!device || Boolean(busyDecision)) && styles.actionDisabled,
                  ]}
                >
                  <Text style={styles.actionText}>
                    {t("cloudBrowser.actions.done")}
                  </Text>
                </Pressable>
              </>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(busyDecision)}
              onPress={() => void decideInteraction("cancel")}
              style={({ pressed }) => [
                styles.action,
                pressed && styles.actionPressed,
                Boolean(busyDecision) && styles.actionDisabled,
              ]}
            >
              <Text style={styles.actionText}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {loginDetail ? (
        <CloudBrowserTakeoverModal
          visible={takeoverVisible}
          detail={loginDetail}
          busyDecision={busyDecision}
          onDismiss={() => setTakeoverVisible(false)}
          onDecision={decideInteraction}
        />
      ) : null}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "stretch",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      padding: 11,
    },
    icon: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 10,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    body: { flex: 1, minWidth: 180 },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
      lineHeight: 19,
    },
    description: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 2,
    },
    code: {
      alignSelf: "flex-start",
      backgroundColor: colors.muted,
      borderRadius: 7,
      color: colors.text,
      fontFamily: fonts.mono.medium,
      fontSize: 15,
      letterSpacing: 1.1,
      marginTop: 6,
      overflow: "hidden",
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    issue: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 5,
    },
    actions: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
      justifyContent: "flex-end",
      width: "100%",
    },
    action: {
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      minHeight: 32,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    actionPrimary: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    actionPressed: { opacity: 0.72 },
    actionDisabled: { opacity: 0.4 },
    actionText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
    },
    actionPrimaryText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12,
    },
  });
