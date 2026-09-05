import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  buildAgentCursorHideExpression,
  buildAgentCursorPresentationExpression,
} from "../../../stella-browser/extension/lib/agent-cursor.js";
import { buildInAppBrowserUserAgent } from "./in-app-browser-auth-policy.js";

export type InAppBrowserDebuggerTarget = {
  id: string;
  url: string;
  title: string;
};

export type InAppBrowserDebuggerEvent = {
  tabId: string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export type InAppBrowserDebuggerRecovery = "terminated" | "reloaded";

export type InAppBrowserDebuggerController = {
  getDebuggerUserAgent?: () => string;
  listDebuggerTargets: (
    ownerId?: string,
  ) => InAppBrowserDebuggerTarget[] | Promise<InAppBrowserDebuggerTarget[]>;
  createDebuggerTarget: (
    url: string,
    ownerId?: string,
  ) => InAppBrowserDebuggerTarget | Promise<InAppBrowserDebuggerTarget>;
  closeDebuggerTarget: (
    tabId: string,
    ownerId?: string,
  ) => boolean | Promise<boolean>;
  activateDebuggerTarget: (
    tabId: string,
    ownerId?: string,
  ) => void | Promise<void>;
  sendDebuggerCommand: (
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    ownerId?: string,
    debuggerSessionId?: string,
  ) => unknown | Promise<unknown>;
  recoverDebuggerTarget: (
    tabId: string,
    ownerId?: string,
    debuggerSessionId?: string,
  ) => InAppBrowserDebuggerRecovery | Promise<InAppBrowserDebuggerRecovery>;
  subscribeDebuggerEvents: (
    listener: (event: InAppBrowserDebuggerEvent) => void,
  ) => () => void;
};

type InAppBrowserCdpAdapterOptions = Readonly<{
  commandTimeoutMs?: number;
  bootstrapCommandTimeoutMs?: number;
  recoveryTimeoutMs?: number;
}>;

type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type ClientState = {
  socket: WebSocket;
  sessions: Map<string, string>;
  childSessions: Map<string, { tabId: string; nativeSessionId: string; frameId: string; parentSessionId: string }>;
  childAttachments: Map<string, Promise<{ sessionId: string }>>;
  cursorTabs: Set<string>;
  discoverTargets: boolean;
  ownerId: string;
};

export type InAppBrowserCdpCapability = Readonly<{
  cdpUrl: string;
  expiresAt: number;
}>;

const OWNER_CAPABILITY_TTL_MS = 60_000;

function isDescendantFrame(value: unknown, frameId: string): boolean {
  if (!value || typeof value !== "object" || !("frameTree" in value)) return false;
  const visit = (tree: unknown, allowRoot: boolean, depth: number): boolean => {
    if (!tree || typeof tree !== "object" || depth > 32) return false;
    if (allowRoot && "frame" in tree && tree.frame && typeof tree.frame === "object" && "id" in tree.frame && tree.frame.id === frameId) return true;
    return "childFrames" in tree && Array.isArray(tree.childFrames) && tree.childFrames.some(child => visit(child, true, depth + 1));
  };
  return visit(value.frameTree, false, 0);
}
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 25_000;
const DEFAULT_CDP_BOOTSTRAP_COMMAND_TIMEOUT_MS = 3_000;
const DEFAULT_CDP_RECOVERY_TIMEOUT_MS = 1_500;
const BOOTSTRAP_PAGE_METHODS = new Set([
  "Page.enable",
  "Runtime.enable",
  "Network.enable",
]);

class CdpCommandTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`CDP command ${method} timed out after ${timeoutMs}ms.`);
    this.name = "CdpCommandTimeoutError";
  }
}

const requirePositiveTimeout = (
  value: number | undefined,
  fallback: number,
  name: string,
) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
};

const withTimeout = async <T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const task = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const isSafeNavigationUrl = (value: string) => {
  if (value === "about:blank") return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const targetInfo = (target: InAppBrowserDebuggerTarget) => ({
  targetId: target.id,
  type: "page",
  title: target.title,
  url: target.url || "about:blank",
  attached: false,
  canAccessOpener: false,
  browserContextId: "stella-in-app-browser",
});

const responseError = (error: unknown) => ({
  code: -32000,
  message: error instanceof Error ? error.message : String(error),
});

const sendJson = (socket: WebSocket, payload: unknown) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
};

