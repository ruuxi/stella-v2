import { useEffect, useRef } from "react";
import { EngineTokenRefresher } from "@stella/contracts/backend/engine-refresher";
import { getBackendClient } from "./backend";
import { useAppVisible } from "./use-app-visible";

/**
 * While the app is open, this phone helps keep the owner's Claude sign-ins
 * fresh: Stella's server never refreshes them, one of the owner's devices
 * does (see EngineTokenRefresher). Paused in the background, when the
 * desktop app, if any, carries on.
 */
export function useEngineTokenRefresher(): void {
  const visible = useAppVisible();
  const refresher = useRef<EngineTokenRefresher | null>(null);

  useEffect(() => {
    const client = () => {
      try {
        return getBackendClient();
      } catch {
        return null;
      }
    };
    const instance = new EngineTokenRefresher({ client });
    refresher.current = instance;
    const unwatch = client()?.watch(
      "engines.get",
      {},
      (settings) => instance.update(settings),
      () => instance.update(null),
    );
    return () => {
      unwatch?.();
      instance.dispose();
      if (refresher.current === instance) refresher.current = null;
    };
  }, []);

  useEffect(() => {
    refresher.current?.setActive(visible);
  }, [visible]);
}
