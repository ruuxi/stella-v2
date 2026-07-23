import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import StaticServer from "react-native-static-server";
import { getMobileConvexToken } from "./src/auth";
import { CarPlayBridge } from "./src/CarPlayBridge";
import { loadInteriorBundle, type InteriorBundle } from "./src/interior-cache";
import { handleNativeRequest } from "./src/native-bridge";

void SplashScreen.preventAutoHideAsync();

function MobileShell() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const webview = useRef<WebView>(null);
  const [token, setToken] = useState("");
  const [bundle, setBundle] = useState<InteriorBundle | null>(null);
  const [interiorUri, setInteriorUri] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMobileConvexToken(), loadInteriorBundle()])
      .then(([nextToken, nextBundle]) => {
        if (cancelled) return;
        setToken(nextToken);
        setBundle(nextBundle);
        void SplashScreen.hideAsync();
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        void SplashScreen.hideAsync();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !bundle?.updateAvailable) return;
      void loadInteriorBundle().then((next) => setBundle(next));
    });
    return () => subscription.remove();
  }, [bundle?.updateAvailable]);

  useEffect(() => {
    if (!bundle) return;
    if (!bundle.directoryPath) {
      setInteriorUri(bundle.uri);
      return;
    }
    const server = new StaticServer(0, bundle.directoryPath, {
      localOnly: true,
      keepAlive: true,
    });
    let cancelled = false;
    void server
      .start()
      .then((origin) => {
        if (!cancelled) setInteriorUri(`${origin}/index.html`);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
      void server.stop();
    };
  }, [bundle]);

  const injected = useMemo(
    () =>
      token
        ? `try{localStorage.setItem("stella-color-mode","system")}catch{};window.__STELLA_MOBILE_SHELL__={token:${JSON.stringify(
            token,
          )},platform:${JSON.stringify(Platform.OS)}};document.documentElement.setAttribute('data-platform','mobile');true;`
        : "true;",
    [token],
  );

  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.brand}>Stella</Text>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!bundle || !token || !interiorUri) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.brand}>Stella</Text>
        <ActivityIndicator color="#6f766e" />
        <Text style={styles.muted}>Preparing your secure workspace…</Text>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.shell,
        colorScheme === "dark" && styles.shellDark,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <WebView
        ref={webview}
        source={{ uri: interiorUri }}
        style={styles.webview}
        originWhitelist={[
          "https://*",
          "http://127.0.0.1:*",
          "http://localhost:*",
        ]}
        injectedJavaScriptBeforeContentLoaded={injected}
        injectedJavaScriptForMainFrameOnly
        onMessage={(event) =>
          void handleNativeRequest(webview, event.nativeEvent.data)
        }
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures
        allowsLinkPreview={false}
        keyboardDisplayRequiresUserAction={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        allowsFullscreenVideo
        mixedContentMode="never"
        overScrollMode="never"
        pullToRefreshEnabled
        contentInsetAdjustmentBehavior="never"
        onRenderProcessGone={() => webview.current?.reload()}
      />
      <CarPlayBridge webview={webview} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileShell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: "#f8f7f3" },
  shellDark: { backgroundColor: "#171a17" },
  webview: { flex: 1, backgroundColor: "transparent" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 28,
    backgroundColor: "#f8f7f3",
  },
  brand: {
    fontSize: 36,
    fontWeight: "500",
    color: "#191b18",
    letterSpacing: -1.5,
  },
  muted: { color: "#6f766e", fontSize: 15 },
  error: {
    color: "#8d342c",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
});
