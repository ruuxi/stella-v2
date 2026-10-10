import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  deviceRequestErrorResponse,
  DeviceRequestRelay,
} from "../device-request-relay.js";
import type { DeviceToolDeviceFrame } from "@stella/contracts/turn-plane/device-tools";
import {
  DEVICE_REQUEST_LIMITS,
  type DeviceRequestDeviceFrame,
  isDeviceRequestMethod,
} from "@stella/contracts/turn-plane/device-requests";
import {
  DEVICE_PRESENCE_CLOSE,
  DEVICE_PRESENCE_PROTOCOL_VERSION,
  DEVICE_PRESENCE_STALE_AFTER_MS,
  type DevicePresenceDeviceFrame,
  type DevicePresenceServerFrame,
  type DeviceRemoteExecution,
  SELECTED_DEVICE_NEEDS_CONSENT,
} from "@stella/contracts/turn-plane/placement";
import {
  type DevicePresenceState,
  MAX_DEVICE_ID_CHARS,
} from "../dispatch-policy.js";
import {
  HEADER_PRESENCE_DEVICE_ID,
  HEADER_DEVICE_REQUEST_MOBILE_ID,
  HEADER_DEVICE_REQUEST_ID,
  HEADER_DEVICE_REQUEST_METHOD,
  AGENT_MESSAGE_OUTCOMES,
} from "./constants.js";
import {
  type PresenceAttachment,
  presenceTag,
  devicePresenceProofMessage,
  verifyDevicePresenceProof,
  parseAvailability,
  type PresenceRow,
  presenceState,
} from "./presence.js";
import { log, trustedOwnerCaller } from "./support.js";
import { OwnerGateBase } from "./gate-base.js";

/**
 * Device presence sockets: frames, presence rows, device requests, and consent.
 */
export abstract class OwnerGateDeviceSockets extends OwnerGateBase {
  protected sockets(deviceId?: string): WebSocket[] {
    try {
      return deviceId
        ? this.ctx.getWebSockets(presenceTag(deviceId))
        : this.ctx.getWebSockets();
    } catch {
      return [];
    }
  }

