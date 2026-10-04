/**
 * The finale: a few starters that open the real chat with the request
 * already sent, and "Start chatting" to open it empty.
 */
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useT } from "../../../i18n";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { useColors } from "../../../theme/theme-context";
import { Icon, type IconName } from "../../Icon";
import { rowEntering, SpringPressable } from "../motion";
import { OnboardingCard, PrimaryAction, useCardStyles } from "../OnboardingCard";

const STARTERS: { key: string; icon: IconName }[] = [
  { key: "plan", icon: "clock" },
  { key: "gift", icon: "sparkles" },
  { key: "remind", icon: "message-square" },
  { key: "explain", icon: "search" },
];

type ReadyCardProps = {
  active: boolean;
  fresh: boolean;
  onStart: (prompt?: string) => void;
};

export function ReadyCard({ active, fresh, onStart }: ReadyCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <OnboardingCard>
      <Text style={cardStyles.label}>{t("mobile.onboarding.ready.startersLabel")}</Text>
      <View style={styles.starters}>
        {STARTERS.map((starter, index) => {
          const title = t(`mobile.onboarding.ready.starters.${starter.key}.title`);
          const prompt = t(`mobile.onboarding.ready.starters.${starter.key}.prompt`);
          return (
            <Animated.View
              key={starter.key}
              entering={fresh ? rowEntering(index, 200) : undefined}
            >
              <SpringPressable
                onPress={() => onStart(prompt)}
                disabled={!active}
                accessibilityRole="button"
                accessibilityLabel={prompt}
                pressScale={0.975}
                style={styles.starter}
              >
                <View style={styles.starterIcon}>
                  <Icon name={starter.icon} size={14} color={colors.accent} weight="semibold" />
                </View>
                <View style={styles.starterText}>
                  <Text style={styles.starterTitle} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={styles.starterPrompt} numberOfLines={2}>
                    {prompt}
                  </Text>
                </View>
                <Icon name="arrow-up-right" size={13} color={colors.textMuted} />
              </SpringPressable>
            </Animated.View>
          );
        })}
      </View>
      <PrimaryAction
        label={t("mobile.onboarding.ready.start")}
        onPress={() => onStart()}
        disabled={!active}
      />
    </OnboardingCard>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    starters: { gap: 8 },
    starter: {
      alignItems: "center",
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 11,
      paddingHorizontal: 12,
      paddingVertical: 11,
    },
    starterIcon: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 9,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    starterText: { flex: 1, gap: 1, minWidth: 0 },
    starterTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14.5,
      letterSpacing: -0.2,
    },
    starterPrompt: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      lineHeight: 17.5,
    },
  });
