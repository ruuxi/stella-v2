import { Context, Effect, Layer } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { SocialSessionService } from "../../social-sessions/service.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as SessionStorage from "./storage.js";
import * as RunnerCell from "./runner-cell.js";

/**
 * Wraps the existing SocialSessionService (per-session Vite preview servers)
 * as a session-scoped resource. Built LAST in the session chain so its
 * finalizer (`stop()`, which tears down preview servers and turn processing)
 * runs FIRST on teardown — before the runner it calls into goes away.
 */
export interface Interface {
  readonly service: SocialSessionService;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/SocialSessions",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const storage = yield* SessionStorage.Service;
    const runnerCell = yield* RunnerCell.Service;
    const init = config.get();

    const service = new SocialSessionService({
      getWorkspaceRoot: () => config.get().stellaWorkspacePath,
      getDeviceId: () => config.deviceId,
      getRunner: () => runnerCell.get(),
      getChatStore: () => storage.chatStore,
      getStore: () => storage.socialSessionStore,
      onLocalChatUpdated: () => {
        storage.notifyLocalChatUpdated();
      },
      pushDisplayPayload: (payload) => {
        // Forward the structured display payload through the existing
        // host display update bridge. The renderer normalizes it via
        // `normalizeDisplayPayload` and routes it to the workspace panel.
        void hostBus
          .request(
            METHOD_NAMES.HOST_DISPLAY_UPDATE,
            { payload },
            {
              retryOnDisconnect: true,
            },
          )
          .catch(() => undefined);
      },
    });
    service.setConvexUrl(init.convexUrl);
    service.setAuthToken(init.authToken);

    yield* Effect.addFinalizer(() => Effect.sync(() => service.stop()));

    return { service };
  }),
);
