import { DurableObject } from "cloudflare:workers";
import {
  HEADER_OWNER,
  HEADER_TOKEN_EXP,
  SUBPROTOCOL,
  isWebSocketUpgrade,
} from "./conversation-hub.js";

export const HEADER_EXECUTION_DEVICE_ID = "x-stella-execution-device-id";
export const DEVICE_PRESENCE_PING_INTERVAL_MS = 10_000;
export const DEVICE_PRESENCE_STALE_MS = 60_000;

type PresenceEnv = {
  STELLA_CONVEX_SITE_URL: string;
  BUILDER_SERVICE_SECRET: string;
};

type PresenceAttachment = {
  v: 1;
  ownerId: string;
  deviceId: string;
  authExpiresAtMs: number;
  connectionId: string;
  nonce: string;
  presenceSessionId?: string;
  active: boolean;
  lastSeenAtMs: number;
};

type CallbackIdentity = Pick<
  PresenceAttachment,
  | "ownerId"
  | "deviceId"
  | "presenceSessionId"
  | "connectionId"
  | "authExpiresAtMs"
>;

const PENDING_DISCONNECTS_KEY = "pendingDisconnects";
const MAX_PENDING_DISCONNECTS = 8;
const MAX_FRAME_BYTES = 1024;
const CALLBACK_TIMEOUT_MS = 10_000;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const clean = (value: string | null, max: number): string => {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized.length <= max ? normalized : "";
};

const frameText = (message: string | ArrayBuffer): string =>
  typeof message === "string"
    ? message
    : new TextDecoder().decode(new Uint8Array(message));

export class DevicePresence extends DurableObject<PresenceEnv> {
  private callbackUrl(path: "check" | "disconnect"): string {
    return `${this.env.STELLA_CONVEX_SITE_URL.replace(/\/+$/u, "")}/api/execution-placement/presence/socket/${path}`;
  }

