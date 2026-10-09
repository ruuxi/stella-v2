/**
 * Where a conversation's tools run: this computer, another of the user's
 * computers, or a cloud container. It is per-conversation state; the host's
 * `HarnessOptions.env` (or, in the cloud, the attached tools) reads it to
 * run the conversation's file and shell tools there. The conversation
 * itself, its brain, stays on the host that holds it wherever its tools run:
 * `switch_destination` changes this and nothing else.
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** What an agent is told about a computer its tools run on. */
export type DevicePlacementInfo = {
  /** The computer's name, as the user's device list shows it. */
  label?: string;
  /** `~` there, and a shell command's working directory when none is given. */
  home?: string;
  hostname?: string;
  platform?: string;
};

export type StellaPlacement =
  | { kind: "local" }
  | { kind: "cloud" }
  | ({
      kind: "device";
      deviceId: string;
      /**
       * Run the agent there as a whole, on that computer's own Stella
       * (`StellaAgentsHost.remote`), rather than keeping it here with only its
       * tools there. Only `spawn_agent` asks for it; no conversation here is
       * ever placed so.
       */
      whole?: true;
    } & DevicePlacementInfo);

/** Where a `spawn_agent` call asked its agent to run. */
export type SpawnDestination =
  | { kind: "here" }
  | { kind: "cloud" }
  | { kind: "device"; deviceId: string; whole?: true };

/** Blank means where the caller runs; any other value names a device. */
export const parseSpawnDestination = (value: unknown, whole?: unknown): SpawnDestination => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { kind: "here" };
  if (text.toLowerCase() === "cloud") return { kind: "cloud" };
  return { kind: "device", deviceId: text, ...(whole === true ? { whole: true as const } : {}) };
};

export const StellaPlacementDoc = defineDoc<{ kind: "local" | "cloud" | "device"; deviceId?: string } & DevicePlacementInfo>({
  kind: "stella.placement",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ kind: "local" }),
});

const INFO_FIELDS = ["label", "home", "hostname", "platform"] as const;

export const placementOf = (
  value: ({ kind: string; deviceId?: string } & DevicePlacementInfo) | undefined,
): StellaPlacement | undefined => {
  if (!value) return undefined;
  if (value.kind === "cloud") return { kind: "cloud" };
  if (value.kind === "device" && value.deviceId) {
    const placement: StellaPlacement = { kind: "device", deviceId: value.deviceId };
    for (const field of INFO_FIELDS) if (typeof value[field] === "string" && value[field]) placement[field] = value[field];
    return placement;
  }
  if (value.kind === "local") return { kind: "local" };
  return undefined;
};

/** A placement as the placement doc holds it: where tools run, and what is known of that computer. */
export const placementRecord = (placement: StellaPlacement): { kind: StellaPlacement["kind"]; deviceId?: string } & DevicePlacementInfo => {
  if (placement.kind !== "device") return { kind: placement.kind };
  const record: { kind: "device"; deviceId: string } & DevicePlacementInfo = { kind: "device", deviceId: placement.deviceId };
  for (const field of INFO_FIELDS) if (placement[field]) record[field] = placement[field];
  return record;
};

export const describePlacement = (placement: StellaPlacement): string =>
  placement.kind === "cloud"
    ? "cloud"
    : placement.kind === "device"
      ? placement.label
        ? `${placement.label} [device ${placement.deviceId}]`
        : `device ${placement.deviceId}`
      : "this computer";

/** Whether two placements name the same place, whatever else is known of it. */
export const samePlacement = (a: StellaPlacement, b: StellaPlacement): boolean =>
  a.kind === b.kind && (a.kind !== "device" || (b.kind === "device" && a.deviceId === b.deviceId));
