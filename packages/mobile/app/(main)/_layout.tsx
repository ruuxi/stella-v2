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
import { setGuestMode } from "../../src/lib/guest-mode";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Icon } from "../../src/components/Icon";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
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
import { tapLight, tapMedium } from "../../src/lib/haptics";
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
  useActivityHub,
  useBackOverride,
} from "../../src/lib/main-shell-store";
import { useEngineTokenRefresher } from "../../src/lib/use-engine-token-refresher";
import { useT } from "../../src/i18n";
import type { ChatArtifact } from "../../src/types";

/**
 * The chat is the base of the `(main)` stack. The other tabs (Schedule, Apps,
 * Files, Settings) sit one level over it and swap in place, and a deep link or
 * a restored last tab still gets the chat inserted underneath, so the chat
 * never has to remount for a visit to another tab and keeps publishing what
 * those tabs show (files, the paired computer).
 */
export const unstable_settings = { anchor: "chat" };

const SIDEBAR_WIDTH = 320;
/** How far the foreground slides right when the drawer opens. Decoupled
 * from SIDEBAR_WIDTH so the sidebar can be widened (more breathing room
 * for its content) without pushing the main content further right; the
 * sidebar keeps its own content clear of the strip the foreground still
 * covers. */
const DRAWER_REVEAL = 292;
/** Diameter of the top bar's circular glass controls. */
const TOP_BAR_BUTTON = 44;

const EMPTY_RUNNING_AGENTS: readonly ActivityIndicatorEntry[] = [];
/** Snappy, lightly-springy settle for the drawer — tuned to feel closer to
 * ChatGPT iOS: it starts moving instantly (unlike an ease-in curve) and rests
 * fast with just a hint of overshoot for tactility. `duration` is the
 * perceptual duration; `dampingRatio` just under 1 keeps the bounce subtle
 * rather than wobbly. Gesture releases additionally hand the fling velocity to
 * the spring so the panel continues from the finger's speed. */
