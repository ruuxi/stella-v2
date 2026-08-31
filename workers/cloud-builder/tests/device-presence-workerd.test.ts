import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const fixture = new URL(
  "./fixtures/device-presence-workerd-worker.ts",
  import.meta.url,
).pathname;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const waitForMessage = (socket: WebSocket) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket message timeout")),
      10_000,
    );
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });

const waitForClose = (socket: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );

describe("DevicePresence real Durable Object WebSocket", () => {
  let callbackServer: Server;
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";
  let temp = "";
  let socketOrigin = "";
  const callbacks: Array<{ path: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    callbackServer = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      callbacks.push({
        path: request.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url?.endsWith("/check")
            ? { current: true }
            : { disconnected: true },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      callbackServer.listen(0, "127.0.0.1", resolve),
    );
    const callbackAddress = callbackServer.address();
    const callbackPort =
      typeof callbackAddress === "object" && callbackAddress
        ? callbackAddress.port
        : 0;
    const port = await freePort();
    const inspectorPort = await allocateWorkerdInspectorPort();
    socketOrigin = `ws://127.0.0.1:${port}`;
    temp = await mkdtemp(join(tmpdir(), "stella-device-presence-workerd-"));
    const config = join(temp, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "stella-device-presence-workerd-test",
        main: fixture,
        compatibility_date: "2026-07-22",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          STELLA_CONVEX_SITE_URL: `http://127.0.0.1:${callbackPort}`,
          BUILDER_SERVICE_SECRET: "workerd-presence-secret",
        },
        durable_objects: {
          bindings: [{ name: "DEVICE_PRESENCE", class_name: "DevicePresence" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["DevicePresence"] }],
      }),
    );
    workerd = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        join(temp, "state"),
        "--inspector-port",
        String(inspectorPort),
        "--show-interactive-dev-session=false",
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const observe = (chunk: unknown) => {
      workerdOutput += String(chunk);
    };
    workerd.stdout?.on("data", observe);
    workerd.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (workerd.exitCode !== null) {
        throw new Error(`workerd exited before readiness:\n${workerdOutput}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  });

  afterAll(async () => {
    if (workerd && workerd.exitCode === null) {
      workerd.kill("SIGTERM");
      await Promise.race([
        once(workerd, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (workerd.exitCode === null) workerd.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    if (temp.includes("stella-device-presence-workerd-")) {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test("handshakes, stays live with tiny frames, replaces, and disconnects", async () => {
    const connect = async () => {
      const socket = new WebSocket(`${socketOrigin}/device/device-a`, [
        "stella.v1",
      ]);
      await once(socket, "open");
      const challenge = await waitForMessage(socket);
      expect(challenge).toMatchObject({
        type: "challenge",
        pingIntervalMs: 10_000,
        staleAfterMs: 60_000,
      });
      socket.send(
        JSON.stringify({ type: "begin", presenceSessionId: "session-a" }),
      );
      expect(await waitForMessage(socket)).toMatchObject({
        type: "prove",
        connectionId: challenge.connectionId,
      });
      socket.send(JSON.stringify({ type: "ready" }));
      expect(await waitForMessage(socket)).toEqual({ type: "connected" });
      return { socket, connectionId: challenge.connectionId };
    };

    const first = await connect();
    first.socket.send(JSON.stringify({ type: "ping" }));
    expect(await waitForMessage(first.socket)).toEqual({ type: "pong" });

    const firstClose = waitForClose(first.socket);
    const second = await connect();
    expect(await firstClose).toEqual({ code: 4001, reason: "replaced" });
    const secondClose = waitForClose(second.socket);
    second.socket.close(1000, "done");
    expect((await secondClose).code).toBe(1000);

    const deadline = Date.now() + 5_000;
    while (
      callbacks.filter((entry) => entry.path.endsWith("/disconnect")).length <
        2 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      callbacks.filter((entry) => entry.path.endsWith("/check")),
    ).toHaveLength(2);
    expect(
      callbacks.filter((entry) => entry.path.endsWith("/disconnect")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({ connectionId: first.connectionId }),
        }),
        expect.objectContaining({
          body: expect.objectContaining({ connectionId: second.connectionId }),
        }),
      ]),
    );
  }, 40_000);
});
