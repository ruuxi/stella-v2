import type { DeviceRemoteExecution } from "@stella/contracts/turn-plane/placement";
import type { ExecutionDeviceDestination } from "../../lib/execution-placement";
import type { StoredPhoneAccess } from "../../lib/phone-access";

/**
 * What a listed computer is doing about dispatched work right now.
 *
 * Being listed and being willing to run work are different facts, so the list
 * never collapses them into one "unavailable": each kind below says which of
 * the two is missing, and only the consent kinds are something a tap here can
 * answer.
 */
export type ComputerRowStatusKind =
  | "online"
  | "notReady"
  | "notEnabled"
  | "awaitingConsent"
  | "declined"
  | "offline";

export type ComputerRow = {
  deviceId: string;
  /** The account's name for the computer, when the device list knows one. */
  label?: string;
  /** This phone's transport credential, when it already holds one. */
  access: StoredPhoneAccess | null;
  statusKind: ComputerRowStatusKind;
  /** The live chat status ("Asleep", "Waking up…") is better copy than "Offline". */
  preferActiveStatusLabel: boolean;
  /** Selectable: online, consented, and ready for work. */
  available: boolean;
  /**
   * The account's device list knows this computer, so enabling it is a call
   * the backend will accept. A stored-only row (a pairing whose desktop is no
   * longer registered) has nothing to enable.
   */
  listed: boolean;
  /** Listed and not consented yet: an explicit Enable tap is the way in. */
  canEnable: boolean;
};

/**
 * `remoteExecution` is the authority; `remoteExecutionEnabled` is its boolean
 * shorthand. A build whose backend predates the four states still answers with
 * the boolean alone, and reading it as "enabled or never asked" is what that
 * backend meant.
 */
const remoteExecutionOf = (
  device: ExecutionDeviceDestination,
): DeviceRemoteExecution =>
  device.remoteExecution ??
  (device.remoteExecutionEnabled ? "enabled" : "unconfigured");

const statusKindOf = (
  device: ExecutionDeviceDestination | undefined,
): ComputerRowStatusKind => {
  if (!device) return "offline";
  const state = remoteExecutionOf(device);
  // Consent comes first when it is missing: it is the one thing the owner can
  // settle from this screen, and an offline computer can be enabled now and
  // honour it the moment it comes back.
  if (state === "unconfigured") return "notEnabled";
  if (state === "asking") return "awaitingConsent";
  if (state === "declined") return "declined";
  if (!device.online) return "offline";
  return device.availability?.ready === true ? "online" : "notReady";
};

/**
 * The account's computers, with this phone's stored access joined on where it
 * happens to exist.
 *
 * The list is the account's device list, not this phone's pairings: every
 * computer signed into the account appears, whether or not this phone has ever
 * held a credential for it. A pairing whose desktop is missing from the device
 * list still shows (it is something the owner can forget) but is not listed,
 * so nothing offers to enable it.
 */
export const buildComputerRows = (props: {
  devices: ExecutionDeviceDestination[] | undefined;
  stored: StoredPhoneAccess[];
  /** The computer the chat is currently connected through, if any. */
  activeDeviceId?: string | null;
}): ComputerRow[] => {
  const storedByDeviceId = new Map(
    props.stored.map((access) => [access.desktopDeviceId, access]),
  );
  const rows: ComputerRow[] = [];
  const seen = new Set<string>();

  const push = (
    deviceId: string,
    device: ExecutionDeviceDestination | undefined,
  ) => {
    if (seen.has(deviceId)) return;
    seen.add(deviceId);
    const statusKind = statusKindOf(device);
    // Deliberately unchanged: online, consented, ready. No slot counting.
    const available = Boolean(
      device?.online &&
        device.remoteExecutionEnabled &&
        device.availability?.ready === true,
    );
    rows.push({
      deviceId,
      ...(device?.label ? { label: device.label } : {}),
      access: storedByDeviceId.get(deviceId) ?? null,
      statusKind,
      preferActiveStatusLabel:
        props.activeDeviceId === deviceId && statusKind === "offline",
      available,
      listed: Boolean(device),
      canEnable: device ? remoteExecutionOf(device) !== "enabled" : false,
    });
  };

  for (const device of props.devices ?? []) push(device.deviceId, device);
  for (const access of props.stored) push(access.desktopDeviceId, undefined);

  return rows;
};
