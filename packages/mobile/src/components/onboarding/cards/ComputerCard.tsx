/**
 * "Your computer, from your pocket" — pairing inside the conversation.
 *
 * A small illustration (a task hopping from the phone over to the computer)
 * explains the idea, and the button opens the same pairing sheet Settings
 * uses (QR scan or code). On success the card celebrates and settles to
 * "Connected to <computer>". Already paired, it starts out connected.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useT } from "../../../i18n";
import { shouldRunContinuousAnimation } from "../../../lib/continuous-animation";
import { tapLight } from "../../../lib/haptics";
import { listExecutionDevices } from "../../../lib/execution-placement";
import {
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "../../../lib/phone-access";
import { useAppVisible } from "../../../lib/use-app-visible";
import { type Colors } from "../../../theme/colors";
import { useColors } from "../../../theme/theme-context";
import { StellaStarGlyph } from "../../AgentActivityGlyph";
import { Icon } from "../../Icon";
import { PairPhoneSheet } from "../../PairPhoneSheet";
import { SPRING_SNAPPY, useSpringFlag, rowEntering } from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SecondaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";

const ART_WIDTH = 240;
const ART_HEIGHT = 72;
/** Phone centre → computer centre, the arc the task travels along. */
const FROM_X = 34;
const TO_X = 190;
const BASE_Y = 58;
const ARC_LIFT = 30;
/** Device centres sit on this line; the arc rises from it. */
const ARC_Y = BASE_Y - 18;
const HOP_MS = 2600;
const CHIP = 18;

type ComputerCardProps = {
  active: boolean;
  answered: "done" | "skipped" | undefined;
  onScreen: boolean;
  /**
   * Pairing belongs to an account, so a signed-out user is offered sign-in first (the
   * conversation resumes on this message when they come back).
   */
  canPair: boolean;
  onSignIn: () => void;
  onAnswer: (answer: "done" | "skipped") => void;
};

