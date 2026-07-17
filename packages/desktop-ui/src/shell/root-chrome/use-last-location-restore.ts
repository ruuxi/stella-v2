import { useEffect, useRef } from "react";
import type { useRouter } from "@tanstack/react-router";
import {
  readPersistedLastLocation,
  writePersistedLastLocation,
} from "@/shared/lib/last-location";
import { useWindowType } from "@/shared/hooks/use-window-type";

type Router = ReturnType<typeof useRouter>;

/** Route families removed from the primary v2 client. Match concrete dynamic
 * descendants, trailing slashes, and query/hash variants without catching
 * similarly prefixed live paths such as `/storefront`. */
export const isRetiredPrimaryLocation = (target: string): boolean => {
  const pathname = target.split(/[?#]/, 1)[0] ?? "";
  return /^\/(?:social|store|apps|c)(?:\/|$)/.test(pathname);
};

export const restorePersistedLastLocation = (router: Router): void => {
  const target = readPersistedLastLocation();
  if (!target || target === "/chat" || target === "/") return;

  // Retired route families always migrate to the stable Chat route. Replace
  // the initial memory-history entry and clear the stale persisted value so a
  // later mount/relaunch cannot replay the migration or create a back loop.
  if (isRetiredPrimaryLocation(target)) {
    writePersistedLastLocation("/chat");
    void router.navigate({ to: "/chat", replace: true });
    return;
  }

  const queryIndex = target.indexOf("?");
  const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const knownPaths = router.routesByPath as unknown as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(knownPaths, pathname)) {
    return;
  }

  const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
  const searchParams = Object.fromEntries(new URLSearchParams(search));

  void router.navigate({
    to: pathname,
    search: searchParams as never,
    replace: true,
  });
};

/**
 * Restore the last persisted location exactly once. Reads synchronously
 * from the shared UI state store (no async hydration race). Retired route
 * families migrate to Chat; live locations restore only when their pathname
 * matches a registered route. Anything else falls through to the
 * memory-history default (`/chat`).
 *
 * The mini window shares the UI state store with the full window, so it must
 * never restore the full window's last route — it always opens at home.
 */
export function useLastLocationRestore(router: Router): void {
  const isMiniWindow = useWindowType() === "mini";
  const restoredRef = useRef(false);
  useEffect(() => {
    if (isMiniWindow) return;
    if (restoredRef.current) return;
    restoredRef.current = true;

    restorePersistedLastLocation(router);
  }, [router, isMiniWindow]);
}
