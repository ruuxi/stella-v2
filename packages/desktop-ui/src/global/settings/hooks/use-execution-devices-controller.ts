import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { listExecutionDevices } from "@/features/cloud/placement-client";
import { backendClient, backendUrl } from "@/platform/backend/backend-client";
import { getAuthToken } from "@/global/auth/services/auth-token";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getDeviceIdOrNull } from "@/platform/electron/device";

/** Presence goes stale quickly, so re-read while the list is on screen. */
const DEVICE_POLL_INTERVAL_MS = 15_000;

export type ExecutionDeviceRow = DeviceDestination & {
  /** The computer the user is looking at right now. */
  isCurrent: boolean;
};

export type ExecutionDevicesError = "load" | "update";

/**
 * The owner's computers for the device list: who is signed in, who is here
 * right now, and who has agreed to run work sent from elsewhere.
 *
 * The read is a presence read and nothing more. `setRemoteExecution` is the
 * only writer and only a user action calls it, which is what keeps "listed"
 * and "willing to run work" apart: polling this hook can never enlist a
 * machine, and neither can rendering a row for it.
 */
export function useExecutionDevicesController() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [devices, setDevices] = useState<DeviceDestination[] | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<ExecutionDevicesError | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  const socketOrigin = hasConnectedAccount && backendUrl ? backendUrl : null;
  // An answer to the user's tap is newer than any read already in flight, so
  // a read that started before it must not scroll the row back.
  const writeSeq = useRef(0);

  useEffect(() => {
    void getDeviceIdOrNull().then(setCurrentDeviceId, () =>
      setCurrentDeviceId(null),
    );
  }, []);

  useEffect(() => {
    if (!socketOrigin) {
      setDevices(null);
      return;
    }
    let active = true;
    const read = () => {
      const seq = writeSeq.current;
      void listExecutionDevices({
        socketOrigin,
        getToken: (options) => getAuthToken(options ?? {}),
      })
        .then((response) => {
          if (!active || seq !== writeSeq.current) return;
          setDevices(response.devices);
          setError((current) => (current === "load" ? null : current));
        })
        .catch(() => {
          if (active) setError("load");
        });
    };
    read();
    const timer = window.setInterval(read, DEVICE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [socketOrigin]);

  const rows = useMemo<ExecutionDeviceRow[]>(() => {
    const listed = (devices ?? []).map((device) => ({
      ...device,
      isCurrent: device.deviceId === currentDeviceId,
    }));
    // This computer first; the rest by the name the user sees.
    return listed.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      return (left.label ?? left.deviceId).localeCompare(
        right.label ?? right.deviceId,
      );
    });
  }, [currentDeviceId, devices]);

  /**
   * Answer the consent question for one device from this signed-in session.
   *
   * The gate's reply is the authority on the resulting state, so the row takes
   * what came back rather than assuming the requested value.
   */
  const setRemoteExecution = useCallback(
    async (deviceId: string, enabled: boolean): Promise<boolean> => {
      if (pendingDeviceId) return false;
      setPendingDeviceId(deviceId);
      setError((current) => (current === "update" ? null : current));
      try {
        const result = await backendClient.call("devices.setRemoteExecution", {
          deviceId,
          enabled,
        });
        writeSeq.current += 1;
        setDevices((current) =>
          (current ?? []).map((device) =>
            device.deviceId === deviceId
              ? {
                  ...device,
                  remoteExecution: result.remoteExecution,
                  remoteExecutionEnabled: result.remoteExecution === "enabled",
                }
              : device,
          ),
        );
        return true;
      } catch {
        setError("update");
        return false;
      } finally {
        setPendingDeviceId(null);
      }
    },
    [pendingDeviceId],
  );

  return {
    hasConnectedAccount,
    /** `null` until the first read answers; `[]` is a real empty account. */
    devices: devices === null ? null : rows,
    currentDeviceId,
    error,
    pendingDeviceId,
    setRemoteExecution,
  };
}
