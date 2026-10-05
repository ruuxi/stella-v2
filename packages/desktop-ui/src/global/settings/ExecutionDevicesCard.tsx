import { useCallback } from "react";
import type { DeviceRemoteExecution } from "@stella/contracts/turn-plane/placement";
import {
  useExecutionDevicesController,
  type ExecutionDeviceRow,
} from "@/global/settings/hooks/use-execution-devices-controller";
import { useT } from "@/shared/i18n";

/** The consent answer in the user's words; presence is reported separately. */
const CONSENT_KEYS: Record<DeviceRemoteExecution, string> = {
  enabled: "settings.executionDevices.state.enabled",
  unconfigured: "settings.executionDevices.state.notEnabled",
  asking: "settings.executionDevices.state.asking",
  declined: "settings.executionDevices.state.declined",
};

/**
 * Every computer signed in to this account, and for each one whether work from
 * the user's other devices may run there.
 *
 * The two facts are shown as two facts. A row exists because that computer is
 * signed in; the consent line next to it is a separate answer, and the only
 * way it changes here is the Enable (or Turn off) button being pressed.
 */
export function ExecutionDevicesCard() {
  const t = useT();
  const { devices, error, pendingDeviceId, setRemoteExecution } =
    useExecutionDevicesController();

  const toggle = useCallback(
    (device: ExecutionDeviceRow) => {
      void setRemoteExecution(device.deviceId, !device.remoteExecutionEnabled);
    },
    [setRemoteExecution],
  );

  if (devices === null) {
    return error === "load" ? (
      <div className="connect-devices">
        <div className="connect-error">
          {t("settings.executionDevices.errors.load")}
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="connect-devices">
      <span className="connect-pair-meta">
        {t("settings.executionDevices.title")}
      </span>
      <p className="connect-devices-note">
        {t("settings.executionDevices.note")}
      </p>

      {error ? (
        <div className="connect-error">
          {t(
            error === "load"
              ? "settings.executionDevices.errors.load"
              : "settings.executionDevices.errors.update",
          )}
        </div>
      ) : null}

      {devices.length === 0 ? (
        <p className="connect-devices-note">
          {t("settings.executionDevices.empty")}
        </p>
      ) : null}

      {devices.map((device) => {
        const busy = pendingDeviceId === device.deviceId;
        return (
          <div
            key={device.deviceId}
            className="connect-device"
            data-device-id={device.deviceId}
          >
            <span className="connect-device-name">
              {device.label?.trim() || t("settings.executionDevices.unnamed")}
              {device.isCurrent ? (
                <span className="connect-device-tag">
                  {t("settings.executionDevices.thisComputer")}
                </span>
              ) : null}
            </span>
            <span className="connect-device-meta">
              <span data-device-presence={device.online ? "online" : "offline"}>
                {t(
                  device.online
                    ? "settings.executionDevices.online"
                    : "settings.executionDevices.offline",
                )}
              </span>
              {" · "}
              <span data-device-consent={device.remoteExecution}>
                {t(CONSENT_KEYS[device.remoteExecution])}
              </span>
            </span>
            <button
              type="button"
              className="connect-bot-link"
              data-device-action={
                device.remoteExecutionEnabled ? "disable" : "enable"
              }
              disabled={pendingDeviceId !== null}
              onClick={() => toggle(device)}
            >
              {device.remoteExecutionEnabled
                ? t(
                    busy
                      ? "settings.executionDevices.disabling"
                      : "settings.executionDevices.disable",
                  )
                : t(
                    busy
                      ? "settings.executionDevices.enabling"
                      : "settings.executionDevices.enable",
                  )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
