import {
  DevicePresence,
  HEADER_EXECUTION_DEVICE_ID,
} from "../../src/device-presence.js";
import {
  HEADER_OWNER,
  HEADER_TOKEN_EXP,
  SUBPROTOCOL,
} from "../../src/conversation-hub.js";

export { DevicePresence };

type Env = {
  DEVICE_PRESENCE: DurableObjectNamespace<DevicePresence>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/device\/([A-Za-z0-9._~-]+)$/u);
    if (!match) return new Response("ready", { status: 200 });
    const forwarded = new Request("https://presence.test/socket", request);
    forwarded.headers.set(HEADER_OWNER, "issuer|workerd-owner");
    forwarded.headers.set(HEADER_EXECUTION_DEVICE_ID, match[1]!);
    forwarded.headers.set(HEADER_TOKEN_EXP, String(Date.now() + 60_000));
    forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
    return await env.DEVICE_PRESENCE.getByName(
      `issuer|workerd-owner:${match[1]!}`,
    ).fetch(forwarded);
  },
};
