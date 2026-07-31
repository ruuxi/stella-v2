import { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackdrop } from "../src/components/AppBackdrop";
import { ConnectHeroAnimation } from "../src/components/ConnectHeroAnimation";
import { StellaAnimation } from "../src/components/stella-animation";
import { isGuest } from "../src/lib/guest-mode";
import { markOnboardingSeen } from "../src/lib/onboarding";
import { tapLight } from "../src/lib/haptics";
import { type Colors } from "../src/theme/colors";
import { useColors, useTheme } from "../src/theme/theme-context";
import { fonts } from "../src/theme/fonts";
import { fadeHex } from "../src/theme/oklch";

const STEP_COUNT = 3;
const SWAP_MS = 260;

/**
 * Three quiet steps after first sign-in: meet Stella, pick a theme, connect
 * the desktop. Skippable at every point; never shown again once finished.
 */
export default function OnboardingScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const guest = isGuest();

  const [step, setStep] = useState(0);
  const progress = useRef(new Animated.Value(1)).current;

  const goToStep = useCallback(
    (next: number) => {
      tapLight();
      Animated.timing(progress, {
        toValue: 0,
        duration: SWAP_MS / 2,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        setStep(next);
        Animated.timing(progress, {
          toValue: 1,
          duration: SWAP_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }).start();
      });
    },
    [progress],
  );

  const finish = useCallback(
    (destination: "/chat" | "/computer") => {
      tapLight();
      void markOnboardingSeen();
      router.replace(destination);
    },
    [router],
  );

  const stepStyle = useMemo(
    () => ({
      opacity: progress,
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [10, 0],
          }),
        },
      ],
    }),
    [progress],
  );

  return (
    <View style={styles.root}>
      <AppBackdrop />
      <View
        style={[
          styles.content,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 28 },
        ]}
      >
        <View style={styles.skipRow}>
          {step < STEP_COUNT - 1 ? (
            <Pressable
              onPress={() => finish("/chat")}
              hitSlop={10}
              accessibilityLabel="Skip introduction"
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          ) : null}
        </View>

        <Animated.View style={[styles.stage, stepStyle]}>
          {step === 0 ? <WelcomeStep styles={styles} /> : null}
          {step === 1 ? <ThemeStep styles={styles} colors={colors} /> : null}
          {step === 2 ? <ConnectStep styles={styles} guest={guest} /> : null}
        </Animated.View>

        <View style={styles.footer}>
          <View style={styles.dots}>
            {Array.from({ length: STEP_COUNT }).map((_, index) => (
              <View
                key={index}
                style={[styles.dot, index === step && styles.dotActive]}
              />
            ))}
          </View>
          {step < STEP_COUNT - 1 ? (
            <Pressable
              onPress={() => goToStep(step + 1)}
              accessibilityLabel="Continue"
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          ) : (
            <>
              {!guest ? (
                <Pressable
                  onPress={() => finish("/computer")}
                  accessibilityLabel="Pair my computer"
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.primaryButtonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    Pair my computer
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => finish("/chat")}
                accessibilityLabel="Start chatting"
                style={({ pressed }) => [
                  guest ? styles.primaryButton : styles.secondaryButton,
                  pressed &&
                    (guest ? styles.primaryButtonPressed : styles.pressed),
                ]}
              >
                <Text
                  style={
                    guest ? styles.primaryButtonText : styles.secondaryText
                  }
                >
                  Start chatting
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function WelcomeStep({ styles }: { styles: OnboardingStyles }) {
  return (
    <View style={styles.stepBody}>
      <View style={styles.creatureSlot}>
        <StellaAnimation
          width={14}
          height={14}
          displayWidth={120}
          displayHeight={120}
          frameSkip={1}
        />
      </View>
      <Text style={styles.title}>Meet Stella</Text>
      <Text style={styles.body}>
        Ask anything, talk things through, or hand off real work — Stella
        answers here and can act on your computer.
      </Text>
    </View>
  );
}

function ThemeStep({
  styles,
  colors,
}: {
  styles: OnboardingStyles;
  colors: Colors;
}) {
  const { theme: activeTheme, setThemeId, themes, isDark } = useTheme();
  return (
    <View style={styles.stepBody}>
      <Text style={styles.title}>Make it yours</Text>
      <Text style={styles.body}>
        Pick a theme. You can change it any time in Settings.
      </Text>
      <View style={styles.themeDots}>
        {themes.map((th) => {
          const previewDark = th.forcedMode
            ? th.forcedMode === "dark"
            : isDark;
          const preview = previewDark ? th.dark : th.light;
          const isActive = th.id === activeTheme.id;
          return (
            <Pressable
              key={th.id}
              onPress={() => {
                tapLight();
                setThemeId(th.id);
              }}
              accessibilityLabel={`Use ${th.name} theme`}
              accessibilityState={{ selected: isActive }}
              style={[
                styles.themeDotOuter,
                isActive && { borderColor: colors.accent },
              ]}
            >
              <View
                style={[
                  styles.themeDotSwatch,
                  {
                    backgroundColor: preview.background,
                    borderColor: preview.border,
                  },
                ]}
              >
                <View
                  style={[
                    styles.themeDotAccent,
                    { backgroundColor: preview.accent },
                  ]}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.themeName}>{activeTheme.name}</Text>
    </View>
  );
}

function ConnectStep({
  styles,
  guest,
}: {
  styles: OnboardingStyles;
  guest: boolean;
}) {
  return (
    <View style={styles.stepBody}>
      <ConnectHeroAnimation />
      <Text style={styles.title}>Your computer, anywhere</Text>
      <Text style={styles.body}>
        {guest
          ? "Sign in later to pair Stella on your computer — then ask your phone to browse, manage files, and run tasks at home."
          : "Pair once with the Stella desktop app and your phone can ask it to browse, manage files, and run tasks — even from across town."}
      </Text>
    </View>
  );
}

type OnboardingStyles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      flex: 1,
      paddingHorizontal: 28,
    },
    skipRow: {
      alignItems: "flex-end",
      height: 24,
    },
    skipText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    pressed: {
      opacity: 0.7,
    },
    stage: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    stepBody: {
      alignItems: "center",
      gap: 10,
    },
    creatureSlot: {
      alignItems: "center",
      height: 120,
      justifyContent: "center",
      marginBottom: 8,
      width: 120,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 30,
      letterSpacing: -1.2,
      textAlign: "center",
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 22,
      maxWidth: 300,
      textAlign: "center",
    },
    themeDots: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
      justifyContent: "center",
      marginTop: 18,
      maxWidth: 320,
    },
    themeDotOuter: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 20,
      borderWidth: 2,
      justifyContent: "center",
      padding: 2,
    },
    themeDotSwatch: {
      alignItems: "center",
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      height: 28,
      justifyContent: "center",
      overflow: "hidden",
      width: 28,
    },
    themeDotAccent: {
      borderRadius: 7,
      height: 14,
      width: 14,
    },
    themeName: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
      marginTop: 4,
    },
    footer: {
      alignItems: "center",
      gap: 16,
    },
    dots: {
      flexDirection: "row",
      gap: 7,
    },
    dot: {
      backgroundColor: fadeHex(colors.text, 0.18),
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    dotActive: {
      backgroundColor: colors.accent,
    },
    primaryButton: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: colors.accent,
      borderRadius: 24,
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: 28,
      paddingVertical: 13,
    },
    primaryButtonPressed: {
      opacity: 0.85,
    },
    primaryButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      letterSpacing: -0.3,
    },
    secondaryButton: {
      alignItems: "center",
      paddingVertical: 6,
    },
    secondaryText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
  } as const);
