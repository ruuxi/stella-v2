import { BoundedBodyError } from "../../src/bounded-body.js";
import {
  boundedBodyStatus,
  bufferBoundedJsonRequest,
} from "../../src/request-ingress.js";
import {
  R2TransferTransformTooLargeError,
  r2TransferBody,
} from "../../src/r2-transfer-body.js";
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
  OWNER_TRANSFER_COORDINATORS: methods("getByName"),
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
  STELLA_CONVEX_SITE_URL: "https://deployment.convex.site",
  STELLA_CONVEX_CLOUD_URL: "https://deployment.convex.cloud",
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
    if (url.pathname === "/r2-stream") {
      const bytes = new Uint8Array(5 * 1024 * 1024);
      bytes[0] = 17;
      bytes[bytes.length - 1] = 29;
      await env.OBJECTS.put("source/large.bin", bytes);
      const source = await env.OBJECTS.get("source/large.bin");
      if (!source)
        return Response.json({ error: "source_missing" }, { status: 500 });
      const prepared = await r2TransferBody({
        source,
        destinationKey: "destination/large.bin",
      });
      const streamed = prepared.body instanceof ReadableStream;
      await env.OBJECTS.put("destination/large.bin", prepared.body);
      const destination = await env.OBJECTS.get("destination/large.bin");
      if (!destination) {
        return Response.json({ error: "destination_missing" }, { status: 500 });
      }
      const copied = new Uint8Array(await destination.arrayBuffer());
      return Response.json({
        streamed,
        size: copied.byteLength,
        first: copied[0],
        last: copied.at(-1),
      });
    }
    if (url.pathname === "/r2-transform-too-large") {
      await env.OBJECTS.put("source/large-meta.json", new Uint8Array(65));
      const source = await env.OBJECTS.get("source/large-meta.json");
      if (!source)
        return Response.json({ error: "source_missing" }, { status: 500 });
      try {
        await r2TransferBody({
          source,
          destinationKey: "destination/meta.json",
          transformMaxBytes: 64,
          transform: async (body) => ({ body }),
        });
        return Response.json({ rejected: false }, { status: 500 });
      } catch (error) {
        return Response.json({
          rejected: error instanceof R2TransferTransformTooLargeError,
        });
      }
    }
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<FixtureEnv>;
