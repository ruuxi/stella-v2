import { StyleSheet } from "react-native";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";

/**
 * The Settings page's grouped-list vocabulary: an uppercase section label
 * over a rounded surface card of rows split by hairlines. It matches the
 * Subscription section's card so every section on the page reads as one set.
 */
export const makeSettingsStyles = (colors: Colors) =>
  StyleSheet.create({
    section: {
      marginTop: 28,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: 0.3,
      marginBottom: 10,
      textTransform: "uppercase",
    },
    group: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    groupGap: {
      marginTop: 12,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    rowDivider: {
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowPressed: {
      backgroundColor: fadeHex(colors.text, 0.05),
    },
    rowDisabled: {
      opacity: 0.55,
    },
    rowIcon: {
      width: 22,
    },
    rowCopy: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    rowSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    rowTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      maxWidth: 150,
    },
    rowAction: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
    },
    rowDanger: {
      color: colors.danger,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
    },
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
  });

export type SettingsStyles = ReturnType<typeof makeSettingsStyles>;
