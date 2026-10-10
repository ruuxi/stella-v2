/**
 * In-memory stand-ins for the owner gate namespace (including the owner
 * events it is handed) plus a well-formed owner snapshot. Every fake records
 * what it was asked so a test can assert the exact admission, release, and
 * owner-event traffic a code path produced.
 */

import { generateCapabilityKeyPair } from "@stella/contracts/gateway/jwt";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { IdentityLevel } from "@stella/contracts/gateway/api";
import type {
  OwnerGateAdmission,
  OwnerGateAdmissionWithLease,
  OwnerGateAdmitInput,
  OwnerGateFenceLeaseRequest,
  OwnerGateSnapshotWithLease,
} from "../../src/owner-gate.js";

/**
 * The gate's `OWNER_AGENT_CONTAINER_LIMIT`, restated: importing the value
 * would load `cloudflare:workers` into every test that uses these fakes.
 */
const OWNER_AGENT_CONTAINER_LIMIT = 6;

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
      applyOwnerEvents: (events: OwnerEvent[]) => Promise<void>;
      noteIdentity: (input: {
        isAnonymous: boolean;
        identityLevel?: IdentityLevel;
      }) => Promise<void>;
      acquireAgentContainer: (input: {
        sandboxId: string;
      }) => Promise<{ ok: boolean; running: number; limit: number }>;
      releaseAgentContainer: (input: { sandboxId: string }) => Promise<void>;
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
  /** Agent container slots currently held, per owner, in acquisition order. */
  agentContainers: Map<string, string[]>;
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
    /** Records the owner events the gates are handed. */
    ownerEvents?: FakeOwnerEvents;
  } = {},
): FakeOwnerGates => {
  const ownerEvents = options.ownerEvents ?? fakeOwnerEvents();
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  const admits: FakeOwnerGates["admits"] = [];
  const releases: FakeOwnerGates["releases"] = [];
  const snapshots: string[] = [];
  const fenceLeases: FakeOwnerGates["fenceLeases"] = [];
  const invalidations: string[] = [];
  const agentContainers = new Map<string, string[]>();
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
        applyOwnerEvents: async (events) => await ownerEvents.apply(events),
        noteIdentity: async () => undefined,
        // Mirrors the gate: a container holds at most one slot, and an owner
        // runs at most OWNER_AGENT_CONTAINER_LIMIT of them.
        acquireAgentContainer: async ({ sandboxId }) => {
          const held = agentContainers.get(ownerId) ?? [];
          const ok =
            held.includes(sandboxId) ||
            held.length < OWNER_AGENT_CONTAINER_LIMIT;
          if (ok && !held.includes(sandboxId)) held.push(sandboxId);
          agentContainers.set(ownerId, held);
          return {
            ok,
            running: held.length,
            limit: OWNER_AGENT_CONTAINER_LIMIT,
          };
        },
        releaseAgentContainer: async ({ sandboxId }) => {
          const held = agentContainers.get(ownerId) ?? [];
          agentContainers.set(
            ownerId,
            held.filter((id) => id !== sandboxId),
          );
        },
      }),
    },
    admits,
    releases,
    snapshots,
    fenceLeases,
    invalidations,
    agentContainers,
  };
};

/** An owner gate namespace whose stubs hand owner events to `recorder`. */
export const withOwnerEvents = <T extends object>(
  namespace: { getByName: (ownerId: string) => T },
  recorder: FakeOwnerEvents,
) => ({
  getByName: (ownerId: string) => ({
    ...namespace.getByName(ownerId),
    applyOwnerEvents: async (events: OwnerEvent[]) =>
      await recorder.apply(events),
  }),
});

export type FakeOwnerEvents = {
  apply: (events: OwnerEvent[]) => Promise<void>;
  events: OwnerEvent[];
  /** One entry per delivery, to assert batching. */
  batches: OwnerEvent[][];
  /** Make the next `count` deliveries throw. */
  failNext: (count: number) => void;
};

export const fakeOwnerEvents = (): FakeOwnerEvents => {
  const events: OwnerEvent[] = [];
  const batches: OwnerEvent[][] = [];
  let failures = 0;
  return {
    apply: async (delivered) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("owner unavailable");
      }
      const batch = delivered.map((event) => structuredClone(event));
      events.push(...batch);
      batches.push(batch);
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
