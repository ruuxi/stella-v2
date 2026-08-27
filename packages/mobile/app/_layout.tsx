import { useMemo, useRef, useState } from "react";
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
import { useEffect } from "react";
import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { authClient } from "../src/lib/auth-client";
import { getConvexClient } from "../src/lib/convex";
import { hasMobileConfig } from "../src/config/env";
import {
  installNotificationCategoriesAndListeners,
  registerForPushNotifications,
} from "../src/lib/notifications";
import { installTextDefaults } from "../src/lib/setup-text-defaults";

installTextDefaults();
import { loadGuestMode, isGuest, setGuestMode } from "../src/lib/guest-mode";
import { loadAiConsent } from "../src/lib/ai-consent";
import { loadNotificationsMuted } from "../src/lib/notifications-prefs";
import {
  hasSeenOnboarding,
  loadOnboardingSeen,
} from "../src/lib/onboarding";
import { loadLastMainTabHref } from "../src/lib/last-main-tab";
import {
  criticalStellaFontAssets,
  deferredStellaFontAssets,
} from "../src/theme/fonts";
import { ShareIntentProvider } from "expo-share-intent";
import { ThemeProvider } from "../src/theme/theme-context";
import { ChatSearchProvider } from "../src/lib/chat-search";
import { I18nProvider, useT } from "../src/i18n";
import { ShareIntentHandler } from "../src/lib/share-intent-handler";
import { CarPlayBridge } from "../src/carplay/CarPlayBridge";

void SplashScreen.preventAutoHideAsync();

const BOOT_CRASH_BREADCRUMB_KEY = "stella-mobile-last-boot-crash-v1";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {

  const t = useT();
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
      <Text style={bootErrorStyles.title}>
        {t("mobile.boot.crashTitle")}
      </Text>
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
        <Text style={bootErrorStyles.buttonLabel}>
          {t("mobile.common.tryAgain")}
        </Text>
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
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(main)" />
      <Stack.Screen name="carplay-diagnostics" />
    </Stack>
  );
}

function AuthenticatedLayout() {
  const session = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [guestReady, setGuestReady] = useState(false);
  const [initialMainHref, setInitialMainHref] = useState<string | null>(null);
  const splashHiddenRef = useRef(false);

  useEffect(() => {
    void Promise.all([
      loadGuestMode(),
      loadAiConsent(),
      loadNotificationsMuted(),
      loadOnboardingSeen(),
      loadLastMainTabHref(),
    ]).then(([, , , , href]) => {
      setInitialMainHref(href);
      setGuestReady(true);
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
    if (session.isPending || !guestReady || !initialMainHref) {
      return;
    }

    const onLogin = pathname === "/login";
    const onIndex = pathname === "/" || pathname === "";
    const onOnboarding = pathname === "/onboarding";
    const onMain =
      pathname.startsWith("/chat") ||
      pathname.startsWith("/computer") ||
      pathname.startsWith("/account");

    if (onOnboarding) {
      return;
    }

    if (session.data) {
      if (isGuest()) void setGuestMode(false);
      void registerForPushNotifications();
      if (!hasSeenOnboarding()) {
        router.replace("/onboarding");
        return;
      }
      if (onLogin || onIndex) {
        router.replace(initialMainHref);
      }
      return;
    }

    if (isGuest()) {

      if (onLogin) {
        return;
      }
      if (!hasSeenOnboarding()) {
        router.replace("/onboarding");
        return;
      }
      if (onIndex) {
        router.replace(initialMainHref);
      }
      return;
    }

    if (onMain || onIndex) {
      router.replace("/login");
    }
  }, [pathname, router, session.data, session.isPending, guestReady, initialMainHref]);

  useEffect(() => {
    if (splashHiddenRef.current) {
      return;
    }
    if (session.isPending || !guestReady || !initialMainHref) {
      return;
    }
    splashHiddenRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void SplashScreen.hideAsync();
      });
    });
  }, [session.isPending, guestReady, initialMainHref]);

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

  const convex = useMemo(() => getConvexClient(), []);

  const providerAuthClient = authClient as unknown as AuthClient;
  return (
    <ConvexBetterAuthProvider client={convex} authClient={providerAuthClient}>
      <AuthenticatedLayout />
    </ConvexBetterAuthProvider>
  );
}

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
          <I18nProvider>
            <ThemeProvider>
              <ChatSearchProvider>
                <AppLayout />
              </ChatSearchProvider>
            </ThemeProvider>
          </I18nProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ShareIntentProvider>
  );
}
