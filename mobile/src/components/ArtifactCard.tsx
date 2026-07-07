import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import type { ChatArtifact } from "../types";
import {
  artifactIconName,
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
};

export function ArtifactCard({ artifact, colors, onPress }: ArtifactCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const payload = artifact.payload;
  const title = artifactTitle(payload);
  const subtitle = artifactSubtitle(payload);
  const iconName = artifactIconName(payload) as IconName;
  // On-device PDFs open to a viewer with a save/share action, so hint that with
  // a share glyph instead of the generic open chevron.
  const trailingIcon: IconName =
    payload.kind === "pdf" && payload.localUri ? "share" : "chevron-right";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      onPress={() => onPress(artifact)}
      style={({ pressed }) => [
        styles.card,
        pressed ? styles.cardPressed : null,
      ]}
    >
      <View style={styles.iconWrap}>
        <Icon name={iconName} size={18} color={colors.text} />
      </View>
      <View style={styles.textWrap}>
        <Text
          style={styles.title}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {title}
        </Text>
        <Text
          style={styles.subtitle}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {subtitle}
        </Text>
      </View>
      <Icon name={trailingIcon} size={18} color={colors.textMuted} />
    </Pressable>
  );
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
