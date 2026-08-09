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
import { probeDesktopBridgeStatus } from "../../src/lib/desktop-bridge-discovery";
import { useT } from "../../src/i18n";

type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
  mobileBridgeCapabilities?: {
    version: number;
    capabilities: {
      mode: string;
      path: string;
      channel?: string;
      transport?: string;
      reason?: string;
    }[];
  };
};

const EMPTY_BRIDGE_BOOTSTRAP: MobileBridgeBootstrap = { localStorage: {} };
const DESKTOP_WAKE_ATTEMPTS = 8;
const DESKTOP_WAKE_RETRY_MS = 1_000;
const BRIDGE_HEALTH_TIMEOUT_MS = 3_000;

type BridgeState = {
  bridgeUrl: string;
  headers: Record<string, string>;
  uri: string;
  bootstrap: MobileBridgeBootstrap;
  access: StoredPhoneAccess;
};

type ScreenState =
  // `messageKey` / `titleKey` are catalog keys resolved at render time, so a
  // language change repaints existing state instead of stranding old copy.
  | { type: "loading"; messageKey: string }
  | {
      type: "unavailable";
      /** Already-resolved backend/user-facing error text, or null. */
      error: string | null;
      titleKey: string;
      titleParams?: Record<string, string | number>;
    }
  | { type: "ready"; bridge: BridgeState };

type ShimMessage =
  | { type: "openExternal"; url: string }
  | { type: "connectionState"; connected: boolean }
  | { type: "capabilityUnavailable"; capability: string }
  | { type: "bridgeContractMismatch"; channel: string };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const canReachBridgeHealth = async (baseUrl: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/bridge/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

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
    case "capabilityUnavailable":
      assert(
        typeof value.capability === "string",
        "WebView capability name is required.",
      );
      return { type: "capabilityUnavailable", capability: value.capability };
    case "bridgeContractMismatch":
      assert(
        typeof value.channel === "string",
        "WebView channel name is required.",
      );
      return { type: "bridgeContractMismatch", channel: value.channel };
  }
  throw new Error(`Unknown WebView message type: ${value.type}`);
}

function readUnavailableState(
  titleKey: string,
  error: string | null = null,
  titleParams?: Record<string, string | number>,
): Extract<ScreenState, { type: "unavailable" }> {
  return {
    type: "unavailable",
    error,
    titleKey,
    titleParams,
  };
}

