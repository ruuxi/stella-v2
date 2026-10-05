/**
 * Reading a device's two independent facts: it is listed, and it is willing to
 * run work sent from elsewhere.
 *
 * Being in `GET /owners/me/devices` only means that computer is signed in.
 * Consent is `remoteExecution`, and `remoteExecutionEnabled` is that state
 * being `"enabled"`. Nothing here derives one from the other, and nothing here
 * writes: enabling is an explicit user action, never a consequence of
 * rendering, polling or picking a target.
 */

import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";

/** The parts of a device these readers need; the full destination satisfies it. */
export type RemoteExecutionDeviceView = Pick<
  DeviceDestination,
  "online" | "remoteExecutionEnabled" | "remoteExecution"
> & {
  availability?: DeviceDestination["availability"];
};

/**
 * Why a listed device cannot be dispatched to, or `null` when it can.
 *
 * `notEnabled`, `asking` and `declined` are three different answers to the
 * consent question and the user acts on each differently: enable it, wait for
 * the prompt on that screen, or know it was refused. Collapsing them into one
 * "unavailable" is what made the picker uninformative.
 */
export type DeviceExecutionBlocker =
  | "offline"
  | "notEnabled"
  | "asking"
  | "declined"
  | "notReady";

/**
 * The dispatch eligibility rule, unchanged: present, consented, and ready.
 * Slot counting was removed deliberately — readiness is the whole story.
 */
export const isExecutionDeviceSelectable = (
  device: RemoteExecutionDeviceView,
): boolean =>
  device.online &&
  device.remoteExecutionEnabled &&
  device.availability?.ready === true;

export const executionDeviceBlocker = (
  device: RemoteExecutionDeviceView,
): DeviceExecutionBlocker | null => {
  if (isExecutionDeviceSelectable(device)) return null;
  // Presence first: a computer that is off cannot answer a prompt either, so
  // "Offline" is the fact the user can act on.
  if (!device.online) return "offline";
  switch (device.remoteExecution) {
    case "unconfigured":
      return "notEnabled";
    case "asking":
      return "asking";
    case "declined":
      return "declined";
    default:
      return "notReady";
  }
};
