import { useEffect, useState } from "react";
import { getDesktopBridgeStatus, type StoredPhoneAccess } from "./phone-access";

/**
 * Resolve each paired desktop's platform label ("macOS", "Windows", …) from
 * the bridge status, keyed by desktopDeviceId. Shared by the Account and
 * View-computer screens so the two surfaces can't disagree about which
 * computers exist and what they're called. Lookups run once per device; a
 * failed lookup is recorded as null so it isn't retried in a loop.
 */
export function useDesktopPlatforms(
  pairedDesktops: StoredPhoneAccess[],
): Record<string, string | null> {
  const [desktopPlatforms, setDesktopPlatforms] = useState<
    Record<string, string | null>
  >({});

  useEffect(() => {
    let cancelled = false;
    const missing = pairedDesktops.filter(
      (access) => !(access.desktopDeviceId in desktopPlatforms),
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (access) => {
        try {
          const status = await getDesktopBridgeStatus(access.desktopDeviceId);
          return [access.desktopDeviceId, status.platform ?? null] as const;
        } catch {
          return [access.desktopDeviceId, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDesktopPlatforms((prev) => {
        const next = { ...prev };
        for (const [id, platform] of entries) {
          next[id] = platform;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [desktopPlatforms, pairedDesktops]);

  return desktopPlatforms;
}
