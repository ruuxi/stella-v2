/**
 * "Now, how should I look?" — appearance and theme, applied live.
 *
 * The same controls as Settings › Appearance (the system segmented control
 * and the theme swatches). Choices go straight through the theme context,
 * so the backdrop and every surface re-tint as the user taps; "Keep the
 * default" puts back what was there when the card arrived.
 */
import { useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { resolveThemeColors } from "@stella/theme";
import { useT } from "../../../i18n";
import { selectionTick, tapLight } from "../../../lib/haptics";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import {
  useColors,
  useTheme,
  type Theme,
  type ThemePreference,
} from "../../../theme/theme-context";
import { SegmentedControl } from "../../SegmentedControl";
import {
  fadeEntering,
  SPRING_SNAPPY,
  SpringPressable,
  useSpringFlag,
} from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SecondaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";

const APPEARANCE: { value: ThemePreference; labelKey: string }[] = [
  { value: "system", labelKey: "mobile.settings.appearance.system" },
  { value: "light", labelKey: "mobile.settings.appearance.light" },
  { value: "dark", labelKey: "mobile.settings.appearance.dark" },
];

const SWATCH = 44;

type ThemeCardProps = {
  active: boolean;
  answered: "done" | "skipped" | undefined;
  onAnswer: (answer: "done" | "skipped") => void;
};

export function ThemeCard({ active, answered, onAnswer }: ThemeCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const {
    preference,
    setPreference,
    selectedThemeId,
    setThemeId,
    themes,
    isDark,
  } = useTheme();
  const initialRef = useRef({ preference, themeId: selectedThemeId });
  const selected = themes.find((theme) => theme.id === selectedThemeId);
  const modeLabel = t(
    APPEARANCE.find((option) => option.value === preference)?.labelKey ??
      "mobile.settings.appearance.system",
  );

  if (answered) {
    return (
      <SettledCard
        leading={selected ? <ThemeSwatch theme={selected} isDark={isDark} size={32} /> : undefined}
        icon="eye"
        title={selected?.name ?? ""}
        description={modeLabel}
      />
    );
  }

  const changed =
    preference !== initialRef.current.preference ||
    selectedThemeId !== initialRef.current.themeId;

  return (
    <OnboardingCard>
      <View style={styles.block}>
        <Text style={cardStyles.label}>{t("mobile.onboarding.theme.appearance")}</Text>
        <SegmentedControl<ThemePreference>
          accessibilityLabel={t("mobile.onboarding.theme.appearance")}
          value={preference}
          disabled={!active}
          onChange={(next) => {
            tapLight();
            setPreference(next);
          }}
          options={APPEARANCE.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      </View>

      <View style={styles.block}>
        <Text style={cardStyles.label}>{t("mobile.onboarding.theme.themes")}</Text>
        <View style={styles.grid}>
          {themes.map((theme) => {
            const isActive = theme.id === selectedThemeId;
            return (
              <SpringPressable
                key={theme.id}
                onPress={() => {
                  if (isActive) return;
                  selectionTick();
                  setThemeId(theme.id);
                }}
                disabled={!active}
                pressScale={0.9}
                accessibilityRole="radio"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={t("mobile.settings.useThemeLabel", { name: theme.name })}
              >
                <SwatchRing selected={isActive}>
                  <ThemeSwatch theme={theme} isDark={isDark} size={SWATCH - 8} />
                </SwatchRing>
              </SpringPressable>
            );
          })}
        </View>
        <Animated.Text
          key={selectedThemeId}
          entering={fadeEntering(0, 200)}
          style={styles.themeName}
        >
          {selected?.name ?? ""}
        </Animated.Text>
      </View>

      <View style={cardStyles.actions}>
        <PrimaryAction
          label={t("mobile.onboarding.theme.confirm")}
          onPress={() => onAnswer(changed ? "done" : "skipped")}
          disabled={!active}
          style={styles.flex}
        />
        {changed ? (
          <SecondaryAction
            label={t("mobile.onboarding.theme.reset")}
            onPress={() => {
              setPreference(initialRef.current.preference);
              setThemeId(initialRef.current.themeId);
              onAnswer("skipped");
            }}
            disabled={!active}
          />
        ) : null}
      </View>
    </OnboardingCard>
  );
}

function SwatchRing({
  selected,
  children,
}: {
  selected: boolean;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const on = useSpringFlag(selected, SPRING_SNAPPY);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: on.value,
    transform: [{ scale: 0.82 + 0.18 * on.value }],
  }));
  return (
    <View style={styles.ringSlot}>
      <Animated.View style={[styles.ring, ringStyle]} />
      {children}
    </View>
  );
}

/** A theme at a glance: its canvas, its edge, its primary. */
export function ThemeSwatch({
  theme,
  isDark,
  size,
}: {
  theme: Theme;
  isDark: boolean;
  size: number;
}) {
  const preview = resolveThemeColors(theme, isDark).colors;
  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: preview.background,
        borderColor: preview.border,
        borderRadius: size / 2,
        borderWidth: StyleSheet.hairlineWidth,
        height: size,
        justifyContent: "center",
        overflow: "hidden",
        width: size,
      }}
    >
      <View
        style={{
          backgroundColor: preview.primary,
          borderRadius: size / 4,
          height: size / 2,
          width: size / 2,
        }}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    block: { gap: 10 },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "flex-start",
    },
    ringSlot: {
      alignItems: "center",
      height: SWATCH,
      justifyContent: "center",
      width: SWATCH,
    },
    ring: {
      ...StyleSheet.absoluteFill,
      borderColor: colors.accent,
      borderRadius: SWATCH / 2,
      borderWidth: 2,
    },
    themeName: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
  });
