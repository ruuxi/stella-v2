/**
 * Self-serve CarPlay field-debugging surface.
 *
 * The CarPlay stack (native scene delegate, patched RNCarPlay module, and the
 * JS session) writes breadcrumbs to the `StellaCarPlayDiagnostics` key in
 * NSUserDefaults. Those lines are the only way to diagnose head-unit failures
 * that happen in the car — Console.app only shows LIVE logs over a cable, but
 * the user-defaults store persists. This screen (Account → CarPlay
 * diagnostics) shows the stored lines and copies them to the clipboard so a
 * field report is one screenshot or paste away.
 */

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
      lines.length > 0 ? lines.join("\n") : "(no CarPlay diagnostics recorded)",
    );
    setCopied(true);
  }, [lines]);

  const clearAll = useCallback(() => {
    tapLight();
    if (Platform.OS === "ios") {
      try {
        Settings.set({ [DIAGNOSTICS_KEY]: [] });
      } catch {
        /* ignore */
      }
    }
    refresh();
  }, [refresh]);

  // Newest last in the store; show newest FIRST so the most recent drive is
  // at the top without scrolling.
  const newestFirst = useMemo(() => [...lines].reverse(), [lines]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            tapLight();
            router.back();
          }}
          accessibilityLabel="Go back"
          hitSlop={12}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>CarPlay diagnostics</Text>
        {/* Spacer balances the back button so the title centers. */}
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.subtitle}>
        Breadcrumbs from the CarPlay connection ({lines.length} lines, newest
        first). Copy and send these after anything misbehaves in the car.
      </Text>

      <View style={styles.actions}>
        <Pressable
          onPress={() => void copyAll()}
          accessibilityLabel="Copy all diagnostics"
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{copied ? "Copied ✓" : "Copy all"}</Text>
        </Pressable>
        <Pressable
          onPress={refresh}
          accessibilityLabel="Refresh diagnostics"
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>Refresh</Text>
        </Pressable>
        <Pressable
          onPress={clearAll}
          accessibilityLabel="Clear diagnostics"
          style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
        >
          <Text style={[styles.actionText, styles.actionDanger]}>Clear</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.log}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {newestFirst.length === 0 ? (
          <Text style={styles.empty}>
            No CarPlay diagnostics recorded yet. Connect to CarPlay once, then
            come back here.
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
