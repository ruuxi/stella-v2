import type { DeviceDestination } from "./turn-plane/placement.js";

export type ExecutionDestination =
  | { kind: "cloud" }
  | { kind: "device"; deviceId: string; label: string };

export type ExecutionContextSnapshot = {
  devices: Array<
    Pick<
      DeviceDestination,
      "deviceId" | "label" | "online" | "remoteExecutionEnabled"
    >
  >;
  destination: ExecutionDestination;
  devicesKnown: boolean;
};

const MAX_DEVICES = 100;
const labelText = (value: string): string =>
  value
    .replace(/[<>\r\n\x00-\x1f]/g, " ")
    .trim()
    .slice(0, 256);

/** Presence timestamps, socket ids and free slots must not churn prompt bytes. */
export const createExecutionContextSnapshot = (args: {
  devices: readonly DeviceDestination[] | null;
  destination: ExecutionDestination;
}): ExecutionContextSnapshot => ({
  destination:
    args.destination.kind === "cloud"
      ? { kind: "cloud" }
      : {
          kind: "device",
          deviceId: labelText(args.destination.deviceId),
          label: labelText(args.destination.label),
        },
  devicesKnown: args.devices !== null,
  devices: [...(args.devices ?? [])]
    .sort((a, b) =>
      a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0,
    )
    .slice(0, MAX_DEVICES)
    .map((device) => ({
      deviceId: labelText(device.deviceId),
      ...(device.label ? { label: labelText(device.label) } : {}),
      online: device.online,
      remoteExecutionEnabled: device.remoteExecutionEnabled,
    })),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Only the bounded context metadata is read from a persisted user message. */
export const readExecutionContextSnapshot = (
  message: unknown,
): ExecutionContextSnapshot | undefined => {
  if (!isRecord(message) || !isRecord(message.executionContext))
    return undefined;
  const snapshot = message.executionContext;
  if (
    !Array.isArray(snapshot.devices) ||
    snapshot.devices.length > MAX_DEVICES ||
    typeof snapshot.devicesKnown !== "boolean"
  )
    return undefined;
  if (!isRecord(snapshot.destination)) return undefined;
  let destination: ExecutionDestination;
  if (snapshot.destination.kind === "cloud") destination = { kind: "cloud" };
  else if (
    snapshot.destination.kind === "device" &&
    boundedString(snapshot.destination.deviceId) &&
    boundedString(snapshot.destination.label)
  ) {
    destination = {
      kind: "device",
      deviceId: snapshot.destination.deviceId,
      label: snapshot.destination.label,
    };
  } else return undefined;
  const devices: DeviceDestination[] = [];
  for (const device of snapshot.devices) {
    if (
      !isRecord(device) ||
      !boundedString(device.deviceId) ||
      (device.label !== undefined && !boundedString(device.label)) ||
      typeof device.online !== "boolean" ||
      typeof device.remoteExecutionEnabled !== "boolean"
    )
      return undefined;
    devices.push({
      deviceId: device.deviceId,
      ...(typeof device.label === "string" ? { label: device.label } : {}),
      online: device.online,
      remoteExecutionEnabled: device.remoteExecutionEnabled,
    });
  }
  return createExecutionContextSnapshot({
    devices: snapshot.devicesKnown ? devices : null,
    destination,
  });
};

export const renderExecutionDevices = (
  snapshot: ExecutionContextSnapshot,
): string =>
  [
    "# Connected devices and execution destinations",
    "- Cloud",
    ...snapshot.devices.map(
      (device) =>
        `- ${device.label || device.deviceId} [device_id: ${device.deviceId}]: ${device.online ? "online" : "offline"}${device.remoteExecutionEnabled ? "" : "; remote execution disabled"}`,
    ),
    ...(!snapshot.devicesKnown
      ? ["The connected device list is currently unavailable."]
      : []),
    "This list describes destinations; it does not grant tools access to another device or move running agents.",
  ].join("\n");

export const renderExecutionDestination = (
  snapshot: ExecutionContextSnapshot,
): string =>
  snapshot.destination.kind === "cloud"
    ? "Current execution destination: Cloud."
    : `Current execution destination: ${snapshot.destination.label || snapshot.destination.deviceId} [device_id: ${snapshot.destination.deviceId}].`;
