import { Context, Effect, Layer } from "effect";
import type { RuntimeModelCatalogSnapshot } from "@stella/contracts/model-catalog";
import { getFileLogger } from "../../observability/file-logger.js";
import { forkDelayed, type WorkerTimerHandle } from "../effect-runtime.js";
import type { RuntimeRunner } from "./types.js";

/**
 * Owns the lazy `kernel/model-catalog` module (the model picker's listing)
 * and the debounced background warm of the Stella model catalog.
 *
 * The module import stays dynamic so the model registry isn't parsed on the
 * worker-ready path.
 */
export interface Interface {
  /** The catalog as the model picker lists it. */
  readonly listModels: () => Promise<RuntimeModelCatalogSnapshot>;
  /**
   * Warm the Stella model catalog in the background whenever an input to its
   * cache key changes (auth identity, device, backend).
   * Debounced so a `configure` call touching multiple fields only warms
   * once, and best-effort so a network failure never affects config
   * application. No-ops when the runner isn't built yet.
   */
  readonly scheduleWarm: (getRunner: () => RuntimeRunner | null) => void;
  /** Cancel a pending warm (worker shutdown). */
  readonly dispose: () => void;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/ModelCatalog",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let warmTimer: WorkerTimerHandle | null = null;

    const listModels = async () =>
      (await import("../../kernel/model-catalog.js")).modelCatalogSnapshot();

    const scheduleWarm = (getRunner: () => RuntimeRunner | null) => {
      if (!getRunner()) return;
      // Debounce as a forked 50ms fiber (the old `clearTimeout` +
      // `setTimeout` pair): a re-schedule cancels the pending fiber, so a
      // configure call touching multiple fields still warms once.
      if (warmTimer) warmTimer.cancel();
      warmTimer = forkDelayed(50, () => {
        warmTimer = null;
        const warmStartedAt = Date.now();
        void getRunner()
          ?.warmModelCatalog()
          .then(() => {
            getFileLogger()?.process("startup.catalog-warmed", {
              ms: Date.now() - warmStartedAt,
            });
          })
          .catch(() => undefined);
      });
    };

    const dispose = () => {
      if (warmTimer) {
        warmTimer.cancel();
        warmTimer = null;
      }
    };

    yield* Effect.addFinalizer(() => Effect.sync(dispose));

    return { listModels, scheduleWarm, dispose };
  }),
);
