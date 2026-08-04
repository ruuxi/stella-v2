import { useEffect, useRef } from "react";
import { readPersistedLastLocation } from "@/shared/lib/last-location";
/**
 * Restore the last persisted location exactly once. Reads synchronously
 * from the shared UI state store (no async hydration race) and only navigates if
 * the pathname matches a registered route in this router. Anything
 * else falls through to the memory-history default (`/chat`).
 */
export function useLastLocationRestore(router) {
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current)
            return;
        restoredRef.current = true;
        const target = readPersistedLastLocation();
        if (!target || target === "/chat" || target === "/")
            return;
        const queryIndex = target.indexOf("?");
        const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
        const knownPaths = router.routesByPath;
        // Which user app the user was inside is not a URL: it is the Apps
        // sidebar section's sub-location, which persists on its own and is
        // restored by the section. Nothing here needs to know about apps.
        if (!Object.prototype.hasOwnProperty.call(knownPaths, pathname))
            return;
        const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
        const searchParams = Object.fromEntries(new URLSearchParams(search));
        void router.navigate({
            to: pathname,
            search: searchParams,
        });
    }, [router]);
}
