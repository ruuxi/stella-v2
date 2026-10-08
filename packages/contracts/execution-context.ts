import {
  CAPABILITIES,
  hasCapability,
  toCapabilityAudience,
  type ManagedCapabilityAudience,
} from "./capabilities.js";
import type { DeviceDestination } from "./turn-plane/placement.js";

export type ExecutionDestination =
  | { kind: "cloud" }
  | { kind: "device"; deviceId: string; label: string };

export type ExecutionContextDevice = Pick<
  DeviceDestination,
  "deviceId" | "label" | "online" | "remoteExecutionEnabled" | "remoteExecution"
>;

/**
 * What media the user can generate right now, so an agent says what to do
 * instead of starting a generation that is refused.
 */
export type MediaAccess = {
  /**
   * Stella's own media models: in the user's plan, not in it, or no Stella
   * account to have a plan on.
   */
  stella: "included" | "upgrade" | "sign_in";
  /** `image_gen` is set to the user's own provider key, and whether one is saved. */
  ownImageKey?: { provider: "openai" | "openrouter" | "fal"; saved: boolean };
};

/** Whether a plan audience includes Stella's media models. */
export const mediaAccessForAudience = (
  audience: ManagedCapabilityAudience | string,
): MediaAccess["stella"] => {
  const plan = toCapabilityAudience(audience as ManagedCapabilityAudience) ?? "free";
  if (plan === "anonymous") return "sign_in";
  return CAPABILITIES.every((capability) => hasCapability(plan, capability)) ? "included" : "upgrade";
};

export type ExecutionContextSnapshot = {
  devices: ExecutionContextDevice[];
  destination: ExecutionDestination;
  devicesKnown: boolean;
  /** Absent when it could not be worked out (offline, plan still loading). */
  media?: MediaAccess;
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
  media?: MediaAccess | undefined;
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
      remoteExecution: device.remoteExecution,
    })),
  ...(args.media
    ? {
        media: {
          stella: args.media.stella,
          ...(args.media.ownImageKey
            ? {
                ownImageKey: {
                  provider: args.media.ownImageKey.provider,
                  saved: args.media.ownImageKey.saved,
                },
              }
            : {}),
        },
      }
    : {}),
});

const readMediaAccess = (value: unknown): MediaAccess | undefined => {
  if (!isRecord(value)) return undefined;
  const stella = value.stella;
  if (stella !== "included" && stella !== "upgrade" && stella !== "sign_in")
    return undefined;
  const key = value.ownImageKey;
  const provider = isRecord(key) ? key.provider : undefined;
  return {
    stella,
    ...(isRecord(key) &&
    (provider === "openai" || provider === "openrouter" || provider === "fal") &&
    typeof key.saved === "boolean"
      ? { ownImageKey: { provider, saved: key.saved } }
      : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const remoteExecutionText = (
  value: unknown,
): DeviceDestination["remoteExecution"] | undefined =>
  value === "unconfigured" ||
  value === "asking" ||
  value === "enabled" ||
  value === "declined"
    ? value
    : undefined;
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
  const devices: ExecutionContextDevice[] = [];
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
      // Messages persisted before devices carried a consent state still parse;
      // the boolean they did carry says which of the two ends it was at.
      remoteExecution: remoteExecutionText(device.remoteExecution)
        ?? (device.remoteExecutionEnabled ? "enabled" : "unconfigured"),
    });
  }
  return createExecutionContextSnapshot({
    devices: snapshot.devicesKnown ? devices : null,
    destination,
    media: readMediaAccess(snapshot.media),
  });
};

/**
 * Why a listed device will not take work, in the words an agent can act on.
 * "Not set up" and "turned down" are different situations and the agent should
 * not report one as the other.
 */
const remoteExecutionNote = (device: ExecutionContextDevice): string => {
  switch (device.remoteExecution) {
    case "enabled":
      return "";
    case "asking":
      return "; waiting for permission on that device's screen";
    case "declined":
      return "; not accepting work from other devices";
    default:
      return "; has not been enabled to accept work from other devices yet";
  }
};

export const renderExecutionDevices = (
  snapshot: ExecutionContextSnapshot,
): string =>
  [
    "# Connected devices and execution destinations",
    "- Cloud",
    ...snapshot.devices.map(
      (device) =>
        `- ${device.label || device.deviceId} [device_id: ${device.deviceId}]: ${device.online ? "online" : "offline"}${remoteExecutionNote(device)}`,
    ),
    ...(!snapshot.devicesKnown
      ? ["The connected device list is currently unavailable."]
      : []),
    'To run an agent on one of these, pass its device_id (or "cloud") as spawn_agent\'s destination. Your own tools still run where you are, and running agents stay where they started.',
  ].join("\n");

export const renderExecutionDestination = (
  snapshot: ExecutionContextSnapshot,
): string =>
  snapshot.destination.kind === "cloud"
    ? "Current execution destination: Cloud."
    : `Current execution destination: ${snapshot.destination.label || snapshot.destination.deviceId} [device_id: ${snapshot.destination.deviceId}].`;

const OWN_KEY_NAMES: Record<NonNullable<MediaAccess["ownImageKey"]>["provider"], string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  fal: "fal",
};

/** Whether the user can generate media, and if not, what turns it on. */
export const renderMediaAccess = (snapshot: ExecutionContextSnapshot): string | undefined => {
  const media = snapshot.media;
  if (!media) return undefined;
  const key = media.ownImageKey;
  const name = key ? OWN_KEY_NAMES[key.provider] : "";
  const keyLine = key?.saved
    ? `Still images use their own ${name} key.`
    : key
      ? `Still images are set to their own ${name} key, but none is saved: ask them to add it in Settings → Image.`
      : null;
  if (media.stella === "included") {
    return ["# Media generation", "On: included in the user's plan.", keyLine].filter(Boolean).join("\n");
  }
  const fix =
    media.stella === "sign_in" ? "sign in and subscribe to Stella Pro" : "subscribe to Stella Pro (Account, top right)";
  const why = media.stella === "sign_in" ? "no Stella account" : "not in the user's plan";
  if (key?.saved) {
    return `# Media generation\nStill images only, on their own ${name} key; the rest is off (${why}). For other media, don't try; tell them to ${fix}.`;
  }
  return [
    "# Media generation",
    `Off: ${why}. If they ask for media, don't try; tell them to ${fix}, or for still images, add their own OpenAI, OpenRouter or fal key in Settings → Image.`,
    keyLine,
  ]
    .filter(Boolean)
    .join("\n");
};
