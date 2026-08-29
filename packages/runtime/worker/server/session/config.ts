import { Context, Layer } from "effect";
import type { WorkerInitializationState } from "../types.js";

/**
 * Per-session config cell: the host-pushed initialization state plus the
 * device identity resolved during initialize. Mutable by design — CONFIGURE
 * patches and auth refreshes update it in place, mirroring the old
 * `state.init` field. Fan-out of patches to the runner services lives
 * in WorkerSessions (which can see the whole session), not here.
 */
export interface Interface {
  readonly deviceId: string;
  readonly get: () => WorkerInitializationState;
  readonly set: (next: WorkerInitializationState) => void;
  readonly patch: (patch: Partial<WorkerInitializationState>) => void;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/SessionConfig",
) {}

export const layer = (init: WorkerInitializationState, deviceId: string) =>
  Layer.sync(Service, () => {
    let state = init;
    return {
      deviceId,
      get: () => state,
      set: (next) => {
        state = next;
      },
      patch: (patch) => {
        state = { ...state, ...patch };
      },
    };
  });
