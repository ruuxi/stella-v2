import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import type { ChatArtifact } from "../types";
import {
  artifactIconName,
  artifactPrimaryFilePath,
  artifactSubtitle,
  artifactTitle,
} from "../lib/mobile-artifacts";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

type ArtifactCardProps = {
  artifact: ChatArtifact;
  colors: Colors;
  onPress: (artifact: ChatArtifact) => void;
  compact?: boolean;
};

export function ArtifactCard({
  artifact,
  colors,
  onPress,
  compact = false,
}: ArtifactCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const payload = artifact.payload;
  const filePath = artifactPrimaryFilePath(payload);
  const filename = filePath?.split(/[?#]/)[0]?.split(/[\\/]/).pop();
  const pill = payload.kind === "canvas-html" && !compact;
  const minimal = compact || pill;
  const title = minimal && filename ? filename : artifactTitle(payload);
  const subtitle = artifactSubtitle(payload);
  const iconName = artifactIconName(payload) as IconName;
  // On-device PDFs open to a viewer with a save/share action, so hint that with
  // a share glyph instead of the generic open chevron.
  const trailingIcon: IconName =
    payload.kind === "pdf" && payload.localUri ? "share" : "chevron-right";

  const card = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      onPress={() => onPress(artifact)}
      style={({ pressed }) => [
        styles.card,
        compact ? styles.compactCard : null,
        pill ? styles.pill : null,
        pressed ? styles.cardPressed : null,
      ]}
    >
      <View style={minimal ? styles.compactIcon : styles.iconWrap}>
        <Icon name={iconName} size={18} color={colors.text} />
      </View>
      <View style={[styles.textWrap, pill ? styles.pillText : null]}>
        <Text
          style={[styles.title, pill ? styles.pillTitle : null]}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {title}
        </Text>
        {!minimal ? (
          <Text
            style={styles.subtitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {!minimal ? (
        <Icon name={trailingIcon} size={18} color={colors.textMuted} />
      ) : null}
    </Pressable>
  );
  return pill ? (
    <View style={styles.connectedPill}>
      <View pointerEvents="none" accessible={false} style={styles.connector} />
      {card}
    </View>
  ) : card;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: fadeHex(colors.card, 0.8),
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      minHeight: 58,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    connectedPill: { marginLeft: 14, paddingBottom: 10, alignSelf: "flex-start", maxWidth: "94%" },
    connector: {
      position: "absolute", left: -9, bottom: -2, width: 14, height: 18,
      borderLeftWidth: 1.5, borderBottomWidth: 1.5, borderBottomLeftRadius: 10,
      borderColor: colors.border, opacity: 0.85,
    },
    pill: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      borderRadius: 22,
      minHeight: 40,
      paddingVertical: 8,
      gap: 6,
    },
    pillText: { flex: 0, flexShrink: 1 },
    pillTitle: { fontFamily: fonts.sans.regular },
    compactCard: {
      backgroundColor: "transparent",
      borderWidth: 0,
      borderRadius: 8,
      minHeight: 44,
      paddingHorizontal: 2,
      paddingVertical: 6,
    },
    compactIcon: {
      alignItems: "center",
      justifyContent: "center",
      width: 20,
      height: 20,
    },
    cardPressed: {
      opacity: 0.72,
    },
    iconWrap: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    textWrap: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 2,
    },
  });
