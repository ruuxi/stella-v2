import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Stack,
  usePathname,
  useRouter,
  type ErrorBoundaryProps,
} from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadAsync, useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { ShareIntentProvider } from "expo-share-intent";
import { ConvexProviderWithAuth } from "convex/react";
import { authClient } from "../src/lib/auth-client";
import { getConvexClient } from "../src/lib/convex";
import { useMobileConvexAuth } from "../src/lib/mobile-convex-auth";
import { hasMobileConfig } from "../src/config/env";
import {
  installNotificationCategoriesAndListeners,
  registerForPushNotifications,
} from "../src/lib/notifications";
import { installTextDefaults } from "../src/lib/setup-text-defaults";
import {
  allowsAutomaticAnonymousBootstrap,
  isAnonymousAuthUser,
} from "../src/lib/auth-identity";
import { clearAccountBoundMobileState } from "../src/lib/account-bound-state";
import { CloudConversationProvider } from "../src/lib/cloud-conversation-controller";
import { loadAiConsent } from "../src/lib/ai-consent";
import { loadNotificationsMuted } from "../src/lib/notifications-prefs";
import { hasSeenOnboarding, loadOnboardingSeen } from "../src/lib/onboarding";
import { loadLastMainTabHref } from "../src/lib/last-main-tab";
import {
  criticalStellaFontAssets,
  deferredStellaFontAssets,
} from "../src/theme/fonts";
import { ThemeProvider } from "../src/theme/theme-context";
import { ChatSearchProvider } from "../src/lib/chat-search";
import { ShareIntentHandler } from "../src/lib/share-intent-handler";
import { CarPlayBridge } from "../src/carplay/CarPlayBridge";

installTextDefaults();
void SplashScreen.preventAutoHideAsync();

/** AsyncStorage key holding the last boot-crash breadcrumb (JSON). */
const BOOT_CRASH_BREADCRUMB_KEY = "stella-mobile-last-boot-crash-v1";