function GuestDesktopScreen() {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.bottom),
    [colors, insets.bottom],
  );
  return (
    <View style={styles.centered}>
      <DesktopTabAnimation />
      <Text style={styles.title}>{t("mobile.desktop.pairTitle")}</Text>
      <Text style={styles.body}>{t("mobile.desktop.guestBody")}</Text>
      <SignInPrompt message={t("mobile.desktop.guestSignInPrompt")} />
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
  const t = useT();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.bottom),
    [colors, insets.bottom],
  );
  const router = useRouter();
  const webViewRef = useRef<WebView>(null);
  const preferredAccessRef = useRef<StoredPhoneAccess | null>(null);
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

  const [screenState, setScreenState] = useState<ScreenState>({
    type: "loading",
    messageKey: "mobile.desktop.connecting",
  });
  const [canGoBack, setCanGoBack] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(true);
  // Desktop capabilities the mirrored UI asked for and could not have here.
  // Tracked so the refusal is visible even when the caller swallowed it.
  const [limitedCapabilities, setLimitedCapabilities] = useState<string[]>([]);
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
        messageKey: "mobile.desktop.connecting",
      });

      const access =
        nextAccess === undefined
          ? (preferredAccessRef.current ?? (await getPreferredPhoneAccess()))
          : nextAccess;

      if (!access) {
        updatePreferredAccess(null);
        setPairedDesktops([]);
        setScreenState(readUnavailableState("mobile.desktop.pairTitle"));
        return;
      }

      updatePreferredAccess(access);
      void listStoredPairedPhoneAccess().then(setPairedDesktops);

      try {
        await requestDesktopConnection(access);
        let status = await getDesktopBridgeStatus(access.desktopDeviceId);
        let baseUrl = "";
        for (
          let attempt = 0;
          attempt < DESKTOP_WAKE_ATTEMPTS && !baseUrl;
          attempt += 1
        ) {
          const probe = await probeDesktopBridgeStatus(
            status,
            access.desktopDeviceId,
            canReachBridgeHealth,
          );
          // A durable descriptor is accepted only when health-confirmed. A
          // currently leased URL retains the old unverified fallback so this
          // mobile build still works with desktops that predate /bridge/health.
          baseUrl = probe.reachableUrl ?? probe.liveFallbackUrl ?? "";
          if (!baseUrl && attempt < DESKTOP_WAKE_ATTEMPTS - 1) {
            await sleep(DESKTOP_WAKE_RETRY_MS);
            status = await getDesktopBridgeStatus(access.desktopDeviceId);
          }
        }

        if (!baseUrl) {
          const platform =
            status.platform ?? status.lastKnownRegistration?.platform;
          setScreenState(
            platform
              ? readUnavailableState(
                  "mobile.desktop.deviceUnreachable",
                  null,
                  { platform },
                )
              : readUnavailableState("mobile.desktop.unreachable"),
          );
          return;
        }

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
              "mobile.desktop.pairTitle",
              t("mobile.desktop.repairNeeded"),
            ),
          );
          return;
        }

        setScreenState(
          readUnavailableState("mobile.desktop.unreachable", message),
        );
      }
    },
    [t, updatePreferredAccess],
  );

  const pairPhone = useCallback(
    async (value: string) => {
      const nextCode = normalizePairingCode(value);
      if (!nextCode) {
        setScreenState(
          readUnavailableState(
            "mobile.desktop.pairTitle",
            t("mobile.desktop.enterCode"),
          ),
        );
        return;
      }

      setIsPairing(true);
      setScreenState({
        type: "loading",
        messageKey: "mobile.desktop.pairing",
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
        setScreenState(
          readUnavailableState("mobile.desktop.pairTitle", result.error),
        );
      }
    },
    [router, setScreenState, t, updatePreferredAccess],
  );

  useEffect(() => {
    if (isPairingOnly) {
      // Pairing deep link — show the pair sheet immediately and skip the
      // bridge refresh entirely so the desktop tunnel/WebView only starts
      // when the user explicitly opens View computer.
      setScreenState(readUnavailableState("mobile.desktop.pairTitle"));
      setIsPairSheetOpen(true);
      return;
    }
    void refreshBridge();
    // Once loaded, the WebView bridge's connectionState messages are the
    // liveness source of truth. Backend availability is only discovery
    // metadata and may be false after its lease expires.
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
    if (message.type === "bridgeContractMismatch") {
      // The shim and the desktop disagree about a channel's payload. The call
      // still went out, so this is a defect signal rather than something to
      // put in front of the user; the parity tests are what should have caught
      // it, and this is the net underneath them.
      console.error(
        `[stella-bridge] Payload contract mismatch on ${message.channel}`,
      );
    }
    if (message.type === "capabilityUnavailable") {
      setLimitedCapabilities((current) =>
        current.includes(message.capability)
          ? current
          : [...current, message.capability],
      );
    }
  };

  if (screenState.type === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.secondaryText}>{t(screenState.messageKey)}</Text>
      </View>
    );
  }

  if (screenState.type === "unavailable") {
    const showRetry = Boolean(preferredAccess);
    return (
      <View style={styles.unavailableView}>
        <View style={styles.statusBlock}>
          <DesktopTabAnimation />
          <Text style={styles.title}>
            {t(screenState.titleKey, screenState.titleParams)}
          </Text>
          <Text style={styles.body}>
            {preferredAccess
              ? t("mobile.desktop.unavailableBodyPaired")
              : t("mobile.desktop.unavailableBodyUnpaired")}
          </Text>
          {screenState.error && (
            <Text style={styles.errorText}>{screenState.error}</Text>
          )}
        </View>

        <View style={styles.actionRow}>
          <PrimaryButton
            label={
              preferredAccess
                ? t("mobile.desktop.pairAnother")
                : t("mobile.computer.pairPhone")
            }
            onPress={() => setIsPairSheetOpen(true)}
            disabled={isPairing}
            accessibilityLabel={
              preferredAccess
                ? t("mobile.desktop.pairAnother")
                : t("mobile.desktop.startPairingLabel")
            }
          />

          {showRetry && (
            <Pressable
              onPress={() => void refreshBridge()}
              accessibilityLabel={t("mobile.desktop.retryLabel")}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.secondaryButtonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {t("mobile.common.tryAgain")}
              </Text>
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
            accessibilityLabel={t("mobile.common.back")}
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
            {!bridgeConnected ? (
              <>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.reconnectText}>
                  {t("mobile.desktop.reconnecting")}
                </Text>
              </>
            ) : (
              limitedCapabilities.length > 0 && (
                <Text style={styles.reconnectText} numberOfLines={1}>
                  {t("mobile.desktop.limitedCapabilities")}
                </Text>
              )
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
                "mobile.desktop.unreachable",
                t("mobile.desktop.linkInterrupted"),
              ),
            )
          }
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 500) {
              setScreenState(
                readUnavailableState("mobile.desktop.unreachable"),
              );
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
