import { Context, Effect, Layer } from "effect";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import { getFileLogger } from "../../observability/file-logger.js";
import * as HostBus from "./host-bus.js";
import type { RuntimeRunner } from "./types.js";

/**
 * Owns the lazy `ai/model-runtime` module: the catalog-changed subscription
 * (forwarded to the host as MODEL_CATALOG_UPDATED) and the debounced
 * background catalog warm.
 *
 * The module import stays dynamic so the model registry isn't parsed on the
 * worker-ready path, exactly as before.
 */
export interface Interface {
  /**
   * Import the model runtime (memoized) and install the catalog-changed
   * subscription once. Safe to call repeatedly; no-ops the subscription
   * after dispose so a shutting-down worker doesn't re-subscribe.
   */
  readonly ensureSubscription: () => Promise<
    (typeof import("../../ai/model-runtime.js"))["modelRuntime"]
  >;
  /**
   * Warm the Stella model catalog in the background whenever an input to its
   * cache key changes (auth identity, device, `modelCatalogUpdatedAt`).
   * Debounced so a `configure` call touching multiple fields only warms
   * once, and best-effort so a network failure never affects config
   * application. No-ops when the runner isn't built yet.
   */
  readonly scheduleWarm: (getRunner: () => RuntimeRunner | null) => void;
  /** Unsubscribe and refuse future subscriptions (worker shutdown). */
  readonly dispose: () => void;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/ModelCatalog",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let modulePromise:
      | Promise<typeof import("../../ai/model-runtime.js")>
      | undefined;
    let warmTimer: ReturnType<typeof setTimeout> | null = null;

    const ensureSubscription = async () => {
      const loaded = await (modulePromise ??= import(
        "../../ai/model-runtime.js"
      ));
      if (!disposed) {
        unsubscribe ??= loaded.modelRuntime.onCatalogChanged((snapshot) => {
          hostBus.notify(NOTIFICATION_NAMES.MODEL_CATALOG_UPDATED, snapshot);
        });
      }
      return loaded.modelRuntime;
    };

    const scheduleWarm = (getRunner: () => RuntimeRunner | null) => {
      if (!getRunner()) return;
      if (warmTimer) clearTimeout(warmTimer);
      warmTimer = setTimeout(() => {
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
      }, 50);
    };

    const dispose = () => {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (warmTimer) {
        clearTimeout(warmTimer);
        warmTimer = null;
      }
    };

    yield* Effect.addFinalizer(() => Effect.sync(dispose));

    return { ensureSubscription, scheduleWarm, dispose };
  }),
);