  private async callback(
    path: "check" | "disconnect",
    identity: CallbackIdentity,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.callbackUrl(path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(identity),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Presence callback failed (${response.status}).`);
    const value = await response.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  }

  private identity(attachment: PresenceAttachment): CallbackIdentity | null {
    return attachment.presenceSessionId
      ? {
          ownerId: attachment.ownerId,
          deviceId: attachment.deviceId,
          presenceSessionId: attachment.presenceSessionId,
          connectionId: attachment.connectionId,
          authExpiresAtMs: attachment.authExpiresAtMs,
        }
      : null;
  }

  private async queueDisconnect(identity: CallbackIdentity): Promise<void> {
    const pending =
      (await this.ctx.storage.get<CallbackIdentity[]>(
        PENDING_DISCONNECTS_KEY,
      )) ?? [];
    if (
      !pending.some((entry) => entry.connectionId === identity.connectionId)
    ) {
      pending.push(identity);
    }
    await this.ctx.storage.put(
      PENDING_DISCONNECTS_KEY,
      pending.slice(-MAX_PENDING_DISCONNECTS),
    );
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  private async disconnect(attachment: PresenceAttachment): Promise<void> {
    const identity = this.identity(attachment);
    if (!identity) return;
    try {
      await this.callback("disconnect", identity);
    } catch {
      await this.queueDisconnect(identity);
    }
  }

  private async flushDisconnects(): Promise<void> {
    const pending =
      (await this.ctx.storage.get<CallbackIdentity[]>(
        PENDING_DISCONNECTS_KEY,
      )) ?? [];
    if (pending.length === 0) return;
    const retry: CallbackIdentity[] = [];
    for (const identity of pending) {
      try {
        await this.callback("disconnect", identity);
      } catch {
        retry.push(identity);
      }
    }
    if (retry.length > 0) {
      await this.ctx.storage.put(PENDING_DISCONNECTS_KEY, retry);
    } else {
      await this.ctx.storage.delete(PENDING_DISCONNECTS_KEY);
    }
  }

  private scheduleAlarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as PresenceAttachment;
      next = Math.min(
        next,
        attachment.lastSeenAtMs + DEVICE_PRESENCE_STALE_MS,
        attachment.authExpiresAtMs,
      );
    }
    if (!Number.isFinite(next)) return Promise.resolve();
    return this.ctx.storage.setAlarm(Math.max(now + 1_000, next));
  }

  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return json({ error: "This endpoint speaks WebSocket only." }, 426);
    }
    const ownerId = clean(request.headers.get(HEADER_OWNER), 512);
    const deviceId = clean(
      request.headers.get(HEADER_EXECUTION_DEVICE_ID),
      256,
    );
    const authExpiresAtMs = Number(request.headers.get(HEADER_TOKEN_EXP));
    if (
      !ownerId ||
      !deviceId ||
      !Number.isFinite(authExpiresAtMs) ||
      authExpiresAtMs <= Date.now()
    ) {
      return json({ error: "Missing verified device identity." }, 401);
    }

    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;
    const now = Date.now();
    const attachment: PresenceAttachment = {
      v: 1,
      ownerId,
      deviceId,
      authExpiresAtMs,
      connectionId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      active: false,
      lastSeenAtMs: now,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(
      JSON.stringify({
        type: "challenge",
        connectionId: attachment.connectionId,
        nonce: attachment.nonce,
        pingIntervalMs: DEVICE_PRESENCE_PING_INTERVAL_MS,
        staleAfterMs: DEVICE_PRESENCE_STALE_MS,
      }),
    );
    await this.scheduleAlarm();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": SUBPROTOCOL },
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const text = frameText(message);
    if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) {
      socket.close(4000, "bad_request");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      socket.close(4000, "bad_request");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      socket.close(4000, "bad_request");
      return;
    }
    const frame = parsed as Record<string, unknown>;
    const attachment = socket.deserializeAttachment() as PresenceAttachment;
    if (frame.type === "begin" && !attachment.active) {
      const presenceSessionId =
        typeof frame.presenceSessionId === "string"
          ? clean(frame.presenceSessionId, 128)
          : "";
      if (!presenceSessionId) {
        socket.close(4000, "bad_request");
        return;
      }
      attachment.presenceSessionId = presenceSessionId;
      attachment.lastSeenAtMs = Date.now();
      socket.serializeAttachment(attachment);
      socket.send(
        JSON.stringify({
          type: "prove",
          connectionId: attachment.connectionId,
        }),
      );
      return;
    }
    if (frame.type === "ready" && !attachment.active) {
      const identity = this.identity(attachment);
      if (!identity) {
        socket.close(4000, "bad_request");
        return;
      }
      let current = false;
      try {
        current = (await this.callback("check", identity)).current === true;
      } catch {
        socket.close(4500, "presence_unavailable");
        return;
      }
      if (!current) {
        socket.close(4403, "device_proof_rejected");
        return;
      }
      attachment.active = true;
      attachment.lastSeenAtMs = Date.now();
      socket.serializeAttachment(attachment);
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const otherAttachment =
          other.deserializeAttachment() as PresenceAttachment;
        if (otherAttachment.active) other.close(4001, "replaced");
      }
      socket.send(JSON.stringify({ type: "connected" }));
      await this.scheduleAlarm();
      return;
    }
    if (frame.type === "ping" && attachment.active) {
      attachment.lastSeenAtMs = Date.now();
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    socket.close(4000, "bad_request");
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ) {
    const attachment = socket.deserializeAttachment() as PresenceAttachment;
    await this.disconnect(attachment);
    try {
      socket.close(code >= 3000 && code <= 4999 ? code : 1000, "");
    } catch {
      // Already gone.
    }
  }

  async webSocketError(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as PresenceAttachment;
    await this.disconnect(attachment);
    try {
      socket.close(1011, "socket_error");
    } catch {
      // Already gone.
    }
  }

  async alarm() {
    await this.flushDisconnects();
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as PresenceAttachment;
      if (
        attachment.authExpiresAtMs <= now ||
        attachment.lastSeenAtMs + DEVICE_PRESENCE_STALE_MS <= now
      ) {
        await this.disconnect(attachment);
        socket.close(4002, "stale");
      }
    }
    const pending =
      (await this.ctx.storage.get<CallbackIdentity[]>(
        PENDING_DISCONNECTS_KEY,
      )) ?? [];
    if (pending.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    } else {
      await this.scheduleAlarm();
    }
  }
}
