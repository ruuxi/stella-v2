import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import type { ActivityIndicatorEntry } from "@stella/contracts/activity-indicator";
import {
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  usePathname,
  useRouter,
} from "expo-router";
import { PersistentAppsHost } from "../../src/components/PersistentAppsHost";
import { AiConsentModal } from "../../src/components/AiConsentModal";
import {
  grantAiConsent,
  hasAiConsent,
  subscribeAiConsentRequested,
} from "../../src/lib/ai-consent";
import { authClient } from "../../src/lib/auth-client";
import { tearDownPushNotifications } from "../../src/lib/notifications";
import { setGuestMode } from "../../src/lib/guest-mode";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Icon } from "../../src/components/Icon";
import { GlassIconButton } from "../../src/components/GlassIconButton";
import { StellaStatusHeader } from "../../src/components/StellaStatusHeader";
import { StellaActivityMenu } from "../../src/components/StellaActivityMenu";
import { ChatSettingsSheet } from "../../src/components/ChatSettingsSheet";
import {
  AppBackdrop,
  TOP_BAR_BAR_HEIGHT,
} from "../../src/components/AppBackdrop";
import { SidebarPanel } from "../../src/components/sidebar/SidebarPanel";
import {
  DRAWER_CHEVRON_SIZE,
  DrawerStage,
} from "../../src/components/sidebar/DrawerStage";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import {
  closeDrawer,
  drawerJustOpened,
  drawerProgress,
  isDrawerOpen,
  openDrawer,
  useDrawerLive,
  useDrawerMetrics,
} from "../../src/lib/drawer";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { fadeHex } from "../../src/theme/oklch";
import { useChatSearch } from "../../src/lib/chat-search";
import { tapLight } from "../../src/lib/haptics";
import {
  MAIN_TAB_HREFS,
  queueMainTab,
  readMainTabFromPath,
  saveLastMainTab,
  takePendingMainTab,
  type MainTabId,
} from "../../src/lib/last-main-tab";
import {
  subscribeSidebarOpenRequests,
  useBackOverride,
  useTopBarAccessory,
} from "../../src/lib/main-shell-store";
import { useT } from "../../src/i18n";

/**
 * The chat is the base of the `(main)` stack. The other tabs (Schedule, Apps,
 * Files, Settings) sit one level over it and swap in place, and a deep link or
 * a restored last tab still gets the chat inserted underneath, so the chat
 * never has to remount for a visit to another tab and keeps publishing what
 * those tabs show (files, the paired computer).
 */
export const unstable_settings = { anchor: "chat" };

const SIDEBAR_WIDTH = 320;
/** Diameter of the top bar's circular glass controls. */
const TOP_BAR_BUTTON = DRAWER_CHEVRON_SIZE;
const TOP_BAR_INSET = 10;
const TITLE_MAX_FONT_SCALE = 1.3;

const EMPTY_RUNNING_AGENTS: readonly ActivityIndicatorEntry[] = [];

