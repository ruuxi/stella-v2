import { useCallback, useEffect, useRef, useState } from "react";

export type DesktopPermissionKind = "accessibility" | "screen" | "microphone";

type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export type DesktopPermissionStatus = Record<DesktopPermissionKind, boolean> & {
  microphoneStatus: MicrophonePermissionStatus;
};

type UseDesktopPermissionsOptions = {
  enabled?: boolean;
  pollMs: number;
  cooldownMs?: number;
  initialStatus: DesktopPermissionStatus;
  restartKinds?: readonly DesktopPermissionKind[];
  normalizeStatus?: (
    status: DesktopPermissionStatus,
  ) => DesktopPermissionStatus;
  unavailableMessage?: string;
  errorMessage?: (error: unknown) => string;
};

const defaultErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const useDesktopPermissions = ({
  enabled = true,
  pollMs,
  cooldownMs = 2000,
  initialStatus,
  restartKinds = [],
  normalizeStatus,
  unavailableMessage = "Desktop permission status is unavailable in this window.",
  errorMessage = defaultErrorMessage,
}: UseDesktopPermissionsOptions) => {
  const [status, setStatus] = useState(initialStatus);
  const [loaded, setLoaded] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<DesktopPermissionKind | null>(
    null,
  );
  const [restartRecommended, setRestartRecommended] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const [cooldownAction, setCooldownAction] =
    useState<DesktopPermissionKind | null>(null);
  const activeActionRef = useRef<DesktopPermissionKind | null>(null);
  const cooldownRef = useRef(false);
  const cooldownTimerRef = useRef<number | null>(null);
  const lastStatusRef = useRef<DesktopPermissionStatus | null>(null);

  useEffect(
    () => () => {
      if (cooldownTimerRef.current !== null) {
        window.clearTimeout(cooldownTimerRef.current);
      }
    },
    [],
  );

  const isShallowEqual = (
    a: DesktopPermissionStatus,
    b: DesktopPermissionStatus,
  ) =>
    a.accessibility === b.accessibility &&
    a.screen === b.screen &&
    a.microphone === b.microphone &&
    a.microphoneStatus === b.microphoneStatus;

  const refresh = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.getPermissionStatus) {
      throw new Error(unavailableMessage);
    }

    const rawStatus = await systemApi.getPermissionStatus();
    const nextStatus = normalizeStatus?.(rawStatus) ?? rawStatus;
    const previousStatus = lastStatusRef.current;
    if (
      previousStatus &&
      restartKinds.some((kind) => !previousStatus[kind] && nextStatus[kind])
    ) {
      setRestartRecommended(true);
    }

    if (previousStatus && isShallowEqual(previousStatus, nextStatus)) {
      return previousStatus;
    }
    lastStatusRef.current = nextStatus;
    setStatus(nextStatus);
    return nextStatus;
  }, [normalizeStatus, restartKinds, unavailableMessage]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const load = async () => {
      try {
        const nextStatus = await refresh();
        if (!cancelled) {
          setError(null);
        }
        return nextStatus;
      } catch (loadError) {
        if (!cancelled) {
          setError(errorMessage(loadError));
        }
        return null;
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    };

    let intervalId: number | null = null;
    const stopPolling = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const startPolling = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {

        if (document.visibilityState === "hidden") return;
        void load().then((next) => {

          if (
            next &&
            next.accessibility &&
            next.screen &&
            next.microphone
          ) {
            stopPolling();
          }
        });
      }, pollMs);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        startPolling();
      } else {
        stopPolling();
      }
    };
    const handleFocus = () => {

      if (document.visibilityState === "hidden") return;
      void load();
      startPolling();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);

    void load().then((next) => {
      if (cancelled) return;

      if (
        next &&
        next.accessibility &&
        next.screen &&
        next.microphone
      ) {
        return;
      }
      startPolling();
    });

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, errorMessage, pollMs, refresh]);

  const requestWithSettingsFallback = useCallback(
    async (kind: DesktopPermissionKind) => {
      const systemApi = window.electronAPI?.system;
      if (
        !systemApi?.requestPermission ||
        !systemApi.openPermissionSettings ||
        !systemApi.getPermissionStatus
      ) {
        throw new Error("Desktop permissions are unavailable in this window.");
      }

      if (activeActionRef.current || cooldownRef.current) {
        return lastStatusRef.current ?? initialStatus;
      }

      activeActionRef.current = kind;
      setActiveAction(kind);
      try {
        const result = await systemApi.requestPermission(kind);
        const nextStatus = await refresh();
        const canOpenSettingsFallback = kind !== "accessibility";
        if (
          canOpenSettingsFallback &&
          !nextStatus[kind] &&
          !result.granted &&
          !result.openedSettings
        ) {
          await systemApi.openPermissionSettings(kind);
        }
        return nextStatus;
      } finally {
        activeActionRef.current = null;
        setActiveAction(null);
        cooldownRef.current = true;
        setCooldownAction(kind);
        if (cooldownTimerRef.current !== null) {
          window.clearTimeout(cooldownTimerRef.current);
        }
        cooldownTimerRef.current = window.setTimeout(() => {
          cooldownRef.current = false;
          cooldownTimerRef.current = null;
          setCooldownAction(null);
        }, cooldownMs);
      }
    },
    [cooldownMs, initialStatus, refresh],
  );

  const restart = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.quitForRestart) {
      throw new Error("Restart is unavailable in this window.");
    }

    setIsRestarting(true);
    try {
      const result = await systemApi.quitForRestart();
      if (!result?.ok) {
        setIsRestarting(false);
      }
      return result;
    } catch (restartError) {
      setIsRestarting(false);
      throw restartError;
    }
  }, []);

  return {
    status,
    setStatus,
    loaded,
    error,
    setError,
    activeAction,
    setActiveAction,
    cooldownAction,
    restartRecommended,
    setRestartRecommended,
    isRestarting,
    refresh,
    requestWithSettingsFallback,
    restart,
  };
};
