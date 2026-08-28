import { WorkerEntrypoint } from "cloudflare:workers";
import type { DeviceCodeFixtureBinding } from "./protocol.js";
import {
  DeviceCodeFixtureProvider,
  type AuthorizationNamespace,
} from "./provider.js";
import type { DeviceCodeFixtureEnv } from "./authorization-session.js";

/** Named service-binding entrypoint. It has no fetch handler and no public URL. */
export class DeviceCodeFixtureService
  extends WorkerEntrypoint<DeviceCodeFixtureEnv>
  implements DeviceCodeFixtureBinding
{
  private provider(): DeviceCodeFixtureProvider {
    return new DeviceCodeFixtureProvider({
      authorizations: this.env
        .DEVICE_AUTHORIZATIONS as unknown as AuthorizationNamespace,
      publicOrigin: this.env.PUBLIC_ORIGIN,
    });
  }

  async authorize(value: unknown) {
    return await this.provider().authorize(value);
  }

  async status(value: unknown) {
    return await this.provider().status(value);
  }

  async consume(value: unknown) {
    return await this.provider().consume(value);
  }
}
