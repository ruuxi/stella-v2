import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { cloudApi, type CloudApp } from "./cloud-api";

export type CloudAppsState = {
  accountScope: string;
  phase: "disabled" | "loading" | "ready" | "error";
  apps: CloudApp[];
  error: string | null;
};

export const isDeployedCloudApp = (app: CloudApp): boolean =>
  app.status === "active" && typeof app.activeBuildId === "string";

export function useCloudApps(): CloudAppsState {
  const {
    cloudMode,
    isLoading: cloudModeLoading,
    accountScope,
    error: cloudModeError,
  } = useCloudMode();
  const requests = useMemo<RequestForQueries>(() => {
    const next: RequestForQueries = {};
    if (cloudMode) {
      next.apps = {
        query: cloudApi.listMyApps,
        args: {},
      };
    }
    return next;
  }, [cloudMode]);
  const results = useQueries(requests);
  const value = results.apps;

  return useMemo(() => {
    if (!cloudMode) {
      return {
        accountScope,
        phase: cloudModeLoading
          ? ("loading" as const)
          : cloudModeError
            ? ("error" as const)
            : ("disabled" as const),
        apps: [],
        error: cloudModeError ?? null,
      };
    }
    if (value instanceof Error) {
      return {
        accountScope,
        phase: "error" as const,
        apps: [],
        error: value.message || "Cloud apps are unavailable right now.",
      };
    }
    if (!Array.isArray(value)) {
      return {
        accountScope,
        phase: "loading" as const,
        apps: [],
        error: null,
      };
    }
    return {
      accountScope,
      phase: "ready" as const,
      apps: value.filter(isDeployedCloudApp),
      error: null,
    };
  }, [
    accountScope,
    cloudMode,
    cloudModeError,
    cloudModeLoading,
    value,
  ]);
}
