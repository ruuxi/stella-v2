import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import {
  getStellaInAppBrowserInitEndpoint,
  getStellaInAppBrowserInitTokenPath,
  type StellaInAppBrowserInitEndpoint,
} from "@stella/runtime/kernel/tools/stella-browser-bridge-config";

const MAX_REQUEST_BYTES = 16 * 1024;

export type InAppBrowserBootstrapServerOptions = {
  token: string;
  ensureReady: () => Promise<void>;
  endpoint?: StellaInAppBrowserInitEndpoint;
  tokenPath?: string;
};

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
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: InAppBrowserBootstrapServerOptions) {
    this.options = options;
    this.endpoint = options.endpoint ?? getStellaInAppBrowserInitEndpoint();
    this.tokenPath = options.tokenPath ?? getStellaInAppBrowserInitTokenPath();
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
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.removeDiscoveryFiles();
  }

  private async startInternal(): Promise<void> {
    if ("path" in this.endpoint) {
      mkdirSync(path.dirname(this.endpoint.path), { recursive: true });
      rmSync(this.endpoint.path, { force: true });
    }
    mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    writeFileSync(this.tokenPath, this.options.token);
    if (process.platform !== "win32") chmodSync(this.tokenPath, 0o600);
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
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
    } catch (error) {
      if (this.server === server) this.server = null;
      server.close();
      this.removeDiscoveryFiles();
      throw error;
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
      const payload = JSON.parse(line) as Record<string, unknown>;
      if (
        payload.action !== "ensure" ||
        !sameToken(payload.token, this.options.token)
      ) {
        this.reply(
          socket,
          false,
          "Unauthorized browser initialization request.",
        );
        return;
      }
      await this.options.ensureReady();
      this.reply(socket, true);
    } catch (error) {
      this.reply(socket, false, errorMessage(error));
    }
  }

  private reply(socket: Socket, success: boolean, error?: string) {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify({ success, ...(error ? { error } : {}) })}\n`);
  }

  private removeDiscoveryFiles() {
    if ("path" in this.endpoint) rmSync(this.endpoint.path, { force: true });
    rmSync(this.tokenPath, { force: true });
  }
}
