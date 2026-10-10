/**
 * Whether first run still needs the computer message.
 *
 * A computer signed in to the account reaches this phone on its own, so the
 * message only matters when there is none yet: a guest, an account with no
 * computer, or a device list we could not read.
 *
 * `null` until the answer is known, so the flow keeps the step until the probe
 * settles rather than flashing it away.
 */
import { useEffect, useState } from "react";
import { listExecutionDevices } from "../../lib/execution-placement";
import { getPreferredPhoneAccess } from "../../lib/phone-access";

export function useComputerStepNeeded(signedIn: boolean): boolean | null {
  const [needed, setNeeded] = useState<boolean | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setNeeded(true);
      return;
    }
    let cancelled = false;
    setNeeded(null);
    void (async () => {
      try {
        const stored = await getPreferredPhoneAccess();
        if (cancelled) return;
        if (stored) {
          setNeeded(false);
          return;
        }
        const devices = await listExecutionDevices();
        if (cancelled) return;
        setNeeded(devices.length === 0);
      } catch {
        if (!cancelled) setNeeded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  return needed;
}
