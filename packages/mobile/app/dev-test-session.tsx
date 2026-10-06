import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { adoptDevTestSession } from "../src/lib/dev-test-session";
import { type Colors } from "../src/theme/colors";
import { useColors } from "../src/theme/theme-context";
import { fonts } from "../src/theme/fonts";

type Status =
  | { kind: "pending" }
  | { kind: "signed-in"; email: string }
  | { kind: "refused"; message: string };

export default function DevTestSessionScreen() {
  const { ott } = useLocalSearchParams<{ ott?: string }>();
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [status, setStatus] = useState<Status>({ kind: "pending" });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    adoptDevTestSession(typeof ott === "string" ? ott : "")
      .then((email) => {
        setStatus({ kind: "signed-in", email });
        router.replace("/");
      })
      .catch((error: unknown) => {
        setStatus({
          kind: "refused",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [ott, router]);

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title} accessibilityRole="header">
        Test-account sign-in
      </Text>
      <Text
        style={styles.body}
        testID={`dev-test-session-${status.kind}`}
        accessibilityLabel={`dev-test-session-${status.kind}`}
      >
        {status.kind === "pending"
          ? "Signing in…"
          : status.kind === "signed-in"
            ? `Signed in as ${status.email}`
            : status.message}
      </Text>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
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
      fontSize: 28,
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      lineHeight: 24,
    },
  } as const);