const DRAWER_SPRING = { duration: 260, dampingRatio: 0.88 } as const;

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  useEngineTokenRefresher();

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
        /* ignore — guests have nothing to sign out of */
      }
      await setGuestMode(false);
      router.replace("/login");
    })();
  }, [router]);

  // Reanimated shared value: 0 = closed, 1 = fully open
  const drawerProgress = useSharedValue(0);

  const activeTab = readMainTabFromPath(pathname);
  const onChatSurface = pathname === "/chat";
  // A tab's own page (not a page pushed from one, like Cloud Home).
  const onTabRoot = Object.values(MAIN_TAB_HREFS).some(
    (href) => href === pathname,
  );
  const backOverride = useBackOverride();
  const hubAccess = useActivityHub()?.access ?? null;
  const [viewerArtifact, setViewerArtifact] = useState<ChatArtifact | null>(
    null,
  );

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

  const openSidebar = () => {
    Keyboard.dismiss();
    tapLight();
    setSidebarOpen(true);
    drawerProgress.value = withSpring(1, DRAWER_SPRING);
  };

  // `haptic` defaults on so direct user closes (scrim tap, back) feel the
  // commit. Callers that already fire their own feedback or close the drawer
  // programmatically (tab navigation, rotating into the wide layout) pass
  // false to avoid a double buzz.
  const closeSidebar = (haptic = true) => {
    if (haptic) tapLight();
    setSidebarOpen(false);
    drawerProgress.value = withSpring(0, DRAWER_SPRING);
  };

  // Tabs push over the chat rather than replacing it, so the chat keeps its
  // mount (scroll position, draft, journal socket) and coming back is a pop,
  // not a cold remount behind the authority spinner. Another tab swaps in
  // place, so the stack is never deeper than the chat plus one tab. The
  // wide layout keeps the sidebar on screen over pages pushed from a tab
  // too; leaving one of those drops to the chat first and opens the tab
  // from there.
  const selectTab = (tab: MainTabId) => {
    const destination = MAIN_TAB_HREFS[tab];
    tapLight();
    if (!wide) closeSidebar(false);
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
    if (wide) closeSidebar(false);
  }, [wide]);

  // A route that takes the drawer away (a pushed page, an open app) never
  // inherits it open.
  useEffect(() => {
    if (drawerAvailable) return;
    setSidebarOpen(false);
    drawerProgress.value = withSpring(0, DRAWER_SPRING);
  }, [drawerAvailable, drawerProgress]);

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

  const openArtifact = useCallback((artifact: ChatArtifact) => {
    setViewerArtifact(artifact);
  }, []);

  // -- Gesture: swipe right anywhere on a tab page to open --
  // `Keyboard.dismiss` is a method on the native Keyboard module and isn't
  // serializable into the Worklets UI runtime, so wrap it in a plain JS
  // function before handing it to `runOnJS`.
  const dismissKeyboard = () => Keyboard.dismiss();
  const openPan = Gesture.Pan()
    .enabled(!sidebarOpen && drawerAvailable)
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
        // Commit open: continue from the fling velocity so the spring picks up
        // where the finger left off, and fire the open haptic on the detent.
        // Medium, not light: a light impact under a moving thumb mid-swipe is
        // below the threshold where the detent actually registers as a detent.
        drawerProgress.value = withSpring(1, {
          ...DRAWER_SPRING,
          velocity: e.velocityX / DRAWER_REVEAL,
        });
        runOnJS(setSidebarOpen)(true);
        runOnJS(tapMedium)();
      } else {
        // Snap back to closed — no haptic, the drawer never left its rest state.
        drawerProgress.value = withSpring(0, {
          ...DRAWER_SPRING,
          velocity: e.velocityX / DRAWER_REVEAL,
        });
      }
    });

  // -- Gesture: swipe left to close --
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
          // Commit closed: ride the fling velocity into the spring and fire the
          // close haptic on the detent.
          drawerProgress.value = withSpring(0, {
            ...DRAWER_SPRING,
            velocity: e.velocityX / DRAWER_REVEAL,
          });
          runOnJS(setSidebarOpen)(false);
          runOnJS(tapMedium)();
        } else {
          // Snap back to open — no haptic, the drawer stays where it was.
          drawerProgress.value = withSpring(1, {
            ...DRAWER_SPRING,
            velocity: e.velocityX / DRAWER_REVEAL,
          });
        }
      });

  const closePanDrawer = makeCloseGesture();
  const drawerPan = sidebarOpen ? closePanDrawer : openPan;

  // -- Animated styles --
  // Sidebar sits underneath the foreground at rest. As the drawer opens we
  // parallax it in (-12px → 0) so the reveal reads as the content lifting
  // away rather than the menu sliding in. Deliberately no opacity fade:
  // UIKit refuses to render Liquid Glass (UIVisualEffectView) beneath a
  // superview whose alpha has been taken below 1, and the sidebar's glass
  // pills stayed flat for exactly that reason. The opaque foreground hides
  // the parked sidebar anyway, so the fade bought nothing visible.
  const sidebarStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(drawerProgress.value, [0, 1], [-12, 0]),
      },
    ],
  }));

  // Foreground (top bar + content) is the elevated layer. It slides right
  // to expose the sidebar parked beneath it.
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

  // Soft scrim painted onto the foreground itself — a faint dim while the
  // drawer is open, plus a tap-to-close target. Lives above content but
  // travels with the foreground so it never covers the sidebar.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value * 0.18,
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
              onOpenArtifact={openArtifact}
            />
            <View style={styles.content}>
              <View style={styles.contentSlot}>
                <MainStack />
              </View>
              <View
                pointerEvents="box-none"
                style={[styles.topBar, { height: topBarHeight }]}
              >
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
              </View>
            </View>
          </View>
        </>
      ) : (
        <View style={styles.narrowLayout}>
          {/* Gradient backdrop — painted behind both sidebar and foreground
              so the inset/rounded foreground reveals the same continuous
              canvas through its curved corners (no contrasting bands). */}
          <AppBackdrop />
          {/* Sidebar parked underneath at the left edge. Always mounted,
              statically positioned, edge-to-edge vertically. The foreground
              (below) slides right to reveal it, so the menu reads as a layer
              the app is lifting off of rather than a panel sliding in over
              the content. */}
          <Animated.View
            pointerEvents={sidebarOpen ? "auto" : "none"}
            style={[styles.sidebarLayer, sidebarStyle]}
          >
            <SidebarPanel
              width={SIDEBAR_WIDTH}
              contentInsetRight={SIDEBAR_WIDTH - DRAWER_REVEAL}
              activeTab={activeTab}
              onSelectTab={selectTab}
              onOpenArtifact={openArtifact}
            />
          </Animated.View>

          {/* Foreground — the elevated layer. Top bar + content travel
              together, with a soft left-edge shadow for depth, and a scrim
              painted on top so taps behind the controls dismiss the drawer
              without ever obscuring the sidebar. */}
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.foregroundLayer, foregroundStyle]}>
              {/* The foreground carries the backdrop as its own opaque surface
                  so soft/flat is actually visible in the app (and the parked
                  sidebar stays hidden) instead of being covered by a flat
                  fill. Clipped to the rounded corners via overflow:hidden. */}
              <AppBackdrop />
              <View style={styles.content}>
                <MainStack />
              </View>

              {/* The top bar floats over the routes: the chat runs edge to
                  edge underneath it, and every other route starts below it
                  (`useShellTopInset`). Taps between its controls pass through
                  to the page. */}
              <View
                pointerEvents="box-none"
                style={[styles.topBar, { height: topBarHeight }]}
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
                {!search.isOpen && onChatSurface ? (
                  <View pointerEvents="box-none" style={styles.statusLane}>
                    <StellaStatusHeader onPress={setActivityMenuRunning} />
                  </View>
                ) : null}
                {search.isOpen ? null : (
                  <View style={styles.topBarSide}>
                    <GlassIconButton
                      icon="chevron-left"
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
              </View>

              {/* Scrim — sits on top of the foreground while the drawer is
                  open. Tap anywhere on the visible app area to close. */}
              <Animated.View
                pointerEvents={sidebarOpen ? "auto" : "none"}
                style={[styles.foregroundScrim, scrimStyle]}
              >
                <Pressable
                  onPress={() => closeSidebar()}
                  style={StyleSheet.absoluteFill}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.nav.closeLabel")}
                  testID="mobile-nav-close"
                />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        </View>
      )}
      <ArtifactViewer
        visible={Boolean(viewerArtifact)}
        artifact={viewerArtifact}
        access={hubAccess}
        onClose={() => setViewerArtifact(null)}
      />
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

    // Narrow (phone)
    narrowLayout: {
      flex: 1,
    },

    // Top bar — phone and tablet action controls, floating over the routes.
    // Height is set inline as `insets.top + barHeight` so the safe-area inset
    // is added on top of the bar's own height rather than eating into it (RN
    // box model is border-box, so a fixed `height` would absorb the inset).
    topBar: {
      alignItems: "flex-end",
      flexDirection: "row",
      left: 0,
      paddingHorizontal: 10,
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
    // Sidebar layer — sits underneath the foreground, anchored to the left
    // edge. Stays mounted so swipe-to-open reveals an already-laid-out menu.
    sidebarLayer: {
      bottom: 0,
      left: 0,
      position: "absolute",
      top: 0,
      width: SIDEBAR_WIDTH,
      zIndex: 1,
    },

    // Foreground layer — elevated above the sidebar. Carries the canvas
    // color so the parked sidebar doesn't show through the app, and a soft
    // left-edge shadow so the layering reads when the drawer is open.
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

    // Scrim painted on the foreground while the drawer is open. Dims the
    // app slightly and provides a tap target to close.
    foregroundScrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "#000",
      zIndex: 3,
    },

    // Shared content area. Routes apply their own inset (see
    // `mainContentStyles`) so a pushed detail page can paint edge to edge.
    content: {
      flex: 1,
      minHeight: 0,
    },
  } as const);
