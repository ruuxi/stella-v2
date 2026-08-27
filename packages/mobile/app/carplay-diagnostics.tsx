import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { tapLight } from "../src/lib/haptics";
import { type Colors } from "../src/theme/colors";
import { useColors } from "../src/theme/theme-context";
import { fonts } from "../src/theme/fonts";
import { useI18n } from "../src/i18n";

const DIAGNOSTICS_KEY = "StellaCarPlayDiagnostics";

function readDiagnostics(): string[] {
  if (Platform.OS !== "ios") return [];
  try {
    const value = Settings.get(DIAGNOSTICS_KEY) as unknown;
    if (!Array.isArray(value)) return [];
    return (value as unknown[]).map((line) => String(line));
  } catch {
    return [];
  }
}

export default function CarPlayDiagnosticsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { t, tPlural } = useI18n();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    setLines(readDiagnostics());
    setCopied(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const copyAll = useCallback(async () => {
    tapLight();
    await Clipboard.setStringAsync(
      lines.length > 0
        ? lines.join("\n")
        : t("mobile.carPlayDiagnostics.clipboardEmpty"),
    );
    setCopied(true);
  }, [lines, t]);

  const clearAll = useCallback(() => {
    tapLight();
    if (Platform.OS === "ios") {
      try {
        Settings.set({ [DIAGNOSTICS_KEY]: [] });
      } catch {

      }
    }
    refresh();
  }, [refresh]);

  const newestFirst = useMemo(() => [...lines].reverse(), [lines]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            tapLight();
            router.back();
          }}
          accessibilityLabel={t("mobile.common.goBack")}
          hitSlop={12}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backText}>{t("mobile.common.backChevron")}</Text>
        </Pressable>
        <Text style={styles.title}>
          {t("mobile.carPlayDiagnostics.title")}
        </Text>
        {}
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.subtitle}>
        {tPlural("mobile.carPlayDiagnostics.subtitle", lines.length)}
      </Text>

      <View style={styles.actions}>
        <Pressable
          onPress={() => void copyAll()}
          accessibilityLabel={t("mobile.carPlayDiagnostics.copyAllLabel")}
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>
            {copied
              ? t("mobile.carPlayDiagnostics.copied")
              : t("mobile.carPlayDiagnostics.copyAll")}
          </Text>
        </Pressable>
        <Pressable
          onPress={refresh}
          accessibilityLabel={t("mobile.carPlayDiagnostics.refreshLabel")}
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>
            {t("mobile.carPlayDiagnostics.refresh")}
          </Text>
        </Pressable>
        <Pressable
          onPress={clearAll}
          accessibilityLabel={t("mobile.carPlayDiagnostics.clearLabel")}
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={[styles.actionText, styles.actionDanger]}>
            {t("mobile.carPlayDiagnostics.clear")}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.log}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {newestFirst.length === 0 ? (
          <Text style={styles.empty}>
            {t("mobile.carPlayDiagnostics.empty")}
          </Text>
        ) : (
          newestFirst.map((line, i) => (
            <Text key={`${i}-${line.slice(0, 24)}`} style={styles.line} selectable>
              {line}
            </Text>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 16,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    backButton: {
      paddingVertical: 4,
      minWidth: 64,
    },
    backText: {
      fontFamily: fonts.sans.medium,
      fontSize: 16,
      color: colors.accent,
    },
    title: {
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      color: colors.textStrong,
    },
    headerSpacer: {
      minWidth: 64,
    },
    subtitle: {
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      color: colors.textMuted,
      marginBottom: 12,
    },
    actions: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 12,
    },
    actionButton: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    actionText: {
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      color: colors.text,
    },
    actionDanger: {
      color: colors.textMuted,
    },
    pressed: {
      opacity: 0.6,
    },
    log: {
      flex: 1,
    },
    line: {
      fontFamily: fonts.mono.regular,
      fontSize: 11,
      lineHeight: 16,
      color: colors.text,
      marginBottom: 6,
    },
    empty: {
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      color: colors.textMuted,
      marginTop: 24,
      textAlign: "center",
    },
  });
