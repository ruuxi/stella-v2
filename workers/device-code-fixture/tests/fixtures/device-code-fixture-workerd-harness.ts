import { DeviceAuthorizationSession } from "../../src/authorization-session.js";
import { DeviceCodeFixtureProvider } from "../../src/provider.js";
import { normalizeUserCode, sha256Hex } from "../../src/protocol.js";
import type { AuthorizationState } from "../../src/state-machine.js";

const STATE_KEY = "authorization";

export class DeviceAuthorizationSessionWorkerdHarness extends DeviceAuthorizationSession {
  async inspect(): Promise<{
    alarm: number | null;
    state: AuthorizationState | null;
  }> {
    return {
      alarm: await this.ctx.storage.getAlarm(),
      state:
        (await this.ctx.storage.get<AuthorizationState>(STATE_KEY)) ?? null,
    };
  }
}

type HarnessEnv = Readonly<{
  DEVICE_AUTHORIZATIONS: DurableObjectNamespace<DeviceAuthorizationSessionWorkerdHarness>;
  PUBLIC_ORIGIN: string;
}>;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

const readJson = async (request: Request): Promise<Record<string, unknown>> =>
  (await request.json()) as Record<string, unknown>;

const providerFor = (env: HarnessEnv): DeviceCodeFixtureProvider =>
  new DeviceCodeFixtureProvider({
    authorizations: {
      getByName: (name) => env.DEVICE_AUTHORIZATIONS.getByName(name),
    },
    publicOrigin: env.PUBLIC_ORIGIN,
  });

const exactUserCode = (value: unknown): string => {
  const userCode = normalizeUserCode(value);
  if (userCode === undefined) throw new TypeError("invalid_user_code");
  return userCode;
};

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }
    try {
      const provider = providerFor(env);
      if (request.method === "POST" && url.pathname === "/authorize") {
        return json(await provider.authorize(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/decision") {
        const body = await readJson(request);
        const decision = body.decision;
        if (decision !== "approve" && decision !== "deny") {
          throw new TypeError("invalid_decision");
        }
        return json(
          await env.DEVICE_AUTHORIZATIONS.getByName(
            exactUserCode(body.userCode),
          ).publicDecision(decision),
        );
      }
      if (request.method === "POST" && url.pathname === "/status") {
        return json(await provider.status(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/consume") {
        return json(await provider.consume(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/direct-create") {
        const body = await readJson(request);
        if (
          typeof body.deviceCode !== "string" ||
          typeof body.expiresAt !== "number"
        ) {
          throw new TypeError("invalid_direct_create");
        }
        const userCode = exactUserCode(body.userCode);
        const result = await env.DEVICE_AUTHORIZATIONS.getByName(
          userCode,
        ).create({
          schemaVersion: 1,
          userCode,
          deviceCodeDigest: await sha256Hex(body.deviceCode),
          createdAt: Date.now(),
          expiresAt: body.expiresAt,
        });
        return json(result);
      }
      if (request.method === "POST" && url.pathname === "/inspect") {
        const body = await readJson(request);
        return json(
          await env.DEVICE_AUTHORIZATIONS.getByName(
            exactUserCode(body.userCode),
          ).inspect(),
        );
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "fixture_error" },
        400,
      );
    }
  },
} satisfies ExportedHandler<HarnessEnv>;
