import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Slot, usePathname, useRouter } from "expo-router";
import { AiConsentModal } from "../../src/components/AiConsentModal";
import {
  grantAiConsent,
  hasAiConsent,
  subscribeAiConsentRequested,
} from "../../src/lib/ai-consent";
import { authClient } from "../../src/lib/auth-client";
import { setGuestMode } from "../../src/lib/guest-mode";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Icon, type IconName } from "../../src/components/Icon";
import { GlassCard } from "../../src/components/glass";
import {
  AppBackdrop,
  TOP_BAR_BAR_HEIGHT,
} from "../../src/components/AppBackdrop";
import { StellaBrandMark } from "../../src/components/StellaBrandMark";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { fadeHex } from "../../src/theme/oklch";
import { useChatSearch } from "../../src/lib/chat-search";
import { tapLight } from "../../src/lib/haptics";
import {
  MAIN_TAB_HREFS,
  readMainTabFromPath,
  saveLastMainTab,
  type MainTabId,
} from "../../src/lib/last-main-tab";
import {
  hasSeenComputerHint,
  markComputerHintSeen,
} from "../../src/lib/computer-hint";
import { useT } from "../../src/i18n";

type TabId = MainTabId;

const TABS: {
  id: TabId;

  labelKey: string;
  icon: IconName;
  href: string;
}[] = [
  {
    id: "chat",
    labelKey: "mobile.nav.chat",
    icon: "message-square",
    href: "/chat",
  },
  {
    id: "computer",
    labelKey: "mobile.nav.computer",
    icon: "monitor",
    href: "/computer",
  },
  {
    id: "account",
    labelKey: "mobile.nav.settings",
    icon: "settings",
    href: "/account",
  },
];

const SHOW_SEARCH_BUTTON = false;

const SIDEBAR_WIDTH = 320;

const DRAWER_REVEAL = 232;

const DRAWER_SPRING = { duration: 260, dampingRatio: 0.88 } as const;

function readActiveTab(pathname: string): TabId | null {
  const tab = readMainTabFromPath(pathname);
  if (tab) return tab;

  return null;
}

