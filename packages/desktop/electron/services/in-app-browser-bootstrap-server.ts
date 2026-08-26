import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import path from "node:path";
import { z } from "zod";

import {
  getStellaInAppBrowserInitEndpoint,
  getStellaInAppBrowserInitTokenPath,
  type StellaInAppBrowserInitEndpoint,
} from "@stella/runtime/kernel/tools/stella-browser-bridge-config";

const MAX_REQUEST_BYTES = 16 * 1024;
const DISCOVERY_LOCK_TIMEOUT_MS = 5_000;
const DISCOVERY_LOCK_RETRY_MS = 10;
const ENDPOINT_PROBE_TIMEOUT_MS = 250;

type FileIdentity = Readonly<{ device: number; inode: number }>;

const delay = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireDiscoveryLock = async (
  lockPath: string,
  ownerId: string,
): Promise<() => void> => {
  const lockValue = JSON.stringify({ ownerId, pid: process.pid });
  const deadline = Date.now() + DISCOVERY_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      writeFileSync(lockPath, lockValue, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return () => {
        try {
          if (readFileSync(lockPath, "utf8") === lockValue) {
            rmSync(lockPath, { force: true });
          }
        } catch {
          // A missing/replaced lock is no longer ours to release.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid?: unknown;
      };
      if (
        typeof existing.pid !== "number" ||
        !Number.isSafeInteger(existing.pid) ||
        existing.pid <= 0 ||
        !processIsAlive(existing.pid)
      ) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      // A creator can briefly exist before its contents are observable. Wait
      // for it unless the bounded acquisition deadline is exhausted.
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out acquiring browser bootstrap discovery lock: ${lockPath}`,
      );
    }
    await delay(DISCOVERY_LOCK_RETRY_MS);
  }
};

const readFileIdentity = (filePath: string): FileIdentity | null => {
  try {
    const stat = lstatSync(filePath);
    return { device: stat.dev, inode: stat.ino };
  } catch {
    return null;
  }
};

const sameFileIdentity = (
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean =>
  left !== null &&
  right !== null &&
  left.device === right.device &&
  left.inode === right.inode;

const endpointIsLive = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(ENDPOINT_PROBE_TIMEOUT_MS, () => {
      // A timeout is ambiguous, so preserve the endpoint rather than stealing
      // a potentially busy owner from another Stella instance.
      finish(true);
    });
  });

export type InAppBrowserBootstrapServerOptions = {
  token: string;
  ensureReady: (
    capability: InAppBrowserBootstrapCapability,
  ) => Promise<InAppBrowserBootstrapResult>;
  endpoint?: StellaInAppBrowserInitEndpoint;
  tokenPath?: string;
};

export type InAppBrowserBootstrapCapability = Readonly<{
  sessionId: string;
  turnId: string;
  ownerLeaseId: string;
  ownerLeaseIssuedAt: number;
  recover?: boolean;
}>;

export type InAppBrowserBootstrapResult = Readonly<{
  bridgeSessionId: string;
  capabilityExpiresAt: number;
}>;

const capabilityString = z.string().trim().min(1).max(512);
const ensureRequestSchema = z.strictObject({
  action: z.literal("ensure"),
  token: z.unknown(),
  sessionId: capabilityString,
  turnId: capabilityString,
  ownerLeaseId: capabilityString,
  ownerLeaseIssuedAt: z.number().int().positive(),
  recover: z.boolean().optional(),
});

const sameToken = (received: unknown, expected: string) => {
  if (typeof received !== "string") return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Authenticated local handoff used by the agent runtime to lazily prepare the
 * in-app browser. This service owns no renderer state and never opens the
 * Browser sidebar; it only invokes the hidden browser readiness callback.
 */
export class InAppBrowserBootstrapServer {
  private readonly options: InAppBrowserBootstrapServerOptions;
  private readonly endpoint: StellaInAppBrowserInitEndpoint;
  private readonly tokenPath: string;
  private readonly sockets = new Set<Socket>();
  private readonly ownerId = randomUUID();
  private readonly discoveryLockPath: string;
  private endpointIdentity: FileIdentity | null = null;
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: InAppBrowserBootstrapServerOptions) {
    this.options = options;
    this.endpoint = options.endpoint ?? getStellaInAppBrowserInitEndpoint();
    this.tokenPath = options.tokenPath ?? getStellaInAppBrowserInitTokenPath();
    this.discoveryLockPath = `${this.tokenPath}.lock`;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.server?.listening) return Promise.resolve();
    const promise = this.startInternal().finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  async stop(): Promise<void> {
    await this.startPromise?.catch(() => {});
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const releaseDiscoveryLock = await acquireDiscoveryLock(
      this.discoveryLockPath,
      this.ownerId,
    );
    try {
      if (server?.listening) {
        await this.closeServerPreservingForeignEndpoint(server);
      }
      this.removeOwnedDiscoveryFilesLocked();
    } finally {
      releaseDiscoveryLock();
    }
  }

  private async startInternal(): Promise<void> {
    mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    const releaseDiscoveryLock = await acquireDiscoveryLock(
      this.discoveryLockPath,
      this.ownerId,
    );
    try {
      const filesystemEndpointPath = this.filesystemEndpointPath();
      if (filesystemEndpointPath) {
        mkdirSync(path.dirname(filesystemEndpointPath), { recursive: true });
        const existingIdentity = readFileIdentity(filesystemEndpointPath);
        if (existingIdentity) {
          if (await endpointIsLive(filesystemEndpointPath)) {
            const error = new Error(
              `Browser bootstrap endpoint is already in use: ${filesystemEndpointPath}`,
            ) as NodeJS.ErrnoException;
            error.code = "EADDRINUSE";
            throw error;
          }
          if (
            !sameFileIdentity(
              readFileIdentity(filesystemEndpointPath),
              existingIdentity,
            )
          ) {
            const error = new Error(
              `Browser bootstrap endpoint changed during stale probe: ${filesystemEndpointPath}`,
            ) as NodeJS.ErrnoException;
            error.code = "EADDRINUSE";
            throw error;
          }
        }
        rmSync(filesystemEndpointPath, { force: true });
      }
      const server = createServer((socket) => this.handleSocket(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.endpoint);
      });
      this.endpointIdentity = filesystemEndpointPath
        ? readFileIdentity(filesystemEndpointPath)
        : null;
      this.publishToken();
    } catch (error) {
      const server = this.server;
      this.server = null;
      if (server) {
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        } else {
          try {
            server.close();
          } catch {
            // The listen error may have left the server unopened.
          }
        }
      }
      this.removeOwnedEndpoint();
      throw error;
    } finally {
      releaseDiscoveryLock();
    }
  }

  private filesystemEndpointPath(): string | null {
    return "path" in this.endpoint && process.platform !== "win32"
      ? this.endpoint.path
      : null;
  }

  private publishToken() {
    const temporaryPath = `${this.tokenPath}.${this.ownerId}.tmp`;
    try {
      writeFileSync(temporaryPath, this.options.token, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (process.platform !== "win32") chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.tokenPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  private handleSocket(socket: Socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    // A first-time profile snapshot can be large. Keep the transport alive
    // while the caller's browser-command deadline governs the actual wait.
    socket.setTimeout(5 * 60_000, () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        this.reply(
          socket,
          false,
          "Browser initialization request is too large.",
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      socket.removeAllListeners("data");
      void this.handleRequest(socket, line);
    });
  }

  private async handleRequest(socket: Socket, line: string) {
    try {
      const payload = ensureRequestSchema.safeParse(JSON.parse(line));
      if (
        !payload.success ||
        !sameToken(payload.data.token, this.options.token)
      ) {
        this.reply(
          socket,
          false,
          "Unauthorized browser initialization request.",
        );
        return;
      }
      const result = await this.options.ensureReady({
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        ownerLeaseId: payload.data.ownerLeaseId,
        ownerLeaseIssuedAt: payload.data.ownerLeaseIssuedAt,
        ...(payload.data.recover ? { recover: true } : {}),
      });
      this.reply(socket, true, undefined, result);
    } catch (error) {
      this.reply(socket, false, errorMessage(error));
    }
  }

  private reply(
    socket: Socket,
    success: boolean,
    error?: string,
    data?: InAppBrowserBootstrapResult,
  ) {
    if (socket.destroyed) return;
    socket.end(
      `${JSON.stringify({
        success,
        ...(error ? { error } : {}),
        ...(data ? { data } : {}),
      })}\n`,
    );
  }

  private ownsPublishedToken(): boolean {
    try {
      return sameToken(
        readFileSync(this.tokenPath, "utf8"),
        this.options.token,
      );
    } catch {
      return false;
    }
  }

  private removeOwnedEndpoint() {
    const filesystemEndpointPath = this.filesystemEndpointPath();
    if (
      filesystemEndpointPath &&
      sameFileIdentity(
        readFileIdentity(filesystemEndpointPath),
        this.endpointIdentity,
      )
    ) {
      rmSync(filesystemEndpointPath, { force: true });
    }
    this.endpointIdentity = null;
  }

  private async closeServerPreservingForeignEndpoint(server: Server) {
    let preservedPath: string | null = null;
    const filesystemEndpointPath = this.filesystemEndpointPath();
    if (
      filesystemEndpointPath &&
      this.endpointIdentity &&
      !sameFileIdentity(
        readFileIdentity(filesystemEndpointPath),
        this.endpointIdentity,
      )
    ) {
      preservedPath = `${filesystemEndpointPath}.${this.ownerId}.preserved`;
      rmSync(preservedPath, { force: true });
      linkSync(filesystemEndpointPath, preservedPath);
    }
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      if (preservedPath) {
        try {
          linkSync(preservedPath, filesystemEndpointPath!);
          rmSync(preservedPath, { force: true });
        } catch {
          // linkSync never replaces a path that appeared while closing.
          // Retaining the preserved endpoint is safer than unlinking either
          // foreign owner.
        }
      }
    }
  }

  private removeOwnedDiscoveryFilesLocked() {
    if (!this.ownsPublishedToken()) {
      this.endpointIdentity = null;
      return;
    }
    this.removeOwnedEndpoint();
    rmSync(this.tokenPath, { force: true });
  }
}
