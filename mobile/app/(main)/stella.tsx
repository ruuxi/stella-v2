import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../src/components/Icon";
import { assert, assertObject } from "../../src/lib/assert";
import { isGuest } from "../../src/lib/guest-mode";
import {
  clearCachedDesktopBridge,
  createDesktopBridgeSession,
} from "../../src/lib/desktop-bridge-chat";
import {
  clearStoredPhoneAccess,
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { normalizePairingCode, pairWithCode } from "../../src/lib/pairing";
import { useDesktopPlatforms } from "../../src/lib/use-desktop-platforms";
import { generateShimScript } from "../../src/lib/shim";
import { userFacingError } from "../../src/lib/user-facing-error";
import { DesktopTabAnimation } from "../../src/components/DesktopTabAnimation";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { notifySuccess } from "../../src/lib/haptics";
import { type Colors } from "../../src/theme/colors";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";

type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
  mobileBridgeCapabilities?: {
    version: number;
    capabilities: Array<{
      mode: string;
      path: string;
      channel?: string;
      transport?: string;
      reason?: string;
    }>;
  };
};

const EMPTY_BRIDGE_BOOTSTRAP: MobileBridgeBootstrap = { localStorage: {} };
const DESKTOP_WAKE_ATTEMPTS = 8;
const DESKTOP_WAKE_RETRY_MS = 1_000;

type BridgeState = {
  bridgeUrl: string;
  headers: Record<string, string>;
  uri: string;
  bootstrap: MobileBridgeBootstrap;
  access: StoredPhoneAccess;
};

type ScreenState =
  | { type: "loading"; message: string }
  | { type: "unavailable"; error: string | null; title: string }
  | { type: "ready"; bridge: BridgeState };

type ShimMessage =
  | { type: "openExternal"; url: string }
  | { type: "connectionState"; connected: boolean };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function getBridgeOrigin(bridgeUrl: string): string {
  return new URL(bridgeUrl).origin;
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSameOriginUrl(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function isAllowedWebViewUrl(value: string, origin: string): boolean {
  return value === "about:blank" || isSameOriginUrl(value, origin);
}

function readShimMessage(data: string): ShimMessage {
  const value = JSON.parse(data) as unknown;
  assertObject(value, "WebView message must be an object.");
  assert(typeof value.type === "string", "WebView message type is required.");
  switch (value.type) {
    case "openExternal":
      assert(typeof value.url === "string", "WebView URL is required.");
      return { type: "openExternal", url: value.url };
    case "connectionState":
      assert(
        typeof value.connected === "boolean",
        "WebView connected flag is required.",
      );
      return { type: "connectionState", connected: value.connected };
  }
  throw new Error(`Unknown WebView message type: ${value.type}`);
}

function readUnavailableState(
  title: string,
  error: string | null = null,
): Extract<ScreenState, { type: "unavailable" }> {
  return {
    type: "unavailable",
    error,
    title,
  };
}

function GuestDesktopScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.bottom),
    [colors, insets.bottom],
  );
  return (
    <View style={styles.centered}>
      <DesktopTabAnimation />
      <Text style={styles.title}>Pair your phone</Text>
      <Text style={styles.body}>
        See your Stella desktop app right on your phone. After pairing, your phone will reconnect automatically.
      </Text>
      <SignInPrompt message="Sign in to get started." />
    </View>
  );
}

export default function StellaScreen() {
  if (isGuest()) {
    return <GuestDesktopScreen />;
  }

  return <AuthenticatedStellaScreen />;
}

function AuthenticatedStellaScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.bottom),
    [colors, insets.bottom],
  );
  const router = useRouter();
  const webViewRef = useRef<WebView>(null);
  const preferredAccessRef = useRef<StoredPhoneAccess | null>(null);
  const screenStateRef = useRef<ScreenState["type"]>("loading");
  const attemptedRouteCodeRef = useRef<string | null>(null);
  const routeParams = useLocalSearchParams<{ code?: string | string[] }>();
  const routeCode = normalizePairingCode(
    typeof routeParams.code === "string"
      ? routeParams.code
      : Array.isArray(routeParams.code)
        ? (routeParams.code[0] ?? "")
        : "",
  );
  // Pairing-only entries (deep link with a code, or no stored desktop)
  // should not spin up the desktop tunnel/WebView. Only an explicit
  // "View computer" navigation triggers the connection flow.
  const isPairingOnly = routeCode.length > 0;

  const [screenState, setScreenStateRaw] = useState<ScreenState>({
    type: "loading",
    message: "Connecting to desktop",
  });
  const setScreenState = useCallback((next: ScreenState) => {
    screenStateRef.current = next.type;
    setScreenStateRaw(next);
  }, []);
  const [canGoBack, setCanGoBack] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(true);
  const [preferredAccess, setPreferredAccess] =
    useState<StoredPhoneAccess | null>(null);
  const [isPairing, setIsPairing] = useState(false);
  const [isPairSheetOpen, setIsPairSheetOpen] = useState(false);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>(
    [],
  );
  const desktopPlatforms = useDesktopPlatforms(pairedDesktops);

  useEffect(() => {
    void listStoredPairedPhoneAccess().then(setPairedDesktops);
  }, [preferredAccess]);

  const updatePreferredAccess = useCallback(
    (nextAccess: StoredPhoneAccess | null) => {
      preferredAccessRef.current = nextAccess;
      setPreferredAccess(nextAccess);
    },
    [],
  );

  const refreshBridge = useCallback(
    async (nextAccess?: StoredPhoneAccess | null) => {
      setScreenState({
        type: "loading",
        message: "Connecting to desktop",
      });

      const access =
        nextAccess === undefined
          ? (preferredAccessRef.current ?? (await getPreferredPhoneAccess()))
          : nextAccess;

      if (!access) {
        updatePreferredAccess(null);
        setPairedDesktops([]);
        setScreenState(readUnavailableState("Pair your phone"));
        return;
      }

      updatePreferredAccess(access);
      void listStoredPairedPhoneAccess().then(setPairedDesktops);

      try {
        await requestDesktopConnection(access);
        let status = await getDesktopBridgeStatus(access.desktopDeviceId);
        for (
          let attempt = 1;
          attempt < DESKTOP_WAKE_ATTEMPTS && !status.available;
          attempt += 1
        ) {
          await sleep(DESKTOP_WAKE_RETRY_MS);
          status = await getDesktopBridgeStatus(access.desktopDeviceId);
        }

        if (!status.available) {
          setScreenState(
            readUnavailableState(
              status.platform
                ? `Your ${status.platform} isn't reachable`
                : "Can't reach your desktop",
            ),
          );
          return;
        }

        const baseUrl = status.baseUrls[0];
        assert(baseUrl, "Desktop bridge URL is required.");
        const bridgeSession = await createDesktopBridgeSession(access, baseUrl);

        let bootstrap = EMPTY_BRIDGE_BOOTSTRAP;
        try {
          const bootstrapRes = await fetch(`${baseUrl}/bridge/bootstrap`, {
            headers: bridgeSession.headers,
          });
          if (bootstrapRes.ok) {
            bootstrap = (await bootstrapRes.json()) as MobileBridgeBootstrap;
          }
        } catch {
          // Best-effort: proceed without desktop state.
        }

        notifySuccess();
        setBridgeConnected(true);
        setScreenState({
          type: "ready",
          bridge: {
            bridgeUrl: baseUrl,
            headers: bridgeSession.headers,
            uri: `${baseUrl}/?mobile=1`,
            bootstrap,
            access,
          },
        });
      } catch (error) {
        const message = userFacingError(error);
        if (message.toLowerCase().includes("pair")) {
          clearCachedDesktopBridge(access.desktopDeviceId);
          await clearStoredPhoneAccess(access.desktopDeviceId);
          updatePreferredAccess(null);
          setScreenState(
            readUnavailableState(
              "Pair your phone",
              "This phone needs to be paired with your computer again.",
            ),
          );
          return;
        }

        setScreenState(
          readUnavailableState("Can't reach your desktop", message),
        );
      }
    },
    [updatePreferredAccess],
  );

  const pairPhone = useCallback(
    async (value: string) => {
      const nextCode = normalizePairingCode(value);
      if (!nextCode) {
        setScreenState(
          readUnavailableState(
            "Pair your phone",
            "Enter the code shown on your computer.",
          ),
        );
        return;
      }

      setIsPairing(true);
      setScreenState({
        type: "loading",
        message: "Pairing this phone",
      });

      const result = await pairWithCode(nextCode);
      setIsPairing(false);
      if (result.ok) {
        updatePreferredAccess(result.access);
        // Pairing complete. Land the user on the Computer chat so they can
        // start sending messages immediately; the WebView/tunnel is only
        // spun up when they explicitly tap "View computer".
        router.replace("/computer");
      } else {
        setScreenState(readUnavailableState("Pair your phone", result.error));
      }
    },
    [router, setScreenState, updatePreferredAccess],
  );

  useEffect(() => {
    if (isPairingOnly) {
      // Pairing deep link — show the pair sheet immediately and skip the
      // bridge refresh entirely so the desktop tunnel/WebView only starts
      // when the user explicitly opens View computer.
      setScreenState(readUnavailableState("Pair your phone"));
      setIsPairSheetOpen(true);
      return;
    }
    void refreshBridge();
    const interval = setInterval(() => {
      const access = preferredAccessRef.current;
      if (!access || screenStateRef.current !== "ready") {
        return;
      }
      void getDesktopBridgeStatus(access.desktopDeviceId)
        .then((status) => {
          if (!status.available) {
            void refreshBridge(access);
          }
        })
        .catch(() => {});
    }, 45_000);
    return () => {
      clearInterval(interval);
    };
  }, [isPairingOnly, refreshBridge, setScreenState]);

  useEffect(() => {
    if (!routeCode || attemptedRouteCodeRef.current === routeCode) {
      return;
    }
    attemptedRouteCodeRef.current = routeCode;
    void pairPhone(routeCode);
  }, [pairPhone, routeCode]);

  // Layered back: step through the desktop app's own history first, then
  // drop out of the full-screen view back to the Computer tab. Drives both
  // the floating back control and Android's hardware back (Modal
  // onRequestClose). iOS edge-swipe-back is handled by the WebView itself.
  const goBackOrExit = useCallback(() => {
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/computer");
    }
  }, [canGoBack, router]);

  const handleMessage = (event: WebViewMessageEvent) => {
    // The desktop's web frontend ships independently of this app, so a newer
    // desktop can post message types this build doesn't know. Those must
    // degrade to a no-op — a throw escaping an event handler is a fatal
    // crash in release builds (no ErrorBoundary catches it).
    let message: ShimMessage;
    try {
      message = readShimMessage(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === "openExternal" && isAllowedExternalUrl(message.url)) {
      void Linking.openURL(message.url);
    }
    if (message.type === "connectionState") {
      setBridgeConnected(message.connected);
    }
  };

  if (screenState.type === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.secondaryText}>{screenState.message}</Text>
      </View>
    );
  }

  if (screenState.type === "unavailable") {
    const showRetry = Boolean(preferredAccess);
    return (
      <View style={styles.unavailableView}>
        <View style={styles.statusBlock}>
          <DesktopTabAnimation />
          <Text style={styles.title}>{screenState.title}</Text>
          <Text style={styles.body}>
            {preferredAccess
              ? "Make sure Stella is open on your computer and connected to the internet. Once connected, your desktop app will appear right here on your phone."
              : "See your Stella desktop app right on your phone. Scan the QR code shown in Stella on your computer to get started — after that, your phone will reconnect automatically."}
          </Text>
          {screenState.error && (
            <Text style={styles.errorText}>{screenState.error}</Text>
          )}
        </View>

        <View style={styles.actionRow}>
          <PrimaryButton
            label={preferredAccess ? "Pair another computer" : "Pair phone"}
            onPress={() => setIsPairSheetOpen(true)}
            disabled={isPairing}
            accessibilityLabel={
              preferredAccess
                ? "Pair another computer"
                : "Start pairing a computer"
            }
          />

          {showRetry && (
            <Pressable
              onPress={() => void refreshBridge()}
              accessibilityLabel="Try connecting again"
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.secondaryButtonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Try again</Text>
            </Pressable>
          )}
        </View>

        <PairPhoneSheet
          visible={isPairSheetOpen}
          onClose={() => setIsPairSheetOpen(false)}
          onPaired={(access) => {
            setIsPairSheetOpen(false);
            updatePreferredAccess(access);
            router.replace("/computer");
          }}
          preferredAccess={preferredAccess}
          pairedDesktops={pairedDesktops}
          desktopPlatforms={desktopPlatforms}
          onSwitchDesktop={(d) => {
            setIsPairSheetOpen(false);
            void refreshBridge(d);
          }}
        />
      </View>
    );
  }

  const bridgeOrigin = getBridgeOrigin(screenState.bridge.bridgeUrl);
  return (
    // Full-screen Modal so the live desktop covers the app's own top bar and
    // sidebar chrome — edge-to-edge, like a native screen. Only the top is
    // padded (for the status bar + back bar); the WebView runs flush to the
    // bottom edge so the desktop's own content reaches the bottom with no
    // surface-colored gap below it.
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      onRequestClose={goBackOrExit}
    >
      <View style={[styles.screenFull, { paddingTop: insets.top }]}>
        <View style={styles.stellaBar}>
          <Pressable
            onPress={goBackOrExit}
            hitSlop={8}
            accessibilityLabel="Back"
            style={({ pressed }) => [
              styles.stellaBarBtn,
              pressed && styles.stellaBarBtnPressed,
            ]}
          >
            <Icon
              name="chevron-left"
              size={22}
              color={colors.text}
              weight="semibold"
            />
          </Pressable>
          <View style={styles.stellaBarStatus} pointerEvents="none">
            {!bridgeConnected && (
              <>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.reconnectText}>Reconnecting...</Text>
              </>
            )}
          </View>
          <View style={styles.stellaBarBtn} />
        </View>
        <WebView
          ref={webViewRef}
          source={{
            uri: screenState.bridge.uri,
            headers: screenState.bridge.headers,
          }}
          injectedJavaScriptBeforeContentLoaded={generateShimScript(
            screenState.bridge.bridgeUrl,
            screenState.bridge.bootstrap,
          )}
          style={styles.webView}
          // Native touch/scroll/keyboard polish — mobile-owned, touches no desktop UI.
          decelerationRate="normal"
          bounces={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          allowsBackForwardNavigationGestures
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          mediaPlaybackRequiresUserAction={false}
          onMessage={handleMessage}
          onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
          onShouldStartLoadWithRequest={(request) => {
            if (isAllowedWebViewUrl(request.url, bridgeOrigin)) {
              return true;
            }
            if (isAllowedExternalUrl(request.url)) {
              void Linking.openURL(request.url);
            }
            return false;
          }}
          onError={() =>
            setScreenState(
              readUnavailableState(
                "Can't reach your desktop",
                "The link to your computer was interrupted.",
              ),
            )
          }
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 500) {
              setScreenState(readUnavailableState("Can't reach your desktop"));
            }
          }}
          originWhitelist={[bridgeOrigin, "about:blank"]}
        />
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors, insetBottom: number) => StyleSheet.create({
  screen: {
    flex: 1,
  },
  /** Full-screen container hosting the live desktop WebView. */
  screenFull: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  /** Slim bar above the live desktop holding the back control + status. */
  stellaBar: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    height: 44,
    paddingHorizontal: 6,
  },
  stellaBarBtn: {
    alignItems: "center",
    borderRadius: 10,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  stellaBarBtnPressed: {
    opacity: 0.6,
  },
  stellaBarStatus: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
  },
  unavailableScroll: {
    flexGrow: 1,
    gap: 12,
    paddingBottom: 28,
  },
  unavailableView: {
    alignItems: "center",
    flex: 1,
    gap: 18,
    justifyContent: "center",
    paddingHorizontal: 24,
    // The parent layout's top bar already clears the status bar, so the
    // top padding only needs visual breathing room so the SVG + title
    // don't hug the navigation chrome. The bottom edge does need the
    // safe-area inset for the home indicator, plus a small buffer so
    // the action button doesn't get clipped.
    paddingTop: 32,
    paddingBottom: insetBottom + 24,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 28,
    letterSpacing: -1.2,
    textAlign: "center",
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  secondaryText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
    lineHeight: 19,
  },
  statusBlock: {
    gap: 8,
    paddingTop: 8,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
    marginTop: "auto",
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  secondaryButtonPressed: {
    opacity: 0.8,
  },
  secondaryButtonText: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  reconnectText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  webView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
} as const);
