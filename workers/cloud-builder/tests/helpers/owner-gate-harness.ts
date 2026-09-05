/**
 * Drives the real `OwnerGate` outside workerd: in-memory SQLite for its
 * tables, a scripted owner snapshot, recording stand-ins for the two Durable
 * Object namespaces and the outbox queue, and a fake of the hibernation
 * WebSocket API (`acceptWebSocket` / `getWebSockets` / `serializeAttachment`)
 * so the presence protocol is exercised frame by frame.
 *
 * The class is passed in rather than imported: every caller has to mock
 * `cloudflare:workers` before importing it.
 */

import { openSqlStorageFake } from "../fixtures/sql-storage.js";
import { sampleOwnerSnapshot } from "./turn-plane-fakes.js";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
import type {
  DevicePresenceDeviceFrame,
  DevicePresenceServerFrame,
} from "@stella/contracts/turn-plane/placement";
import { DEVICE_PRESENCE_PROOF_PREFIX } from "@stella/contracts/turn-plane/placement";
import type { AdmittedCloudChat, CloudChatPreparation } from "../../src/cloud-chat-admission.js";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
import { OwnerFenceStore } from "../../src/owner-fence-store.js";

export type FakeSocket = {
  sent: DevicePresenceServerFrame[];
  closes: Array<{ code: number; reason: string }>;
  readonly closed: boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

const createSocket = (): FakeSocket => {
  const sent: DevicePresenceServerFrame[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  let attachment: unknown = null;
  return {
    sent,
    closes,
    get closed() {
      return closes.length > 0;
    },
    send(data: string) {
      sent.push(JSON.parse(data) as DevicePresenceServerFrame);
    },
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
    serializeAttachment(value: unknown) {
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return attachment === null ? null : structuredClone(attachment);
    },
  };
};

/** `fetch()` builds a `WebSocketPair`; bun has none, so supply one. */
export const installWebSocketPair = (): void => {
  const scope = globalThis as unknown as { WebSocketPair?: unknown };
  if (scope.WebSocketPair) return;
  scope.WebSocketPair = function WebSocketPairFake() {
    return [createSocket(), createSocket()];
  } as unknown as typeof WebSocketPair;
};

export type DeviceKey = {
  deviceId: string;
  publicKey: string;
  sign(message: string): Promise<string>;
};

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

export const generateDeviceKey = async (
  deviceId: string,
): Promise<DeviceKey> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return {
    deviceId,
    publicKey: toBase64(spki),
    sign: async (message: string) =>
      toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            pair.privateKey,
            new TextEncoder().encode(message),
          ),
        ),
      ),
  };
};

