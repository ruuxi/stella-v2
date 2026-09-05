import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateLoopbackPort } from "./workerd-test-port.js";

const packageRoot = new URL("../..", import.meta.url);

export type JsonResponse = { status: number; body: Record<string, unknown> };

export type WorkerdDev = {
  origin: string;
  /** Everything wrangler has written to stdout and stderr. */
  output(): string;
  /** Kills wrangler and removes its persisted state. */
  stop(): Promise<void>;
  /** Kills wrangler and boots it again over the same persisted state. */
  restart(): Promise<void>;
  /** GET without a body, otherwise POST as JSON; non-JSON bodies read as `{}`. */
  requestJson(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<JsonResponse>;
  eventually<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
};

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

/**
 * Boots `wrangler dev` for a fixture Worker on fresh loopback ports and waits
 * until `GET /` answers 200. State persists under a temp directory that lives
 * until `stop()`, so `restart()` observes Durable Object storage as a real
 * process restart would.
 */
export const startWorkerdDev = async (options: {
  /** Wrangler config path, resolved against the package root. */
  config: string;
  /** Temp directory prefix for persisted state. */
  prefix: string;
  /** Extra `--var` bindings, for values only known once the test runs. */
  vars?: Record<string, string>;
}): Promise<WorkerdDev> => {
  const port = await allocateLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const persistencePath = await mkdtemp(join(tmpdir(), options.prefix));
  let child: ChildProcess | null = null;
  let output = "";

  const start = async (): Promise<void> => {
    const inspectorPort = await allocateLoopbackPort();
    const spawned = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        options.config,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistencePath,
        "--inspector-port",
        String(inspectorPort),
        "--show-interactive-dev-session=false",
        ...Object.entries(options.vars ?? {}).flatMap(([key, value]) => [
          "--var",
          `${key}:${value}`,
        ]),
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = spawned;
    const observe = (chunk: unknown): void => {
      output += String(chunk);
    };
    spawned.stdout?.on("data", observe);
    spawned.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawned.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${output}`);
      }
      try {
        if ((await fetch(`${origin}/`)).ok) return;
      } catch {
        // Still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  };

  const kill = async (): Promise<void> => {
    const running = child;
    child = null;
    if (!running || running.exitCode !== null) return;
    running.kill("SIGTERM");
    await Promise.race([once(running, "exit"), pause(5_000)]);
    if (running.exitCode === null) {
      running.kill("SIGKILL");
      await once(running, "exit");
    }
  };

  const stop = async (): Promise<void> => {
    try {
      await kill();
    } finally {
      await rm(persistencePath, { recursive: true, force: true });
    }
  };

  try {
    await start();
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    origin,
    output: () => output,
    stop,
    restart: async () => {
      await kill();
      await start();
    },
    requestJson: async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >,
      };
    },
    eventually: async (read, accept, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let latest = await read();
      while (!accept(latest) && Date.now() < deadline) {
        await pause(50);
        latest = await read();
      }
      if (!accept(latest)) {
        throw new Error(`condition not reached: ${JSON.stringify(latest)}`);
      }
      return latest;
    },
  };
};