export function ComputerCard({
  active,
  answered,
  onScreen,
  canPair,
  onSignIn,
  onAnswer,
}: ComputerCardProps) {
  const t = useT();
  const cardStyles = useCardStyles();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [access, setAccess] = useState<StoredPhoneAccess | null>(null);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState(false);

  const resolveName = useCallback(
    async (next: StoredPhoneAccess) => {
      try {
        const devices = await listExecutionDevices();
        const device = devices.find(
          (entry) => entry.deviceId === next.desktopDeviceId,
        );
        setComputerName(device?.label?.trim() || null);
      } catch {
        setComputerName(null);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void getPreferredPhoneAccess()
      .then((stored) => {
        if (cancelled || !stored) return;
        setAccess(stored);
        void resolveName(stored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [resolveName]);

  const connected = access !== null;
  const name = computerName ?? t("mobile.computer.defaultDeviceLabel");

  const handlePaired = useCallback(
    (next: StoredPhoneAccess) => {
      // `pairWithCode` already played the success notification.
      setSheetOpen(false);
      setAccess(next);
      setJustPaired(true);
      void resolveName(next);
    },
    [resolveName],
  );

  // Let the celebration land before the conversation moves on.
  useEffect(() => {
    if (!justPaired || !active) return;
    const timer = setTimeout(() => onAnswer("done"), 1500);
    return () => clearTimeout(timer);
  }, [active, justPaired, onAnswer]);

  if (answered) {
    return connected ? (
      <SettledCard
        icon="monitor"
        tone="success"
        title={t("mobile.onboarding.computer.connectedTo", { name })}
        description={t("mobile.onboarding.computer.settledConnectedDesc")}
      />
    ) : (
      <SettledCard
        icon="monitor"
        title={t("mobile.onboarding.computer.settledSkippedTitle")}
        description={t("mobile.onboarding.computer.settledSkippedDesc")}
      />
    );
  }

  return (
    <OnboardingCard>
      <HopArt
        connected={connected}
        running={active && onScreen && !connected}
      />
      <Text style={cardStyles.title}>
        {connected
          ? t("mobile.onboarding.computer.connectedTo", { name })
          : t("mobile.onboarding.computer.title")}
      </Text>
      <Text style={cardStyles.body}>
        {connected
          ? t("mobile.onboarding.computer.connectedBody")
          : t("mobile.onboarding.computer.body")}
      </Text>
      {!connected ? (
        <View style={styles.points}>
          {(["point1", "point2", "point3"] as const).map((key, index) => (
            <Animated.View key={key} entering={rowEntering(index, 220)} style={styles.point}>
              <StellaGlyphDot />
              <Text style={cardStyles.body}>{t(`mobile.onboarding.computer.${key}`)}</Text>
            </Animated.View>
          ))}
        </View>
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
                canPair
                  ? t("mobile.onboarding.computer.pair")
                  : t("mobile.onboarding.computer.signInToPair")
              }
              icon={canPair ? "camera" : "user"}
              onPress={() => {
                tapLight();
                if (canPair) setSheetOpen(true);
                else onSignIn();
              }}
              disabled={!active}
              style={styles.flex}
            />
            <SecondaryAction
              label={t("mobile.onboarding.computer.later")}
              onPress={() => onAnswer("skipped")}
              disabled={!active}
            />
          </>
        )}
      </View>
      {!connected ? (
        <Text style={[cardStyles.body, styles.hint]}>{canPair
            ? t("mobile.onboarding.computer.hint")
            : t("mobile.onboarding.computer.guestHint")}</Text>
      ) : null}
      <PairPhoneSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onPaired={handlePaired}
      />
    </OnboardingCard>
  );
}

function StellaGlyphDot() {
  const colors = useColors();
  return (
    <View style={styles.pointGlyph}>
      <StellaStarGlyph size={11} color={colors.accent} />
    </View>
  );
}

/**
 * Phone on the left, computer on the right, and a task chip hopping along
 * the arc between them. Once connected the arc goes solid and the computer
 * shows a check. The hop loops only while it is on screen, in the
 * foreground and motion is allowed.
 */
function HopArt({ connected, running }: { connected: boolean; running: boolean }) {
  const colors = useColors();
  const art = useMemo(() => makeArtStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();
  const appVisible = useAppVisible();
  const loop = shouldRunContinuousAnimation({
    logicalActive: running,
    appVisible,
    reducedMotion,
  });
  const clock = useSharedValue(0);
  const settle = useSpringFlag(connected, SPRING_SNAPPY);

  useEffect(() => {
    if (!loop) {
      cancelAnimation(clock);
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(1, { duration: HOP_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [clock, loop]);

  const chipStyle = useAnimatedStyle(() => {
    // 0–0.62 travel (eased), 0.62–0.8 land and fade, rest offstage.
    const raw = clock.value;
    const travel = Math.min(1, raw / 0.62);
    const eased = travel < 0.5
      ? 4 * travel * travel * travel
      : 1 - Math.pow(-2 * travel + 2, 3) / 2;
    const x = FROM_X + (TO_X - FROM_X) * eased;
    const y = ARC_Y - ARC_LIFT * 4 * eased * (1 - eased);
    const visible = connected
      ? 0
      : raw < 0.06
        ? raw / 0.06
        : raw > 0.62
          ? Math.max(0, 1 - (raw - 0.62) / 0.12)
          : 1;
    return {
      opacity: loop ? visible : 0,
      transform: [
        { translateX: x - CHIP / 2 },
        { translateY: y - CHIP / 2 },
        { scale: 0.8 + 0.25 * Math.sin(Math.PI * eased) },
      ],
    };
  });

  const screenStyle = useAnimatedStyle(() => {
    const raw = clock.value;
    const ping = loop && raw > 0.6 && raw < 0.85 ? Math.sin(((raw - 0.6) / 0.25) * Math.PI) : 0;
    return {
      transform: [{ scale: 1 + 0.05 * ping + 0.03 * settle.value }],
    };
  });
  const glowStyle = useAnimatedStyle(() => {
    const raw = clock.value;
    const ping = loop && raw > 0.6 && raw < 0.85 ? Math.sin(((raw - 0.6) / 0.25) * Math.PI) : 0;
    return { opacity: Math.max(ping * 0.7, settle.value * 0.9) };
  });
  const checkStyle = useAnimatedStyle(() => ({
    opacity: settle.value,
    transform: [{ scale: interpolate(settle.value, [0, 0.7, 1], [0.3, 1.2, 1]) }],
  }));
  const arcSolidStyle = useAnimatedStyle(() => ({ opacity: settle.value }));

  const arc = `M ${FROM_X} ${ARC_Y} Q ${(FROM_X + TO_X) / 2} ${ARC_Y - ARC_LIFT * 2} ${TO_X} ${ARC_Y}`;

  return (
    <View style={art.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={art.canvas}>
        <Svg width={ART_WIDTH} height={ART_HEIGHT} style={StyleSheet.absoluteFill}>
          <Path d={arc} stroke={colors.border} strokeWidth={1.5} strokeDasharray="3 5" fill="none" strokeLinecap="round" />
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, arcSolidStyle]}>
          <Svg width={ART_WIDTH} height={ART_HEIGHT}>
            <Path d={arc} stroke={colors.ok} strokeWidth={1.5} fill="none" strokeLinecap="round" />
          </Svg>
        </Animated.View>

        {/* Phone */}
        <View style={[art.phone, { left: FROM_X - 15 }]}>
          <View style={art.phoneNotch} />
          <View style={art.phoneBubbleRight} />
          <View style={art.phoneBubbleLeft} />
        </View>

        {/* Computer */}
        <Animated.View style={[art.computer, { left: TO_X - 38 }, screenStyle]}>
          <View style={art.screen}>
            <Animated.View style={[StyleSheet.absoluteFill, art.screenGlow, glowStyle]} />
            <Animated.View style={[art.checkBadge, checkStyle]}>
              <Icon name="check" size={12} color={colors.accentForeground} weight="bold" />
            </Animated.View>
          </View>
          <View style={art.base} />
        </Animated.View>

        {/* The task, mid-hop */}
        <Animated.View style={[art.chip, chipStyle]}>
          <StellaStarGlyph size={10} color={colors.accentForeground} />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  points: { gap: 8 },
  point: { alignItems: "flex-start", flexDirection: "row", gap: 9 },
  pointGlyph: { alignItems: "center", height: 21, justifyContent: "center", width: 14 },
  hint: {
    fontSize: 12.5,
    lineHeight: 17,
    textAlign: "center",
  },
});

const makeArtStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { alignItems: "center" },
    canvas: { height: ART_HEIGHT, width: ART_WIDTH },
    phone: {
      backgroundColor: colors.background,
      borderColor: colors.textMuted,
      borderCurve: "continuous",
      borderRadius: 8,
      borderWidth: 1.5,
      gap: 4,
      height: 52,
      paddingHorizontal: 4,
      paddingTop: 4,
      position: "absolute",
      top: BASE_Y - 44,
      width: 30,
    },
    phoneNotch: {
      alignSelf: "center",
      backgroundColor: colors.textMuted,
      borderRadius: 2,
      height: 3,
      marginBottom: 2,
      width: 9,
    },
    phoneBubbleRight: {
      alignSelf: "flex-end",
      backgroundColor: colors.userBubbleFill,
      borderRadius: 3,
      height: 6,
      width: 14,
    },
    phoneBubbleLeft: {
      alignSelf: "flex-start",
      backgroundColor: colors.muted,
      borderRadius: 3,
      height: 6,
      width: 16,
    },
    computer: {
      alignItems: "center",
      position: "absolute",
      top: BASE_Y - 40,
      width: 76,
    },
    screen: {
      alignItems: "center",
      backgroundColor: colors.background,
      borderColor: colors.textMuted,
      borderCurve: "continuous",
      borderRadius: 6,
      borderWidth: 1.5,
      height: 44,
      justifyContent: "center",
      overflow: "hidden",
      width: 66,
    },
    screenGlow: {
      backgroundColor: colors.accentSoft,
    },
    checkBadge: {
      alignItems: "center",
      backgroundColor: colors.ok,
      borderRadius: 11,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    base: {
      backgroundColor: colors.textMuted,
      borderRadius: 2,
      height: 4,
      marginTop: 2,
      width: 82,
    },
    chip: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: CHIP / 2,
      height: CHIP,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.35,
      shadowRadius: 6,
      top: 0,
      width: CHIP,
    },
  });