/**
 * Root-level render-error boundary (picked up by expo-router). Postmortem
 * armor from the 2026-07-02 OTA boot crash: a render-time ReferenceError in
 * ChatPane hit `RCTFatal` in release and killed the app before ANY UI — no
 * error screen, no diagnostics, and expo-updates never rolled back. This
 * boundary turns any future render/boot throw into a visible error screen
 * with a retry, persists a breadcrumb for diagnostics, and lifts the native
 * splash (the crash usually happens while the splash is still up, which would
 * otherwise hide the fallback and look like a hang).
 *
 * Deliberately depends on nothing but react-native primitives + AsyncStorage
 * so the fallback itself can't be taken down by whatever module just failed.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => undefined);
    const breadcrumb = JSON.stringify({
      at: new Date().toISOString(),
      message: String(error?.message ?? error),
      stack: typeof error?.stack === "string" ? error.stack.slice(0, 4000) : "",
    });
    void AsyncStorage.setItem(BOOT_CRASH_BREADCRUMB_KEY, breadcrumb).catch(
      () => undefined,
    );
  }, [error]);

  return (
    <View style={bootErrorStyles.root}>
      <Text style={bootErrorStyles.title}>Something broke at launch</Text>
      <Text style={bootErrorStyles.detail} numberOfLines={6}>
        {String(error?.message ?? error)}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void retry()}
        style={({ pressed }) => [
          bootErrorStyles.button,
          pressed && bootErrorStyles.buttonPressed,
        ]}
      >
        <Text style={bootErrorStyles.buttonLabel}>Try again</Text>
      </Pressable>
    </View>
  );
}

const bootErrorStyles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
    backgroundColor: "#edf3fb",
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    color: "#1c2733",
    textAlign: "center",
  },
  detail: {
    fontSize: 13,
    color: "#5b6b7b",
    textAlign: "center",
  },
  button: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: "#1c2733",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
});

function RootStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}

function AuthenticatedLayout() {
  const session = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [startupReady, setStartupReady] = useState(false);
  const [anonymousBootstrap, setAnonymousBootstrap] = useState<
    "idle" | "pending" | "failed"
  >("idle");
  const [initialMainHref, setInitialMainHref] = useState<string | null>(null);
  const splashHiddenRef = useRef(false);

  useEffect(() => {
    void Promise.all([
      loadAiConsent(),
      loadNotificationsMuted(),
      loadOnboardingSeen(),
      loadLastMainTabHref(),
    ]).then(([, , , href]) => {
      setInitialMainHref(href);
      setStartupReady(true);
    });
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void installNotificationCategoriesAndListeners().then((unsubscribe) => {
      if (cancelled) {
        unsubscribe();
        return;
      }
      dispose = unsubscribe;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (
      session.isPending ||
      !startupReady ||
      !initialMainHref ||
      session.data
    ) {
      return;
    }

    if (
      !allowsAutomaticAnonymousBootstrap(pathname) ||
      anonymousBootstrap !== "idle"
    ) {
      return;
    }

    setAnonymousBootstrap("pending");
    void clearAccountBoundMobileState()
      .then(() => authClient.signIn.anonymous())
      .then((result) => {
        if (result.error) {
          throw new Error(
            result.error.message ?? "Could not start an anonymous session.",
          );
        }
        const store = (
          authClient as unknown as {
            $store?: { notify: (signal: string) => void };
          }
        ).$store;
        store?.notify("$sessionSignal");
      })
      .catch(() => {
        setAnonymousBootstrap("failed");
      });
  }, [
    anonymousBootstrap,
    initialMainHref,
    pathname,
    session.data,
    session.isPending,
    startupReady,
  ]);

  useEffect(() => {
    if (session.data && anonymousBootstrap !== "idle") {
      setAnonymousBootstrap("idle");
    }
  }, [anonymousBootstrap, session.data]);

  useEffect(() => {
    if (session.isPending || !startupReady || !initialMainHref) {
      return;
    }

    const onAuthCallback =
      pathname === "/auth" || pathname.startsWith("/auth/");
    const onLogin = pathname === "/login";
    const onIndex = pathname === "/" || pathname === "";
    const onOnboarding = pathname === "/onboarding";
    const onMain =
      pathname.startsWith("/chat") ||
      pathname.startsWith("/computer") ||
      pathname.startsWith("/stella") ||
      pathname.startsWith("/account");

    if (onAuthCallback || onOnboarding) {
      return;
    }

    if (session.data) {
      const anonymous = isAnonymousAuthUser(session.data.user);
      if (!anonymous) {
        void registerForPushNotifications();
      }
      if (!hasSeenOnboarding()) {
        router.replace("/onboarding");
        return;
      }
      if (onIndex || (onLogin && !anonymous)) {
        router.replace(initialMainHref);
      }
      return;
    }

    if (onLogin) {
      return;
    }
    if (anonymousBootstrap === "failed" && (onMain || onIndex)) {
      router.replace("/login");
    }
  }, [
    anonymousBootstrap,
    initialMainHref,
    pathname,
    router,
    session.data,
    session.isPending,
    startupReady,
  ]);

  // Hold the native splash until auth + local startup state have resolved, so a
  // returning user goes straight from splash to their app — no flash of the
  // "Checking your session" / login screen while `useSession()` does its first
  // network round-trip. This runs after the routing effect above, and the
  // double `requestAnimationFrame` lets the chosen destination paint underneath
  // the splash before it lifts.
  useEffect(() => {
    if (splashHiddenRef.current) {
      return;
    }
    const onLogin = pathname === "/login";
    const onAuthCallback =
      pathname === "/auth" || pathname.startsWith("/auth/");
    const waitingForAnonymousSession =
      !session.data &&
      !onLogin &&
      !onAuthCallback &&
      anonymousBootstrap !== "failed";
    if (
      session.isPending ||
      !startupReady ||
      !initialMainHref ||
      waitingForAnonymousSession
    ) {
      return;
    }
    splashHiddenRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void SplashScreen.hideAsync();
      });
    });
  }, [
    anonymousBootstrap,
    initialMainHref,
    pathname,
    session.data,
    session.isPending,
    startupReady,
  ]);

  return (
    <>
      <ShareIntentHandler />
      <CarPlayBridge />
      <RootStack />
    </>
  );
}

function AppLayout() {
  if (!hasMobileConfig) {
    // No auth gate on this path, so nothing else lifts the splash — drop it
    // once the theme has painted.
    return (
      <>
        <HideSplashWhenThemed />
        <RootStack />
      </>
    );
  }

  return <ConvexBoundLayout />;
}

function ConvexBoundLayout() {
  // Lazily create the Convex client once, after we've confirmed the
  // mobile config is present. The identity-scoped auth hook clears the
  // previous account's cached JWT before Convex installs a new auth config.
  const convex = useMemo(() => getConvexClient(), []);
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useMobileConvexAuth}>
      <CloudConversationProvider>
        <AuthenticatedLayout />
      </CloudConversationProvider>
    </ConvexProviderWithAuth>
  );
}

/**
 * Mounted inside `ThemeProvider`, which holds rendering until the stored
 * theme has loaded — so the splash only lifts once the first frame is
 * painted in the user's actual theme (no Pearl flash on cold start).
 */
function HideSplashWhenThemed() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts(criticalStellaFontAssets);

  useEffect(() => {
    if (!fontsLoaded) {
      return;
    }

    void loadAsync(deferredStellaFontAssets).catch(() => undefined);
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <ShareIntentProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <ChatSearchProvider>
              <AppLayout />
            </ChatSearchProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ShareIntentProvider>
  );
}
