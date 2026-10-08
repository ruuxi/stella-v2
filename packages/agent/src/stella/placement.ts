/**
 * Where a conversation's tools run: this computer, another of the user's
 * computers, or a cloud container. It is per-conversation state; the host's
 * `HarnessOptions.env` reads it to build the conversation's ExecutionEnv.
 * The orchestrator has none and runs where its host is.
 */
import { defineDoc } from "@earendil-works/pi-durable";

export type StellaPlacement =
  | { kind: "local" }
  | { kind: "cloud" }
  | { kind: "device"; deviceId: string };

/** Where a `spawn_agent` call asked its agent to run. */
export type SpawnDestination = { kind: "here" } | { kind: "cloud" } | { kind: "device"; deviceId: string };

/** Blank means where the caller runs; any other value names a device. */
export const parseSpawnDestination = (value: unknown): SpawnDestination => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { kind: "here" };
  if (text.toLowerCase() === "cloud") return { kind: "cloud" };
  return { kind: "device", deviceId: text };
};

export const StellaPlacementDoc = defineDoc<{ kind: "local" | "cloud" | "device"; deviceId?: string }>({
  kind: "stella.placement",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ kind: "local" }),
});

export const placementOf = (value: { kind: string; deviceId?: string } | undefined): StellaPlacement | undefined => {
  if (!value) return undefined;
  if (value.kind === "cloud") return { kind: "cloud" };
  if (value.kind === "device" && value.deviceId) return { kind: "device", deviceId: value.deviceId };
  if (value.kind === "local") return { kind: "local" };
  return undefined;
};

export const describePlacement = (placement: StellaPlacement): string =>
  placement.kind === "cloud" ? "cloud" : placement.kind === "device" ? `device ${placement.deviceId}` : "this computer";
