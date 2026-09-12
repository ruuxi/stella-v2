import {
  parseWorkspaceApps,
  type WorkspaceApp as App,
} from "@stella/contracts/workspace-apps";
import { MainDetailSurface } from "../../src/components/MainScreenSurface";
import { AppBackdrop } from "../../src/components/AppBackdrop";
import { publishBackOverride } from "../../src/lib/main-shell-store";
import { useT } from "../../src/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { WebView } from "react-native-webview";
import { useColors } from "../../src/theme/theme-context";
import { getConvexToken } from "../../src/lib/auth-token";
import { authClient } from "../../src/lib/auth-client";
const configQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  { httpOrigin: string | null }
>("cloud_apps:getCloudRealtimeConfig");

export default function AppsScreen() {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useConvexAuth();
  const { data: session } = authClient.useSession();
  const config = useQuery(configQuery, isAuthenticated ? {} : "skip");
  const scope = useRef(0);
  const [opening, setOpening] = useState(false);
  const [apps, setApps] = useState<App[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ url: string; title: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  // While an app is open, the shell's single top-left chevron closes it
  // instead of popping the route, and Android hardware back matches.
  const frameOpen = frame !== null;
  const backLabel = t("mobile.nav.backToApps");
  useEffect(() => {
    if (!frameOpen) return;
    const close = () => setFrame(null);
    publishBackOverride({ label: backLabel, onPress: close });
    const hardware = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => {
      hardware.remove();
      publishBackOverride(null);
    };
  }, [frameOpen, backLabel]);
  const frameStyles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, minHeight: 0 },
        // Edge to edge: no detail-surface gutter, only the home indicator.
        keyboard: { flex: 1, paddingBottom: insets.bottom },
        web: { flex: 1, backgroundColor: "transparent" },
      }),
    [insets.bottom],
  );
  useEffect(() => {
    scope.current++;
    setOpening(false);
    setApps([]);
    setFrame(null);
    setError(null);
    setLoading(true);
    if (!config?.httpOrigin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const token = await getConvexToken();
        if (!token) throw new Error("Sign in to view your apps.");
        const response = await fetch(`${config.httpOrigin}/owners/me/apps`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error("Apps could not be loaded.");
        const data = await response.json();
        if (!cancelled) {
          setApps(parseWorkspaceApps(data.apps));
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Apps could not be loaded.",
          );
          setLoading(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      cancelled = true;
      scope.current++;
      clearTimeout(timer);
    };
  }, [config?.httpOrigin, session?.user.id]);
  const open = async (app: App) => {
    const currentScope = scope.current;
    setOpening(true);
    setError(null);
    try {
      const token = await getConvexToken();
      const response = await fetch(
        `${config?.httpOrigin}/owners/me/apps/${encodeURIComponent(app.slug)}/session`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
        },
      );
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string")
        throw new Error(data.error ?? "App could not be opened.");
      if (currentScope === scope.current)
        setFrame({ url: data.url, title: app.title });
    } catch (e) {
      if (currentScope === scope.current)
        setError(e instanceof Error ? e.message : "App could not be opened.");
    } finally {
      if (currentScope === scope.current) setOpening(false);
    }
  };
  if (frame) {
    return (
      <View style={frameStyles.root}>
        <AppBackdrop />
        <KeyboardAvoidingView
          style={frameStyles.keyboard}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <WebView
            key={frame.url}
            source={{ uri: frame.url }}
            style={frameStyles.web}
            javaScriptEnabled
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            setSupportMultipleWindows={false}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            keyboardDisplayRequiresUserAction={false}
            onError={() => {
              setFrame(null);
              setError("App could not be loaded. Try opening it again.");
            }}
            onShouldStartLoadWithRequest={(request) =>
              request.url === "about:blank" || request.url.startsWith(frame.url)
            }
          />
        </KeyboardAvoidingView>
      </View>
    );
  }
  return (
    <MainDetailSurface>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 26, color: colors.text }}
        >
          Apps
        </Text>
        {loading || opening ? <ActivityIndicator /> : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.text }}>
            {error}
          </Text>
        ) : null}
        {!loading && apps.length === 0 && !error ? (
          <Text style={{ color: colors.text }}>
            Ask Stella to create an app.
          </Text>
        ) : null}
        {apps.map((app) => (
          <Pressable
            key={app.slug}
            accessibilityRole="button"
            accessibilityLabel={app.title}
            disabled={opening || app.status !== "ready"}
            onPress={() => void open(app)}
            style={{
              padding: 16,
              borderRadius: 12,
              backgroundColor: colors.surface,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 17 }}>
              {app.title}
            </Text>
            {app.error ? (
              <Text style={{ color: colors.text }}>{app.error}</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </MainDetailSurface>
  );
}
