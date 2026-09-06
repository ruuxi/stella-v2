import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import {
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  usePathname,
  useRouter,
} from "expo-router";
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
import { NativeMenu } from "../../src/components/NativeMenu";
import { GlassIconButton } from "../../src/components/GlassIconButton";
import {
  AppBackdrop,
  TOP_BAR_BAR_HEIGHT,
} from "../../src/components/AppBackdrop";
import {
  SidebarPanel,
  type SidebarDestination,
} from "../../src/components/sidebar/SidebarPanel";
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
import { tapLight } from "../../src/lib/haptics";
import {
  readMainTabFromPath,
  saveLastMainTab,
} from "../../src/lib/last-main-tab";
import {
  subscribeSidebarOpenRequests,
  useActivityHub,
  useComputerControl,
  useHistoryControl,
} from "../../src/lib/main-shell-store";
import { useT } from "../../src/i18n";
import type { ChatArtifact } from "../../src/types";

/**
 * The chat is the base of the `(main)` stack. Settings, Account, and Cloud
 * Home push over it, and a deep link or a restored last-tab of `/settings`
 * still gets the chat inserted underneath, so "back" always has somewhere to
 * go and the chat never has to remount for a visit to a detail page.
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
  const computer = useComputerControl();
  const history = useHistoryControl();
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

  // Detail pages push over the chat rather than replacing it, so the chat
  // keeps its mount (scroll position, draft, journal socket) and coming back
  // is a pop, not a cold remount behind the authority spinner.
  const navigate = (destination: SidebarDestination) => {
    tapLight();
    if (destination === "/chat") {
      if (!onChatSurface) router.dismissTo("/chat");
    } else if (destination === "/login") {
      router.replace("/login");
    } else if (onChatSurface) {
      router.push(destination);
    } else if (pathname !== destination) {
      // Already on a detail page: swap it so the stack stays chat + one page.
      router.replace(destination);
    }
    closeSidebar(false);
  };

  // Settings and Account are detail pages off the one chat, so the top-left
  // control reads as "back" there and as the drawer reveal on the chat.
  const onPressTopLeft = () => {
    if (onChatSurface) {
      openSidebar();
      return;
    }
    tapLight();
    if (router.canGoBack()) router.back();
    else router.replace("/chat");
  };

  const onPressComputer = () => {
    if (!computer) return;
    tapLight();
    Keyboard.dismiss();
    computer.onPress();
  };

  useEffect(() => {
    if (wide) closeSidebar(false);
  }, [wide]);

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

  // -- Gesture: swipe right anywhere on the app to open --
  // `Keyboard.dismiss` is a method on the native Keyboard module and isn't
  // serializable into the Worklets UI runtime, so wrap it in a plain JS
  // function before handing it to `runOnJS`.
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
        // Commit open: continue from the fling velocity so the spring picks up
        // where the finger left off, and fire the open haptic on the detent.
        drawerProgress.value = withSpring(1, {
          ...DRAWER_SPRING,
          velocity: e.velocityX / DRAWER_REVEAL,
        });
        runOnJS(setSidebarOpen)(true);
        runOnJS(tapLight)();
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
          runOnJS(tapLight)();
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

  const chatControls = (
    <View style={styles.topBarRight}>
      {onChatSurface && history ? (
        <NativeMenu
          label={<Icon name="history" size={21} color={colors.text} />}
          circular
          width={TOP_BAR_BUTTON}
          height={TOP_BAR_BUTTON}
          accessibilityLabel={t("shell.topbar.conversation.history")}
          disabled={history.disabled}
          items={history.items}
          onFallbackPress={history.onPress}
        />
      ) : null}
      {onChatSurface && computer ? (
        // Quiet unless there is something to say: a muted
        // glyph while unpaired or asleep, a spinner while
        // waking, and the green dot only once connected.
        <GlassIconButton
          icon="settings"
          size={TOP_BAR_BUTTON}
          iconSize={21}
          muted={computer.connection !== "connected"}
          loading={computer.connection === "connecting"}
          dot={computer.connection === "connected" ? colors.ok : null}
          accessibilityLabel={`${t("mobile.nav.settings")}, ${computer.label}`}
          onPress={onPressComputer}
        />
      ) : null}
    </View>
  );

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
              open
              width={SIDEBAR_WIDTH}
              onNavigate={navigate}
              onOpenArtifact={openArtifact}
            />
            <View style={styles.content}>
              <View
                style={[
                  styles.topBar,
                  {
                    height: insets.top + TOP_BAR_BAR_HEIGHT,
                    justifyContent: "flex-end",
                  },
                ]}
              >
                {chatControls}
              </View>
              <View style={styles.contentSlot}>
                <MainStack />
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
              open={sidebarOpen}
              width={SIDEBAR_WIDTH}
              contentInsetRight={SIDEBAR_WIDTH - DRAWER_REVEAL}
              onNavigate={navigate}
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
                      <GlassIconButton
                        icon="chevron-left"
                        size={TOP_BAR_BUTTON}
                        iconSize={20}
                        accessibilityLabel={
                          onChatSurface
                            ? t("mobile.nav.openLabel")
                            : t("mobile.nav.backToChat")
                        }
                        onPress={onPressTopLeft}
                      />
                    </View>
                    <View style={{ flex: 1 }} />
                    {chatControls}
                  </>
                )}
              </View>

              <View style={styles.content}>
                <MainStack />
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
  return (
    <NavigationThemeProvider value={TRANSPARENT_NAVIGATION_THEME}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "transparent" },
          animation: "slide_from_right",
          gestureEnabled: false,
        }}
      >
        <Stack.Screen
          name="settings"
          options={{
            presentation: "formSheet",
            animation: "slide_from_bottom",
            gestureEnabled: true,
            sheetAllowedDetents: [0.9],
            sheetGrabberVisible: true,
            sheetCornerRadius: 28,
          }}
        />
      </Stack>
    </NavigationThemeProvider>
  );
}

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

    // Top bar — phone and tablet action controls. Height is set inline
    // as `insets.top + barHeight` so the safe-area inset is added on top of
    // the bar's own height rather than eating into it (RN box model is
    // border-box, so a fixed `height` would absorb the inset).
    topBar: {
      alignItems: "flex-end",
      flexDirection: "row",
      paddingHorizontal: 10,
    },
    topBarSide: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    // Right-side action cluster (search + chat/computer toggle).
    topBarRight: {
      gap: 8,
      alignItems: "center",
      flexDirection: "row",
      height: 44,
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
    wideChatHeader: {
      alignItems: "center",
      marginBottom: 8,
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
