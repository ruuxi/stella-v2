import { Context, Effect, Layer } from "effect";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import { VoiceRuntimeService } from "../../voice/service.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as RunnerCell from "./runner-cell.js";

/**
 * Wraps the existing VoiceRuntimeService for the session. Stateless teardown
 * (the old code just nulled the reference), so no finalizer.
 */
export interface Interface {
  readonly service: VoiceRuntimeService;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/VoiceRuntime",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const runnerCell = yield* RunnerCell.Service;

    const service = new VoiceRuntimeService({
      getRunner: () => runnerCell.get(),
      getDeviceId: () => config.deviceId,
      emitAgentEvent: (payload) => {
        hostBus.notify(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, payload);
      },
    });

    return { service };
  }),
);
