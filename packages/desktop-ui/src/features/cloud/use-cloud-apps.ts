import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { parseWorkspaceApps } from "@stella/contracts/workspace-apps";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { cloudApi, type CloudApp } from "./cloud-api";
export type CloudAppsState = {
  accountScope: string;
  phase: "disabled" | "loading" | "ready" | "error";
  apps: CloudApp[];
  error: string | null;
  httpOrigin: string | null;
};
export const isDeployedCloudApp = (app: CloudApp) => app.status === "ready";
export function useCloudApps(): CloudAppsState {
  const { isCloudConversationReady, accountScope } =
    useCloudConversationSession();
  const config = useQuery(
    cloudApi.getCloudRealtimeConfig,
    isCloudConversationReady ? {} : "skip",
  );
  const origin = config?.httpOrigin ?? null;
  const [result, setResult] = useState<{
    scope: string;
    apps: CloudApp[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
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
      }
      if (!cancelled) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
