import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { IN_APP_BROWSER_USER_AGENT } from "./in-app-browser-auth-policy.js";

export type InAppBrowserDebuggerTarget = {
  id: string;
  url: string;
  title: string;
};

export type InAppBrowserDebuggerEvent = {
  tabId: string;
  method: string;
  params?: Record<string, unknown>;
};

export type InAppBrowserDebuggerController = {
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
  ) => unknown | Promise<unknown>;
  subscribeDebuggerEvents: (
    listener: (event: InAppBrowserDebuggerEvent) => void,
  ) => () => void;
};

type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type ClientState = {
  socket: WebSocket;
  sessions: Map<string, string>;
  discoverTargets: boolean;
  ownerId: string;
};

export type InAppBrowserCdpCapability = Readonly<{
  cdpUrl: string;
  expiresAt: number;
}>;

const OWNER_CAPABILITY_TTL_MS = 60_000;

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

  constructor(controller: InAppBrowserDebuggerController) {
    this.controller = controller;
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
      discoverTargets: false,
      ownerId,
    };
    this.clients.add(client);
    socket.on("message", (data) => {
      void this.handleMessage(client, data);
    });
    socket.once("close", () => this.clients.delete(client));
    socket.once("error", () => this.clients.delete(client));
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
          userAgent: IN_APP_BROWSER_USER_AGENT,
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
          throw new Error("Browser target was not found.");
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
        client.sessions.delete(sessionId);
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

    const tabId = request.sessionId
      ? client.sessions.get(request.sessionId)
      : undefined;
    if (!tabId) {
      throw new Error(`CDP method ${method} requires a page session.`);
    }

    await this.presentAgentAction(tabId, method, params, client.ownerId);
    return await this.controller.sendDebuggerCommand(
      tabId,
      method,
      params,
      client.ownerId,
    );
  }

  private broadcastDebuggerEvent(event: InAppBrowserDebuggerEvent) {
    for (const client of this.clients) {
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
    tabId: string,
    method: string,
    params: Record<string, unknown>,
    ownerId?: string,
  ) {
    if (method !== "Input.dispatchMouseEvent") return;
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const kind = params.type === "mousePressed" ? "click" : "move";
    const expression = `(() => {
      const ROOT_ID = '__stella_agent_pointer__';
      let root = document.getElementById(ROOT_ID);
      if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;contain:layout style;transition:transform 220ms cubic-bezier(.2,.8,.2,1);';
        const cursor = document.createElement('div');
        cursor.dataset.cursor = 'true';
        cursor.style.cssText = 'position:absolute;width:20px;height:25px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));transform:translate(-2px,-2px);';
        cursor.innerHTML = '<svg viewBox="0 0 20 25" width="20" height="25"><path d="M2 1.5v18.2l4.7-4.1 3.1 7.2 3.1-1.35-3.1-7.1h6.4L2 1.5Z" fill="#101116" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        const badge = document.createElement('div');
        badge.textContent = 'Stella';
        badge.style.cssText = 'position:absolute;left:15px;top:19px;padding:3px 7px;border-radius:999px;background:#101116;color:white;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.22);white-space:nowrap;';
        root.append(cursor, badge);
        (document.documentElement || document.body).appendChild(root);
      }
      root.style.transform = 'translate3d(${x}px,${y}px,0)';
      if ('${kind}' === 'click') {
        const ring = document.createElement('div');
        ring.dataset.stellaClickRing = 'true';
        ring.style.cssText = 'position:absolute;left:0;top:0;width:28px;height:28px;margin:-14px;border:2px solid rgba(255,255,255,.95);border-radius:50%;background:rgba(20,22,28,.12);animation:__stella_agent_click__ 420ms ease-out forwards;';
        if (!document.getElementById('__stella_agent_pointer_style__')) {
          const style = document.createElement('style');
          style.id = '__stella_agent_pointer_style__';
          style.textContent = '@keyframes __stella_agent_click__{from{opacity:.92;transform:scale(.35)}to{opacity:0;transform:scale(2.6)}}@media(prefers-reduced-motion:reduce){#__stella_agent_pointer__{transition:none!important}#__stella_agent_pointer__ [data-stella-click-ring]{animation:none!important;opacity:.55;transform:none}}';
          (document.head || document.documentElement).appendChild(style);
        }
        root.prepend(ring);
        setTimeout(() => ring.remove(), 460);
      }
    })()`;
    await Promise.resolve(
      this.controller.sendDebuggerCommand(
        tabId,
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
        },
        ownerId,
      ),
    ).catch(() => undefined);
    if (kind === "click") {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  }
}
