import { useMemo } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";
import { hasMobileConfig } from "../src/config/env";
import { type Colors } from "../src/theme/colors";
import { useColors } from "../src/theme/theme-context";
import { fonts } from "../src/theme/fonts";
import { useT } from "../src/i18n";

export default function Index() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!hasMobileConfig) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>{t("mobile.boot.missingConfigTitle")}</Text>
        <Text style={styles.body}>{t("mobile.boot.missingConfigBody")}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>{t("mobile.boot.checkingSessionTitle")}</Text>
      <Text style={styles.body}>{t("mobile.boot.checkingSessionBody")}</Text>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 12,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 34,
    letterSpacing: -1.5,
    lineHeight: 38,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 16,
    letterSpacing: -0.3,
    lineHeight: 24,
  },
} as const);