/**
 * A deliberately narrow CDP facade over Stella-owned browser tabs.
 *
 * Electron's global remote-debugging switch exposes every Stella renderer on a
 * local unauthenticated port. This adapter instead publishes only targets the
 * in-app browser controller owns, behind an unguessable loopback WebSocket
 * path. Page-domain commands are forwarded through `webContents.debugger` by
 * the controller; browser-level Target commands are virtualized here.
 */
export class InAppBrowserCdpAdapter {
  private readonly controller: InAppBrowserDebuggerController;
  private readonly commandTimeoutMs: number;
  private readonly bootstrapCommandTimeoutMs: number;
  private readonly recoveryTimeoutMs: number;
  private readonly token = randomBytes(32).toString("hex");
  private readonly clients = new Set<ClientState>();
  private readonly ownerRoutes = new Map<
    string,
    Readonly<{ ownerId: string; expiresAt: number }>
  >();
  private httpServer: HttpServer | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private webSocketUrl: string | null = null;
  private unsubscribeDebuggerEvents: (() => void) | null = null;

  constructor(
    controller: InAppBrowserDebuggerController,
    options: InAppBrowserCdpAdapterOptions = {},
  ) {
    this.controller = controller;
    this.commandTimeoutMs = requirePositiveTimeout(
      options.commandTimeoutMs,
      DEFAULT_CDP_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.bootstrapCommandTimeoutMs = requirePositiveTimeout(
      options.bootstrapCommandTimeoutMs,
      DEFAULT_CDP_BOOTSTRAP_COMMAND_TIMEOUT_MS,
      "bootstrapCommandTimeoutMs",
    );
    this.recoveryTimeoutMs = requirePositiveTimeout(
      options.recoveryTimeoutMs,
      DEFAULT_CDP_RECOVERY_TIMEOUT_MS,
      "recoveryTimeoutMs",
    );
  }

  async start(): Promise<string> {
    if (this.webSocketUrl) return this.webSocketUrl;

    const path = `/devtools/browser/${this.token}`;
    const server = createServer((request, response) => {
      if (request.url === "/json/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            Browser: "Stella/InAppBrowser",
            "Protocol-Version": "1.3",
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const requestPath = request.url ?? "";
      const route = this.ownerRoutes.get(requestPath);
      if (!route || route.expiresAt <= Date.now()) {
        this.ownerRoutes.delete(requestPath);
        socket.destroy();
        return;
      }
      const ownerId = route.ownerId;
      // Owner routes are bearer capabilities: consume them on the first
      // successful upgrade so a copied URL cannot attach a second daemon.
      this.ownerRoutes.delete(requestPath);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        Reflect.set(webSocket, "__stellaOwnerId", ownerId);
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (socket) =>
      this.attachClient(
        socket,
        Reflect.get(socket, "__stellaOwnerId") as string | undefined,
      ),
    );

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
      server.listen(0, "127.0.0.1");
    });

    const address = server.address() as AddressInfo;
    this.httpServer = server;
    this.webSocketServer = webSocketServer;
    this.webSocketUrl = `ws://127.0.0.1:${address.port}${path}`;
    this.unsubscribeDebuggerEvents = this.controller.subscribeDebuggerEvents(
      (event) => this.broadcastDebuggerEvent(event),
    );
    return this.webSocketUrl;
  }

  async createOwnerCapability(
    ownerId: string,
  ): Promise<InAppBrowserCdpCapability> {
    const normalizedOwnerId = ownerId.trim();
    if (
      !normalizedOwnerId ||
      normalizedOwnerId.length > 512 ||
      normalizedOwnerId.includes("\0")
    ) {
      throw new Error("ownerId must be a non-empty capability string.");
    }
    const legacyUrl = await this.start();
    const parsed = new URL(legacyUrl);
    const routePath = `/devtools/browser/${randomBytes(32).toString("hex")}`;
    const expiresAt = Date.now() + OWNER_CAPABILITY_TTL_MS;
    this.pruneExpiredOwnerRoutes();
    this.ownerRoutes.set(routePath, { ownerId: normalizedOwnerId, expiresAt });
    parsed.pathname = routePath;
    return { cdpUrl: parsed.toString(), expiresAt };
  }

  async stop(): Promise<void> {
    this.unsubscribeDebuggerEvents?.();
    this.unsubscribeDebuggerEvents = null;
    for (const client of this.clients) {
      await this.hideClientAgentCursors(client);
      await this.detachChildSessions(client);
      client.socket.close();
    }
    this.clients.clear();
    this.ownerRoutes.clear();
    this.webSocketServer?.close();
    this.webSocketServer = null;
    const server = this.httpServer;
    this.httpServer = null;
    this.webSocketUrl = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private attachClient(socket: WebSocket, ownerId?: string) {
    if (!ownerId) {
      socket.close(1008, "Owner capability required");
      return;
    }
    const client: ClientState = {
      socket,
      sessions: new Map(),
      childSessions: new Map(),
      childAttachments: new Map(),
      cursorTabs: new Set(),
      discoverTargets: false,
      ownerId,
    };
    this.clients.add(client);
    socket.on("message", (data) => {
      void this.handleMessage(client, data);
    });
    const detach = () => {
      if (!this.clients.delete(client)) return;
      void this.hideClientAgentCursors(client);
      void this.detachChildSessions(client);
    };
    socket.once("close", detach);
    socket.once("error", detach);
  }

  private async handleMessage(client: ClientState, raw: RawData) {
    let request: CdpRequest;
    try {
      request = JSON.parse(raw.toString()) as CdpRequest;
    } catch {
      return;
    }
    if (typeof request.id !== "number" || !request.method) return;
    const method = request.method;

    try {
      const result = await this.dispatch(client, { ...request, method });
      sendJson(client.socket, { id: request.id, result: result ?? {} });
    } catch (error) {
      sendJson(client.socket, {
        id: request.id,
        error: responseError(error),
      });
    }
  }

  private async dispatch(client: ClientState, request: CdpRequest) {
    const method = request.method;
    if (!method) throw new Error("CDP method is required.");
    const params = request.params ?? {};
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Stella/InAppBrowser",
          revision: "0",
          // Mirror the session-level UA so any CDP client that derives the page
          // UA from Browser.getVersion sees the real Chrome UA, not "Stella".
          userAgent:
            this.controller.getDebuggerUserAgent?.() ??
            buildInAppBrowserUserAgent(undefined),
          jsVersion: process.versions.v8,
        };
      case "Browser.setDownloadBehavior":
      case "Browser.grantPermissions":
      case "Browser.resetPermissions":
      case "Browser.close":
      case "Target.setAutoAttach":
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: ["stella-in-app-browser"] };
      case "Target.createBrowserContext":
        return { browserContextId: "stella-in-app-browser" };
      case "Target.disposeBrowserContext":
        return {};
      case "Target.setDiscoverTargets": {
        client.discoverTargets = params.discover === true;
        return {};
      }
      case "Target.getTargets": {
        const targets = await this.controller.listDebuggerTargets(
          client.ownerId,
        );
        return { targetInfos: targets.map(targetInfo) };
      }
      case "Target.getTargetInfo": {
        const targetId = String(params.targetId ?? "");
        const targets = await this.controller.listDebuggerTargets(
          client.ownerId,
        );
        const target = targets.find((candidate) => candidate.id === targetId);
        if (!target) throw new Error("Browser target was not found.");
        return { targetInfo: targetInfo(target) };
      }
      case "Target.createTarget": {
        const url = String(params.url ?? "about:blank");
        if (!isSafeNavigationUrl(url)) {
          throw new Error(
            "Only http, https, and about:blank URLs are allowed.",
          );
        }
        const target = await this.controller.createDebuggerTarget(
          url,
          client.ownerId,
        );
        this.broadcastTargetEvent(
          "Target.targetCreated",
          { targetInfo: targetInfo(target) },
          client.ownerId,
        );
        return { targetId: target.id };
      }
      case "Target.attachToTarget": {
        const targetId = String(params.targetId ?? "");
        const targets = await this.controller.listDebuggerTargets(
          client.ownerId,
        );
        if (!targets.some((target) => target.id === targetId)) {
          const parentTabId = request.sessionId
            ? client.sessions.get(request.sessionId) ?? client.childSessions.get(request.sessionId)?.tabId
            : undefined;
          if (!parentTabId) throw new Error("Browser target was not found.");
          const parentSessionId = request.sessionId;
          if (!parentSessionId) throw new Error("Parent frame session is required.");
          const key = parentTabId + ":" + targetId;
          const pending = client.childAttachments.get(key);
          if (pending) return await pending;
          const attach = this.attachChildSession(client, parentTabId, parentSessionId, targetId);
          client.childAttachments.set(key, attach);
          try { return await attach; }
          finally { if (client.childAttachments.get(key) === attach) client.childAttachments.delete(key); }
        }
        const sessionId = randomUUID();
        client.sessions.set(sessionId, targetId);
        return { sessionId };
      }
      case "Target.activateTarget": {
        const targetId = String(params.targetId ?? "");
        await this.controller.activateDebuggerTarget(targetId, client.ownerId);
        return {};
      }
      case "Target.detachFromTarget": {
        const sessionId = String(params.sessionId ?? request.sessionId ?? "");
        const child = client.childSessions.get(sessionId);
        if (child) {
          await this.detachChildSessions(client, child.tabId, sessionId);
          return {};
        }
        const tabId = client.sessions.get(sessionId);
        client.sessions.delete(sessionId);
        if (tabId) await this.detachChildSessions(client, tabId);
        return {};
      }
      case "Target.closeTarget": {
        const targetId = String(params.targetId ?? "");
        const success = await this.controller.closeDebuggerTarget(
          targetId,
          client.ownerId,
        );
        for (const [sessionId, tabId] of client.sessions) {
          if (tabId === targetId) client.sessions.delete(sessionId);
        }
        for (const [sessionId, binding] of client.childSessions) {
          if (binding.tabId === targetId) client.childSessions.delete(sessionId);
        }
        if (success) {
          this.broadcastTargetEvent(
            "Target.targetDestroyed",
            { targetId },
            client.ownerId,
          );
        }
        return { success };
      }
      default:
        break;
    }

