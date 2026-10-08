/**
 * The worker shell end to end in real workerd: the generated just-bash bundle
 * in a Worker Loader isolate, the `ctx.exports` loopback, and a real
 * WorldStore that the host commits into. `ShellHost` builds the router the
 * way `resident-turn.ts` does; only the sandbox ladder is a recorder.
 */

import { DurableObject } from "cloudflare:workers";
import type { SerializedAgentToolResult } from "@stella/executor-cloud/attached-tool-protocol";
import { WORLD_ROOT } from "../../src/workspace.js";
import { createWorkerShellRouter } from "../../src/worker-shell-router.js";
import { createWorkerShellRunner } from "../../src/worker-shell-runner.js";
import { WorldShellFs } from "../../src/world-shell-fs.js";
import { WorldStore } from "../../src/world-store.js";

export { WorldShellFs, WorldStore };

type Env = {
  LOADER: WorkerLoader;
  WORLDS: DurableObjectNamespace<WorldStore>;
  HOSTS: DurableObjectNamespace<ShellHost>;
};

type ExecInput = {
  world: string;
  cmd: string;
  params?: Record<string, unknown>;
  /** The sandbox is already attached when the call arrives. */
  attached?: boolean;
  /** Abort the tool call this many milliseconds after it starts. */
  abortAfterMs?: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ShellHost extends DurableObject<Env> {
  async exec(input: ExecInput) {
    const world = this.env.WORLDS.getByName(input.world);
    const root = WORLD_ROOT;
    const sandboxCalls: Array<{ toolName: string; params: unknown }> = [];
    const events: Array<{ kind: string; payload: unknown }> = [];
    let attached = input.attached === true;
    const router = createWorkerShellRouter({
      ladder: {
        attached: () => attached,
        execute: async (call): Promise<SerializedAgentToolResult> => {
          // The first container tool attaches the sandbox for the turn.
          attached = true;
          sandboxCalls.push({ toolName: call.toolName, params: call.params });
          return {
            outcome: { kind: "ok", text: "ran in the sandbox" },
            details: null,
            authorizedImages: [],
          };
        },
      },
      root,
      emitEvent: (kind, payload) => events.push({ kind, payload }),
      shell: createWorkerShellRunner({
        loader: this.env.LOADER,
        loopback: () =>
          this.ctx.exports.WorldShellFs({
            props: { worldName: input.world },
          }),
        world: {
          head: () => world.head(),
          commitShell: (change) => world.commitShell(change),
        },
        root,
        scope: input.world,
      }),
    });
    const signal =
      input.abortAfterMs === undefined
        ? undefined
        : AbortSignal.timeout(input.abortAfterMs);
    const started = Date.now();
    const first = await router.execute({
      toolCallId: `call-${started}`,
      toolName: "Bash",
      params: { cmd: input.cmd, ...input.params },
      ...(signal ? { signal } : {}),
    });
    return {
      result: first,
      sandboxCalls,
      events,
      attached,
      elapsedMs: Date.now() - started,
    };
  }

  /** Two commands in one turn, sharing its attach state. */
  async sequence(input: { world: string; commands: string[] }) {
    const world = this.env.WORLDS.getByName(input.world);
    const root = WORLD_ROOT;
    const sandboxCalls: string[] = [];
    let attached = false;
    const router = createWorkerShellRouter({
      ladder: {
        attached: () => attached,
        execute: async (call) => {
          attached = true;
          sandboxCalls.push(String(call.params.cmd));
          return {
            outcome: { kind: "ok", text: "ran in the sandbox" },
            details: null,
            authorizedImages: [],
          };
        },
      },
      root,
      shell: createWorkerShellRunner({
        loader: this.env.LOADER,
        loopback: () =>
          this.ctx.exports.WorldShellFs({ props: { worldName: input.world } }),
        world: {
          head: () => world.head(),
          commitShell: (change) => world.commitShell(change),
        },
        root,
        scope: `${input.world}:shared`,
      }),
    });
    const outputs: string[] = [];
    for (const cmd of input.commands) {
      const result = await router.execute({
        toolCallId: `call-${outputs.length}`,
        toolName: "Bash",
        params: { cmd },
      });
      outputs.push(
        result.outcome.kind === "ok" ? result.outcome.text : result.outcome.message,
      );
    }
    return { outputs, sandboxCalls };
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ok");
    const body = (request.method === "POST" ? await request.json() : {}) as Record<
      string,
      unknown
    >;
    try {
      switch (url.pathname) {
        case "/seed": {
          const world = env.WORLDS.getByName(String(body.world));
          for (const [path, value] of Object.entries(
            body.files as Record<string, string | { symlink: string } | { mode: number; text: string }>,
          )) {
            if (typeof value === "string") {
              await world.writeFile(path, encoder.encode(value));
            } else if ("symlink" in value) {
              await world.symlink(path, value.symlink);
            } else {
              await world.writeFile(path, encoder.encode(value.text), {
                mode: value.mode,
              });
            }
          }
          return json({ ok: true });
        }
        case "/read": {
          const world = env.WORLDS.getByName(String(body.world));
          const entry = await world.stat(String(body.path));
          if (!entry) return json({ entry: null });
          const bytes =
            entry.kind === "file"
              ? await world.readFile(String(body.path))
              : null;
          return json({
            entry,
            text: bytes ? decoder.decode(bytes) : null,
          });
        }
        case "/head": {
          return json(await env.WORLDS.getByName(String(body.world)).head());
        }
        case "/exec": {
          const host = env.HOSTS.getByName(String(body.world));
          return json(await host.exec(body as unknown as ExecInput));
        }
        case "/sequence": {
          const host = env.HOSTS.getByName(`${String(body.world)}:sequence`);
          return json(
            await host.sequence(
              body as unknown as { world: string; commands: string[] },
            ),
          );
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        500,
      );
    }
  },
};
