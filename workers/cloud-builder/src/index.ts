import { DurableObject } from "cloudflare:workers";
import {
  getSandbox,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { Effect } from "effect";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  BUILD_SESSIONS: DurableObjectNamespace<BuildSession>;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
  SANDBOX_IDLE_TIMEOUT_MS: string;
};

type StubExecution = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const authorized = (request: Request, env: Env): boolean => {
  const authorization = request.headers.get("authorization");
  return (
    authorization !== null &&
    authorization === `Bearer ${env.BUILDER_SERVICE_SECRET}`
  );
};

const sessionName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

export class BuildSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }

    if (url.pathname === "/cancel") {
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (sandboxId) {
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
          transport: "rpc",
          enableDefaultSession: false,
        });
        await sandbox.destroy().catch(() => undefined);
        await this.ctx.storage.delete("sandboxId");
      }
      return json({ canceled: true });
    }

    if (url.pathname !== "/turn" && url.pathname !== "/echo") {
      return json({ error: "Not found." }, 404);
    }

    const sandboxId = `m0-${this.ctx.id.toString().slice(0, 24)}`;
    await this.ctx.storage.put("sandboxId", sandboxId);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      transport: "rpc",
      enableDefaultSession: false,
    });
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);

    try {
      const execution = await Effect.runPromise(
        Effect.tryPromise({
          try: async (): Promise<StubExecution> => {
            const session = await sandbox.createSession({
              id: sessionName(`turn-${crypto.randomUUID()}`),
              cwd: "/opt/stella",
              commandTimeoutMs,
            });
            try {
              return await session.exec(
                "bun packages/executor-cloud/src/cli.ts --stub",
                { timeout: commandTimeoutMs },
              );
            } finally {
              await sandbox.deleteSession(session.id).catch(() => undefined);
            }
          },
          catch: (error) => new Error(errorMessage(error)),
        }),
      );

      if (!execution.success) {
        return json(
          {
            error: "The cloud executor stub failed.",
            detail: execution.stderr.slice(0, 2_000),
            exitCode: execution.exitCode,
          },
          502,
        );
      }

      return json({
        ok: true,
        executor: JSON.parse(execution.stdout.trim().split("\n").at(-1) ?? "{}"),
      });
    } catch (error) {
      return json(
        { error: "The sandbox turn failed.", detail: errorMessage(error) },
        502,
      );
    } finally {
      await sandbox.destroy().catch(() => undefined);
      await this.ctx.storage.delete("sandboxId");
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }

    if (!authorized(request, env)) {
      return json({ error: "Unauthorized." }, 401);
    }

    if (request.method === "POST" && url.pathname === "/m0/echo") {
      const id = env.BUILD_SESSIONS.idFromName("m0-echo");
      return env.BUILD_SESSIONS.get(id).fetch("https://build-session/echo", {
        method: "POST",
      });
    }

    const turnMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns$/);
    if (request.method === "POST" && turnMatch) {
      const id = env.BUILD_SESSIONS.idFromName(turnMatch[1]!);
      return env.BUILD_SESSIONS.get(id).fetch("https://build-session/turn", {
        method: "POST",
        body: await request.text(),
      });
    }

    const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const id = env.BUILD_SESSIONS.idFromName(cancelMatch[1]!);
      return env.BUILD_SESSIONS.get(id).fetch("https://build-session/cancel", {
        method: "POST",
      });
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