    const child = request.sessionId ? client.childSessions.get(request.sessionId) : undefined;
    const tabId = request.sessionId
      ? client.sessions.get(request.sessionId) ?? child?.tabId
      : undefined;
    if (!tabId) {
      throw new Error(`CDP method ${method} requires a page session.`);
    }

    if (!child) await this.presentAgentAction(client, tabId, method, params);
    return await this.sendPageCommand(tabId, method, params, client.ownerId, child?.nativeSessionId);
  }

  private async sendPageCommand(
    tabId: string,
    method: string,
    params: Record<string, unknown>,
    ownerId: string,
    debuggerSessionId?: string,
    discardLateResult?: (result: unknown) => Promise<void>,
  ): Promise<unknown> {
    const timeoutMs = BOOTSTRAP_PAGE_METHODS.has(method)
      ? this.bootstrapCommandTimeoutMs
      : this.commandTimeoutMs;
    const send = async () => {
      let abandoned = false;
      try { return await withTimeout(
        async () => {
          const result = await this.controller.sendDebuggerCommand(tabId, method, params, ownerId, debuggerSessionId);
          if (abandoned) await discardLateResult?.(result);
          return result;
        },
        timeoutMs,
        () => new CdpCommandTimeoutError(method, timeoutMs),
      ); } catch (error) { abandoned = true; throw error; }
    };

    try {
      return await send();
    } catch (error) {
      if (
        !(error instanceof CdpCommandTimeoutError) ||
        method === "Runtime.terminateExecution"
      ) {
        throw error;
      }

      let recovery: InAppBrowserDebuggerRecovery;
      try {
        recovery = await withTimeout(
          () => this.controller.recoverDebuggerTarget(tabId, ownerId, debuggerSessionId),
          this.recoveryTimeoutMs,
          () =>
            new Error(
              `CDP recovery timed out after ${this.recoveryTimeoutMs}ms.`,
            ),
        );
      } catch (recoveryError) {
        if (debuggerSessionId) await this.invalidateChildSession(tabId, debuggerSessionId);
        throw new Error(
          `${error.message} Page recovery failed: ${
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError)
          }`,
          { cause: error },
        );
      }

      // A replacement daemon enables Page/Runtime while attaching to every
      // retained tab, and network tooling enables Network on demand. Retry
      // them once after terminating/reloading a poisoned renderer so
      // bootstrap does not repeatedly kill healthy new daemons.
      if (debuggerSessionId) {
        await this.invalidateChildSession(tabId, debuggerSessionId);
        throw new Error(`${error.message} Frame session was invalidated after recovery; capture a new AX snapshot.`);
      }
      if (BOOTSTRAP_PAGE_METHODS.has(method)) {
        return await send();
      }

      throw new Error(`${error.message} Page execution was ${recovery}.`, {
        cause: error,
      });
    }
  }

  private broadcastDebuggerEvent(event: InAppBrowserDebuggerEvent) {
    for (const client of this.clients) {
      if (event.method === "Target.detachedFromTarget") {
        for (const [sessionId, binding] of client.childSessions) {
          if (binding.tabId === event.tabId && binding.nativeSessionId === event.params?.sessionId) {
            void this.detachChildSessions(client, binding.tabId, sessionId);
            sendJson(client.socket, { method: "Target.detachedFromTarget", params: {sessionId} });
          }
        }
      }
      if (event.sessionId) {
        for (const [sessionId, binding] of client.childSessions) {
          if (binding.tabId === event.tabId && binding.nativeSessionId === event.sessionId) {
            sendJson(client.socket, {method: event.method, params: event.params ?? {}, sessionId});
          }
        }
        continue;
      }
      for (const [sessionId, tabId] of client.sessions) {
        if (tabId !== event.tabId) continue;
        sendJson(client.socket, {
          method: event.method,
          params: event.params ?? {},
          sessionId,
        });
      }
    }
  }

  private broadcastTargetEvent(
    method: string,
    params: unknown,
    ownerId?: string,
  ) {
    for (const client of this.clients) {
      if (client.discoverTargets && client.ownerId === ownerId) {
        sendJson(client.socket, { method, params });
      }
    }
  }

  private pruneExpiredOwnerRoutes() {
    const now = Date.now();
    for (const [routePath, route] of this.ownerRoutes) {
      if (route.expiresAt <= now) this.ownerRoutes.delete(routePath);
    }
  }

  private async presentAgentAction(
    client: ClientState,
    tabId: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (method !== "Input.dispatchMouseEvent") return;
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dragging =
      params.type === "mouseMoved" &&
      (params.button === "left" || Number(params.buttons) > 0);
    const expression = buildAgentCursorPresentationExpression({
      x,
      y,
      animateMovement: !dragging,
      turnKey: client.ownerId,
    });
    client.cursorTabs.add(tabId);
    await Promise.resolve(
      this.controller.sendDebuggerCommand(
        tabId,
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
        client.ownerId,
      ),
    ).catch(() => undefined);
  }

  private async hideClientAgentCursors(client: ClientState) {
    const tabIds = [...client.cursorTabs];
    client.cursorTabs.clear();
    await Promise.all(
      tabIds.map((tabId) =>
        Promise.resolve(
          this.cleanupPageCommand(
            tabId,
            "Runtime.evaluate",
            {
              expression: buildAgentCursorHideExpression({
                turnKey: client.ownerId,
              }),
              returnByValue: true,
              awaitPromise: true,
            },
            client.ownerId,
          ),
        ).catch(() => undefined),
      ),
    );
  }

  private async attachChildSession(client: ClientState, tabId: string, parentSessionId: string, targetId: string): Promise<{sessionId: string}> {
    if (!(await this.validateDescendant(client, parentSessionId, targetId))) throw new Error("Browser frame target was not found.");
    const existing = [...client.childSessions.entries()].find(([, binding]) => binding.tabId === tabId && binding.frameId === targetId);
    if (existing) return {sessionId: existing[0]};
    // Electron's native Target agent only accepts target IDs it has reported.
    // Register currently live targets internally; never expose this unfiltered
    // browser-wide result through the owner-scoped adapter.
    await this.sendPageCommand(tabId, "Target.getTargets", {}, client.ownerId);
    const attached = await this.sendPageCommand(tabId, "Target.attachToTarget", {targetId, flatten: true}, client.ownerId, undefined, async (result) => {
      if (result && typeof result === "object" && "sessionId" in result && typeof result.sessionId === "string") {
        await this.cleanupPageCommand(tabId, "Target.detachFromTarget", {sessionId: result.sessionId}, client.ownerId).catch(() => undefined);
      }
    });
    if (!attached || typeof attached !== "object" || !("sessionId" in attached) || typeof attached.sessionId !== "string") throw new Error("Browser did not return a frame session.");
    if (!this.clients.has(client) || client.socket.readyState !== WebSocket.OPEN || (!client.sessions.has(parentSessionId) && !client.childSessions.has(parentSessionId))) {
      await this.cleanupPageCommand(tabId, "Target.detachFromTarget", {sessionId: attached.sessionId}, client.ownerId).catch(() => undefined);
      throw new Error("Browser owner session ended while attaching a frame.");
    }
    const sessionId = randomUUID();
    client.childSessions.set(sessionId, {tabId, nativeSessionId: attached.sessionId, frameId: targetId, parentSessionId});
    return {sessionId};
  }

  private async validateDescendant(client: ClientState, parentSessionId: string, frameId: string, depth = 0): Promise<boolean> {
    if (depth > 32 || !this.clients.has(client)) return false;
    const parent = client.childSessions.get(parentSessionId);
    const tabId = client.sessions.get(parentSessionId) ?? parent?.tabId;
    if (!tabId) return false;
    if (parent && !(await this.validateDescendant(client, parent.parentSessionId, parent.frameId, depth + 1))) return false;
    const tree = await this.sendPageCommand(tabId, "Page.getFrameTree", {}, client.ownerId, parent?.nativeSessionId);
    if (isDescendantFrame(tree, frameId)) return true;
    // Chromium omits out-of-process frames from this session's frame tree.
    // DOM.getFrameOwner is scoped to the inspected target and proves that
    // the candidate frame has an owner element in this document subtree.
    try {
      const owner = await this.sendPageCommand(tabId, "DOM.getFrameOwner", {frameId}, client.ownerId, parent?.nativeSessionId);
      return !!owner && typeof owner === "object" && "backendNodeId" in owner && typeof owner.backendNodeId === "number";
    } catch { return false; }
  }

  private cleanupPageCommand(tabId: string, method: string, params: Record<string, unknown>, ownerId: string) {
    return withTimeout(() => this.controller.sendDebuggerCommand(tabId, method, params, ownerId), this.recoveryTimeoutMs, () => new Error("Frame cleanup timed out."));
  }

  private async invalidateChildSession(tabId: string, nativeSessionId: string) {
    for (const client of this.clients) {
      for (const [sessionId, binding] of client.childSessions) {
        if (binding.tabId === tabId && binding.nativeSessionId === nativeSessionId) await this.detachChildSessions(client, tabId, sessionId);
      }
    }
  }

  private async detachChildSessions(client: ClientState, tabId?: string, rootSessionId?: string) {
    const selected = new Set(rootSessionId ? [rootSessionId] : []);
    for (let round = 0; round <= client.childSessions.size; round += 1) {
      let changed = false;
      for (const [sessionId, binding] of client.childSessions) {
        if ((!tabId || binding.tabId === tabId) && (!rootSessionId || selected.has(binding.parentSessionId) || selected.has(sessionId)) && !selected.has(sessionId)) {
          selected.add(sessionId); changed = true;
        }
      }
      if (!changed) break;
    }
    const pending: Promise<unknown>[] = [];
    for (const [sessionId, binding] of client.childSessions) {
      if (!selected.has(sessionId)) continue;
      client.childSessions.delete(sessionId);
      pending.push(this.cleanupPageCommand(binding.tabId, "Target.detachFromTarget", {sessionId: binding.nativeSessionId}, client.ownerId));
    }
    await Promise.allSettled(pending);
  }
}
