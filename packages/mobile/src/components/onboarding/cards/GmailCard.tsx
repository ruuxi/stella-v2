/**
 * "Connect Gmail", right after the account step (signed-in users only).
 *
 * Gmail is an account-level connection, so connecting it here connects it
 * for Stella everywhere. Connect opens the account's hosted Google page;
 * the card then watches the connection status (on a short poll, and again
 * whenever the app comes back to the foreground) and flips to Connected
 * once Google is done.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { useT } from "../../../i18n";
import { getBackendClient } from "../../../lib/backend";
import { notifySuccess, tapLight } from "../../../lib/haptics";
import { useAppVisible } from "../../../lib/use-app-visible";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { useColors } from "../../../theme/theme-context";
import { Icon } from "../../Icon";
import { fadeEntering } from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SecondaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";

const GMAIL_CONNECTOR_ID = "gmail";
const STATUS_POLL_MS = 3000;

type Phase = "idle" | "opening" | "waiting" | "connected" | "error";

type GmailCardProps = {
  active: boolean;
  answered: "done" | "skipped" | undefined;
  onAnswer: (answer: "done" | "skipped") => void;
};

const readConnected = async (): Promise<boolean> => {
  const result = await getBackendClient().call("integrations.status", {
    id: GMAIL_CONNECTOR_ID,
  });
  return result.connected;
};

export function GmailCard({ active, answered, onAnswer }: GmailCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const appVisible = useAppVisible();
  const [phase, setPhase] = useState<Phase>("idle");

  // Already connected (another device, an earlier run): say so up front.
  useEffect(() => {
    if (answered) return;
    let cancelled = false;
    void readConnected()
      .then((connected) => {
        if (!cancelled && connected) {
          setPhase((current) => (current === "idle" ? "connected" : current));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [answered]);

  // After the Google page opens, watch for the connection to land.
  useEffect(() => {
    if (answered || phase !== "waiting" || !appVisible) return;
    let cancelled = false;
    const check = () => {
      void readConnected()
        .then((connected) => {
          if (cancelled || !connected) return;
          notifySuccess();
          setPhase("connected");
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [answered, appVisible, phase]);

  const connect = useCallback(async () => {
    tapLight();
    setPhase("opening");
    try {
      const { url } = await getBackendClient().call("integrations.connectLink", {
        id: GMAIL_CONNECTOR_ID,
      });
      await Linking.openURL(url);
      setPhase("waiting");
    } catch {
      setPhase("error");
    }
  }, []);

  if (answered) {
    return answered === "done" ? (
      <SettledCard
        icon="check"
        tone="success"
        title={t("mobile.onboarding.gmail.settledTitle")}
      />
    ) : (
      <SettledCard icon="mail" title={t("mobile.onboarding.gmail.settledSkippedTitle")} />
    );
  }

  const connected = phase === "connected";

  return (
    <OnboardingCard>
      <View style={styles.header}>
        <View style={styles.mark}>
          <GmailMark size={22} />
        </View>
        <View style={styles.flex}>
          <Text style={cardStyles.title}>{t("mobile.onboarding.gmail.title")}</Text>
          {connected ? (
            <Animated.View entering={fadeEntering(0, 220)} style={styles.connectedRow}>
              <Icon name="check" size={13} color={colors.ok} weight="bold" />
              <Text style={styles.connectedText}>{t("mobile.onboarding.gmail.connected")}</Text>
            </Animated.View>
          ) : null}
        </View>
      </View>
      <Text style={cardStyles.body}>{t("mobile.onboarding.gmail.body")}</Text>
      {phase === "error" ? (
        <Text style={[cardStyles.body, styles.error]} accessibilityRole="alert">
          {t("mobile.onboarding.gmail.error")}
        </Text>
      ) : null}
      <View style={cardStyles.actions}>
        {connected ? (
          <PrimaryAction
            label={t("mobile.common.continue")}
            onPress={() => onAnswer("done")}
            disabled={!active}
            style={styles.flex}
          />
        ) : (
          <>
            <PrimaryAction
              label={
                phase === "waiting"
                  ? t("mobile.onboarding.gmail.waiting")
                  : t("mobile.onboarding.gmail.connect")
              }
              icon="mail"
              onPress={() => void connect()}
              busy={phase === "opening"}
              disabled={!active}
              style={styles.flex}
            />
            <SecondaryAction
              label={t("mobile.onboarding.gmail.skip")}
              onPress={() => onAnswer("skipped")}
              disabled={!active}
            />
          </>
        )}
      </View>
    </OnboardingCard>
  );
}

/** Gmail's mark, fitted to a 24px box. */
function GmailMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G transform="translate(0 3) scale(0.272727) translate(-52 -42)">
        <Path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <Path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <Path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <Path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <Path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </G>
    </Svg>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
    },
    mark: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderCurve: "continuous",
      borderRadius: 12,
      height: 40,
      justifyContent: "center",
      width: 40,
    },
    connectedRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      marginTop: 2,
    },
    connectedText: {
      color: colors.ok,
      fontFamily: fonts.sans.medium,
      fontSize: 13.5,
    },
    error: {
      color: colors.danger,
    },
  });
