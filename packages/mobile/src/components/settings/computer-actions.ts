import type { DeviceRemoteExecution } from "@stella/contracts/turn-plane/placement";
import { getBackendClient } from "../../lib/backend";
import type { ExecutionDeviceDestination } from "../../lib/execution-placement";

/**
 * Answer "accept work from your other devices?" for one computer from this
 * phone, which is signed into the same account.
 *
 * This is the only thing on the Settings screen that may change a computer's
 * consent, and it only ever runs from a tap. Listing a computer, polling its
 * presence, attaching this phone to it and selecting it all deliberately
 * leave `remoteExecution` alone — being listed and being willing to run work
 * are different facts, and this call is the second one.
 */
export const enableRemoteExecution = async (deviceId: string) =>
  await getBackendClient().call("devices.setRemoteExecution", {
    deviceId,
    enabled: true,
  });

/**
 * Fold the answer into the polled device list.
 *
 * Only the consent fields move: presence and readiness are the device's own
 * report, so a computer that just agreed still has to be online and ready
 * before anything may be dispatched to it.
 */
export const applyRemoteExecution = (
  devices: ExecutionDeviceDestination[] | undefined,
  deviceId: string,
  remoteExecution: DeviceRemoteExecution,
): ExecutionDeviceDestination[] | undefined =>
  devices?.map((device) =>
    device.deviceId === deviceId
      ? {
          ...device,
          remoteExecution,
          remoteExecutionEnabled: remoteExecution === "enabled",
        }
      : device,
  );
