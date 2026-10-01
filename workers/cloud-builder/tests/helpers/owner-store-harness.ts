/**
 * The production owner-store registry over in-memory SQLite, with a scripted
 * host. Domain tests drive calls, views, jobs and outbox events through the
 * same `OwnerStore` the gate uses.
 */

import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
import { openSqlStorageFake, type SqlStorageFake } from "../fixtures/sql-storage.js";
import { installWebSocketPair, type FakeSocket } from "./owner-gate-harness.js";
import { sampleOwnerSnapshot } from "./turn-plane-fakes.js";
import { ownerRegistry } from "../../src/owner-store/domains.js";
import { applyOwnerOutbox } from "../../src/owner-store/outbox-apply.js";
import type {
  AgentTurnDispatch,
  OwnerCaller,
  OwnerHost,
  OwnerRegistry,
} from "../../src/owner-store/registry.js";
import { OwnerStore } from "../../src/owner-store/store.js";

installWebSocketPair();

export const OWNER_ID = "https://issuer.test|user-1";

export type HostCalls = {
  dispatched: AgentTurnDispatch[];
  canceled: Array<Parameters<OwnerHost["cancelAgentTurn"]>[0]>;
  cards: Array<Parameters<OwnerHost["postConversationCard"]>[0]>;
};

export type OwnerStoreHarness = {
  store: OwnerStore;
  fake: SqlStorageFake;
  snapshot: OwnerSnapshot;
  host: HostCalls;
  /** Next `dispatchAgentTurn` outcome; undefined succeeds. */
  dispatchOutcome: Error | undefined;
  cancelOutcome: "canceled" | "changed";
  caller(overrides?: Partial<OwnerCaller>): OwnerCaller;
  call<T = any>(name: string, args: unknown, caller?: OwnerCaller): Promise<T>;
  callError(name: string, args: unknown, caller?: OwnerCaller): Promise<{ code: string; message: string; reason?: string }>;
  /** Subscribe on a fresh live socket; returns a reader of the latest value. */
  watch(view: string, args: unknown): Promise<() => any>;
  outbox(events: OutboxEvent[]): Promise<void>;
  runJobs(now?: number): Promise<number>;
  close(): void;
};

export const createOwnerStoreHarness = (
  options: { registry?: OwnerRegistry; snapshot?: Partial<OwnerSnapshot> } = {},
): OwnerStoreHarness => {
  const fake = openSqlStorageFake();
  const accepted: Array<{ socket: FakeSocket; tags: string[] }> = [];
  const snapshot: OwnerSnapshot = {
    ...sampleOwnerSnapshot({ ownerId: OWNER_ID }),
    ...options.snapshot,
  } as OwnerSnapshot;
  const host: HostCalls = { dispatched: [], canceled: [], cards: [] };
  const harness = {} as OwnerStoreHarness;
  const ownerHost: OwnerHost = {
    snapshot: async () => harness.snapshot,
    dispatchAgentTurn: async (input) => {
      host.dispatched.push(input);
      const outcome = harness.dispatchOutcome;
      harness.dispatchOutcome = undefined;
      if (outcome) throw outcome;
    },
    cancelAgentTurn: async (input) => {
      host.canceled.push(input);
      return harness.cancelOutcome;
    },
    postConversationCard: async (input) => {
      host.cards.push(input);
    },
  };
  const store = new OwnerStore({
    ctx: {
      storage: { sql: fake.sql, transactionSync: <T>(fn: () => T) => fn() },
      getWebSockets: (tag?: string) =>
        accepted
          .filter((entry) => !entry.socket.closed && (!tag || entry.tags.includes(tag)))
          .map((entry) => entry.socket),
      acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
        accepted.push({ socket, tags });
      },
    } as unknown as DurableObjectState,
    env: {} as Cloudflare.Env,
    ownerId: () => OWNER_ID,
    registry: options.registry ?? ownerRegistry,
    host: ownerHost,
    verifyToken: async () => null,
  });
  const caller = (overrides: Partial<OwnerCaller> = {}): OwnerCaller => ({
    ownerId: OWNER_ID,
    subject: "user-1",
    sessionId: "session-1",
    isAnonymous: false,
    expiresAtMs: Date.now() + 30 * 60_000,
    ...overrides,
  });
  let nextSub = 1;
  Object.assign(harness, {
    store,
    fake,
    snapshot,
    host,
    dispatchOutcome: undefined,
    cancelOutcome: "canceled",
    caller,
    async call(name: string, args: unknown, who = caller()) {
      const response = await store.call(name, args, who);
      if (!response.ok) {
        throw new Error(`${name} failed: ${response.error.code} ${response.error.message}`);
      }
      return response.value;
    },
    async callError(name: string, args: unknown, who = caller()) {
      const response = await store.call(name, args, who);
      if (response.ok) throw new Error(`${name} unexpectedly succeeded`);
      return response.error;
    },
    async watch(view: string, args: unknown) {
      store.acceptLive(caller());
      const socket = accepted.at(-1)!.socket;
      const id = String(nextSub++);
      await store.onLiveMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ t: "sub", id, view, args }),
      );
      return () => {
        const frames = socket.sent as unknown as Array<{ t: string; id: string; value?: unknown; error?: unknown }>;
        const latest = frames.filter((frame) => frame.id === id).at(-1);
        if (!latest) return undefined;
        if (latest.t === "error") throw new Error(JSON.stringify(latest.error));
        return latest.value;
      };
    },
    async outbox(events: OutboxEvent[]) {
      const effects = applyOwnerOutbox(store.context(null).db, events);
      store.flush();
      for (const card of effects.cards) await ownerHost.postConversationCard(card);
    },
    runJobs: (now?: number) => store.runDueJobs(now ?? Date.now()),
    close: () => fake.close(),
  } satisfies Partial<OwnerStoreHarness>);
  return harness;
};