/** Pages whose name the top bar carries, centred between its controls. */
const PAGE_TITLE_KEYS: Partial<Record<MainTabId, string>> = {
  schedule: "mobile.activityHub.tabs.schedule",
  apps: "mobile.nav.apps",
  files: "mobile.activityHub.tabs.files",
};

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const drawerLive = useDrawerLive();
  const { travel } = useDrawerMetrics();
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  // The in-progress agents the top-bar indicator was showing when it was
  // pressed. Held rather than re-read so the menu keeps listing what the user
  // tapped on even as work settles underneath it.
  const [activityMenuRunning, setActivityMenuRunning] = useState<
    readonly ActivityIndicatorEntry[] | null
  >(null);
  const [consentVisible, setConsentVisible] = useState(false);
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
        await tearDownPushNotifications();
        await authClient.signOut();
      } catch {
        /* ignore — guests have nothing to sign out of */
      }
      await setGuestMode(false);
      router.replace("/login");
    })();
  }, [router]);

  const activeTab = readMainTabFromPath(pathname);
  const onChatSurface = pathname === "/chat";
  // A tab's own page (not a page pushed from one, like Cloud Home).
  const onTabRoot = Object.values(MAIN_TAB_HREFS).some(
    (href) => href === pathname,
  );
  const backOverride = useBackOverride();
  const pageTitleKey =
    onTabRoot && !backOverride && activeTab
      ? PAGE_TITLE_KEYS[activeTab]
      : undefined;
  const pageTitle = pageTitleKey ? t(pageTitleKey) : null;
  const topBarAccessory = useTopBarAccessory();
  const accessoryVisible = Boolean(pageTitle) && topBarAccessory != null;

  const search = useChatSearch();
  // Collapse + clear search whenever the route changes (e.g. switching tabs) so
  // search never leaks across surfaces.
  useEffect(() => {
    search.close();
    // `search.close` is stable; only react to route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (activeTab) {
      void saveLastMainTab(activeTab);
    }
  }, [activeTab]);

  // A restored tab opens over the chat once the chat is on screen.
  useEffect(() => {
    if (!onChatSurface) return;
    const pending = takePendingMainTab();
    if (pending) router.push(MAIN_TAB_HREFS[pending]);
  }, [onChatSurface, router]);

  // The sidebar, which carries the navigation, opens from the tab pages
  // themselves. Pages pushed from a tab and a route's own in-place view (an
  // open app) take the full screen behind the top-left back control instead.
  const drawerAvailable = onChatSurface || (onTabRoot && !backOverride);
  const backVisible = !drawerAvailable;

  const openSidebar = openDrawer;

  // Tabs push over the chat rather than replacing it, so the chat keeps its
  // mount (scroll position, draft, journal socket) and coming back is a pop,
  // not a cold remount behind the authority spinner. Another tab swaps in
  // place, so the stack is never deeper than the chat plus one tab. The
  // wide layout keeps the sidebar on screen over pages pushed from a tab
  // too; leaving one of those drops to the chat first and opens the tab
  // from there.
  const selectTab = (tab: MainTabId) => {
    if (!wide && drawerJustOpened()) return;
    const destination = MAIN_TAB_HREFS[tab];
    tapLight();
    if (!wide) closeDrawer();
    if (destination === pathname) return;
    Keyboard.dismiss();
    if (destination === "/chat") {
      router.dismissTo("/chat");
    } else if (onChatSurface) {
      router.push(destination);
    } else if (onTabRoot) {
      router.replace(destination);
    } else if (activeTab === tab) {
      router.dismissTo(destination);
    } else {
      queueMainTab(tab);
      router.dismissTo("/chat");
    }
  };

  // The top-left control is the drawer reveal on the chat and the other tab
  // pages, and "back" on a page pushed from a tab (or a route's in-place
  // view, like an open app).
  const onPressTopLeft = () => {
    if (drawerAvailable) {
      openSidebar();
      return;
    }
    tapLight();
    if (backOverride) {
      backOverride.onPress();
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace("/chat");
  };

  useEffect(() => {
    if (wide && isDrawerOpen()) closeDrawer();
  }, [wide]);

  // A route that takes the drawer away (a pushed page, an open app) never
  // inherits it open.
  useEffect(() => {
    if (!drawerAvailable && isDrawerOpen()) closeDrawer();
  }, [drawerAvailable]);

  // The chat's running-tasks pill asks for the drawer; the wide layout has
  // the sidebar on screen already, so there is nothing to reveal there.
  const openSidebarRef = useRef(openSidebar);
  openSidebarRef.current = openSidebar;
  useEffect(
    () =>
      subscribeSidebarOpenRequests(() => {
        if (!wide) openSidebarRef.current();
      }),
    [wide],
  );

  const topBarFade = useAnimatedStyle(() => ({
    opacity: interpolate(
      drawerProgress.value,
      [0, 0.22],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  // Constant on every route (like the empty nav bar over an iOS large title),
  // so the chat underneath never reflows as tabs swap over it.
  const topBarHeight = insets.top + TOP_BAR_BAR_HEIGHT;

  return (
    // edges=[] disables SafeAreaView's auto-padding so every layer below
    // (gradient, sidebar, foreground) can extend edge-to-edge through the
    // status-bar and home-indicator regions. The chrome that needs to clear
    // those areas (top bar, chat composer, scrollable content) reads
    // `useSafeAreaInsets()` and pads itself.
    <SafeAreaView style={styles.shell} edges={[]}>
      <StatusBar style={isDark ? "light" : "dark"} />

      {wide ? (
        <>
          <AppBackdrop />
          <View style={styles.wideLayout}>
            <SidebarPanel
              width={SIDEBAR_WIDTH}
              activeTab={activeTab}
              onSelectTab={selectTab}
            />
            <View style={styles.content}>
              <View style={styles.contentSlot}>
                <MainStack />
              </View>
              <View
                pointerEvents="box-none"
                style={[styles.topBar, { height: topBarHeight }]}
              >
                {pageTitle ? (
                  <View pointerEvents="none" style={styles.titleLane}>
                    <Text
                      accessibilityRole="header"
                      style={styles.pageTitle}
                      numberOfLines={1}
                      maxFontSizeMultiplier={TITLE_MAX_FONT_SCALE}
                    >
                      {pageTitle}
                    </Text>
                  </View>
                ) : null}
                {backVisible ? (
                  <View style={styles.topBarSide}>
                    <GlassIconButton
                      icon="chevron-left"
                      size={TOP_BAR_BUTTON}
                      iconSize={20}
                      accessibilityLabel={
                        backOverride?.label ?? t("mobile.common.back")
                      }
                      onPress={onPressTopLeft}
                    />
                  </View>
                ) : null}
                {accessoryVisible ? (
                  <View style={[styles.topBarSide, styles.topBarEnd]}>
                    {topBarAccessory}
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        </>
      ) : (
        <DrawerStage
          enabled={drawerAvailable}
          panel={
            <SidebarPanel
              width={travel}
              animated
              activeTab={activeTab}
              onSelectTab={selectTab}
            />
          }
          chevron={{
            left: TOP_BAR_INSET,
            top: topBarHeight - TOP_BAR_BUTTON,
            openLabel: t("mobile.nav.openLabel"),
            closeLabel:
              activeTab === "chat"
                ? t("mobile.nav.backToChat")
                : t("mobile.nav.closeLabel"),
          }}
        >
          <AppBackdrop />
          <View style={styles.content}>
            <MainStack />
          </View>

          {/* The top bar floats over the routes: the chat runs edge to
              edge underneath it, and every other route starts below it
              (`useShellTopInset`). Taps between its controls pass through
              to the page. */}
          <Animated.View
            pointerEvents="box-none"
            style={[styles.topBar, { height: topBarHeight }, topBarFade]}
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
            ) : null}
            {!search.isOpen && pageTitle ? (
              <View pointerEvents="none" style={styles.titleLane}>
                <Text
                  accessibilityRole="header"
                  style={styles.pageTitle}
                  numberOfLines={1}
                  maxFontSizeMultiplier={TITLE_MAX_FONT_SCALE}
                >
                  {pageTitle}
                </Text>
              </View>
            ) : null}
            {!search.isOpen && onChatSurface ? (
              <View pointerEvents="box-none" style={styles.statusLane}>
                <StellaStatusHeader onPress={setActivityMenuRunning} />
              </View>
            ) : null}
            {search.isOpen ? null : (
              <View
                style={[
                  styles.topBarSide,
                  drawerAvailable && drawerLive && styles.handedOff,
                ]}
                pointerEvents={drawerAvailable && drawerLive ? "none" : "auto"}
                accessibilityElementsHidden={drawerAvailable && drawerLive}
              >
                <GlassIconButton
                  icon={drawerAvailable ? "chevron-right" : "chevron-left"}
                  size={TOP_BAR_BUTTON}
                  iconSize={20}
                  accessibilityLabel={
                    drawerAvailable
                      ? t("mobile.nav.openLabel")
                      : (backOverride?.label ?? t("mobile.common.back"))
                  }
                  onPress={onPressTopLeft}
                />
              </View>
            )}
            {!search.isOpen && accessoryVisible ? (
              <View style={[styles.topBarSide, styles.topBarEnd]}>
                {topBarAccessory}
              </View>
            ) : null}
            {!search.isOpen && onChatSurface ? (
              <View style={[styles.topBarSide, styles.topBarEnd]}>
                <GlassIconButton
                  icon="settings"
                  size={TOP_BAR_BUTTON}
                  iconSize={19}
                  accessibilityLabel={t("mobile.nav.chatSettingsLabel")}
                  onPress={() => {
                    tapLight();
                    setChatSettingsOpen(true);
                  }}
                />
              </View>
            ) : null}
          </Animated.View>
        </DrawerStage>
      )}
      <ChatSettingsSheet
        visible={chatSettingsOpen}
        onClose={() => setChatSettingsOpen(false)}
      />
      <StellaActivityMenu
        visible={activityMenuRunning !== null}
        running={activityMenuRunning ?? EMPTY_RUNNING_AGENTS}
        onClose={() => setActivityMenuRunning(null)}
      />
      <AiConsentModal
        visible={consentVisible}
        onAccept={onConsentAccept}
        onDecline={onConsentDecline}
      />
    </SafeAreaView>
  );
}

/**
 * The route stack under the shell chrome. Screens paint their own canvas: the
 * chat shows the foreground backdrop through a transparent card, and detail
 * routes carry an opaque one (`MainDetailSurface`) so the chat underneath
 * never bleeds through a push. The stack's own edge-swipe stays off because
 * the drawer's swipe-right owns the left edge on every route, as before.
 */
function MainStack() {
  const pathname = usePathname();
  return (
    <NavigationThemeProvider value={TRANSPARENT_NAVIGATION_THEME}>
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "transparent" },
            animation: "slide_from_right",
            gestureEnabled: false,
          }}
        >
          {/* Tabs switch instantly; pages pushed from a tab (Cloud Home)
              keep the slide. */}
          <Stack.Screen name="schedule" options={TAB_SCREEN_OPTIONS} />
          <Stack.Screen name="apps" options={TAB_SCREEN_OPTIONS} />
          <Stack.Screen name="files" options={TAB_SCREEN_OPTIONS} />
          <Stack.Screen name="settings" options={TAB_SCREEN_OPTIONS} />
        </Stack>
        <PersistentAppsHost visible={pathname === "/apps"} />
      </View>
    </NavigationThemeProvider>
  );
}

const TAB_SCREEN_OPTIONS = { animation: "none" } as const;

/**
 * React Navigation paints `colors.background` beneath every stack screen, and
 * with no theme provided that is its light default (rgb 242), which covered
 * the shell's backdrop. The shell owns the canvas, so the navigator gets a
 * theme that paints nothing.
 */
const TRANSPARENT_NAVIGATION_THEME = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: "transparent" },
};

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    shell: {
      flex: 1,
      backgroundColor: colors.background,
    },

    // Wide (tablet / landscape)
    wideLayout: {
      flex: 1,
      flexDirection: "row",
    },

    // Top bar — phone and tablet action controls, floating over the routes.
    // Height is set inline as `insets.top + barHeight` so the safe-area inset
    // is added on top of the bar's own height rather than eating into it (RN
    // box model is border-box, so a fixed `height` would absorb the inset).
    topBar: {
      alignItems: "flex-end",
      flexDirection: "row",
      left: 0,
      paddingHorizontal: TOP_BAR_INSET,
      position: "absolute",
      right: 0,
      top: 0,
      // Native glass shadows extend below this row. Paint the controls above
      // the route surface so its backdrop cannot cut them off at the seam.
      overflow: "visible",
      zIndex: 1,
    },
    // Stella's status pill: spans the bar row beneath the status bar at the
    // side buttons' height and baseline, drawn under the menu button so the
    // button keeps its taps.
    statusLane: {
      bottom: 0,
      height: TOP_BAR_BUTTON,
      left: 0,
      position: "absolute",
      right: 0,
    },
    // A page's name, centred on the bar whatever sits at either side of it,
    // in the sidebar's place-label face.
    titleLane: {
      alignItems: "center",
      bottom: 0,
      height: TOP_BAR_BUTTON,
      justifyContent: "center",
      left: TOP_BAR_INSET + TOP_BAR_BUTTON + 8,
      position: "absolute",
      right: TOP_BAR_INSET + TOP_BAR_BUTTON + 8,
    },
    pageTitle: {
      color: colors.text,
      fontFamily: fonts.sans.bold,
      fontSize: 20,
      letterSpacing: -0.6,
    },
    topBarEnd: { marginLeft: "auto" },
    topBarSide: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    // Expanded search field that replaces the top-bar contents.
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
    contentSlot: {
      flex: 1,
      minHeight: 0,
    },
    handedOff: { opacity: 0 },

    // Shared content area. Routes apply their own inset (see
    // `mainContentStyles`) so a pushed detail page can paint edge to edge.
    content: {
      flex: 1,
      minHeight: 0,
    },
  } as const);
