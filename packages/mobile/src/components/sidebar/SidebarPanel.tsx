import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../../i18n";
import { authClient } from "../../lib/auth-client";
import { isGuest } from "../../lib/guest-mode";
import type { MainTabId } from "../../lib/last-main-tab";
import { useActivityHub } from "../../lib/main-shell-store";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { useColors } from "../../theme/theme-context";
import { Icon } from "../Icon";
import { StellaMarkHero } from "../stella-mark/StellaMarkHero";
import { Rise, SIDEBAR_PLACES, SidebarPlaceRow } from "./SidebarNav";

const AVATAR = 52;
const BRAND_MARK = 40;
const BRAND_TOP = 18;
const BRAND_ROW = 44;

export const SIDEBAR_BRAND_CENTER = BRAND_TOP + BRAND_ROW / 2;
const PLACES_FROM_TOP = [...SIDEBAR_PLACES].reverse();

export function SidebarPanel({
  width,
  animated = false,
  activeTab,
  onSelectTab,
}: {
  width: number;
  animated?: boolean;
  activeTab: MainTabId | null;
  onSelectTab: (tab: MainTabId) => void;
}) {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const session = authClient.useSession();
  const hub = useActivityHub();
  const user = isGuest() ? null : session.data?.user;
  const name = user?.name?.trim() ?? "";
  const image = user?.image ?? null;
  const accountLabel = t("mobile.nav.account");
  const fileCount = hub?.artifacts.length ?? 0;
  const metas: Partial<Record<MainTabId, string>> = {
    files: fileCount > 0 ? String(fileCount) : undefined,
  };
  const onAccount = activeTab === "settings";
  let i = 0;

  return (
    <View style={[styles.root, { width }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + 18,
            paddingTop: insets.top + BRAND_TOP,
          },
        ]}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical={false}
      >
        <Rise i={i++} animated={animated}>
          <View
            style={styles.brand}
            accessible
            accessibilityRole="header"
            accessibilityLabel="Stella"
          >
            <StellaMarkHero
              size={BRAND_MARK}
              faceColor={colors.background}
              shape="soft"
            />
            <Text style={styles.wordmark} maxFontSizeMultiplier={1}>
              Stella
            </Text>
          </View>
        </Rise>

        <View style={styles.spacer} />

        {PLACES_FROM_TOP.map((place) => (
          <Rise key={place} i={i++} animated={animated}>
            <SidebarPlaceRow
              place={place}
              active={activeTab === place}
              meta={metas[place]}
              onSelect={onSelectTab}
            />
          </Rise>
        ))}

        <View style={styles.rule} />

        <Rise i={i++} animated={animated}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: onAccount }}
            accessibilityLabel={name ? `${name}, ${accountLabel}` : accountLabel}
            onPress={() => onSelectTab("settings")}
            style={({ pressed }) => [styles.account, pressed && styles.pressed]}
            testID="mobile-sidebar-nav-settings"
          >
            <View style={styles.avatar}>
              {image ? (
                <Image
                  source={{ uri: image }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : name ? (
                <Text style={styles.initial} maxFontSizeMultiplier={1}>
                  {name.slice(0, 1).toUpperCase()}
                </Text>
              ) : (
                <Icon name="user" size={22} color={colors.accentForeground} />
              )}
            </View>
            <View style={styles.identity}>
              <View style={styles.titleLine}>
                <Text
                  style={styles.name}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {name || accountLabel}
                </Text>
                {!name && onAccount ? <View style={styles.current} /> : null}
              </View>
              {name ? (
                <View style={styles.accountLine}>
                  <Text
                    style={styles.accountLink}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {accountLabel}
                  </Text>
                  {onAccount ? <View style={styles.current} /> : null}
                </View>
              ) : null}
            </View>
          </Pressable>
        </Rise>

      </ScrollView>
      <LinearGradient
        pointerEvents="none"
        colors={[
          colors.background,
          colors.background,
          fadeHex(colors.background, 0),
        ]}
        locations={[0, insets.top / (insets.top + 14), 1]}
        style={[styles.topFade, { height: insets.top + 14 }]}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      minHeight: "100%",
      paddingLeft: 28,
      paddingRight: 20,
    },
    pressed: {
      opacity: 0.6,
    },
    avatar: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: AVATAR / 2,
      height: AVATAR,
      justifyContent: "center",
      overflow: "hidden",
      width: AVATAR,
    },
    initial: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.bold,
      fontSize: 22,
    },
    account: {
      alignItems: "center",
      flexDirection: "row",
      gap: 14,
    },
    identity: {
      flex: 1,
      minWidth: 0,
    },
    titleLine: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
    },
    name: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.bold,
      fontSize: 28,
      letterSpacing: -1,
      lineHeight: 34,
    },
    accountLine: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    accountLink: {
      color: colors.textInteractive,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
    },
    current: {
      backgroundColor: colors.accent,
      borderRadius: 4,
      height: 8,
      width: 8,
    },
    rule: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginBottom: 20,
      marginTop: 14,
      opacity: 0.8,
    },
    spacer: {
      flex: 1,
      minHeight: 24,
    },
    brand: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      height: BRAND_ROW,
    },
    wordmark: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 32,
      letterSpacing: -0.6,
    },
    topFade: {
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
  });
