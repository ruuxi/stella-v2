import { useCallback, useEffect, useMemo, useState } from "react";
import { Image } from "expo-image";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  useCloudConnectRequestActions,
  useCurrentConversationConnectRequest,
} from "../lib/cloud-connector-connect";
import { useT } from "../i18n";
import { useColors } from "../theme/theme-context";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";

/**
 * Inline connect card for a cloud turn: the orchestrator's
 * `connector_status` asked to use a Store integration this account has not
 * connected. Connect opens the account's hosted OAuth page; the waiting
 * turn observes the finished connection itself, so the card only has to
 * carry the user's answer.
 */
export function CloudConnectorConnectCard({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const request = useCurrentConversationConnectRequest(conversationId);
  const { decide } = useCloudConnectRequestActions();
  const [busy, setBusy] = useState<"connect" | "decline" | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setBusy(null);
    setIssue(null);
    setIconFailed(false);
  }, [request?.requestId]);

  const answer = useCallback(
    async (decision: "connect" | "decline") => {
      if (!request || busy) return;
      setBusy(decision);
      setIssue(null);
      try {
        const outcome = await decide({
          requestId: request.requestId,
          expectedRevision: request.revision,
          decision,
        });
        if (decision === "connect" && outcome.url) {
          try {
            await Linking.openURL(outcome.url);
          } catch {
            setIssue(t("cloudConnector.errors.open"));
          }
        }
      } catch {
        setIssue(t("cloudConnector.errors.decision", { name: request.name }));
      } finally {
        setBusy(null);
      }
    },
    [busy, decide, request, t],
  );

  if (!request) return null;
  const connecting = request.state === "connecting";
  const showIcon = Boolean(request.iconUrl) && !iconFailed;

  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.icon}>
        {connecting ? (
          <Icon name="check" size={17} color={colors.text} />
        ) : showIcon ? (
          <Image
            source={{ uri: request.iconUrl }}
            style={styles.iconImage}
            contentFit="contain"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <Icon name="globe" size={17} color={colors.text} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>
          {connecting
            ? t("cloudConnector.titleWaiting", { name: request.name })
            : t("cloudConnector.titleOffer", { name: request.name })}
        </Text>
        <Text style={styles.description}>
          {connecting
            ? t("cloudConnector.connecting", { name: request.name })
            : (request.reason ?? request.description ?? "")}
        </Text>
        {issue ? <Text style={styles.issue}>{issue}</Text> : null}
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(busy)}
          onPress={() => void answer("decline")}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.actionPressed,
            Boolean(busy) && styles.actionDisabled,
          ]}
        >
          <Text style={styles.actionText}>
            {connecting ? t("common.cancel") : t("cloudConnector.notNow")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(busy)}
          onPress={() => void answer("connect")}
          style={({ pressed }) => [
            styles.action,
            styles.actionPrimary,
            pressed && styles.actionPressed,
            Boolean(busy) && styles.actionDisabled,
          ]}
        >
          <Text style={styles.actionPrimaryText}>
            {connecting
              ? t("cloudConnector.openAgain")
              : t("cloudConnector.connect")}
          </Text>
        </Pressable>
      </View>
    </View>
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
      overflow: "hidden",
      width: 32,
    },
    iconImage: { height: 20, width: 20 },
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
