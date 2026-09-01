/**
 * Pinned "you need to act" card above the composer — signed out, plan
 * limit reached, model gated, provider rejected. Reads the composer-notice
 * store and shares the cloud-browser intervention card's silhouette so
 * the two occupy one slot. Mirrors the desktop `ComposerNotice`.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  dismissComposerNotice,
  useComposerNotice,
  type ComposerNoticeKind,
} from "../lib/composer-notice";
import { useT } from "../i18n";
import { useColors } from "../theme/theme-context";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { Icon, type IconName } from "./Icon";

const KIND_ICON: Record<ComposerNoticeKind, IconName> = {
  "sign-in": "user",
  upgrade: "sparkles",
  limit: "alert-circle",
  provider: "alert-circle",
};

export function ComposerNotice({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const notice = useComposerNotice(conversationId);

  if (!notice) return null;

  const dismiss = () => dismissComposerNotice(notice.id);
  const primary =
    notice.kind === "sign-in"
      ? {
          label: "Sign in",
          onPress: () => {
            dismiss();
            router.replace("/login");
          },
        }
      : notice.kind === "upgrade"
        ? {
            label: "Upgrade",
            onPress: () => {
              dismiss();
              router.push("/account");
            },
          }
        : null;

  return (
    <View
      style={styles.card}
      accessibilityRole="summary"
      testID="composer-notice"
    >
      <View style={styles.icon}>
        <Icon name={KIND_ICON[notice.kind]} size={17} color={colors.text} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{notice.title}</Text>
        {notice.description ? (
          <Text style={styles.description}>{notice.description}</Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        hitSlop={8}
        onPress={dismiss}
        style={styles.dismiss}
      >
        <Icon name="x" size={14} color={colors.textMuted} />
      </Pressable>
      {primary ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={primary.onPress}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryText}>{primary.label}</Text>
          </Pressable>
        </View>
      ) : null}
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
      paddingRight: 36,
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
    dismiss: {
      alignItems: "center",
      height: 24,
      justifyContent: "center",
      position: "absolute",
      right: 8,
      top: 8,
      width: 24,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      width: "100%",
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    primaryButtonPressed: {
      backgroundColor: colors.accentHover,
    },
    primaryText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13,
    },
  });
