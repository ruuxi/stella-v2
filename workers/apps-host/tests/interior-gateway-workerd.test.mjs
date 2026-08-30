import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { issueInteriorShellSession } from "../src/interior-shell-policy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const signingKey = "workerd-interior-token-key-000000000000000000000";
const routeId = "sr_12345678-1234-4123-8123-123456789abc";
const otherRouteId = "sr_87654321-4321-4321-8321-cba987654321";
const ownerHash = "b".repeat(64);
const buildId = `interior-${"c".repeat(48)}`;
const convexJwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ2aWV3ZXItYSJ9.signature";
const conversationId = "conversation-owned";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });

const waitForReady = async (port, child) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("Workerd exited before readiness.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/missing`);
      if (response.status === 404) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workerd did not become ready.");
};

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const openSocket = (url, protocols = []) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, {
      origin: "null",
      headers: { Origin: "null" },
    });
    let settled = false;
    socket.once("open", () => {
      settled = true;
      resolve(socket);
    });
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

const waitForMessage = (socket) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket message timeout")),
      10_000,
    );
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });

const waitForClose = (socket) =>
  new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );

let temp;
let child;
let upstream;
let upstreamOrigin;
let gatewayOrigin;
let gatewayWsOrigin;
let scoped;
let otherRouteScoped;
const observed = {
  syncUpgrades: 0,
  conversationUpgrades: 0,
  syncFrames: [],
  conversationProtocol: "",
  serviceAuthorization: "",
  httpPaths: [],
};

beforeAll(async () => {
  const syncServer = new WebSocketServer({ noServer: true });
  const conversationServer = new WebSocketServer({ noServer: true });
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, upstreamOrigin);
    observed.httpPaths.push(url.pathname);
    if (url.pathname === "/api/cloud/interior-active-route") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          mode: "custom",
          ownerHash,
          buildId,
          artifactPrefix: `interiors/${ownerHash}/${buildId}`,
        }),
      );
      return;
    }
    if (url.pathname === "/api/query") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const value =
        body.path === "cloud_apps:getMyConversation"
          ? body.args?.conversationId === conversationId
            ? { conversationId }
            : null
          : { ownerId: "viewer-a", ownerGeneration: "generation-a" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", value }));
      return;
    }
    if (url.pathname === "/api/stella/models") {
      observed.serviceAuthorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: ["workerd-model"] }));
      return;
    }
    response.writeHead(404).end();
  });
  upstream.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, upstreamOrigin);
    if (/^\/api\/[0-9.]+\/sync$/.test(url.pathname)) {
      observed.syncUpgrades += 1;
      syncServer.handleUpgrade(request, socket, head, (ws) => {
        syncServer.emit("connection", ws, request);
      });
      return;
    }
    if (url.pathname === `/conversations/${conversationId}/socket`) {
      observed.conversationUpgrades += 1;
      observed.conversationProtocol =
        request.headers["sec-websocket-protocol"] ?? "";
      conversationServer.handleUpgrade(request, socket, head, (ws) => {
        conversationServer.emit("connection", ws, request);
      });
      return;
    }
    socket.destroy();
  });
  syncServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const text = data.toString();
      observed.syncFrames.push(text);
      const message = JSON.parse(text);
      if (message.type === "ModifyQuerySet") socket.send("sync-ok");
    });
  });
  conversationServer.on("connection", (socket) =>
    socket.send("conversation-ok"),
  );
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  const gatewayPort = await freePort();
  const inspectorPort = await freePort();
  gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
  gatewayWsOrigin = `ws://127.0.0.1:${gatewayPort}`;
  temp = await mkdtemp(path.join(tmpdir(), "stella-interior-gateway-workerd-"));
  const wranglerPath = path.join(temp, "wrangler.json");
  await writeFile(
    wranglerPath,
    JSON.stringify({
      name: "interior-gateway-workerd-test",
      main: path.join(
        root,
        "tests/fixtures/interior-gateway-workerd-worker.ts",
      ),
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        UPSTREAM_ORIGIN: upstreamOrigin,
        APP_TOKEN_SIGNING_KEY: signingKey,
      },
    }),
  );
  child = spawn(
    process.execPath,
    [
      "x",
      "wrangler",
      "dev",
      "--config",
      wranglerPath,
      "--ip",
      "127.0.0.1",
      "--port",
      String(gatewayPort),
      "--inspector-ip",
      "127.0.0.1",
      "--inspector-port",
      String(inspectorPort),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForReady(gatewayPort, child);
  scoped = await issueInteriorShellSession({
    appTokenSigningKey: signingKey,
    issuer: "dev:outgoing-bulldog-865",
    stableRouteId: routeId,
    routeBuild: { mode: "custom", buildId },
    viewerId: "viewer-a",
    viewerOwnerGeneration: "generation-a",
    convexJwt,
    trustedGatewayOrigin:
      "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
  });
  otherRouteScoped = await issueInteriorShellSession({
    appTokenSigningKey: signingKey,
    issuer: "dev:outgoing-bulldog-865",
    stableRouteId: otherRouteId,
    routeBuild: { mode: "custom", buildId },
    viewerId: "viewer-a",
    viewerOwnerGeneration: "generation-a",
    convexJwt,
    trustedGatewayOrigin:
      "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
  });
  const parseProbe = await fetch(`${gatewayOrigin}/_test/parse`, {
    headers: { authorization: `Bearer ${scoped.token}` },
  });
  if (!parseProbe.ok)
    throw new Error(`Workerd token parse failed: ${parseProbe.status}`);
}, 60_000);

