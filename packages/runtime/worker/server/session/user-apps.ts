import { Context, Effect, Layer } from "effect";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import { UserAppProjectService } from "../../user-apps/project-service.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";

/**
 * Wraps the UserAppProjectService (dev servers for user app projects under
 * `<workspace>/apps`) as a session-scoped resource. Built at the TOP of the
 * session chain so its finalizer (`shutdown()`, which stops project dev
 * servers) runs FIRST on teardown — the old `stopWorkerServices` stopped
 * user app projects before the social/voice/runner services.
 */
export interface Interface {
  readonly service: UserAppProjectService;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/UserAppProjects",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;

    const service = new UserAppProjectService({
      workspacePath: config.get().stellaWorkspacePath,
      onChanged: () => {
        hostBus.notify(NOTIFICATION_NAMES.PROJECTS_UPDATED, undefined);
      },
    });
    // Awaited on the initialize path, as before: a start() failure fails
    // session initialization.
    yield* Effect.tryPromise({
      try: () => service.start(),
      catch: (error) => error as Error,
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => service.shutdown().catch(() => undefined)),
    );

    return { service };
  }),
);
