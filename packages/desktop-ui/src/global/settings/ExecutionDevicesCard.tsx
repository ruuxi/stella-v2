import type { DeviceRemoteExecution } from "@stella/contracts/turn-plane/placement";
import {
  useExecutionDevicesController,
  type ExecutionDeviceRow,
} from "@/global/settings/hooks/use-execution-devices-controller";
import { Switch } from "@/ui/switch";
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
 * A row exists because that computer is signed in; the switch is a separate
 * answer, and the only way it changes here is the switch being flipped.
 */
export function ExecutionDevicesCard() {
  const t = useT();
  const { devices, error, pendingDeviceId, setRemoteExecution } =
    useExecutionDevicesController();

  if (devices === null) {
    return error === "load" ? (
      <p className="connect-note connect-note--error">
        {t("settings.executionDevices.errors.load")}
      </p>
    ) : (
      <div className="connect-list connect-list--loading" aria-busy="true" />
    );
  }

  if (devices.length === 0) {
    return (
      <p className="connect-note">{t("settings.executionDevices.empty")}</p>
    );
  }

  const label = (device: ExecutionDeviceRow) =>
    device.label?.trim().replace(/\.local$/i, "") ||
    t("settings.executionDevices.unnamed");

  return (
    <>
      <ul className="connect-list">
        {devices.map((device) => (
          <li
            key={device.deviceId}
            className="connect-device"
            data-device-id={device.deviceId}
          >
            <span
              className="connect-device__dot"
              data-device-presence={device.online ? "online" : "offline"}
              aria-hidden="true"
            />
            <span className="connect-device__text">
              <span className="connect-device__name">
                <span className="connect-device__label">{label(device)}</span>
                {device.isCurrent ? (
                  <span className="connect-device__tag">
                    {t("settings.executionDevices.thisComputer")}
                  </span>
                ) : null}
              </span>
              <span className="connect-device__meta">
                {t(
                  device.online
                    ? "settings.executionDevices.online"
                    : "settings.executionDevices.offline",
                )}
                {" · "}
                <span data-device-consent={device.remoteExecution}>
                  {t(CONSENT_KEYS[device.remoteExecution])}
                </span>
              </span>
            </span>
            <Switch
              className="connect-device__switch"
              checked={device.remoteExecutionEnabled}
              disabled={pendingDeviceId !== null}
              data-device-action={
                device.remoteExecutionEnabled ? "disable" : "enable"
              }
              aria-label={label(device)}
              onCheckedChange={(next) =>
                void setRemoteExecution(device.deviceId, next)
              }
            />
          </li>
        ))}
      </ul>
      {error === "update" ? (
        <p className="connect-note connect-note--error">
          {t("settings.executionDevices.errors.update")}
        </p>
      ) : null}
    </>
  );
}