afterAll(async () => {
  await stop(child);
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe("real Workerd interior gateway", () => {
  test("fails closed on an unknown pre-auth sync frame without opening upstream", async () => {
    const before = observed.syncUpgrades;
    const socket = await openSocket(`${gatewayWsOrigin}/api/1.31.0/sync`);
    socket.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-denied",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: "Unknown" }));
    expect(await closed).toMatchObject({ code: 4403 });
    expect(observed.syncUpgrades).toBe(before);
  });

  test("rewrites scoped Convex auth and denies cross-route refresh", async () => {
    const socket = await openSocket(`${gatewayWsOrigin}/api/1.31.0/sync`);
    socket.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-allowed",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    socket.send(
      JSON.stringify({
        type: "Authenticate",
        tokenType: "User",
        value: scoped.token,
        baseVersion: 0,
      }),
    );
    const outcomePromise = Promise.race([
      waitForMessage(socket).then((message) => ({ kind: "message", message })),
      waitForClose(socket).then((close) => ({ kind: "close", close })),
    ]);
    socket.send(
      JSON.stringify({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          {
            type: "Add",
            queryId: 0,
            udfPath: "cloud_apps:listMyConversations",
            args: [{}],
          },
        ],
      }),
    );
    const outcome = await outcomePromise;
    if (outcome.kind !== "message") {
      throw new Error(JSON.stringify({ outcome, observed }));
    }
    expect(outcome).toEqual({ kind: "message", message: "sync-ok" });
    expect(
      observed.syncFrames.some((raw) => raw.includes(scoped.token)),
    ).toBeFalse();
    expect(
      observed.syncFrames.some((raw) => raw.includes(convexJwt)),
    ).toBeTrue();
    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        type: "Authenticate",
        tokenType: "User",
        value: otherRouteScoped.token,
        baseVersion: 1,
      }),
    );
    expect(await closed).toMatchObject({ code: 4403 });
  });

  test("proves conversation ownership before substituting its socket bearer", async () => {
    const socket = await openSocket(
      `${gatewayWsOrigin}/conversations/${conversationId}/socket?protocol=1&since=-1`,
      ["stella.v1", `stella.token.${scoped.token}`],
    );
    expect(socket.protocol).toBe("stella.v1");
    expect(await waitForMessage(socket)).toBe("conversation-ok");
    expect(observed.conversationProtocol).toContain(
      `stella.token.${convexJwt}`,
    );
    expect(observed.conversationProtocol).not.toContain(scoped.token);
    const closed = waitForClose(socket);
    socket.close();
    await closed;

    const before = observed.conversationUpgrades;
    await expect(
      openSocket(
        `${gatewayWsOrigin}/conversations/conversation-substituted/socket?protocol=1&since=-1`,
        ["stella.v1", `stella.token.${scoped.token}`],
      ),
    ).rejects.toThrow();
    expect(observed.conversationUpgrades).toBe(before);
  });

  test("streams only an exact service path with the internal JWT", async () => {
    const response = await fetch(`${gatewayOrigin}/api/stella/models`, {
      headers: { origin: "null", authorization: `Bearer ${scoped.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: ["workerd-model"] });
    expect(observed.serviceAuthorization).toBe(`Bearer ${convexJwt}`);
    expect(observed.serviceAuthorization).not.toContain(scoped.token);
    const denied = await fetch(
      `${gatewayOrigin}/api/cloud/projects/credentials`,
      {
        headers: { origin: "null", authorization: `Bearer ${scoped.token}` },
      },
    );
    expect(denied.status).toBe(404);
  });
});
