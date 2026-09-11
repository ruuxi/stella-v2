import {
  parseWorkspaceApps,
  type WorkspaceApp as App,
} from "@stella/contracts/workspace-apps";
import { MainDetailSurface } from "../../src/components/MainScreenSurface";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
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
  return (
    <MainDetailSurface>
      {frame ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to apps"
            onPress={() => setFrame(null)}
            style={{ padding: 16 }}
          >
            <Text style={{ color: colors.text }}>‹ Apps · {frame.title}</Text>
          </Pressable>
          <WebView
            key={frame.url}
            source={{ uri: frame.url }}
            style={{ flex: 1 }}
            javaScriptEnabled
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            setSupportMultipleWindows={false}
            onError={() => {
              setFrame(null);
              setError("App could not be loaded. Try opening it again.");
            }}
            onShouldStartLoadWithRequest={(request) =>
              request.url === "about:blank" || request.url.startsWith(frame.url)
            }
          />
        </>
      ) : (
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
      )}
    </MainDetailSurface>
  );
}
