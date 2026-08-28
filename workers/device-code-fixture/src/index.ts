import type { DeviceCodeFixtureEnv } from "./authorization-session.js";
import { handlePublicRequest } from "./public-page.js";

export { DeviceAuthorizationSession } from "./authorization-session.js";
export { DeviceCodeFixtureService } from "./service.js";

export default {
  async fetch(request: Request, env: DeviceCodeFixtureEnv): Promise<Response> {
    return await handlePublicRequest(request, env);
  },
} satisfies ExportedHandler<DeviceCodeFixtureEnv>;
