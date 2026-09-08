import type { AutomaticExecutionTarget } from "./execution-placement-core";
import type { StoredPhoneAccess } from "./phone-access";

export type RealtimeVoiceRoute =
  | { execution: "phone"; desktopAccess: null }
  | { execution: "computer"; desktopAccess: StoredPhoneAccess };

/**
 * Decide where a realtime voice session runs from the user's execution
 * selection rather than from whether any computer happens to be paired.
 *
 * - Cloud: always the phone's own cloud session, even with paired computers.
 * - A specific computer: that computer's credentials, or the phone when the
 *   selection no longer matches a stored pairing.
 * - Automatic: the preferred paired computer when one exists, else the phone.
 */
export const resolveRealtimeVoiceRoute = (args: {
  executionTarget: AutomaticExecutionTarget;
  preferredAccess: StoredPhoneAccess | null;
  pairedDesktops: readonly StoredPhoneAccess[];
}): RealtimeVoiceRoute => {
  const { executionTarget, preferredAccess, pairedDesktops } = args;
  if (executionTarget.mode === "cloud") {
    return { execution: "phone", desktopAccess: null };
  }
  if (executionTarget.mode === "device") {
    const selected =
      pairedDesktops.find(
        (entry) => entry.desktopDeviceId === executionTarget.deviceId,
      ) ??
      (preferredAccess?.desktopDeviceId === executionTarget.deviceId
        ? preferredAccess
        : null);
    return selected
      ? { execution: "computer", desktopAccess: selected }
      : { execution: "phone", desktopAccess: null };
  }
  return preferredAccess
    ? { execution: "computer", desktopAccess: preferredAccess }
    : { execution: "phone", desktopAccess: null };
};
