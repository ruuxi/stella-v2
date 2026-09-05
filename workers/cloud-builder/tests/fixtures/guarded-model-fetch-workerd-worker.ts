import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { guardedModelFetch } from "../../src/guarded-model-fetch.js";

type Env = { GATEWAY: Fetcher; EXECUTORS: DurableObjectNamespace<Executor> };

export class Executor extends DurableObject<Env> {
  private enteredAt = 0;
  private firstBodyAt = 0;
  private bytes = 0;
  async stats() {
    return {
      enteredAt: this.enteredAt,
      firstBodyAt: this.firstBodyAt,
      bytes: this.bytes,
    };
  }
  async fetch(request: Request) {
    this.enteredAt = Date.now();
    if (new URL(request.url).pathname === "/refuse")
      return new Response("account suspended", { status: 403 });
    const reader = request.body?.getReader();
    if (!reader) throw new Error("missing fixture body");
    const parts: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (this.firstBodyAt === 0) this.firstBodyAt = Date.now();
      this.bytes += chunk.value.byteLength;
      parts.push(chunk.value);
    }
    return new Response(new Blob(parts), {
      status: 201,
      headers: { "x-provider": "fixture" },
    });
  }
}

export class Gateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    if (request.headers.get("authorization") !== "Bearer fixture")
      return new Response("bad fixture token", { status: 401 });
    const id = request.headers.get("x-test-id");
    if (!id) throw new Error("missing test id");
    return await this.env.EXECUTORS.getByName(id).fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mode = new URL(request.url).pathname.slice(1);
    if (!mode) return new Response("ready");
    const id = crypto.randomUUID();
    const executor = env.EXECUTORS.getByName(id);
    const abort = new AbortController();
    let authorizedAt = 0;
    let gatewayEnteredDuringGuard = false;
    const body = JSON.stringify({
      prompt: "private memory",
      chunks: "x".repeat(256_000),
    });
    let authorizationFinished: (() => void) | undefined;
    const guardFinished = new Promise<void>((resolve) => {
      authorizationFinished = resolve;
    });
    let result:
      | { status: number; body: string; header: string | null }
      | { error: string };
    try {
      const response = await guardedModelFetch({
        request: new Request(`https://gateway/${mode}`, {
          method: "POST",
          headers: { authorization: "Bearer fixture", "x-test-id": id },
          body,
          signal: abort.signal,
        }),
        authorize: async () => {
          try {
            // Wait for actual service and DO entry. If fetch were buffered
            // behind authorization, this would time out instead of passing.
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline) {
              const state = await executor.stats();
              if (state.enteredAt > 0) {
                gatewayEnteredDuringGuard = true;
                if (state.bytes !== 0)
                  throw new Error("body leaked before authorization");
                break;
              }
              await scheduler.wait(5);
            }
            if (!gatewayEnteredDuringGuard)
              throw new Error("gateway did not enter during guard");
            if (mode === "deny") throw new Error("MEMORY_POLICY_CHANGED");
            if (mode === "cancel") {
              abort.abort(new Error("exact turn canceled"));
              await scheduler.wait(10);
            }
            authorizedAt = Date.now();
          } finally {
            authorizationFinished?.();
          }
        },
        fetch: (value) => env.GATEWAY.fetch(value),
      });
      result = {
        status: response.status,
        body: await response.text(),
        header: response.headers.get("x-provider"),
      };
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await guardFinished;
    return Response.json({
      result,
      authorizedAt,
      gatewayEnteredDuringGuard,
      expectedBody: body,
      ...(await executor.stats()),
    });
  },
};
