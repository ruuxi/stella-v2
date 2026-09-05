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
  OwnerGateAdmissionWithLease,
  OwnerGateAdmitInput,
  OwnerGateFenceLeaseRequest,
  OwnerGateSnapshotWithLease,
} from "../../src/owner-gate.js";

export const sampleOwnerSnapshot = (
  overrides: Partial<OwnerSnapshot> = {},
): OwnerSnapshot => ({
  v: 1,
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  writable: true,
  isAnonymous: false,
  identityLevel: 3,
  plan: "pro",
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
      admitWithFenceLease: (input: {
        admission: OwnerGateAdmitInput;
        lease: OwnerGateFenceLeaseRequest;
      }) => Promise<OwnerGateAdmissionWithLease>;
      release: (input: { turnId: string }) => Promise<void>;
      snapshot: () => Promise<OwnerSnapshot>;
      snapshotWithFenceLease: (input: {
        lease: OwnerGateFenceLeaseRequest;
      }) => Promise<OwnerGateSnapshotWithLease>;
      invalidate: () => Promise<void>;
    };
  };
  admits: Array<{ ownerId: string; input: OwnerGateAdmitInput }>;
  releases: Array<{ ownerId: string; turnId: string }>;
  snapshots: string[];
  /** Every combined snapshot-plus-register call, with what the gate did. */
  fenceLeases: Array<{
    ownerId: string;
    lease: OwnerGateFenceLeaseRequest;
    outcome: OwnerGateSnapshotWithLease["lease"];
  }>;
  invalidations: string[];
};

export const fakeOwnerGates = (
  options: {
    snapshot?: OwnerSnapshot;
    admit?: (
      ownerId: string,
      input: OwnerGateAdmitInput,
    ) => OwnerGateAdmission | Promise<OwnerGateAdmission>;
    /** Replace the combined call; the default mirrors the gate's own rules. */
    snapshotWithFenceLease?: (
      ownerId: string,
      lease: OwnerGateFenceLeaseRequest,
    ) => OwnerGateSnapshotWithLease | Promise<OwnerGateSnapshotWithLease>;
  } = {},
): FakeOwnerGates => {
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  const admits: FakeOwnerGates["admits"] = [];
  const releases: FakeOwnerGates["releases"] = [];
  const snapshots: string[] = [];
  const fenceLeases: FakeOwnerGates["fenceLeases"] = [];
  const invalidations: string[] = [];
  const defaultSnapshotWithFenceLease = (
    _ownerId: string,
    lease: OwnerGateFenceLeaseRequest,
  ): OwnerGateSnapshotWithLease => {
    if (!snapshot.writable) {
      return { snapshot, lease: { status: "skipped", reason: "not_writable" } };
    }
    if (lease.ownerGeneration !== snapshot.ownerGeneration) {
      return {
        snapshot,
        lease: { status: "skipped", reason: "generation_stale" },
      };
    }
    return {
      snapshot,
      lease: {
        status: "registered",
        generation:
          lease.generation ?? `fence-generation-${fenceLeases.length + 1}`,
        expiresAt: Date.now() + 30 * 60_000,
      },
    };
  };
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
        admitWithFenceLease: async ({ admission: input, lease }) => {
          admits.push({ ownerId, input: structuredClone(input) });
          const admission = await (options.admit ?? defaultAdmit)(
            ownerId,
            input,
          );
          if (!admission.ok)
            return {
              admission,
              lease: { status: "skipped", reason: "admission_refused" },
            };
          const result = defaultSnapshotWithFenceLease(ownerId, lease);
          fenceLeases.push({
            ownerId,
            lease: structuredClone(lease),
            outcome: result.lease,
          });
          return { admission, lease: result.lease };
        },
        release: async ({ turnId }) => {
          releases.push({ ownerId, turnId });
        },
        snapshot: async () => {
          snapshots.push(ownerId);
          return snapshot;
        },
        snapshotWithFenceLease: async ({ lease }) => {
          const outcome = await (
            options.snapshotWithFenceLease ?? defaultSnapshotWithFenceLease
          )(ownerId, lease);
          fenceLeases.push({
            ownerId,
            lease: structuredClone(lease),
            outcome: structuredClone(outcome.lease),
          });
          return outcome;
        },
        invalidate: async () => {
          invalidations.push(ownerId);
        },
      }),
    },
    admits,
    releases,
    snapshots,
    fenceLeases,
    invalidations,
  };
};

export type FakeOutbox = {
  queue: {
    send: (body: OutboxEvent) => Promise<void>;
    sendBatch: (messages: Iterable<{ body: OutboxEvent }>) => Promise<void>;
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
let signingEnv:
  | { CAPABILITY_SIGNING_KEY: string; CAPABILITY_SIGNING_KID: string }
  | undefined;

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