function Sidebar({
  activeTab,
  onSelectTab,
  colors,
  styles,
  tabs,
  showComputerHint,
}: {
  activeTab: TabId | null;
  onSelectTab: (tab: TabId) => void;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
  tabs: typeof TABS;
  showComputerHint: boolean;
}) {
  const insets = useSafeAreaInsets();
  const t = useT();
  return (
    <GlassCard
      radius={0}
      legible
      style={[
        styles.sidebar,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom },
      ]}
    >
      <StellaBrandMark />
      <View style={styles.nav}>
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelectTab(tab.id)}
              style={({ pressed }) => [
                styles.navItem,
                active && styles.navItemActive,
                pressed && styles.navItemPressed,
              ]}
            >
              <View style={styles.navIcon}>
                <Icon
                  name={tab.icon}
                  size={18}
                  color={active ? colors.accent : colors.textMuted}
                  filled={active}
                />
                {tab.id === "computer" && showComputerHint && !active ? (
                  <View style={styles.navHintDot} />
                ) : null}
              </View>
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                {t(tab.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GlassCard>
  );
}

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [consentVisible, setConsentVisible] = useState(false);

  const [showComputerHint, setShowComputerHint] = useState(false);
  const colors = useColors();
  const t = useT();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    if (!hasAiConsent()) {
      setConsentVisible(true);
    }
    return subscribeAiConsentRequested(() => {
      if (!hasAiConsent()) setConsentVisible(true);
    });
  }, []);

  const onConsentAccept = useCallback(() => {
    void grantAiConsent().then(() => setConsentVisible(false));
  }, []);

  const onConsentDecline = useCallback(() => {
    setConsentVisible(false);
    void (async () => {
      try {
        await authClient.signOut();
      } catch {

      }
      await setGuestMode(false);
      router.replace("/login");
    })();
  }, [router]);

  const drawerProgress = useSharedValue(0);

  const activeTab = readActiveTab(pathname);
  const onComputer = pathname === "/computer";
  const onChatSurface = pathname === "/chat" || pathname === "/computer";

  const search = useChatSearch();

  useEffect(() => {
    search.close();

  }, [pathname]);

  useEffect(() => {
    if (activeTab) {
      void saveLastMainTab(activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    void hasSeenComputerHint().then((seen) => setShowComputerHint(!seen));
  }, []);

  useEffect(() => {
    if (!onComputer || !showComputerHint) return;
    setShowComputerHint(false);
    void markComputerHintSeen();
  }, [onComputer, showComputerHint]);

  const openSidebar = () => {
    Keyboard.dismiss();
    tapLight();
    setSidebarOpen(true);
    drawerProgress.value = withSpring(1, DRAWER_SPRING);
  };

  const closeSidebar = (haptic = true) => {
    if (haptic) tapLight();
    setSidebarOpen(false);
    drawerProgress.value = withSpring(0, DRAWER_SPRING);
  };

  const navigate = (tab: TabId) => {
    tapLight();
    router.replace(MAIN_TAB_HREFS[tab]);
    closeSidebar(false);
  };

  useEffect(() => {
    if (wide) closeSidebar(false);
  }, [wide]);

  const dismissKeyboard = () => Keyboard.dismiss();
  const openPan = Gesture.Pan()
    .enabled(!sidebarOpen)
    .activeOffsetX(15)
    .failOffsetY([-20, 20])
    .onStart(() => {
      runOnJS(dismissKeyboard)();
    })
    .onUpdate((e) => {
      drawerProgress.value = Math.min(
        1,
        Math.max(0, e.translationX / DRAWER_REVEAL),
      );
    })
    .onEnd((e) => {
      if (e.velocityX > 500 || drawerProgress.value > 0.4) {

        drawerProgress.value = withSpring(1, {
          ...DRAWER_SPRING,
          velocity: e.velocityX / DRAWER_REVEAL,
        });
        runOnJS(setSidebarOpen)(true);
        runOnJS(tapLight)();
      } else {

        drawerProgress.value = withSpring(0, {
          ...DRAWER_SPRING,
          velocity: e.velocityX / DRAWER_REVEAL,
        });
      }
    });

  const makeCloseGesture = () =>
    Gesture.Pan()
      .enabled(sidebarOpen)
      .activeOffsetX(-15)
      .failOffsetY([-20, 20])
      .onUpdate((e) => {
        drawerProgress.value = Math.min(
          1,
          Math.max(0, 1 + e.translationX / DRAWER_REVEAL),
        );
      })
      .onEnd((e) => {
        if (e.velocityX < -500 || drawerProgress.value < 0.6) {

          drawerProgress.value = withSpring(0, {
            ...DRAWER_SPRING,
            velocity: e.velocityX / DRAWER_REVEAL,
          });
          runOnJS(setSidebarOpen)(false);
          runOnJS(tapLight)();
        } else {

          drawerProgress.value = withSpring(1, {
            ...DRAWER_SPRING,
            velocity: e.velocityX / DRAWER_REVEAL,
          });
        }
      });

  const closePanDrawer = makeCloseGesture();
  const drawerPan = sidebarOpen ? closePanDrawer : openPan;

  const sidebarStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerProgress.value, [0, 0.4, 1], [0, 0.6, 1]),
    transform: [
      {
        translateX: interpolate(drawerProgress.value, [0, 1], [-12, 0]),
      },
    ],
  }));

  const foregroundStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          drawerProgress.value,
          [0, 1],
          [0, DRAWER_REVEAL],
        ),
      },
    ],
  }));

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value * 0.18,
  }));

  return (

    <SafeAreaView style={styles.shell} edges={[]}>
      <StatusBar style={isDark ? "light" : "dark"} />

      {wide ? (
        <>
          <AppBackdrop />
          <View style={styles.wideLayout}>
            <Sidebar
              activeTab={activeTab}
              onSelectTab={navigate}
              colors={colors}
              styles={styles}
              tabs={TABS}
              showComputerHint={showComputerHint}
            />
            <View style={styles.content}>
              <View style={styles.contentSlot}>
                <Slot />
              </View>
            </View>
          </View>
        </>
      ) : (
        <View style={styles.narrowLayout}>
          {

}
          <AppBackdrop />
          {

}
          <Animated.View
            pointerEvents={sidebarOpen ? "auto" : "none"}
            style={[styles.sidebarLayer, sidebarStyle]}
          >
            <Sidebar
              activeTab={activeTab}
              onSelectTab={navigate}
              colors={colors}
              styles={styles}
              tabs={TABS}
              showComputerHint={showComputerHint}
            />
          </Animated.View>

          {

}
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.foregroundLayer, foregroundStyle]}>
              {

}
              <AppBackdrop />
              <View
                style={[
                  styles.topBar,
                  { height: insets.top + TOP_BAR_BAR_HEIGHT },
                ]}
              >
                {search.isOpen ? (
                  <View style={styles.searchRow}>
                    <View style={styles.searchField}>
                      <Icon name="search" size={16} color={colors.textMuted} />
                      <TextInput
                        style={styles.searchInput}
                        value={search.query}
                        onChangeText={search.setQuery}
                        placeholder={t("mobile.search.placeholder")}
                        placeholderTextColor={fadeHex(colors.textMuted, 0.6)}
                        selectionColor={colors.accent}
                        autoFocus
                        autoCorrect={false}
                        returnKeyType="search"
                      />
                      {search.query.length > 0 ? (
                        <Pressable
                          onPress={() => search.setQuery("")}
                          hitSlop={8}
                          accessibilityLabel={t("mobile.search.clearLabel")}
                        >
                          <Icon name="x" size={15} color={colors.textMuted} />
                        </Pressable>
                      ) : null}
                    </View>
                    <Pressable
                      onPress={search.close}
                      hitSlop={8}
                      accessibilityLabel={t("mobile.search.cancelLabel")}
                      style={styles.searchCancel}
                    >
                      <Text style={styles.searchCancelText}>
                        {t("mobile.common.cancel")}
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <View style={styles.topBarSide}>
                      <Pressable
                        onPress={openSidebar}
                        hitSlop={8}
                        accessibilityLabel={t("mobile.nav.openLabel")}
                        style={styles.hamburger}
                      >
                        <Icon
                          name="menu"
                          size={22}
                          color={colors.text}
                          weight="semibold"
                        />
                      </Pressable>
                    </View>
                    <View style={{ flex: 1 }} />
                    <View style={styles.topBarRight}>
                      {SHOW_SEARCH_BUTTON && onChatSurface ? (
                        <Pressable
                          onPress={search.open}
                          hitSlop={8}
                          accessibilityLabel={t("mobile.search.openLabel")}
                          style={styles.hamburger}
                        >
                          <Icon
                            name="search"
                            size={21}
                            color={colors.text}
                            weight="regular"
                          />
                        </Pressable>
                      ) : null}
                    </View>
                  </>
                )}
              </View>

              <View style={styles.content}>
                <Slot />
              </View>

              {
}
              <Animated.View
                pointerEvents={sidebarOpen ? "auto" : "none"}
                style={[styles.foregroundScrim, scrimStyle]}
              >
                <Pressable
                  onPress={() => closeSidebar()}
                  style={StyleSheet.absoluteFill}
                  accessibilityLabel={t("mobile.nav.closeLabel")}
                />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        </View>
      )}
      <AiConsentModal
        visible={consentVisible}
        onAccept={onConsentAccept}
        onDecline={onConsentDecline}
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    shell: {
      flex: 1,
      backgroundColor: colors.background,
    },

    wideLayout: {
      flex: 1,
      flexDirection: "row",
    },

    narrowLayout: {
      flex: 1,
    },

    topBar: {
      alignItems: "flex-end",
      flexDirection: "row",
      paddingHorizontal: 4,
    },
    topBarSide: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },

    topBarRight: {
      alignItems: "center",
      flexDirection: "row",
      height: 44,
    },

    topBarBrand: {
      alignItems: "center",
      bottom: 0,
      height: 44,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
    },
    topBarAction: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },

    searchRow: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 8,
      height: 44,
      paddingLeft: 8,
    },
    searchField: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderColor: colors.border,
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: "row",
      gap: 8,
      height: 36,
      paddingHorizontal: 10,
    },
    searchInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      padding: 0,
    },
    searchCancel: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    searchCancelText: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    hamburger: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    wideChatHeader: {
      alignItems: "center",
      marginBottom: 8,
    },
    contentSlot: {
      flex: 1,
      minHeight: 0,
    },

    sidebar: {
      flex: 1,
      width: SIDEBAR_WIDTH,
    },
    nav: {
      gap: 2,
      paddingHorizontal: 12,
    },
    navItem: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderRadius: 10,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
      width: 188,
    },
    navItemActive: {
      backgroundColor: colors.accentSoft,
    },
    navItemPressed: {
      opacity: 0.7,
    },
    navIcon: {
      alignItems: "center",
      justifyContent: "center",
      width: 20,
    },

    navHintDot: {
      backgroundColor: colors.danger,
      borderColor: colors.background,
      borderRadius: 4,
      borderWidth: 1.5,
      height: 8,
      position: "absolute",
      right: -1,
      top: -1,
      width: 8,
    },
    navLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    navLabelActive: {
      color: colors.accent,
    },

    sidebarLayer: {
      bottom: 0,
      left: 0,
      position: "absolute",
      top: 0,
      width: SIDEBAR_WIDTH,
      zIndex: 1,
    },

    foregroundLayer: {
      flex: 1,
      backgroundColor: colors.background,
      zIndex: 2,
      shadowColor: "#000",
      shadowOffset: { width: -2, height: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 18,
      elevation: 12,
      overflow: "hidden",
      borderTopLeftRadius: 56,
      borderBottomLeftRadius: 56,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },

    foregroundScrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "#000",
      zIndex: 3,
    },

    content: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: 20,
      paddingTop: 4,
    },
  } as const);
