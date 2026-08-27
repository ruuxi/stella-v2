import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { getSubscriptionStatusRef } from "../lib/billing-refs";
import {
  setDebugStorefrontOverride,
  useStorefrontEligibility,
} from "../lib/use-storefront-eligibility";
import { useMobileCheckout } from "../lib/use-mobile-checkout";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n";
import { PrimaryButton } from "./PrimaryButton";
import { tapLight } from "../lib/haptics";

const PAID_PLANS = ["go", "pro"];

function formatPrice(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  const dollars = Math.max(0, cents) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function formatDate(ms) {
  if (typeof ms !== "number" || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function SubscriptionSection() {
  const colors = useColors();
  const t = useT();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const status = useQuery(getSubscriptionStatusRef, {});
  const storefront = useStorefrontEligibility();
  const checkout = useMobileCheckout();

  const [justSubscribedPlan, setJustSubscribedPlan] = useState(null);
  const startedPlanRef = useRef(null);

  const debugTapRef = useRef(0);

  const plan = status ? status.plan : "free";
  const signedIn = Boolean(status && status.authenticated && !status.isAnonymous);
  const isPaid = PAID_PLANS.includes(plan);
  const eligible = storefront.status === "eligible";
  const plans = status ? status.plans : null;

  const checkoutPhase = checkout.phase;
  const currentPlan = status ? status.plan : null;
  useEffect(() => {
    if (
      checkoutPhase === "pending" &&
      PAID_PLANS.includes(currentPlan) &&
      currentPlan !== startedPlanRef.current
    ) {
      setJustSubscribedPlan(currentPlan);
      checkout.reset();
    }
  }, [checkoutPhase, currentPlan, checkout]);

  const onDebugCycle = () => {
    if (!__DEV__) return;
    debugTapRef.current += 1;
    if (debugTapRef.current < 3) return;
    debugTapRef.current = 0;
    const next =
      storefront.countryCode === "USA"
        ? "GBR"
        : storefront.countryCode === "GBR"
          ? null
          : "USA";
    setDebugStorefrontOverride(next);
    storefront.refresh();
  };

  const handleSubscribe = (planKey) => {
    tapLight();
    startedPlanRef.current = status ? status.plan : "free";
    setJustSubscribedPlan(null);
    void checkout.startCheckout(planKey, storefront.countryCode);
  };

  const header = (
    <Pressable onPress={onDebugCycle} disabled={!__DEV__}>
      <Text style={styles.sectionLabel}>{t("billing.mobile.sectionTitle")}</Text>
    </Pressable>
  );

  if (status === undefined || storefront.status === "loading") {
    return null;
  }

  if (!signedIn) {
    if (!eligible) return null;
    return (
      <View style={styles.section}>
        {header}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("billing.mobile.chooseHeading")}</Text>
          <Text style={styles.cardSubtitle}>{t("billing.subtitle")}</Text>
          {PAID_PLANS.map((key) => renderPlanRow(key, { subscribe: false }))}
          <PrimaryButton
            label={t("billing.mobile.signInToSubscribe")}
            onPress={() => {
              tapLight();
              router.replace("/login");
            }}
            style={styles.cta}
          />
          <Text style={styles.footnote}>{t("billing.mobile.footnote")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {header}
      <View style={styles.card}>
        {}
        <View style={styles.currentPlanRow}>
          <Text style={styles.currentPlanLabel}>
            {t("billing.mobile.currentPlanLabel")}
          </Text>
          <Text style={styles.currentPlanValue}>
            {t("billing.mobile.planValue", { plan: planLabel(plan) })}
          </Text>
        </View>
        {isPaid ? renderRenewal() : null}

        {justSubscribedPlan ? renderSuccess() : null}

        {isPaid
          ? renderManage()
          : eligible
            ? renderPurchase()
            : null }
      </View>
    </View>
  );

  function planLabel(key) {
    if (plans && plans[key] && plans[key].label) return plans[key].label;
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function renderRenewal() {
    if (!status || !status.currentPeriodEnd) return null;
    const date = formatDate(status.currentPeriodEnd);
    if (!date) return null;
    const label = status.cancelAtPeriodEnd
      ? t("billing.mobile.accessEnds", { date })
      : t("billing.mobile.renews", { date });
    return <Text style={styles.renewal}>{label}</Text>;
  }

  function renderSuccess() {
    return (
      <View style={[styles.banner, styles.bannerSuccess]}>
        <Text style={styles.bannerTitle}>
          {t("billing.mobile.successTitle", { plan: planLabel(justSubscribedPlan) })}
        </Text>
        <Text style={styles.bannerBody}>{t("billing.mobile.successBody")}</Text>
        <Pressable
          onPress={() => {
            tapLight();
            setJustSubscribedPlan(null);
          }}
          style={styles.linkRow}
        >
          <Text style={styles.link}>{t("mobile.common.done")}</Text>
        </Pressable>
      </View>
    );
  }

  function renderManage() {

    if (eligible) {
      return (
        <>
          {checkout.error ? (
            <Text style={styles.errorText}>{checkout.error.message}</Text>
          ) : null}
          <Pressable
            onPress={() => {
              tapLight();
              void checkout.openManage();
            }}
            style={({ pressed }) => [styles.manageRow, pressed && styles.rowPressed]}
          >
            <Text style={styles.manageText}>{t("billing.mobile.manage")}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </>
      );
    }
    return <Text style={styles.footnote}>{t("billing.mobile.manageWebNote")}</Text>;
  }

  function renderPurchase() {
    if (justSubscribedPlan) return null;
    if (checkoutPhase === "pending") {
      return (
        <View style={[styles.banner, styles.bannerPending]}>
          <View style={styles.pendingHeader}>
            <ActivityIndicator size="small" color={colors.text} />
            <Text style={styles.bannerTitle}>{t("billing.mobile.pendingTitle")}</Text>
          </View>
          <Text style={styles.bannerBody}>{t("billing.mobile.pendingBody")}</Text>
          <Pressable
            onPress={() => {
              tapLight();
              checkout.reset();
            }}
            style={styles.linkRow}
          >
            <Text style={styles.link}>{t("billing.mobile.pendingDismiss")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <>
        <Text style={styles.cardTitle}>{t("billing.mobile.chooseHeading")}</Text>
        <Text style={styles.cardSubtitle}>{t("billing.subtitle")}</Text>
        {checkoutPhase === "error" && checkout.error ? (
          <View style={[styles.banner, styles.bannerError]}>
            <Text style={styles.bannerTitle}>
              {checkout.error.code === "CONFLICT"
                ? t("billing.mobile.alreadySubscribedTitle")
                : t("errors.generic")}
            </Text>
            <Text style={styles.bannerBody}>{checkout.error.message}</Text>
            <Pressable
              onPress={() => {
                tapLight();
                checkout.reset();
              }}
              style={styles.linkRow}
            >
              <Text style={styles.link}>{t("billing.mobile.errorRetry")}</Text>
            </Pressable>
          </View>
        ) : null}
        {PAID_PLANS.map((key) => renderPlanRow(key, { subscribe: true }))}
        <Text style={styles.footnote}>{t("billing.mobile.footnote")}</Text>
      </>
    );
  }

  function renderPlanRow(key, opts) {
    const config = plans ? plans[key] : null;
    const priceText = config ? formatPrice(config.monthlyPriceCents) : "";
    const intro =
      config && typeof config.introFirstMonthPriceCents === "number"
        ? formatPrice(config.introFirstMonthPriceCents)
        : null;
    const starting = checkoutPhase === "starting";
    return (
      <View key={key} style={styles.planRow}>
        <View style={styles.planInfo}>
          <Text style={styles.planName}>{planLabel(key)}</Text>
          <Text style={styles.planTagline}>{t(`billing.plans.${key}.tagline`)}</Text>
          <Text style={styles.planPrice}>
            {intro
              ? t("billing.mobile.introLine", { introPrice: intro, price: priceText })
              : t("billing.mobile.perMonth", { price: priceText })}
          </Text>
        </View>
        {opts.subscribe ? (
          <PrimaryButton
            label={
              starting
                ? t("billing.mobile.startingCheckout")
                : t("billing.mobile.subscribe")
            }
            disabled={starting}
            onPress={() => handleSubscribe(key)}
            style={styles.planCta}
          />
        ) : null}
      </View>
    );
  }
}

const makeStyles = (colors) => ({
  section: {
    marginTop: 4,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
    letterSpacing: 0.3,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: colors.surface ?? colors.card ?? "transparent",
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  cardSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    lineHeight: 18,
    marginTop: -6,
  },
  currentPlanRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  currentPlanLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
  },
  currentPlanValue: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  renewal: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    marginTop: -4,
  },
  planRow: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    padding: 12,
  },
  planInfo: {
    flex: 1,
    gap: 2,
  },
  planName: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  planTagline: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
  },
  planPrice: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 14,
    marginTop: 2,
  },
  planCta: {
    minWidth: 108,
  },
  cta: {
    marginTop: 4,
  },
  manageRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  rowPressed: {
    opacity: 0.6,
  },
  manageText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 20,
  },
  banner: {
    borderRadius: 12,
    gap: 6,
    padding: 12,
  },
  bannerSuccess: {
    backgroundColor: colors.successSoft ?? colors.surfaceMuted ?? "transparent",
    borderColor: colors.border,
    borderWidth: 1,
  },
  bannerPending: {
    backgroundColor: colors.surfaceMuted ?? "transparent",
    borderColor: colors.border,
    borderWidth: 1,
  },
  bannerError: {
    backgroundColor: colors.dangerSoft ?? colors.surfaceMuted ?? "transparent",
    borderColor: colors.border,
    borderWidth: 1,
  },
  pendingHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  bannerTitle: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 15,
  },
  bannerBody: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    color: colors.danger ?? colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
  },
  linkRow: {
    paddingVertical: 4,
  },
  link: {
    color: colors.accent ?? colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 14,
  },
  footnote: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 12,
    lineHeight: 16,
  },
});
