import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { loadConnectorAccessToken } from "./oauth.js";
import {
  removeConnectorBridgeProcessRecord,
  stopConnectorBridgeProcess,
  writeConnectorBridgeProcessRecord,
} from "./process-registry.js";
import type {
  ConnectorToolCallResult,
  ConnectorCommandConfig,
  ConnectorToolInfo,
} from "./types.js";

/** Thrown when a connector request comes back with an HTTP auth status
 *  (401/403/407). Lets callers branch
 *  on auth failure vs. real probe errors without parsing message strings. */
export class ConnectorAuthError extends Error {
  readonly kind = "auth_required" as const;
  constructor(
    readonly status: number,
    readonly serverDisplayName: string,
    readonly tokenKey: string | undefined,
    bodyPreview: string,
  ) {
    super(
      `${serverDisplayName} connector request failed (${status}): ${bodyPreview.slice(0, 500)}`,
    );
    this.name = "ConnectorAuthError";
  }
}

const AUTH_STATUSES = new Set([401, 403, 407]);

type RpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

const parseSseMessages = (text: string): RpcMessage[] => {
  const messages: RpcMessage[] = [];
  for (const block of text.split(/\n\n+/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data) as RpcMessage);
    } catch {
      // Ignore malformed non-RPC SSE frames.
    }
  }
  return messages;
};

const resolveSecretPlaceholders = async (
  stellaAppDir: string,
  values: Record<string, string> = {},
) => {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = await replaceSecretPlaceholders(stellaAppDir, value);
  }
  return resolved;
};

const replaceSecretPlaceholders = async (stellaAppDir: string, value: string) => {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\$\{([a-zA-Z0-9_.-]+)\}/gu)) {
    parts.push(value.slice(cursor, match.index));
    parts.push(
      (await loadConnectorAccessToken(stellaAppDir, match[1])) ?? match[0],
    );
    cursor = match.index + match[0].length;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
};

/**
 * Optional server-provided usage guidance from the MCP `initialize`
 * response (`result.instructions`). Captured so imports can embed it in
 * the generated connector skill.
 */
const readInstructions = (result: unknown): string | undefined => {
  const instructions =
    result && typeof result === "object"
      ? (result as { instructions?: unknown }).instructions
      : undefined;
  return typeof instructions === "string" && instructions.trim()
    ? instructions.trim()
    : undefined;
};

class HttpConnectorBridgeSession {
  private sessionId: string | null = null;
  private initialized = false;
  /** From the last successful `initialize` (see {@link readInstructions}). */
  instructions: string | undefined;

  constructor(
    private readonly stellaAppDir: string,
    private readonly server: ConnectorCommandConfig,
  ) {}

  private async headers() {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.server.headers ?? {}),
    };
    const token = await loadConnectorAccessToken(
      this.stellaAppDir,
      this.server.auth?.tokenKey,
    );
    if (token) {
      const scheme = this.server.auth?.scheme ?? "bearer";
      const value =
        scheme === "raw"
          ? token
          : scheme === "basic"
            ? `Basic ${token}`
            : scheme === "oauth"
              ? `OAuth ${token}`
              : `Bearer ${token}`;
      headers[this.server.auth?.headerName ?? "authorization"] = value;
    } else if (this.server.auth?.type && this.server.auth.type !== "none") {
      throw new ConnectorAuthError(
        0,
        this.server.displayName,
        this.server.auth.tokenKey,
        `${this.server.displayName} has no stored credential for tokenKey "${this.server.auth.tokenKey}".`,
      );
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    return headers;
  }

  private async request(
    method: string,
    params?: unknown,
    recoverSession = true,
  ): Promise<unknown> {
    if (!this.server.url)
      throw new Error(`${this.server.displayName} does not have a URL.`);
    const id = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(this.server.url, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `${this.server.displayName} timed out waiting for ${method}.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) this.sessionId = responseSessionId;
    const text = await response.text();
    if (!response.ok) {
      if (
        response.status === 404 &&
        recoverSession &&
        this.sessionId &&
        method !== "initialize"
      ) {
        this.sessionId = null;
        this.initialized = false;
        await this.initialize();
        return await this.request(method, params, false);
      }
      if (AUTH_STATUSES.has(response.status)) {
        throw new ConnectorAuthError(
          response.status,
          this.server.displayName,
          this.server.auth?.tokenKey,
          text,
        );
      }
      throw new Error(
        `${this.server.displayName} connector request failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : [JSON.parse(text) as RpcMessage];
    const message = messages.find((entry) => String(entry.id) === id);
    if (!message) {
      throw new Error(
        `${this.server.displayName} did not return a response for ${method}.`,
      );
    }
    if (message.error) {
      throw new Error(message.error.message ?? `${method} failed.`);
    }
    return message.result;
  }

  private async notify(method: string, params?: unknown) {
    if (!this.server.url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      await fetch(this.server.url, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stella", version: "0" },
    });
    this.instructions = readInstructions(result) ?? this.instructions;
    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<ConnectorToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as ConnectorToolInfo[]) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ConnectorToolCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as ConnectorToolCallResult;
  }

  close() {
    this.sessionId = null;
    this.initialized = false;
  }
}

class StdioConnectorBridgeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private processRecordPromise: Promise<string | null> | null = null;
  /** From the last successful `initialize` (see {@link readInstructions}). */
  instructions: string | undefined;
  private nextId = 1;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private initialized = false;

  constructor(
    private readonly stellaAppDir: string,
    private readonly server: ConnectorCommandConfig,
  ) {}

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    // Ignore late events from a child that has already been retired or
    // replaced. Its first failure already removed the matching process record.
    if (this.child !== child) return;
    const recordPromise = this.processRecordPromise;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.processRecordPromise = null;
    this.initialized = false;
    void recordPromise?.then(removeConnectorBridgeProcessRecord);
    try {
      child.kill();
    } catch {
      // The connector already exited.
    }
  }

  private async start() {
    if (this.child) return;
    if (!this.server.command) {
      throw new Error(`${this.server.displayName} does not have a command.`);
    }
    const bridgeSessionId = randomUUID();
    const workerPid = Number.parseInt(
      process.env.STELLA_RUNTIME_WORKER_PID ?? "",
      10,
    );
    this.child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.server.cwd,
      env: {
        ...process.env,
        ...(await resolveSecretPlaceholders(this.stellaAppDir, this.server.env)),
        STELLA_CONNECTOR_BRIDGE: "1",
        STELLA_CONNECTOR_ID: this.server.id,
        STELLA_CONNECTOR_SESSION: bridgeSessionId,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const child = this.child;
    this.processRecordPromise = child.pid
      ? writeConnectorBridgeProcessRecord(this.stellaAppDir, {
          sessionId: bridgeSessionId,
          pid: child.pid,
          ownerPid: process.pid,
          ...(Number.isInteger(workerPid) && workerPid > 0 ? { workerPid } : {}),
          connectorId: this.server.id,
          displayName: this.server.displayName,
          command: this.server.command,
          args: this.server.args ?? [],
          ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
          startedAt: Date.now(),
          processGroup: process.platform !== "win32",
        })
      : Promise.resolve(null);
    this.child.stderr.on("data", () => {
      // Drain diagnostics so verbose connector commands cannot block on a full pipe.
    });
    this.child.on("exit", () => {
      this.failChild(child, new Error(`${this.server.displayName} exited.`));
    });
    this.child.on("error", (error) => {
      this.failChild(child, error);
    });
    // stdin has its own error channel; child.on("error") only covers process
    // spawn failures. Own EPIPE/ECONNRESET before sending any MCP messages.
    this.child.stdin.on("error", (error) => this.failChild(child, error));
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "connector request failed."),
        );
      } else {
        pending.resolve(message.result);
      }
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`${this.server.displayName} is not running.`);
    const id = String(this.nextId++);
    const payload = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `${this.server.displayName} timed out waiting for ${method}.`,
            ),
          );
        }
      }, 60_000);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      // Register the request before writing. A connector can respond in the
      // same turn, and response dispatch must never race pending registration.
      try {
        child.stdin.write(payload, (error) => {
          if (error) this.failChild(child, error);
        });
      } catch (error) {
        this.failChild(
          child,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  private async notify(method: string, params?: unknown) {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`${this.server.displayName} is not running.`);
    const payload = `${JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(payload, (error) => {
          if (!error) {
            resolve();
            return;
          }
          this.failChild(child, error);
          reject(error);
        });
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.failChild(child, normalized);
        reject(normalized);
      }
    });
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stella", version: "0" },
    });
    this.instructions = readInstructions(result) ?? this.instructions;
    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<ConnectorToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as ConnectorToolInfo[]) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ConnectorToolCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as ConnectorToolCallResult;
  }

  async close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`${this.server.displayName} was disconnected.`));
    }
    this.pending.clear();
    const child = this.child;
    const recordPromise = this.processRecordPromise;
    this.child = null;
    this.processRecordPromise = null;
    this.initialized = false;
    if (child) {
      await stopConnectorBridgeProcess(child.pid, {
        processGroup: process.platform !== "win32",
      });
    }
    await recordPromise?.then(removeConnectorBridgeProcessRecord);
  }
}

const sessions = new Map<
  string,
  HttpConnectorBridgeSession | StdioConnectorBridgeSession
>();

const getSession = (stellaAppDir: string, server: ConnectorCommandConfig) => {
  const key = `${stellaAppDir}:${server.id}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session =
    server.transport === "stdio"
      ? new StdioConnectorBridgeSession(stellaAppDir, server)
      : new HttpConnectorBridgeSession(stellaAppDir, server);
  sessions.set(key, session);
  return session;
};

export const listConnectorBridgeTools = async (
  stellaAppDir: string,
  server: ConnectorCommandConfig,
) => getSession(stellaAppDir, server).listTools();

export type ConnectorBridgeProbe = {
  tools: ConnectorToolInfo[];
  /** Server-provided usage guidance from the MCP `initialize` response. */
  instructions?: string;
};

/**
 * `tools/list` plus the `instructions` string the server volunteered
 * during `initialize` — the shape MCP imports need to generate a skill.
 */
export const probeConnectorBridgeTools = async (
  stellaAppDir: string,
  server: ConnectorCommandConfig,
): Promise<ConnectorBridgeProbe> => {
  const session = getSession(stellaAppDir, server);
  const tools = await session.listTools();
  return {
    tools,
    ...(session.instructions ? { instructions: session.instructions } : {}),
  };
};

export const callConnectorBridgeTool = async (
  stellaAppDir: string,
  server: ConnectorCommandConfig,
  toolName: string,
  args: Record<string, unknown>,
) => getSession(stellaAppDir, server).callTool(toolName, args);

export const closeConnectorBridgeSessions = async (
  stellaAppDir: string,
  serverIds: Iterable<string>,
) => {
  for (const serverId of serverIds) {
    const key = `${stellaAppDir}:${serverId}`;
    const session = sessions.get(key);
    await session?.close();
    sessions.delete(key);
  }
};
