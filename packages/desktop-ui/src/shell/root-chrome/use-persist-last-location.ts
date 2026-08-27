import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";
import { writePersistedLastLocation } from "@/shared/lib/last-location";

type Router = ReturnType<typeof useRouter>;

export function usePersistLastLocation(router: Router): void {
  useEffect(() => {
    return router.subscribe("onResolved", ({ toLocation }) => {
      const href =
        toLocation.pathname === "/chat" ? "/chat" : toLocation.href;
      writePersistedLastLocation(href);
    });
  }, [router]);
}
