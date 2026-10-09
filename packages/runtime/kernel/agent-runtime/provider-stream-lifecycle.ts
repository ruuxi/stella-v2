/**
 * Provider stream lifecycle events, as a run's event recorder reports them
 * (`recordProviderLifecycle` in `run-events.ts`): a provider request's
 * lifecycle proof, and how its stream settled.
 */

import type { ProviderRequestLifecycleProof } from "../../ai/types.js";

export type ProviderStreamLifecycleEvent = ProviderRequestLifecycleProof & {
  streamOrdinal: number;
  provider: string;
  modelId: string;
};

export type ProviderStreamSettlementEvent = {
  phase: "transport-joined" | "abandoned" | "outcome-unknown";
  requestIdSha256: string;
  physicalAttempt: number;
  streamOrdinal: number;
  provider: string;
  modelId: string;
  outcome?: "completed" | "canceled" | "error";
};
