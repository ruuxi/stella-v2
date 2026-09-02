/**
 * In-memory stand-ins for the turn plane's two new bindings — the owner gate
 * namespace and the outbox queue — plus a well-formed owner snapshot. Every
 * fake records what it was asked so a test can assert the exact admission,
 * release, and projection traffic a code path produced.
 */

import { generateCapabilityKeyPair } from "@stella/contracts/gateway/jwt";
import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type {
  OwnerGateAdmission,
  OwnerGateAdmitInput,
} from "../../src/owner-gate.js";

export const sampleOwnerSnapshot = (
  overrides: Partial<OwnerSnapshot> = {},
): OwnerSnapshot => ({
  v: 1,
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  writable: true,
  plan: "pro",
  unlimited: false,
  quotas: {
    chat: { burstStarts: 20, dailyTurns: 500, concurrent: 2 },
    agent: { burstStarts: 10, dailyTurns: 100, concurrent: 2 },
  },
  allowance: { audience: "pro", budgetMicroCents: 250_000_000 },
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/default",
    reasoningEffort: "default",
  },
  connectedEngines: [],
  fetchedAt: 1_800_000_000_000,
  ttlMs: 300_000,
  ...overrides,
});

export type FakeOwnerGates = {
  namespace: {
    getByName: (ownerId: string) => {
      admit: (input: OwnerGateAdmitInput) => Promise<OwnerGateAdmission>;
      release: (input: { turnId: string }) => Promise<void>;
      snapshot: () => Promise<OwnerSnapshot>;
      invalidate: () => Promise<void>;
    };
  };
  admits: Array<{ ownerId: string; input: OwnerGateAdmitInput }>;
  releases: Array<{ ownerId: string; turnId: string }>;
  snapshots: string[];
  invalidations: string[];
};

export const fakeOwnerGates = (
  options: {
    snapshot?: OwnerSnapshot;
    admit?: (
      ownerId: string,
      input: OwnerGateAdmitInput,
    ) => OwnerGateAdmission | Promise<OwnerGateAdmission>;
  } = {},
): FakeOwnerGates => {
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  const admits: FakeOwnerGates["admits"] = [];
  const releases: FakeOwnerGates["releases"] = [];
  const snapshots: string[] = [];
  const invalidations: string[] = [];
  const defaultAdmit = (
    _ownerId: string,
    input: OwnerGateAdmitInput,
  ): OwnerGateAdmission => {
    if (
      input.expectedGeneration &&
      input.expectedGeneration !== snapshot.ownerGeneration
    ) {
      return {
        ok: false,
        code: "generation_stale",
        message: "This cloud owner generation is no longer current.",
        retryable: false,
      };
    }
    return { ok: true, snapshot, replayed: false };
  };
  return {
    namespace: {
      getByName: (ownerId: string) => ({
        admit: async (input) => {
          admits.push({ ownerId, input: structuredClone(input) });
          return await (options.admit ?? defaultAdmit)(ownerId, input);
        },
        release: async ({ turnId }) => {
          releases.push({ ownerId, turnId });
        },
        snapshot: async () => {
          snapshots.push(ownerId);
          return snapshot;
        },
        invalidate: async () => {
          invalidations.push(ownerId);
        },
      }),
    },
    admits,
    releases,
    snapshots,
    invalidations,
  };
};

export type FakeOutbox = {
  queue: {
    send: (body: OutboxEvent) => Promise<void>;
    sendBatch: (
      messages: Iterable<{ body: OutboxEvent }>,
    ) => Promise<void>;
  };
  events: OutboxEvent[];
  /** Number of `sendBatch` calls, to assert batching. */
  batches: OutboxEvent[][];
  /** Make the next `count` sends throw. */
  failNext: (count: number) => void;
};

export const fakeOutbox = (): FakeOutbox => {
  const events: OutboxEvent[] = [];
  const batches: OutboxEvent[][] = [];
  let failures = 0;
  const fail = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("queue unavailable");
    }
  };
  return {
    queue: {
      send: async (body) => {
        fail();
        events.push(structuredClone(body));
        batches.push([structuredClone(body)]);
      },
      sendBatch: async (messages) => {
        fail();
        const batch = [...messages].map((message) =>
          structuredClone(message.body),
        );
        events.push(...batch);
        batches.push(batch);
      },
    },
    events,
    batches,
    failNext: (count) => {
      failures = count;
    },
  };
};

/**
 * A real ES256 key pair for the Durable Objects that mint turn capabilities at
 * admission. Generated once per test process: signing is exercised for real
 * (a malformed claim still fails) without paying for a key per test.
 */
let signingEnv: { CAPABILITY_SIGNING_KEY: string; CAPABILITY_SIGNING_KID: string } | undefined;

export const capabilitySignerEnv = async (): Promise<{
  CAPABILITY_SIGNING_KEY: string;
  CAPABILITY_SIGNING_KID: string;
}> => {
  if (!signingEnv) {
    const pair = await generateCapabilityKeyPair();
    signingEnv = {
      CAPABILITY_SIGNING_KEY: pair.privateKeyPem,
      CAPABILITY_SIGNING_KID: "builder-test",
    };
  }
  return signingEnv;
};
