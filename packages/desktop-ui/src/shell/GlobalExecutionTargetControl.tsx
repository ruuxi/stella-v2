import { useChatStorageMode } from "@/features/chat/services/chat-storage-preference";
import { useEffect, useMemo, useState } from "react";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { listExecutionDevices } from "@/features/cloud/placement-client";
import { backendUrl } from "@/platform/backend/backend-client";
import { getAuthToken } from "@/global/auth/services/auth-token";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  AUTOMATIC_EXECUTION_TARGET,
  executionTargetStore,
  useExecutionTarget,
  type DesktopExecutionTarget,
} from "@/features/execution-placement/execution-target-store";
import {
  executionDeviceBlocker,
  isExecutionDeviceSelectable,
  type DeviceExecutionBlocker,
} from "@/features/execution-placement/device-remote-execution";
import { openConnectDialog } from "@/global/integrations/connect-action";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { AppWindowMac, Check, Globe } from "@/ui/icons";
import { platformCapabilities } from "@/platform/capabilities";
import { SIGN_IN_TOAST_ACTION } from "@/shared/lib/auth-cta";

/** Live presence goes stale quickly; refresh while the picker is open. */
const DEVICE_POLL_INTERVAL_MS = 15_000;

/**
 * Why a listed computer cannot be picked, said plainly. "Unavailable" used to
 * cover all of these, which told the user nothing and hid the one case they
 * can clear themselves: a computer that is simply not enabled yet.
 *
 * Enabling happens in the device list (Connect), never here — the picker reads
 * state and selects a target, and a tap meant as "run it there" must not be
 * read as consent for that machine.
 */
const BLOCKER_LABELS: Record<DeviceExecutionBlocker, string> = {
  offline: "Offline",
  notEnabled: "Not enabled",
  asking: "Waiting for approval",
  declined: "Declined",
  notReady: "Not ready",
};

export function GlobalExecutionTargetControl() {
  const isPrivate = useChatStorageMode() === "local";
  const { isCloudConversationReady: authCloudReady } = useCloudConversationSession();
  const isCloudConversationReady = !isPrivate && authCloudReady;
  const { hasConnectedAccount } = useAuthSessionState();
  const [open, setOpen] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const storedTarget = useExecutionTarget();
  // Cloud and other computers need a signed-in account; signed out, sends
  // run here (see `getExecutionTargetSnapshot`), so the picker says so.
  const target = hasConnectedAccount ? storedTarget : AUTOMATIC_EXECUTION_TARGET;
  // Placement lives on the backend worker; the device list is an HTTPS read
  // of the owner's gate there.
  const socketOrigin =
    isCloudConversationReady && hasConnectedAccount && backendUrl
      ? backendUrl
      : null;
  const [destinations, setDestinations] = useState<
    DeviceDestination[] | undefined
  >(undefined);

  // The owner gate holds presence, so this is a read of live device state
  // rather than a backend view subscription. Poll only while the picker is open.
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
        getToken: (options) => getAuthToken(options ?? {}),
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

  // Every other computer that is present, plus whichever one is selected even
  // when it is not. Being listed here says only "signed in and reachable";
  // whether anything may be sent to it is the label's job.
  const otherDevices = useMemo(
    () =>
      (destinations ?? []).filter(
        (device) =>
          device.deviceId !== currentDeviceId &&
          (device.online ||
            (target.mode === "device" && target.deviceId === device.deviceId)),
      ),
    [currentDeviceId, destinations, target],
  );
  const hasDeviceToEnable = otherDevices.some(
    (device) => !device.remoteExecutionEnabled,
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

  if (isPrivate) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="sidebar-footer-button execution-target-button"
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
            onClick={() => {
              if (hasConnectedAccount) {
                choose({ mode: "cloud" });
                return;
              }
              setOpen(false);
              SIGN_IN_TOAST_ACTION.onClick();
            }}
          >
            <Globe size={16} />
            <span>Cloud</span>
            {!hasConnectedAccount ? (
              <small>Sign in</small>
            ) : target.mode === "cloud" ? (
              <Check size={15} />
            ) : null}
          </button>
          {otherDevices.map((device) => {
            const blocker = executionDeviceBlocker(device);
            const selectable = isExecutionDeviceSelectable(device);
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
                {blocker ? (
                  <small>{BLOCKER_LABELS[blocker]}</small>
                ) : target.mode === "device" &&
                  target.deviceId === device.deviceId ? (
                  <Check size={15} />
                ) : null}
              </button>
            );
          })}
          {hasConnectedAccount && hasDeviceToEnable ? (
            // The answer lives in the device list, not here: enabling is a
            // deliberate trip to Connect, never a side effect of a tap meant
            // to choose where this message runs.
            <button
              type="button"
              className="execution-target-option"
              onClick={() => {
                setOpen(false);
                openConnectDialog();
              }}
            >
              <AppWindowMac size={16} />
              <span>Enable a computer…</span>
            </button>
          ) : null}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
