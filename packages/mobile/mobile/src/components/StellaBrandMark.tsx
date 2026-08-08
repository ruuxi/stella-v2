import { useMemo } from "react";
import { Image, PixelRatio, StyleSheet, Text, View } from "react-native";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

/** Rasterized from `assets/stella-logo.svg` (same asset as desktop/launcher). */
const STELLA_LOGO =
  PixelRatio.get() >= 3
    ? require("../../assets/stella-logo-84.png")
    : require("../../assets/stella-logo-56.png");

type Props = {
  /** Drop the sidebar header padding for use in tight spots (e.g. the top bar). */
  compact?: boolean;
};

export function StellaBrandMark({ compact = false }: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={compact ? styles.rootCompact : styles.root}>
      <Image
        source={STELLA_LOGO}
        style={compact ? styles.logoCompact : styles.logo}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      <Text style={compact ? styles.wordmarkCompact : styles.wordmark}>
        Stella
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      paddingBottom: 20,
      paddingHorizontal: 20,
    },
    rootCompact: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
    },
    logo: {
      height: 28,
      opacity: 1,
      width: 28,
    },
    logoCompact: {
      height: 26,
      opacity: 1,
      width: 26,
    },
    wordmark: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
    wordmarkCompact: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
  });
