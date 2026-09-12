import {
  parseWorkspaceApps,
  type WorkspaceApp,
} from "@stella/contracts/workspace-apps";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackdrop } from "./AppBackdrop";
import { publishBackOverride } from "../lib/main-shell-store";
import { useT } from "../i18n";
import { MainDetailSurface } from "./MainScreenSurface";
import { useColors } from "../theme/theme-context";
import { getConvexTokenForSubject } from "../lib/auth-token";
import { authClient } from "../lib/auth-client";
import {
  appListCacheKey,
  reusableAppFrame,
  retainAppFrame,
  type AppFrame,
} from "../lib/app-cache";

const configQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  { httpOrigin: string | null }
>("cloud_apps:getCloudRealtimeConfig");

/** Owned by the shell: navigating away must not discard the library or WebViews. */
export function PersistentAppsHost({ visible }: { visible: boolean }) {
  const { isAuthenticated } = useConvexAuth();
  const { data: session } = authClient.useSession();
  const config = useQuery(configQuery, isAuthenticated ? {} : "skip");
  const owner = isAuthenticated ? session?.user.id : undefined;
  if (!owner || !config?.httpOrigin)
    return visible ? (
      <View style={StyleSheet.absoluteFill}>
        <MainDetailSurface>
          {isAuthenticated && config === undefined ? (
            <ActivityIndicator />
          ) : (
            <Text>Apps are unavailable. Please try again.</Text>
          )}
        </MainDetailSurface>
      </View>
    ) : null;
  return (
    <AppsHost
      key={appListCacheKey(owner, config.httpOrigin)}
      owner={owner}
      origin={config.httpOrigin}
      visible={visible}
    />
  );
}