  protected attachment(socket: WebSocket): PresenceAttachment | null {
    try {
      const value = socket.deserializeAttachment() as PresenceAttachment | null;
      return value && value.v === 1 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * When a proven device was last heard from. Current devices' keepalives
   * are answered by the platform without waking this object, so the time of
   * the last auto-response counts alongside the last frame handled here.
   */
  protected lastSeenAt(
    socket: WebSocket,
    attachment: PresenceAttachment,
  ): number {
    let seen = attachment.lastSeenAtMs;
    if (attachment.phase !== "connected") return seen;
    try {
      const answered = this.ctx.getWebSocketAutoResponseTimestamp(socket);
      if (answered) seen = Math.max(seen, answered.getTime());
    } catch {
      // No timestamp; the last handled frame stands.
    }
    return seen;
  }

  protected send(socket: WebSocket, frame: DevicePresenceServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The peer is gone; the close path cleans up.
    }
  }

  protected closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  /** The device's connected socket, only while its presence is not stale. */
  protected liveSocket(deviceId: string): WebSocket | null {
    const socket = this.connectedSocket(deviceId);
    if (!socket) return null;
    const presence = this.presenceRow(deviceId);
    return presence?.connected &&
      presence.lastSeenAt + DEVICE_PRESENCE_STALE_AFTER_MS > Date.now()
      ? socket
      : null;
  }

  /** The one connected, proven socket for a device, if it has one. */
  protected connectedSocket(deviceId: string): WebSocket | null {
    for (const socket of this.sockets(deviceId)) {
      const attachment = this.attachment(socket);
      if (attachment?.phase === "connected") return socket;
    }
    return null;
  }

  protected async handleDeviceFrame(
    socket: WebSocket,
    attachment: PresenceAttachment,
    frame: DevicePresenceDeviceFrame,
    now: number,
  ): Promise<void> {
    if (frame.type === "begin") {
      if (attachment.phase !== "challenged") {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      const presenceSessionId =
        typeof frame.presenceSessionId === "string"
          ? frame.presenceSessionId.trim()
          : "";
      const availability = parseAvailability(frame.availability);
      if (
        !presenceSessionId ||
        presenceSessionId.length > 128 ||
        frame.protocolVersion !== DEVICE_PRESENCE_PROTOCOL_VERSION ||
        !availability
      ) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      attachment.presenceSessionId = presenceSessionId;
      attachment.availability = availability;
      attachment.phase = "begun";
      attachment.lastSeenAtMs = now;
      socket.serializeAttachment(attachment);
      return;
    }
    if (frame.type === "proof") {
      if (attachment.phase !== "begun" || !attachment.presenceSessionId) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      const signature =
        typeof frame.signature === "string" ? frame.signature.trim() : "";
      let snapshot: OwnerSnapshot;
      try {
        snapshot = await this.snapshot({ now });
      } catch {
        this.closeSocket(
          socket,
          DEVICE_PRESENCE_CLOSE.internal,
          "presence_unavailable",
        );
        return;
      }
      const device = (snapshot.devices ?? []).find(
        (candidate) => candidate.deviceId === attachment.deviceId,
      );
      const verified =
        Boolean(device) &&
        Boolean(signature) &&
        (await verifyDevicePresenceProof({
          publicKey: device!.publicKey,
          message: devicePresenceProofMessage({
            connectionId: attachment.connectionId,
            nonce: attachment.nonce,
          }),
          signature,
        }));
      if (!verified) {
        log("error", "device_presence_proof_rejected", {
          ownerId: this.ownerId(),
          deviceId: attachment.deviceId,
          registered: Boolean(device),
        });
        this.closeSocket(
          socket,
          DEVICE_PRESENCE_CLOSE.proofRejected,
          "device_proof_rejected",
        );
        return;
      }
      // The proof is what earns the device its slot, so the older socket for
      // the same device only loses it here — a failed handshake can never
      // evict a working one.
      for (const other of this.sockets(attachment.deviceId)) {
        if (other === socket) continue;
        this.deviceRequestRelay().onDeviceGone(attachment.deviceId, other);
        this.deviceToolRelayState?.onDeviceGone(attachment.deviceId, other);
        this.closeSocket(other, DEVICE_PRESENCE_CLOSE.replaced, "replaced");
      }
      attachment.phase = "connected";
      attachment.lastSeenAtMs = now;
      socket.serializeAttachment(attachment);
      this.writePresence(attachment, now, true);
      this.send(socket, {
        type: "connected",
        presenceSessionId: attachment.presenceSessionId,
        serverTimeMs: now,
      });
      this.deviceToolRelayState?.onDeviceConnected(attachment.deviceId, socket);
      const flushed = await this.ownerStore().internalCall(
        "agentThreads.flushDeviceMessages",
        { deviceId: attachment.deviceId },
      );
      if (!flushed.ok) {
        log("error", "device_agent_messages_flush_failed", {
          deviceId: attachment.deviceId,
          message: flushed.error.message,
        });
      }
      await this.scheduleAlarm(now);
      return;
    }
    if (attachment.phase !== "connected" || !attachment.presenceSessionId) {
      this.closeSocket(
        socket,
        DEVICE_PRESENCE_CLOSE.unauthorized,
        "unauthorized",
      );
      return;
    }
    attachment.lastSeenAtMs = now;
    if (frame.type === "ping") {
      // Older devices' JSON keepalive. The attachment is where it lands:
      // `presenceRow` reads last-seen from the socket, so this costs no write.
      socket.serializeAttachment(attachment);
      this.send(socket, { type: "pong", serverTimeMs: now });
      return;
    }
    if (frame.type === "availability") {
      const availability = parseAvailability(frame.availability);
      if (!availability) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      attachment.availability = availability;
      socket.serializeAttachment(attachment);
      this.writePresence(attachment, now, true);
      return;
    }
    if (frame.type === "consent") {
      // The answer arrives on the proven presence socket, so it is the machine
      // itself speaking, not merely someone holding the account. That is what
      // makes this the on-device half of the decision rather than a second
      // copy of the enable button.
      if (typeof frame.allow !== "boolean") {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      socket.serializeAttachment(attachment);
      const written = await this.ownerStore().internalCall(
        "devices.setRemoteExecution",
        { deviceId: attachment.deviceId, enabled: frame.allow },
      );
      if (!written.ok) {
        log("error", "device_consent_write_failed", {
          deviceId: attachment.deviceId,
          message: written.error.message,
        });
        this.send(socket, {
          type: "error",
          code: written.error.code,
          message: written.error.message,
          retryable: true,
        });
      }
      return;
    }
    socket.serializeAttachment(attachment);
    if (
      frame.type === "response.start" ||
      frame.type === "response.chunk" ||
      frame.type === "response.end" ||
      frame.type === "response.error"
    ) {
      this.deviceRequestRelay().onFrame(
        socket,
        attachment.deviceId,
        frame as DeviceRequestDeviceFrame,
      );
      return;
    }
    if (
      frame.type === "tool.accepted" ||
      frame.type === "tool.result" ||
      frame.type === "tool.error"
    ) {
      this.deviceToolRelayState?.onFrame(
        attachment.deviceId,
        frame as DeviceToolDeviceFrame,
      );
      return;
    }
    if (frame.type === "agent-message.ack") {
      const messageId =
        typeof frame.messageId === "string" ? frame.messageId : "";
      if (!messageId || !AGENT_MESSAGE_OUTCOMES.has(frame.outcome)) {
        this.closeSocket(socket, DEVICE_PRESENCE_CLOSE.protocol, "bad_request");
        return;
      }
      this.localAgentMessageAcks.get(`${attachment.deviceId}:${messageId}`)?.(
        frame.outcome,
      );
      return;
    }
    await this.handleExecutorFrame(socket, attachment, frame, now);
  }

  protected deviceRequestRelay(): DeviceRequestRelay {
    return (this.deviceRequestRelayState ??= new DeviceRequestRelay({
      liveSocket: (deviceId) => this.liveSocket(deviceId),
      send: (socket, frame) => this.send(socket, frame),
      log: (event, fields) =>
        log("error", event, { ownerId: this.ownerId(), ...fields }),
    }));
  }

  /**
   * `POST /owners/me/devices/:deviceId/requests`, forwarded by the Worker
   * after it verified the account and the phone's pairing proof. The body is
   * the request's params JSON; the answer streams back from the computer.
   */
  protected async handleDeviceRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    const caller = trustedOwnerCaller(request);
    if (!caller || caller.ownerId !== this.ownerId()) {
      return deviceRequestErrorResponse(
        "unauthorized",
        "Missing verified identity.",
      );
    }
    const deviceId =
      request.headers.get(HEADER_PRESENCE_DEVICE_ID)?.trim() ?? "";
    const mobileDeviceId =
      request.headers.get(HEADER_DEVICE_REQUEST_MOBILE_ID)?.trim() ?? "";
    const requestId =
      request.headers.get(HEADER_DEVICE_REQUEST_ID)?.trim() ?? "";
    const method =
      request.headers.get(HEADER_DEVICE_REQUEST_METHOD)?.trim() ?? "";
    const paramsJson = await request.text();
    if (
      !deviceId ||
      deviceId.length > MAX_DEVICE_ID_CHARS ||
      !mobileDeviceId ||
      !requestId ||
      requestId.length > DEVICE_REQUEST_LIMITS.requestId ||
      !isDeviceRequestMethod(method) ||
      paramsJson.length > DEVICE_REQUEST_LIMITS.paramsBytes
    ) {
      return deviceRequestErrorResponse(
        "bad_request",
        "Malformed device request.",
      );
    }
    this.ensureSchema();
    return await this.deviceRequestRelay().open({
      deviceId,
      mobileDeviceId,
      requestId,
      method,
      paramsJson,
    });
  }

  protected async dropSocket(
    socket: WebSocket,
    attachment: PresenceAttachment,
    code: number,
    reason: string,
    now: number,
  ): Promise<void> {
    if (attachment.phase === "connected") {
      this.markDisconnected(attachment, now);
    }
    this.deviceRequestRelay().onDeviceGone(attachment.deviceId, socket);
    this.deviceToolRelayState?.onDeviceGone(attachment.deviceId, socket);
    this.closeSocket(socket, code, reason);
    await this.scheduleAlarm(now);
  }

  protected writePresence(
    attachment: PresenceAttachment,
    now: number,
    connected: boolean,
  ): void {
    const availability = attachment.availability ?? {
      ready: false,
      capabilities: [],
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO device_presence (
         device_id, presence_session_id, connection_id, connected, ready,
         chat_slots, agent_slots, capabilities, protocol_version,
         last_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         presence_session_id = excluded.presence_session_id,
         connection_id = excluded.connection_id,
         connected = excluded.connected,
         ready = excluded.ready,
         chat_slots = excluded.chat_slots,
         agent_slots = excluded.agent_slots,
         capabilities = excluded.capabilities,
         protocol_version = excluded.protocol_version,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      attachment.deviceId,
      attachment.presenceSessionId ?? "",
      attachment.connectionId,
      connected ? 1 : 0,
      availability.ready ? 1 : 0,
      // Retained only for compatibility with existing SQLite tables.
      0,
      0,
      JSON.stringify(availability.capabilities),
      DEVICE_PRESENCE_PROTOCOL_VERSION,
      now,
      now,
    );
  }

  /**
   * A device that goes away keeps its row (so the destinations list can say
   * "offline" rather than "unknown") but is immediately ineligible.
   */
  protected markDisconnected(
    attachment: PresenceAttachment,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE device_presence
         SET connected = 0, ready = 0, updated_at = ?
       WHERE device_id = ? AND connection_id = ?`,
      now,
      attachment.deviceId,
      attachment.connectionId,
    );
  }

  protected presenceRow(deviceId: string): DevicePresenceState | undefined {
    const row = this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT device_id, presence_session_id, connection_id, connected, ready,
                chat_slots, agent_slots, capabilities, protocol_version, last_seen_at
           FROM device_presence WHERE device_id = ?`,
        deviceId,
      )
      .toArray()[0];
    if (!row) return undefined;
    const state = presenceState(row);
    if (!state.connected) return state;
    // The row's `last_seen_at` is only written when presence changes; between
    // changes the socket knows when the device was last heard from.
    for (const socket of this.sockets(deviceId)) {
      const attachment = this.attachment(socket);
      if (
        attachment?.phase === "connected" &&
        attachment.connectionId === row.connection_id
      ) {
        return {
          ...state,
          lastSeenAt: Math.max(
            state.lastSeenAt,
            this.lastSeenAt(socket, attachment),
          ),
        };
      }
    }
    return state;
  }

  protected selectedDeviceRefusal(args: {
    deviceId: string | null;
    now: number;
    remoteExecution?: DeviceRemoteExecution;
  }): {
    fallbackReason: string;
    errorCode: string;
    errorMessage: string;
  } | null {
    const presence = args.deviceId
      ? this.presenceRow(args.deviceId)
      : undefined;
    // Consent comes first: a computer that has not agreed to run remote work
    // is refusing for a reason the owner can fix in one tap, and saying
    // "offline" or "not ready" instead would send them looking for the wrong
    // problem. This code is also what keeps a waiting agent waiting.
    if (args.remoteExecution && args.remoteExecution !== "enabled") {
      return {
        fallbackReason: `selected-device-${args.remoteExecution}`,
        errorCode: SELECTED_DEVICE_NEEDS_CONSENT,
        errorMessage:
          args.remoteExecution === "declined"
            ? "That computer is set not to accept work from your other devices. Enable it in the device list, or allow it on that computer."
            : "That computer has not agreed to run work sent from elsewhere yet. It is asking on its own screen; you can also tap Enable for it in the device list.",
      };
    }
    if (
      !args.deviceId ||
      !presence?.connected ||
      presence.lastSeenAt + DEVICE_PRESENCE_STALE_AFTER_MS <= args.now
    ) {
      return {
        fallbackReason: "selected-device-offline",
        errorCode: "SELECTED_DEVICE_OFFLINE",
        errorMessage: "The selected computer is offline.",
      };
    }
    if (!presence.ready) {
      return {
        fallbackReason: "selected-device-unavailable",
        errorCode: "SELECTED_DEVICE_UNAVAILABLE",
        errorMessage:
          "The selected computer is online but isn't accepting work right now. It may still be starting up, be signed out, have cloud sync off, or not allow work from other devices.",
      };
    }
    return null;
  }

  /**
   * Ask a device, on its own screen, to start accepting dispatched work.
   *
   * Called when something was aimed at a device that has not agreed. The
   * attempt it came from does not wait on the answer — a human tap is not on
   * the offer window's timescale — so this only raises the prompt and records
   * that it is up. Agent work retries for the next hour, which is what makes
   * "wait for allow" work without holding a dispatch open.
   */
  protected async requestDeviceConsent(args: {
    deviceId: string;
    remoteExecution: DeviceRemoteExecution;
    requesterLabel?: string;
    now: number;
  }): Promise<void> {
    if (args.remoteExecution === "enabled") return;
    const recorded = await this.ownerStore().internalCall(
      "devices.requestRemoteExecution",
      { deviceId: args.deviceId },
    );
    if (!recorded.ok) {
      log("error", "device_consent_request_failed", {
        deviceId: args.deviceId,
        message: recorded.error.message,
      });
      return;
    }
    const socket = this.connectedSocket(args.deviceId);
    if (!socket) return;
    this.send(socket, {
      type: "consent.request",
      requestedAt: args.now,
      ...(args.requesterLabel ? { requesterLabel: args.requesterLabel } : {}),
    });
  }

  protected async expirePresence(now: number): Promise<void> {
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      if (attachment.authExpiresAtMs <= now) {
        await this.dropSocket(
          socket,
          attachment,
          DEVICE_PRESENCE_CLOSE.stale,
          "stale",
          now,
        );
        continue;
      }
      if (
        this.lastSeenAt(socket, attachment) + DEVICE_PRESENCE_STALE_AFTER_MS <=
        now
      ) {
        await this.dropSocket(
          socket,
          attachment,
          DEVICE_PRESENCE_CLOSE.stale,
          "stale",
          now,
        );
      }
    }
  }

  // Implemented further up the chain.
  abstract snapshot(options?: {
    refresh?: boolean;
    now?: number;
  }): Promise<OwnerSnapshot>;
  protected abstract handleExecutorFrame(
    socket: WebSocket,
    attachment: PresenceAttachment,
    frame: DevicePresenceDeviceFrame,
    now: number,
  ): Promise<void>;
}
