import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import {
  resolveRuntimePaths,
  type RuntimePaths,
} from "../worker/runtime-paths.js";
import {
  startOrAttachWorkerEffect,
  stopRunningWorkerEffect,
} from "../host/lifecycle/attach.js";
import { acquireHostLock } from "../host/lifecycle/lock.js";
import {
  HostLockTimeoutError,
  WorkerReadyTimeoutError,
} from "../host/lifecycle/errors.js";
import {
  defaultLifecycleBudgets,
  type LifecycleBudgets,
} from "../host/lifecycle/options.js";

/**
 * Effect-runtime interruption/timeout tests for the host attach pipeline.
 * These live inside packages/runtime because `effect` is fenced there
 * (check-boundary.mjs bans it from desktop-ui, tests included).
 *
 * Covered paths:
 * - readiness-probe timeout after a spawn whose worker dies at boot (the
 *   parity error string, host lock released);
 * - interrupted attach mid-probe releases the probe socket AND the host
 *   lock (scope finalizers on interruption);
 * - interrupted attach after spawn reaps the just-spawned child;
 * - successful attach hands the caller a socket that SURVIVES scope close
 *   (the exit-aware release must not destroy it on success);
 * - lockfile serialization: held-by-live-pid times out with the parity
 *   error; stale/unparseable locks are taken over atomically.
 */

const WORKER_READY_PROBE_ID = "__stella_runtime_ready_probe__";
const TEST_PROTOCOL_VERSION = "host-lifecycle-test-proto";

const tempDirs: string[] = [];
const runtimeDirs: string[] = [];
const servers: Server[] = [];
const trackedConnections: Socket[][] = [];
const spawnedPids: number[] = [];

const makeRoot = () => {
  const stellaAppDir = mkdtempSync(
    path.join(os.tmpdir(), "stella-host-lifecycle-"),
  );
  tempDirs.push(stellaAppDir);
  const paths = resolveRuntimePaths(stellaAppDir);
  mkdirSync(paths.rootDir, { recursive: true });
  runtimeDirs.push(paths.rootDir, paths.logDir);
  return { stellaAppDir, paths };
};

const hostLockFileFor = (paths: RuntimePaths) => `${paths.lockFile}.host`;

const budgets = (overrides: Partial<LifecycleBudgets>): LifecycleBudgets => ({
  ...defaultLifecycleBudgets,
  ...overrides,
});

const writeExecutable = (dir: string, name: string, body: string) => {
  const scriptPath = path.join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
};

const waitFor = async (
  condition: () => boolean,
  timeoutMs = 3_000,
  label = "condition",
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!condition()) {
    throw new Error(`Timed out waiting for ${label}`);
  }
};

const pidIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fake detached worker: a UDS server on the runtime socket path. `mode`
 * controls the probe behavior — "ready" answers with the expected protocol
 * version; "hang" accepts the connection and never responds. Sockets are
 * resumed and their `close` events counted so the tests can observe the
 * client-side destroy: a paused Node socket never reads the FIN and would
 * report `destroyed === false` forever.
 */