function AppsHost({
  owner,
  origin,
  visible,
}: {
  owner: string;
  origin: string;
  visible: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const [apps, setApps] = useState<WorkspaceApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [frames, setFrames] = useState<AppFrame[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  const request = useRef(0);
  const mounted = useRef(true);
  const openingRef = useRef(false);
  const preloaded = useRef(false);
  const persistedList = useRef<string | null>(null);
  const cacheKey = appListCacheKey(owner, origin);
  const frame = frames.find((entry) => entry.slug === selected);
  const frameOpen = visible && frame !== undefined;
  const backLabel = t("mobile.nav.backToApps");
  useEffect(() => {
    if (!frameOpen) return;
    const close = () => setSelected(null);
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

  useEffect(() => {
    mounted.current = true;
    const generation = request;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(cacheKey)
      .then((stored) => {
        if (!cancelled && stored) {
          try {
            const cached = parseWorkspaceApps(JSON.parse(stored));
            setApps((current) => current ?? cached);
          } catch {
            /* Ignore an obsolete or damaged cache. */
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  // Preload once at shell entry. Poll only while the library is visible and
  // foregrounded; returning triggers a refresh without hiding cached content.
  useEffect(() => {
    if (!active || (!visible && preloaded.current)) return;
    preloaded.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController;
    const load = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const token = await getConvexTokenForSubject(owner);
        if (cancelled) return;
        const response = await fetch(`${origin}/owners/me/apps`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Apps could not be refreshed.");
        const data = parseWorkspaceApps((await response.json()).apps);
        if (cancelled) return;
        setApps((current) =>
          JSON.stringify(current) === JSON.stringify(data) ? current : data,
        );
        setError(null);
        setFrames((current) =>
          current.filter((entry) =>
            data.some(
              (app) => app.slug === entry.slug && app.status === "ready",
            ),
          ),
        );
        const serialized = JSON.stringify(data);
        if (persistedList.current !== serialized) {
          persistedList.current = serialized;
          void AsyncStorage.setItem(cacheKey, serialized).catch(() => {
            persistedList.current = null;
          });
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Apps could not be refreshed.",
          );
      } finally {
        clearTimeout(timeout);
        if (!cancelled && visible)
          timer = setTimeout(() => void load(), 15_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [owner, origin, cacheKey, visible, active]);

  const open = async (app: WorkspaceApp) => {
    if (openingRef.current) return;
    const cached = reusableAppFrame(frames, app, Date.now());
    if (cached) {
      setFrames((current) => retainAppFrame(current, cached));
      setSelected(app.slug);
      setError(null);
      return;
    }
    const id = ++request.current;
    openingRef.current = true;
    setOpening(app.slug);
    setError(null);
    try {
      const token = await getConvexTokenForSubject(owner);
      if (!mounted.current || id !== request.current) return;
      const response = await fetch(
        `${origin}/owners/me/apps/${encodeURIComponent(app.slug)}/session`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
        },
      );
      const data = await response.json();
      if (
        !response.ok ||
        typeof data.url !== "string" ||
        !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= Date.now() + 60_000
      )
        throw new Error(data.error ?? "App could not be opened.");
      if (mounted.current && id === request.current) {
        setFrames((current) =>
          retainAppFrame(current, {
            slug: app.slug,
            revision: app.revision,
            title: app.title,
            url: data.url,
            expiresAt: data.expiresAt,
          }),
        );
        setSelected(app.slug);
      }
    } catch (e) {
      if (mounted.current && id === request.current)
        setError(e instanceof Error ? e.message : "App could not be opened.");
    } finally {
      if (mounted.current && id === request.current) {
        openingRef.current = false;
        setOpening(null);
      }
    }
  };
  const renewSelected = useEffectEvent(() => {
    const app = apps?.find((entry) => entry.slug === selected);
    if (app) void open(app);
  });
  // Retained pages outlive a navigation visit. Renew their one-hour access
  // before it expires, including when returning from a long background stay.
  useEffect(() => {
    if (!visible || !active || !frame) return;
    const timer = setTimeout(
      () => renewSelected(),
      Math.max(0, frame.expiresAt - Date.now() - 60_000),
    );
    return () => clearTimeout(timer);
  }, [visible, active, frame]);

  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      setFrames((current) =>
        current.filter((entry) => visible && entry.slug === selected),
      );
    });
    return () => subscription.remove();
  }, [visible, selected]);

  const discard = (entry: AppFrame) => {
    setFrames((current) => current.filter((item) => item.url !== entry.url));
    setError("App could not be loaded. Try opening it again.");
  };
  return (
    <View
      style={[StyleSheet.absoluteFill, { display: visible ? "flex" : "none" }]}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <AppBackdrop />
      <View style={{ flex: 1, display: frame ? "none" : "flex" }}>
        <MainDetailSurface>
          <ScrollView
            style={{ display: frame ? "none" : "flex" }}
            contentContainerStyle={{ padding: 20, gap: 16 }}
          >
            <Text
              accessibilityRole="header"
              style={{ fontSize: 26, color: colors.text }}
            >
              Apps
            </Text>
            {apps === null && !error ? <ActivityIndicator /> : null}
            {error ? (
              <Text accessibilityRole="alert" style={{ color: colors.text }}>
                {error}
              </Text>
            ) : null}
            {apps?.length === 0 && !error ? (
              <Text style={{ color: colors.text }}>
                Ask Stella to create an app.
              </Text>
            ) : null}
            {apps?.map((app) => (
              <Pressable
                key={app.slug}
                accessibilityRole="button"
                accessibilityLabel={app.title}
                accessibilityState={{ busy: opening === app.slug }}
                disabled={opening !== null || app.status !== "ready"}
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
                {opening === app.slug ? <ActivityIndicator /> : null}
                {app.error ? (
                  <Text style={{ color: colors.text }}>{app.error}</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </MainDetailSurface>
      </View>
      {frames.map((entry) => (
        <KeyboardAvoidingView
          key={entry.url}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{
            flex: 1,
            display: selected === entry.slug ? "flex" : "none",
            paddingBottom: insets.bottom,
          }}
          accessibilityElementsHidden={selected !== entry.slug}
          importantForAccessibility={
            selected === entry.slug ? "auto" : "no-hide-descendants"
          }
        >
          <WebView
            source={{ uri: entry.url }}
            style={{ flex: 1, backgroundColor: "transparent" }}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            keyboardDisplayRequiresUserAction={false}
            javaScriptEnabled
            cacheEnabled
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            setSupportMultipleWindows={false}
            onError={() => discard(entry)}
            onHttpError={(event) => {
              if (event.nativeEvent.url === entry.url) discard(entry);
            }}
            onContentProcessDidTerminate={() => discard(entry)}
            onRenderProcessGone={() => discard(entry)}
            onShouldStartLoadWithRequest={(event) =>
              event.url === "about:blank" || event.url.startsWith(entry.url)
            }
          />
        </KeyboardAvoidingView>
      ))}
    </View>
  );
}
