/**
 * Whether first run still has to ask about pairing a computer.
 *
 * Reach is granted on demand now: `ensurePhoneAccess` attaches this phone to
 * any computer the account already lists, so a signed-in owner with a computer
 * on the account never needs to carry a code between two screens. The step is
 * only worth showing when that codeless path cannot work — a guest (the attach
 * route refuses an anonymous caller), an account with no computer yet, or a
 * device list we could not read.
 *
 * `null` until the answer is known, so the flow keeps the step until the probe
 * settles rather than flashing it away.
 */
import { useEffect, useState } from "react";
import { listExecutionDevices } from "../../lib/execution-placement";
import { getPreferredPhoneAccess } from "../../lib/phone-access";

export function usePairingStepNeeded(signedIn: boolean): boolean | null {
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