const startFakeWorkerServer = (
  paths: RuntimePaths,
  mode: "ready" | "hang",
): Promise<{
  server: Server;
  connections: Socket[];
  closedCount: () => number;
}> =>
  new Promise((resolve, reject) => {
    const connections: Socket[] = [];
    let closed = 0;
    const server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        closed += 1;
      });
      if (mode === "hang") {
        socket.resume();
        return;
      }
      socket.on("data", (chunk) => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as { id?: unknown };
            if (message.id === WORKER_READY_PROBE_ID) {
              socket.write(
                `${JSON.stringify({
                  id: WORKER_READY_PROBE_ID,
                  result: { protocolVersion: TEST_PROTOCOL_VERSION },
                })}\n`,
              );
            }
          } catch {
            // ignore non-JSON test traffic
          }
        }
      });
    });
    servers.push(server);
    trackedConnections.push(connections);
    server.on("error", reject);
    server.listen(paths.socketPath, () =>
      resolve({ server, connections, closedCount: () => closed }),
    );
  });

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  // Destroy any surviving connections first so server.close() can settle.
  for (const connections of trackedConnections.splice(0)) {
    for (const socket of connections) {
      socket.destroy();
    }
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of runtimeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("host lifecycle attach pipeline (Effect)", () => {
  it("fails with the parity readiness-timeout error and releases the host lock when the spawned worker dies at boot", async () => {
    const { stellaAppDir, paths } = makeRoot();
    // "bun" that exits immediately: the spawn succeeds but no socket ever
    // binds, so the readiness poll must exhaust its budget.
    const fakeBun = writeExecutable(stellaAppDir, "fake-bun-exit", "exit 0");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        startOrAttachWorkerEffect(
          {
            stellaAppDir,
            workerEntryPath: path.join(stellaAppDir, "entry.js"),
            bunBinaryPath: fakeBun,
          },
          budgets({
            startTimeoutMs: 400,
            socketConnectTimeoutMs: 100,
            startPollIntervalMs: 25,
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as Error)
      : null;
    expect(error).toBeInstanceOf(WorkerReadyTimeoutError);
    expect((error as Error).message).toBe(
      `Timed out waiting for runtime worker to become ready (socket=${paths.socketPath}).`,
    );
    // Scope close released the lockfile despite the failure.
    expect(existsSync(hostLockFileFor(paths))).toBe(false);
  });

  it("interrupting an attach mid-probe destroys the probe socket and releases the host lock", async () => {
    const { stellaAppDir, paths } = makeRoot();
    // Discovery path: pidfile points at a live pid (this test process), the
    // socket accepts, and the probe hangs — the fiber is parked inside the
    // readiness probe when we interrupt it.
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    const { connections, closedCount } = await startFakeWorkerServer(
      paths,
      "hang",
    );

    const fiber = Effect.runFork(
      Effect.scoped(
        startOrAttachWorkerEffect(
          {
            stellaAppDir,
            workerEntryPath: path.join(stellaAppDir, "entry.js"),
          },
          budgets({
            // Long probe budget: the interrupt must win, not the timeout.
            socketConnectTimeoutMs: 10_000,
            staleRetryTimeoutMs: 10_000,
            startTimeoutMs: 10_000,
          }),
        ),
      ),
    );

    await waitFor(() => connections.length > 0, 3_000, "probe connection");
    // The lock is held while the fiber is inside the critical section.
    expect(existsSync(hostLockFileFor(paths))).toBe(true);

    await Effect.runPromise(Fiber.interrupt(fiber));

    // Scope finalizers destroyed the probe socket (server sees the close)
    // and released the lock.
    await waitFor(
      () => closedCount() === connections.length,
      3_000,
      "probe socket close",
    );
    expect(existsSync(hostLockFileFor(paths))).toBe(false);
  });

  it("interrupting an attach after spawn reaps the just-spawned worker process", async () => {
    const { stellaAppDir, paths } = makeRoot();
    const childPidFile = path.join(stellaAppDir, "child.pid");
    // "bun" that records its pid and hangs without ever binding the socket:
    // the pipeline sits in the readiness poll with a live child when the
    // interrupt lands.
    const fakeBun = writeExecutable(
      stellaAppDir,
      "fake-bun-hang",
      `echo $$ > "${childPidFile}"\nexec sleep 60`,
    );

    const fiber = Effect.runFork(
      Effect.scoped(
        startOrAttachWorkerEffect(
          {
            stellaAppDir,
            workerEntryPath: path.join(stellaAppDir, "entry.js"),
            bunBinaryPath: fakeBun,
          },
          budgets({
            startTimeoutMs: 20_000,
            socketConnectTimeoutMs: 100,
            startPollIntervalMs: 25,
          }),
        ),
      ),
    );

    await waitFor(() => existsSync(childPidFile), 3_000, "spawned child pid");
    const childPid = Number.parseInt(
      readFileSync(childPidFile, "utf-8").trim(),
      10,
    );
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    spawnedPids.push(childPid);
    expect(pidIsAlive(childPid)).toBe(true);

    await Effect.runPromise(Fiber.interrupt(fiber));

    // The spawn resource's interrupt-only release ran the kill ladder.
    await waitFor(() => !pidIsAlive(childPid), 3_000, "child reaped");
    expect(existsSync(hostLockFileFor(paths))).toBe(false);
  });

  it("a successful attach returns a socket that survives scope close, and releases the lock", async () => {
    const { stellaAppDir, paths } = makeRoot();
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    const { connections } = await startFakeWorkerServer(paths, "ready");

    const connection = await Effect.runPromise(
      Effect.scoped(
        startOrAttachWorkerEffect({
          stellaAppDir,
          workerEntryPath: path.join(stellaAppDir, "entry.js"),
          expectedProtocolVersion: TEST_PROTOCOL_VERSION,
        }),
      ),
    );

    expect(connection.spawned).toBe(false);
    expect(connection.pid).toBe(process.pid);
    // The scope already closed (lock released) …
    expect(existsSync(hostLockFileFor(paths))).toBe(false);
    // … but the peer socket must still be live: the exit-aware release
    // only destroys it on non-success exits. Prove it end-to-end.
    expect(connection.socket.destroyed).toBe(false);
    const received: Buffer[] = [];
    // Probe connection + clean peer connection.
    expect(connections.length).toBe(2);
    const peerSide = connections[1]!;
    peerSide.on("data", (chunk) => received.push(chunk));
    connection.socket.write("ping\n");
    await waitFor(
      () => Buffer.concat(received).toString("utf-8").includes("ping"),
      3_000,
      "peer socket traffic",
    );
    connection.socket.destroy();
  });

  it("times out on a lock held by a live process with the parity error message", async () => {
    const { paths } = makeRoot();
    const lockFile = hostLockFileFor(paths);
    writeFileSync(lockFile, String(process.pid), "utf-8");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(acquireHostLock(lockFile, 250)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as Error;
      expect(error).toBeInstanceOf(HostLockTimeoutError);
      expect(error.message).toBe(
        `Timed out acquiring runtime host lock at ${lockFile} after 250ms.`,
      );
    }
    // The holder's lock must not have been deleted by the loser.
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
    rmSync(lockFile, { force: true });
  });

  it("takes over a stale lock with an unparseable holder and releases it on scope close", async () => {
    const { paths } = makeRoot();
    const lockFile = hostLockFileFor(paths);
    writeFileSync(lockFile, "not-a-pid", "utf-8");

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const handle = yield* Scope.provide(
          acquireHostLock(lockFile, 2_000),
          scope,
        );
        expect(handle.lockFile).toBe(lockFile);
        // The takeover rewrote the lock with our pid.
        expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    expect(existsSync(lockFile)).toBe(false);
  });

  it("stopRunningWorkerEffect reports no-op when no worker is recorded", async () => {
    const { stellaAppDir } = makeRoot();
    const result = await Effect.runPromise(
      stopRunningWorkerEffect(stellaAppDir),
    );
    expect(result).toEqual({ stopped: false, pid: null });
  });
});
