import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import {
  executionTargetStore,
  useExecutionTarget,
  type DesktopExecutionTarget,
} from "@/features/execution-placement/execution-target-store";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { AppWindowMac, Check, Globe } from "@/ui/icons";

export function GlobalExecutionTargetControl() {
  const { cloudMode } = useCloudMode();
  const [open, setOpen] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const target = useExecutionTarget();
  const destinations = useQuery(
    cloudApi.listMyExecutionDestinations,
    cloudMode ? {} : "skip",
  );

  useEffect(() => {
    void getDeviceIdOrNull().then(setCurrentDeviceId, () =>
      setCurrentDeviceId(null),
    );
  }, []);

  const otherDevices = useMemo(
    () =>
      (destinations ?? []).filter(
        (device) =>
          device.deviceId !== currentDeviceId &&
          ((device.online && device.remoteExecutionEnabled) ||
            (target.mode === "device" && target.deviceId === device.deviceId)),
      ),
    [currentDeviceId, destinations, target],
  );
  const selectedDevice =
    target.mode === "device"
      ? destinations?.find((device) => device.deviceId === target.deviceId)
      : undefined;

  const label =
    target.mode === "cloud"
      ? "Cloud"
      : target.mode === "device"
        ? (selectedDevice?.name ?? "Computer")
        : "This computer";
  const TriggerIcon = target.mode === "cloud" ? Globe : AppWindowMac;

  const choose = (next: DesktopExecutionTarget) => {
    executionTargetStore.set(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="pill-btn execution-target-button"
          data-active={open || undefined}
          aria-label={`Run on ${label}`}
          aria-pressed={open}
        >
          <TriggerIcon size={14} strokeWidth={1.75} />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="execution-target-popover"
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
      >
        <PopoverBody className="execution-target-list">
          <button
            type="button"
            className="execution-target-option"
            onClick={() => choose({ mode: "automatic" })}
          >
            <AppWindowMac size={16} />
            <span>This computer</span>
            {target.mode === "automatic" ? <Check size={15} /> : null}
          </button>
          <button
            type="button"
            className="execution-target-option"
            onClick={() => choose({ mode: "cloud" })}
          >
            <Globe size={16} />
            <span>Cloud</span>
            {target.mode === "cloud" ? <Check size={15} /> : null}
          </button>
          {otherDevices.map((device) => {
            const selectable =
              device.online &&
              device.remoteExecutionEnabled &&
              device.ready &&
              !device.busy;
            const unavailableLabel = !device.online
              ? "Offline"
              : !device.remoteExecutionEnabled
                ? "Unavailable"
                : "Busy";
            return (
              <button
                key={device.deviceId}
                type="button"
                className="execution-target-option"
                disabled={!selectable}
                onClick={() =>
                  choose({ mode: "device", deviceId: device.deviceId })
                }
              >
                <AppWindowMac size={16} />
                <span>{device.name}</span>
                {!selectable ? (
                  <small>{unavailableLabel}</small>
                ) : target.mode === "device" &&
                  target.deviceId === device.deviceId ? (
                  <Check size={15} />
                ) : null}
              </button>
            );
          })}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
