import { DurableObject } from "cloudflare:workers";
import {
  getSandbox,
  type DirectoryBackup,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { Effect } from "effect";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  BUILD_SESSIONS: DurableObjectNamespace<BuildSession>;
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
  SANDBOX_IDLE_TIMEOUT_MS: string;
  APPS_HOST_BASE_URL: string;
};

type Execution = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type TurnRequest = {
  ownerId: string;
  appId: string;
  turnId: string;
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
  autoActivate?: boolean;
  preflightDelayMs?: number;
  watchdogMs?: number;
};

type ExecutorResult = {
  ok: true;
  runtimeTools: string[];
  metrics: {
    dependencyHydrationMs: number;
    productionBuildMs: number;
    activeCpuSeconds: number;
    peakMemoryBytes: number;
    workspaceDiskBytes: number;
  };
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const authorized = (request: Request, env: Env): boolean =>
  request.headers.get("authorization") ===
  `Bearer ${env.BUILDER_SERVICE_SECRET}`;

const sessionName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

const contentType = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export class BuildSession extends DurableObject<Env> {
  private sandbox(id: string) {
    return getSandbox(this.env.Sandbox, id, {
      transport: "rpc",
      enableDefaultSession: false,
      keepAlive: true,
      normalizeId: true,
      containerTimeouts: {
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 120_000,
      },
      labels: { service: "stella-v2", workload: "app-build" },
    });
  }

  private async callback(
    turn: TurnRequest,
    path: string,
    body: unknown,
  ): Promise<void> {
    const response = await fetch(
      `${turn.convexCallbackBase.replace(/\/+$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Convex callback ${path} failed with ${response.status}.`,
      );
    }
  }

  private event(
    turn: TurnRequest,
    seq: number,
    kind: string,
    payload: unknown,
    terminal = false,
  ) {
    return this.callback(turn, "/api/cloud/events", {
      turnId: turn.turnId,
      sessionId: this.ctx.id.toString(),
      seq,
      kind,
      payload,
      terminal,
    });
  }

  async alarm(): Promise<void> {
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (!turn || (await this.ctx.storage.get<boolean>("terminal"))) return;
    await this.ctx.storage.put("terminal", true);
    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    if (sandboxId)
      await this.sandbox(sandboxId)
        .destroy()
        .catch(() => undefined);
    log("error", "turn_timed_out", {
      turnId: turn.turnId,
      appId: turn.appId,
      sandboxId,
    });
    await this.event(
      turn,
      99,
      "timeout",
      {
        message: "This took longer than expected, so Stella stopped. Try again.",
      },
      true,
    ).catch(() => undefined);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/cancel") {
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (sandboxId)
        await this.sandbox(sandboxId)
          .destroy()
          .catch(() => undefined);
      const turn = await this.ctx.storage.get<TurnRequest>("turn");
      if (turn && !(await this.ctx.storage.get<boolean>("terminal"))) {
        await this.ctx.storage.put("terminal", true);
        await this.event(
          turn,
          98,
          "canceled",
          {
            message: "Stopped. Nothing was changed.",
          },
          true,
        ).catch(() => undefined);
        log("info", "turn_canceled", {
          turnId: turn.turnId,
          appId: turn.appId,
          sandboxId,
        });
      }
      return json({ canceled: true });
    }
    if (url.pathname === "/echo") return this.runEcho();
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    return this.runTurn((await request.json()) as TurnRequest);
  }

  private async runEcho(): Promise<Response> {
    const sandboxId = `m0-${this.ctx.id.toString().slice(0, 24)}`;
    const sandbox = this.sandbox(sandboxId);
    await this.ctx.storage.put("sandboxId", sandboxId);
    try {
      const session = await sandbox.createSession({
        id: sessionName(`echo-${crypto.randomUUID()}`),
        cwd: "/opt/stella",
        commandTimeoutMs: Number(this.env.TURN_TIMEOUT_MS),
      });
      const execution = await session.exec(
        "bun packages/executor-cloud/src/cli.ts --stub",
        { timeout: Number(this.env.TURN_TIMEOUT_MS) },
      );
      await sandbox.deleteSession(session.id).catch(() => undefined);
      if (!execution.success) {
        return json(
          { error: "Executor echo failed", detail: execution.stderr },
          502,
        );
      }
      return json({
        ok: true,
        executor: JSON.parse(
          execution.stdout.trim().split("\n").at(-1) ?? "{}",
        ),
      });
    } catch (error) {
      return json(
        { error: "Sandbox echo failed", detail: errorMessage(error) },
        502,
      );
    } finally {
      await sandbox.destroy().catch(() => undefined);
      await this.ctx.storage.deleteAll();
    }
  }

  private async runTurn(turn: TurnRequest): Promise<Response> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const firstSandboxId = sessionName(`turn-${turn.turnId}`);
    const secondSandboxId = sessionName(`restore-${turn.turnId}`);
    const first = this.sandbox(firstSandboxId);
    await this.ctx.storage.put({
      sandboxId: firstSandboxId,
      turn,
      turnTokenHash: await digest(turn.turnToken),
      turnId: turn.turnId,
      terminal: false,
    });
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
    );
    let seq = 0;
    const requestStarted = performance.now();
    log("info", "turn_started", {
      turnId: turn.turnId,
      appId: turn.appId,
      sessionId: this.ctx.id.toString(),
      autoActivate: turn.autoActivate !== false,
    });
    try {
      await this.event(turn, seq++, "started", { appId: turn.appId });
      if (turn.preflightDelayMs) {
        await scheduler.wait(turn.preflightDelayMs);
      }
      if (await this.ctx.storage.get<boolean>("terminal")) {
        throw new Error("Turn was canceled or timed out before execution.");
      }
      const coldStarted = performance.now();
      const session = await first.createSession({
        id: sessionName(`build-${turn.turnId}`),
        cwd: "/opt/stella",
        commandTimeoutMs,
        env: {
          STELLA_TURN_TOKEN: turn.turnToken,
          STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
        },
      });
      const coldContainerStartMs = Math.round(performance.now() - coldStarted);
      await this.event(turn, seq++, "sandbox_ready", { coldContainerStartMs });

      const modelStarted = performance.now();
      const modelResponse = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/model`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prompt: turn.prompt }),
        },
      );
      const modelPayload = (await modelResponse.json()) as {
        spec?: unknown;
        usage?: Record<string, unknown>;
        error?: string;
      };
      if (!modelResponse.ok || !modelPayload.spec) {
        throw new Error(
          modelPayload.error ?? `Model relay failed (${modelResponse.status}).`,
        );
      }
      const appTitle =
        typeof (modelPayload.spec as { title?: unknown })?.title === "string"
          ? ((modelPayload.spec as { title: string }).title.trim().slice(0, 32) ||
            undefined)
          : undefined;
      await this.event(turn, seq++, "model_completed", {
        ...modelPayload.usage,
        roundTripMs: Math.round(performance.now() - modelStarted),
      });
      await session.writeFile(
        "/workspace/turn-input.json",
        JSON.stringify({ prompt: turn.prompt, spec: modelPayload.spec }),
      );
      const execution = (await session.exec(
        "bun packages/executor-cloud/src/cli.ts --app-turn",
        { timeout: commandTimeoutMs },
      )) as Execution;
      if (!execution.success) {
        log("error", "executor_failed", {
          turnId: turn.turnId,
          appId: turn.appId,
          stderr: execution.stderr.slice(-4_000),
        });
        throw new Error("Stella hit a problem while building. Try again.");
      }
      const executor = JSON.parse(
        execution.stdout.trim().split("\n").at(-1) ?? "{}",
      ) as ExecutorResult;
      await this.event(turn, seq++, "app_built", {
        runtimeTools: executor.runtimeTools,
        ...executor.metrics,
      });

      const viteStarted = performance.now();
      const vite = await session.startProcess(
        "/usr/local/bin/vite --host 0.0.0.0 --port 5173",
        { cwd: "/workspace/app" },
      );
      await vite.waitForPort(5173, {
        path: "/",
        status: 200,
        timeout: 120_000,
      });
      const tunnel = await first.tunnels.get(5173);
      const firstPreviewMs = Math.round(performance.now() - viteStarted);
      await this.event(turn, seq++, "live_preview", {
        url: tunnel.url,
        firstPreviewMs,
      });

      const checkpointStarted = performance.now();
      const backup = await first.createBackup({
        dir: "/workspace/app",
        name: `stella-${turn.appId}`,
        ttl: 86_400,
        localBucket: true,
        compression: { format: "zstd", threads: 2 },
      });
      const checkpointMs = Math.round(performance.now() - checkpointStarted);
      await this.event(turn, seq++, "checkpointed", {
        checkpointMs,
        backupId: backup.id,
      });
      await first.destroy();

      const restore = this.sandbox(secondSandboxId);
      await this.ctx.storage.put("sandboxId", secondSandboxId);
      const restoreStarted = performance.now();
      await restore.restoreBackup(backup as DirectoryBackup);
      const restoreMs = Math.round(performance.now() - restoreStarted);
      const restoredSession = await restore.createSession({
        id: sessionName(`publish-${turn.turnId}`),
        cwd: "/workspace/app",
        commandTimeoutMs,
      });
      const verify = await restoredSession.exec(
        "test -f dist/index.html && test -d dist/assets",
      );
      if (!verify.success)
        throw new Error(
          "Restored workspace did not contain the production build.",
        );
      await this.event(turn, seq++, "workspace_restored", { restoreMs });

      const files = await restoredSession.listFiles("/workspace/app/dist", {
        recursive: true,
      });
      const buildId = crypto.randomUUID();
      const artifactPrefix = `builds/${buildId}`;
      const slug = `orbit-${turn.appId.slice(-8)}`;
      let uploadedBytes = 0;
      for (const file of files.files.filter((entry) => entry.type === "file")) {
        const relative = file.absolutePath
          .replace(/^\/workspace\/app\/dist\/?/, "")
          .replace(/^dist\/?/, "");
        const read = await restoredSession.readFile(file.absolutePath, {
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(read.content), (char) =>
          char.charCodeAt(0),
        );
        uploadedBytes += bytes.byteLength;
        await this.env.APP_BUILDS.put(`${artifactPrefix}/${relative}`, bytes, {
          httpMetadata: { contentType: contentType(relative) },
          customMetadata: { buildId, appId: turn.appId },
        });
      }
      const contextSource = `window.__STELLA_APP_CONTEXT__={...${JSON.stringify(
        {
          appId: turn.appId,
          convexSiteUrl: turn.convexCallbackBase,
        },
      )},bridge:window.parent!==window};\n`;
      uploadedBytes += new TextEncoder().encode(contextSource).byteLength;
      await this.env.APP_BUILDS.put(
        `${artifactPrefix}/stella-context.js`,
        contextSource,
        {
          httpMetadata: { contentType: "text/javascript; charset=utf-8" },
          customMetadata: { buildId, appId: turn.appId },
        },
      );
      const previewUrl = `${this.env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/apps/${slug}/`;
      if (turn.autoActivate !== false) {
        await this.env.APP_ROUTES.put(
          `app:${slug}`,
          JSON.stringify({
            appId: turn.appId,
            ownerId: turn.ownerId,
            buildId,
            artifactPrefix,
            suspended: false,
            updatedAt: Date.now(),
          }),
        );
      }
      const metrics = {
        coldContainerStartMs,
        backupRestoreMs: restoreMs,
        firstPreviewMs,
        checkpointMs,
        uploadedBytes,
        wallClockMs: Math.round(performance.now() - requestStarted),
        ...executor.metrics,
        model: modelPayload.usage,
        capacity: {
          instanceType: "standard-4",
          vCpu: 4,
          memoryBytes: 12 * 1024 ** 3,
          diskBytes: 20 * 1024 ** 3,
        },
      };
      await this.callback(turn, "/api/cloud/builds", {
        buildId,
        appId: turn.appId,
        ownerId: turn.ownerId,
        artifactPrefix,
        previewUrl,
        metrics,
        slug,
        autoActivate: turn.autoActivate !== false,
        title: appTitle,
      });
      const result = {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        previewUrl,
        metrics,
      };
      await this.event(turn, seq++, "completed", result, true);
      await this.ctx.storage.put("terminal", true);
      await restore.destroy();
      await this.ctx.storage.deleteAll();
      log("info", "turn_completed", {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        wallClockMs: metrics.wallClockMs,
        activeCpuSeconds: metrics.activeCpuSeconds,
        uploadedBytes,
      });
      return json({ ok: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
      if (!(await this.ctx.storage.get<boolean>("terminal"))) {
        await this.ctx.storage.put("terminal", true);
        await this.event(turn, seq++, "failed", { message }, true).catch(
          () => undefined,
        );
      }
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (sandboxId)
        await this.sandbox(sandboxId)
          .destroy()
          .catch(() => undefined);
      await first.destroy().catch(() => undefined);
      await this.ctx.storage.deleteAll();
      log("error", "turn_failed", {
        turnId: turn.turnId,
        appId: turn.appId,
        message,
      });
      return json({ error: "Cloud app turn failed.", detail: message }, 502);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: url.pathname,
    });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }
    if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
    if (request.method === "POST" && url.pathname === "/m0/echo") {
      return env.BUILD_SESSIONS.getByName("m0-echo").fetch(
        "https://build-session/echo",
        {
          method: "POST",
        },
      );
    }
    const turnMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns$/);
    if (request.method === "POST" && turnMatch) {
      return env.BUILD_SESSIONS.getByName(turnMatch[1]!).fetch(
        "https://build-session/turn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      return env.BUILD_SESSIONS.getByName(cancelMatch[1]!).fetch(
        "https://build-session/cancel",
        {
          method: "POST",
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/routes/activate") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
        buildId: string;
        artifactPrefix: string;
      };
      await env.APP_ROUTES.put(
        `app:${body.slug}`,
        JSON.stringify({
          ...body,
          suspended: false,
          updatedAt: Date.now(),
        }),
      );
      log("info", "route_activated", {
        requestId,
        slug: body.slug,
        appId: body.appId,
        buildId: body.buildId,
      });
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/routes/suspend") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
      };
      const route = await env.APP_ROUTES.get<Record<string, unknown>>(
        `app:${body.slug}`,
        "json",
      );
      if (
        !route ||
        route.appId !== body.appId ||
        route.ownerId !== body.ownerId
      ) {
        return json({ error: "App route not found." }, 404);
      }
      await env.APP_ROUTES.put(
        `app:${body.slug}`,
        JSON.stringify({
          ...route,
          suspended: true,
          updatedAt: Date.now(),
        }),
      );
      log("info", "route_suspended", {
        requestId,
        slug: body.slug,
        appId: body.appId,
      });
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
