import { Context, Layer } from "effect";
import type { RuntimeRunner } from "../types.js";

/**
 * Mutable slot holding the session's runner once the background build lands
 * (the old `state.runner`). Split from RunnerHandle because services built
 * BEFORE the runner in the session chain (CliBridge's auth refresh, config
 * fan-out) need lazy access to it, while the runner's stop finalizer must run
 * EARLY in teardown — i.e. the handle layer must build late. The cell has no
 * finalizer; RunnerHandle owns the lifecycle.
 */
export interface Interface {
  readonly get: () => RuntimeRunner | null;
  readonly set: (runner: RuntimeRunner | null) => void;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/RunnerCell",
) {}

export const layer = Layer.sync(Service, () => {
  let runner: RuntimeRunner | null = null;
  return {
    get: () => runner,
    set: (next) => {
      runner = next;
    },
  };
});
