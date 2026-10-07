import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { parseWorkspaceApps } from "@stella/contracts/workspace-apps";
import { useEffect, useMemo, useState } from "react";
import { backendUrl } from "@/platform/backend/backend-client";
import type { CloudApp } from "./cloud-api";
export type CloudAppsState = {
  accountScope: string;
  phase: "disabled" | "loading" | "ready" | "error";
  apps: CloudApp[];
  error: string | null;
  httpOrigin: string | null;
};
export const isDeployedCloudApp = (app: CloudApp) => app.status === "ready";
// Every poll is a backend round trip against the owner's objects, so this
// refreshes slowly and only while the window is actually being looked at; a
// window that comes back to the foreground refreshes immediately.
const APPS_REFRESH_MS = 60_000;
export function useCloudApps(): CloudAppsState {
  const { isCloudConversationReady, accountScope } =
    useCloudConversationSession();
  const origin = isCloudConversationReady && backendUrl ? backendUrl : null;
  const [result, setResult] = useState<{
    scope: string;
    apps: CloudApp[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const schedule = () => {
      clearTimeout(timer);
      if (cancelled || !visible()) return;
      timer = setTimeout(() => void load(), APPS_REFRESH_MS);
    };
    const load = async () => {
      if (cancelled || loading) return;
      loading = true;
      try {
        const response = await fetch(`${origin}/owners/me/apps`, {
          headers: await getAuthHeaders(),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error("Apps could not be loaded.");
        const data = await response.json();
        const apps = parseWorkspaceApps(data.apps);
        if (!cancelled) setResult({ scope: accountScope, apps, error: null });
      } catch (e) {
        if (!cancelled)
          setResult((previous) => ({
            scope: accountScope,
            apps: previous?.scope === accountScope ? previous.apps : [],
            error: e instanceof Error ? e.message : "Apps could not be loaded.",
          }));
      } finally {
        loading = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (visible()) void load();
      else clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (visible()) void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [origin, accountScope]);
  return useMemo(
    () => ({
      accountScope,
      httpOrigin: origin,
      phase: !isCloudConversationReady
        ? "disabled"
        : !result || result.scope !== accountScope
          ? "loading"
          : result.error
            ? "error"
            : "ready",
      apps: result?.scope === accountScope ? result.apps : [],
      error: result?.scope === accountScope ? result.error : null,
    }),
    [accountScope, origin, isCloudConversationReady, result],
  );
}
