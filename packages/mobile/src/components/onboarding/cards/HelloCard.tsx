/**
 * The first message's card: what Stella is in three lines, the way in, and
 * the legal line (Terms / Privacy open in a sheet, like sign-in).
 */
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useT } from "../../../i18n";
import type { LegalDocument } from "../../../lib/legal-text";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { useColors } from "../../../theme/theme-context";
import { Icon, type IconName } from "../../Icon";
import { LegalSheet } from "../../LegalSheet";
import { rowEntering } from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";

const PILLARS: { icon: IconName; key: string }[] = [
  { icon: "sparkles", key: "done" },
  { icon: "clock", key: "background" },
  { icon: "check", key: "asks" },
];

type HelloCardProps = {
  active: boolean;
  answered: boolean;
  /** Plays the staggered entrance (a fresh message, not a resumed one). */
  fresh: boolean;
  onContinue: () => void;
};

export function HelloCard({ active, answered, fresh, onContinue }: HelloCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [legal, setLegal] = useState<LegalDocument | null>(null);

  if (answered) {
    return (
      <SettledCard
        icon="sparkles"
        title={t("mobile.onboarding.hello.settledTitle")}
        description={PILLARS.map((pillar) =>
          t(`mobile.onboarding.hello.pillars.${pillar.key}.title`),
        ).join(" · ")}
      />
    );
  }

  return (
    <OnboardingCard>
      <View style={styles.pillars}>
        {PILLARS.map((pillar, index) => (
          <Animated.View
            key={pillar.key}
            entering={fresh ? rowEntering(index, 260) : undefined}
            style={styles.pillar}
          >
            <View style={styles.pillarIcon}>
              <Icon name={pillar.icon} size={15} color={colors.accent} weight="semibold" />
            </View>
            <View style={styles.pillarText}>
              <Text style={styles.pillarTitle}>
                {t(`mobile.onboarding.hello.pillars.${pillar.key}.title`)}
              </Text>
              <Text style={cardStyles.body}>
                {t(`mobile.onboarding.hello.pillars.${pillar.key}.body`)}
              </Text>
            </View>
          </Animated.View>
        ))}
      </View>

      <PrimaryAction
        label={t("mobile.onboarding.hello.cta")}
        onPress={onContinue}
        disabled={!active}
      />

      <Text style={styles.legal}>
        {t("mobile.login.legalPrefix")}
        <Text style={styles.legalLink} onPress={() => setLegal("terms")}>
          {t("mobile.login.legalTerms")}
        </Text>
        {t("mobile.login.legalConjunction")}
        <Text style={styles.legalLink} onPress={() => setLegal("privacy")}>
          {t("mobile.login.legalPrivacy")}
        </Text>
        {t("mobile.login.legalSuffix")}
      </Text>
      <LegalSheet document={legal} onClose={() => setLegal(null)} />
    </OnboardingCard>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pillars: { gap: 14 },
    pillar: { alignItems: "flex-start", flexDirection: "row", gap: 12 },
    pillarIcon: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderCurve: "continuous",
      borderRadius: 10,
      height: 30,
      justifyContent: "center",
      marginTop: 1,
      width: 30,
    },
    pillarText: { flex: 1, gap: 2 },
    pillarTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.25,
    },
    legal: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
    },
    legalLink: {
      textDecorationLine: "underline",
    },
  });