export type ForwardedCall = {
  authority?: AdmittedCloudChat;
  namespace: "orchestrator" | "build";
  name: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type GateHarness = {
  values: Map<string, unknown>;
  activeLeaseIds(): string[];
  instance: Record<string, unknown> & {
    admit: (input: unknown) => Promise<unknown>;
    release: (input: { turnId: string }) => Promise<void>;
    snapshot: (options?: { refresh?: boolean; now?: number }) => Promise<OwnerSnapshot>;
    submit: (input: unknown) => Promise<any>;
    dispatchStatus: (dispatchId: string) => Promise<any>;
    cancelDispatch: (input: unknown) => Promise<any>;
    devices: (now?: number) => Promise<any>;
    fetch: (request: Request) => Promise<Response>;
    webSocketMessage: (
      socket: unknown,
      message: string | ArrayBuffer,
    ) => Promise<void>;
    webSocketClose: (socket: unknown, code: number) => Promise<void>;
    alarm: () => Promise<void>;
  };
  sockets: FakeSocket[];
  outbox: OutboxEvent[];
  forwarded: ForwardedCall[];
  alarms: number[];
  snapshot: OwnerSnapshot;
  /** Open a presence socket and run challenge -> begin -> proof. */
  connect(
    key: DeviceKey,
    options?: {
      availability?: Partial<{
        ready: boolean;
        chatSlots: number;
        agentSlots: number;
        capabilities: string[];
      }>;
      presenceSessionId?: string;
      authExpiresAtMs?: number;
      signWith?: DeviceKey;
      skipProof?: boolean;
    },
  ): Promise<{ socket: FakeSocket; presenceSessionId: string }>;
  sendFrame(socket: FakeSocket, frame: DevicePresenceDeviceFrame): Promise<void>;
  close(): void;
};

export const createGateHarness = (
  OwnerGate: new (...args: never[]) => unknown,
  options: {
    ownerId?: string;
    snapshot?: OwnerSnapshot;
    respond?: (call: ForwardedCall) => Response | Promise<Response>;
    enqueue?: (events: OutboxEvent[]) => Promise<void>;
  } = {},
): GateHarness => {
  installWebSocketPair();
  const ownerId = options.ownerId ?? "owner-1";
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  const values = new Map<string, unknown>();
  const sqlFake = openSqlStorageFake();
  const alarms: number[] = [];
  const outbox: OutboxEvent[] = [];
  const forwarded: ForwardedCall[] = [];
  const tagged: Array<{ socket: FakeSocket; tags: string[] }> = [];
  const respond =
    options.respond ??
    ((call: ForwardedCall) =>
      Response.json(
        call.namespace === "orchestrator"
          ? {
              protocol: 1,
              conversationId: call.name,
              turnId: call.authority?.turnId ?? `turn-${call.name}`,
              accepted: true,
              replayed: false,
              createdConversation: false,
            }
          : {
              protocol: 1,
              threadId: call.name,
              turnId: `turn-${call.name}`,
              attemptGeneration: 1,
              accepted: true,
              replayed: false,
            },
        { status: 202 },
      ));

  const namespace = (kind: "orchestrator" | "build") => ({
    idFromName: (name: string) => ({ toString: () => name }),
    getByName: (name: string) => ({
      startAdmittedChat: async (body: CloudTurnStartRequest, authority: AdmittedCloudChat, _preparation: CloudChatPreparation) => {
        const call: ForwardedCall = { namespace: kind, name, url: "https://orchestrator-session/turn",
          headers: { "content-type": "application/json", "x-stella-owner": authority.ownerId,
            "x-stella-turn-auth": "service", "x-stella-conversation-id": name, "x-stella-owner-generation": authority.ownerGeneration }, body, authority };
        forwarded.push(call);
        return respond(call);
      },
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const call: ForwardedCall = {
          namespace: kind,
          name,
          url,
          headers,
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        };
        forwarded.push(call);
        return respond(call);
      },
    }),
  });

  const storage = {
    sql: sqlFake.sql,
    sync: async () => {},
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    setAlarm: async (at: number) => {
      alarms.push(at);
    },
    getAlarm: async () => alarms.at(-1) ?? null,
    deleteAlarm: async () => {
      alarms.length = 0;
    },
  };
  const transactionalStorage = { ...storage, transaction: async <T>(work: (transaction: typeof storage) => Promise<T>) => work(storage) };

  const instance = Object.create(
    (OwnerGate as unknown as { prototype: object }).prototype,
  ) as GateHarness["instance"];
  Object.assign(instance, {
    ctx: {
      storage: transactionalStorage,
      waitUntil: (_promise: Promise<unknown>) => {},
      blockConcurrencyWhile: async <T>(work: () => Promise<T>) => work(),
      id: { name: ownerId, toString: () => ownerId },
      acceptWebSocket: (socket: FakeSocket, tags: string[] = []) => {
        tagged.push({ socket, tags });
      },
      getWebSockets: (tag?: string) =>
        tagged
          .filter(
            (entry) =>
              !entry.socket.closed && (!tag || entry.tags.includes(tag)),
          )
          .map((entry) => entry.socket),
    },
    env: {
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      BUILDER_SERVICE_SECRET: "secret",
      TURN_TIMEOUT_MS: "900000",
      ORCHESTRATOR_SESSIONS: namespace("orchestrator"),
      BUILD_SESSIONS: namespace("build"),
      TURN_OUTBOX: {
        sendBatch: async (messages: Iterable<{ body: OutboxEvent }>) => {
          const batch = [...messages];
          await options.enqueue?.(batch.map((message) => message.body));
          for (const message of batch) {
            outbox.push(structuredClone(message.body));
          }
        },
      },
    },
    fetchSnapshot: async () => snapshot,
  });

  const sendFrame = async (
    socket: FakeSocket,
    frame: DevicePresenceDeviceFrame,
  ) => {
    await instance.webSocketMessage(socket, JSON.stringify(frame));
  };

  return {
    instance,
    values,
    activeLeaseIds: () => { const store = new OwnerFenceStore(sqlFake.sql); store.initialize(); return store.activeLeases().map(lease => lease.leaseId); },
    get sockets() {
      return tagged.map((entry) => entry.socket);
    },
    outbox,
    forwarded,
    alarms,
    snapshot,
    sendFrame,
    async connect(key, connectOptions = {}) {
      const before = tagged.length;
      const response = await instance.fetch(
        new Request(`https://owner-gate/presence`, {
          headers: {
            upgrade: "websocket",
            "x-stella-owner": ownerId,
            "x-stella-device-id": key.deviceId,
            "x-stella-token-exp": String(
              connectOptions.authExpiresAtMs ?? Date.now() + 3_600_000,
            ),
          },
        }),
      );
      if (response.status !== 101) {
        throw new Error(`presence upgrade refused (${response.status})`);
      }
      const socket = tagged[before]!.socket;
      const challenge = socket.sent.at(-1);
      if (!challenge || challenge.type !== "challenge") {
        throw new Error("no challenge frame");
      }
      const presenceSessionId =
        connectOptions.presenceSessionId ?? `session-${key.deviceId}`;
      await sendFrame(socket, {
        type: "begin",
        presenceSessionId,
        protocolVersion: 1,
        availability: {
          ready: true,
          chatSlots: 1,
          agentSlots: 1,
          capabilities: ["chat", "agent", "attachments"],
          ...(connectOptions.availability ?? {}),
        } as never,
      });
      if (!connectOptions.skipProof) {
        const signer = connectOptions.signWith ?? key;
        await sendFrame(socket, {
          type: "proof",
          signature: await signer.sign(
            `${DEVICE_PRESENCE_PROOF_PREFIX}\0${challenge.connectionId}\0${challenge.nonce}`,
          ),
        });
      }
      return { socket, presenceSessionId };
    },
    close: () => sqlFake.close(),
  };
};

/** Run `fn` with `Date.now()` pinned, for lease and staleness assertions. */
export const withNow = async <T>(at: number, fn: () => Promise<T>): Promise<T> => {
  const original = Date.now;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
};
