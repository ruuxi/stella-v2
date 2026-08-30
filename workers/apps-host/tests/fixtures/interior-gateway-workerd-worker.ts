import {
  handleInteriorConversationSocket,
  handleInteriorConvexSocket,
  handleInteriorService,
} from "../../src/interior-shell-gateway";
import type { AppsHostConfig } from "../../src/config";
import { parseInteriorShellSession } from "../../src/interior-shell-policy";

type Env = {
  UPSTREAM_ORIGIN: string;
  APP_TOKEN_SIGNING_KEY: string;
};

const config = (env: Env): AppsHostConfig => ({
  hostRole: "trusted",
  appBuilds: null,
  appRoutes: null,
  deploymentIdentity: "dev:outgoing-bulldog-865",
  sharesDisabled: false,
  convexSiteOrigin: env.UPSTREAM_ORIGIN as AppsHostConfig["convexSiteOrigin"],
  convexCloudOrigin: env.UPSTREAM_ORIGIN as AppsHostConfig["convexCloudOrigin"],
  appsHostOrigin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
  trustedAppsHostOrigin: "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
  cloudBuilderOrigin:
    env.UPSTREAM_ORIGIN as AppsHostConfig["cloudBuilderOrigin"],
  cloudBuilderWebSocketOrigin: env.UPSTREAM_ORIGIN.replace(
    /^http/,
    "ws",
  ) as AppsHostConfig["cloudBuilderWebSocketOrigin"],
  builderServiceSecret: "workerd-interior-builder-secret-0000000000000000",
  appTokenSigningKey: env.APP_TOKEN_SIGNING_KEY,
  appAuth: null,
  appFetchGate: null,
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gateway = config(env);
    if (new URL(request.url).pathname === "/_test/parse") {
      try {
        const token =
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const parsed = await parseInteriorShellSession({
          token,
          appTokenSigningKey: env.APP_TOKEN_SIGNING_KEY,
          expected: {
            issuer: gateway.deploymentIdentity,
            trustedGatewayOrigin: gateway.trustedAppsHostOrigin,
          },
        });
        return Response.json(parsed);
      } catch {
        return new Response("invalid", { status: 401 });
      }
    }
    const convex = await handleInteriorConvexSocket(request, gateway);
    if (convex) return convex;
    const conversation = await handleInteriorConversationSocket(
      request,
      gateway,
    );
    if (conversation) return conversation;
    const service = await handleInteriorService(request, gateway);
    if (service) return service;
    return new Response("Not found", { status: 404 });
  },
};
