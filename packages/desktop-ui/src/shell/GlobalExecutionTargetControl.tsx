import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { cloudApi } from "@/features/cloud/cloud-api";
import { listExecutionDevices } from "@/features/cloud/placement-client";
import { getConvexToken } from "@/global/auth/services/auth-token";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
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
import { platformCapabilities } from "@/platform/capabilities";

/** Live presence goes stale quickly; refresh while the picker is open. */
const DEVICE_POLL_INTERVAL_MS = 15_000;

export function GlobalExecutionTargetControl() {
  const { isCloudConversationReady } = useCloudConversationSession();
  const { hasConnectedAccount } = useAuthSessionState();
  const [open, setOpen] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const target = useExecutionTarget();
  // Placement lives on the cloud builder, so the only Convex read left here
  // is where that builder is.
  const realtime = useQuery(
    cloudApi.getCloudRealtimeConfig,
    isCloudConversationReady && hasConnectedAccount ? {} : "skip",
  );
  const socketOrigin =
    typeof realtime?.socketOrigin === "string" && realtime.socketOrigin
      ? realtime.socketOrigin
      : null;
  const [destinations, setDestinations] = useState<
    DeviceDestination[] | undefined
  >(undefined);

  // The owner gate holds presence, so this is a read of live device state
  // rather than a Convex subscription. Poll only while the picker is open.
  useEffect(() => {
    if (
      !open ||
      !socketOrigin ||
      !isCloudConversationReady ||
      !hasConnectedAccount
    ) {
      return;
    }
    let active = true;
    const read = () => {
      void listExecutionDevices({
        socketOrigin,
        getToken: (options) => getConvexToken(options ?? {}),
      })
        .then((response) => {
          if (active) setDestinations(response.devices);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, DEVICE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasConnectedAccount, isCloudConversationReady, open, socketOrigin]);

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
        ? (selectedDevice?.label ?? "Computer")
        : platformCapabilities.automaticExecutionLabel;
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
            {platformCapabilities.website ? (
              <Globe size={16} />
            ) : (
              <AppWindowMac size={16} />
            )}
            <span>{platformCapabilities.automaticExecutionLabel}</span>
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
              device.availability?.ready === true &&
              (device.availability?.chatSlots ?? 0) > 0;
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
                <span>{device.label ?? "Computer"}</span>
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
