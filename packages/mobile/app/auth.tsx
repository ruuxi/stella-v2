import { useEffect, useMemo, useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable, StyleSheet, Text } from "react-native";
import { authClient } from "../src/lib/auth-client";
import { type Colors } from "../src/theme/colors";
import { useColors } from "../src/theme/theme-context";
import { fonts } from "../src/theme/fonts";
import { loadLastMainTabHref } from "../src/lib/last-main-tab";
import { useT } from "../src/i18n";

type CallbackError = {
  /** Catalog key for the user-facing message. */
  messageKey: string;
  retryable: boolean;
};

const readCallbackError = (error: unknown): CallbackError => {
  const message = error instanceof Error ? error.message : "";

  if (
    message === "Invalid token"
    || message === "Token expired"
    || message === "Session expired"
  ) {
    return {
      messageKey: "mobile.authCallback.linkExpired",
      retryable: false,
    };
  }

  return {
    messageKey: "mobile.authCallback.genericFailure",
    retryable: true,
  };
};

export default function AuthCallbackScreen() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ ott?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<CallbackError | null>(null);

  useEffect(() => {
    const token = params.ott;
    if (!token) {
      setError({
        messageKey: "mobile.authCallback.invalidLink",
        retryable: false,
      });
      return;
    }

    let cancelled = false;
    setError(null);

    const verify = async () => {
      try {
        // Exchange the one-time-token for session cookies.
        // expoClient's onSuccess hook stores the cookies in SecureStore
        // and notifies the session signal automatically.
        await authClient.$fetch("/cross-domain/one-time-token/verify", {
          method: "POST",
          body: { token },
        });

        if (cancelled) return;
        router.replace(await loadLastMainTabHref());
      } catch (error) {
        if (cancelled) return;
        setError(readCallbackError(error));
      }
    };

    void verify();

    return () => {
      cancelled = true;
    };
  }, [attempt, params.ott, router]);

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>{t("mobile.authCallback.failedTitle")}</Text>
        <Text style={styles.body}>{t(error.messageKey)}</Text>
        <Pressable
          onPress={() => {
            if (error.retryable) {
              setAttempt((current) => current + 1);
              return;
            }

            router.replace("/login");
          }}
          style={({ pressed }) => [
            styles.button,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonText}>
            {error.retryable
              ? t("mobile.common.tryAgain")
              : t("mobile.authCallback.backToSignIn")}
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>{t("mobile.authCallback.signingInTitle")}</Text>
      <Text style={styles.body}>{t("mobile.authCallback.signingInBody")}</Text>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 30,
    letterSpacing: -1.5,
    textAlign: "center",
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 16,
    letterSpacing: -0.3,
    lineHeight: 24,
    textAlign: "center",
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 15,
  },
  buttonPressed: {
    backgroundColor: colors.accentHover,
  },
  buttonText: {
    color: colors.accentForeground,
    fontFamily: fonts.sans.semiBold,
    fontSize: 16,
    letterSpacing: -0.3,
  },
} as const);
