import { BoundedBodyError } from "../../src/bounded-body.js";
import {
  boundedBodyStatus,
  bufferBoundedJsonRequest,
} from "../../src/request-ingress.js";
import { evaluateCloudBuilderReadiness } from "../../src/readiness.js";
import { verifyServiceBearerRequest } from "../../src/service-bearer.js";

type FixtureEnv = {
  OBJECTS: R2Bucket;
  SERVICE_SECRET: string;
};

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const readyInput = (env: FixtureEnv) => ({
  Sandbox: methods("getByName"),
  APP_BUILD_SANDBOX: methods("getByName"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_GATES: methods("getByName"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: env.OBJECTS,
  APP_ROUTES: methods("get", "put", "delete", "list"),
  BACKUP_BUCKET: env.OBJECTS,
  AGENT_HOME: env.OBJECTS,
  CONVERSATION_ARCHIVE: env.OBJECTS,
  LOADER: methods("get", "load"),
  BUILDER_SERVICE_SECRET: env.SERVICE_SECRET,
  SANDBOX_TRANSPORT: "rpc",
  TURN_TIMEOUT_MS: "900000",
  SANDBOX_IDLE_TIMEOUT_MS: "600000",
  APPS_HOST_BASE_URL: "https://apps-untrusted.example",
  TRUSTED_APPS_HOST_BASE_URL: "https://apps-auth.example",
  MODEL_GATEWAY: methods("fetch"),
  MODEL_GATEWAY_URL: "https://model-gateway.example",
  CLOUD_BUILDER_PUBLIC_URL: "https://builder.example",
  CAPABILITY_SIGNING_KEY:
    "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n",
  CAPABILITY_SIGNING_KID: "builder-1",
});

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/readyz") {
      const readiness = evaluateCloudBuilderReadiness(readyInput(env));
      return Response.json(readiness, { status: readiness.ready ? 200 : 503 });
    }
    if (url.pathname === "/auth") {
      const authorized = await verifyServiceBearerRequest(
        request,
        env.SERVICE_SECRET,
      );
      return Response.json({ authorized }, { status: authorized ? 200 : 401 });
    }
    if (url.pathname === "/ingress") {
      try {
        const bounded = await bufferBoundedJsonRequest(request, 64);
        return new Response(await bounded.text(), {
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const status = boundedBodyStatus(error) ?? 500;
        return Response.json(
          {
            code:
              status === 413
                ? "request_too_large"
                : error instanceof BoundedBodyError
                  ? "bad_request"
                  : "internal_error",
          },
          { status },
        );
      }
    }
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<FixtureEnv>;
