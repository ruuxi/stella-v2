import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import type {
  OwnerModelGrant,
  OwnerModelGrantStore,
} from "../src/owner-model-grants.js";
import {
  createGateHarness,
  type GateHarness,
} from "./helpers/owner-gate-harness.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { OwnerGate } = await import("../src/owner-gate.js");
mock.restore();

const policy: MemoryPolicy = {
  ownerGeneration: "owner-generation-1",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 1,
  updatedAt: 1_800_000_000_000,
};
const harnesses: GateHarness[] = [];
const open = () => {
  const harness = createGateHarness(OwnerGate);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

type GrantGate = GateHarness["instance"] & {
  registerConversationReader(args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    readerId: string;
  }): Promise<void>;
  acquireModelGrant(args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    readerId: string;
    turnId: string;
    leaseId: string;
    fenceGeneration: string;
    policy: MemoryPolicy;
  }): Promise<OwnerModelGrant>;
  retireCloudChatHandoff(authority: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    clientMsgId: string;
    turnId: string;
    leaseId: string;
    fenceGeneration: string;
  }): Promise<void>;
  modelGrants(): OwnerModelGrantStore;
};

const gate = (harness: GateHarness) => harness.instance as GrantGate;
const jsonRequest = (path: string, body: Record<string, unknown>) =>
  new Request(`https://owner-gate/owner-fence/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-1", ...body }),
  });

const registerLease = async (harness: GateHarness) => {
  const response = await harness.instance.fetch(
    jsonRequest("register", {
      ownerGeneration: policy.ownerGeneration,
      leaseId: "lease-1",
      sessionId: "conversation-1",
      turnId: "turn-1",
      namespace: "orchestrator",
      role: "orchestrator",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { generation: string; expiresAt: number };
};

const issue = async (harness: GateHarness) => {
  const lease = await registerLease(harness);
  harness.values.set("memoryPolicy:cache:v1", {
    fenceGeneration: lease.generation,
    policy,
  });
  await gate(harness).registerConversationReader({
    ownerId: "owner-1",
    ownerGeneration: policy.ownerGeneration,
    conversationId: "conversation-1",
    readerId: "reader-1",
  });
  const grant = await gate(harness).acquireModelGrant({
    ownerId: "owner-1",
    ownerGeneration: policy.ownerGeneration,
    conversationId: "conversation-1",
    readerId: "reader-1",
    turnId: "turn-1",
    leaseId: "lease-1",
    fenceGeneration: lease.generation,
    policy,
  });
  return { grant, lease };
};

describe("OwnerGate model grants", () => {
  test("invalid transfer registration does not evict the memory policy cache", async () => {
    const harness = open();
    const cache = { fenceGeneration: "fence-1", policy };
    harness.values.set("memoryPolicy:cache:v1", cache);

    expect(
      (
        await harness.instance.fetch(
          jsonRequest("register", {
            leaseId: "transfer-1",
            sessionId: "transfer-session",
            turnId: "owner-transfer:1",
            ownerGeneration: policy.ownerGeneration,
            namespace: "activity",
            role: "transfer",
          }),
        )
      ).status,
    ).toBe(400);
    expect(harness.values.get("memoryPolicy:cache:v1")).toEqual(cache);

    expect(
      (
        await harness.instance.fetch(
          jsonRequest("register", {
            leaseId: "transfer-1",
            sessionId: "transfer-session",
            turnId: "owner-transfer:1",
            ownerGeneration: policy.ownerGeneration,
            namespace: "activity",
            role: "transfer",
            expiresAt: Date.now() + 60_000,
          }),
        )
      ).status,
    ).toBe(200);
    expect(harness.values.has("memoryPolicy:cache:v1")).toBe(false);
  });

  test("binds an admitted grant to the exact reader and lease, then deletes it on cloud handoff retirement", async () => {
    const harness = open();
    const { grant, lease } = await issue(harness);
    expect(grant).toMatchObject({
      ownerId: "owner-1",
      ownerGeneration: policy.ownerGeneration,
      conversationId: "conversation-1",
      readerId: "reader-1",
      turnId: "turn-1",
      leaseId: "lease-1",
      fenceGeneration: lease.generation,
    });

    await gate(harness).retireCloudChatHandoff({
      ownerId: "owner-1",
      ownerGeneration: policy.ownerGeneration,
      conversationId: "conversation-1",
      clientMsgId: "dispatch-1",
      turnId: "turn-1",
      leaseId: "lease-1",
      fenceGeneration: lease.generation,
    });

    expect(
      await gate(harness).modelGrants().retireExactTurnLease({
        ownerGeneration: policy.ownerGeneration,
        conversationId: "conversation-1",
        turnId: "turn-1",
        leaseId: "lease-1",
      }),
    ).toEqual({ retiredGrantIds: [] });
  });

  test("freezes the exact reader before a valid purge fence changes", async () => {
    const harness = open();
    const { grant } = await issue(harness);
    const env = Reflect.get(harness.instance, "env") as {
      ORCHESTRATOR_SESSIONS: {
        idFromName(name: string): { toString(): string };
        getByName(name: string): {
          freezeOwnerModelGrants(request: unknown): Promise<unknown>;
        };
      };
    };
    const sessions = env.ORCHESTRATOR_SESSIONS;
    let fenceStateDuringFreeze: string | undefined;
    env.ORCHESTRATOR_SESSIONS = {
      ...sessions,
      getByName: (name) => ({
        freezeOwnerModelGrants: async (request) => {
          fenceStateDuringFreeze = (
            harness.values.get("ownerPurgeFence") as { state?: string }
          ).state;
          return await sessions.getByName(name).freezeOwnerModelGrants(request);
        },
      }),
    };

    const response = await harness.instance.fetch(
      jsonRequest("begin", {
        requestId: "purge-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(fenceStateDuringFreeze).toBe("open");
    expect(harness.frozenModelGrants).toEqual([
      {
        ownerId: "owner-1",
        ownerGeneration: policy.ownerGeneration,
        conversationId: "conversation-1",
        readerId: "reader-1",
        grants: [{ grantId: grant.grantId, expiresAt: grant.expiresAt }],
      },
    ]);
    expect(
      (harness.values.get("ownerPurgeFence") as { state?: string }).state,
    ).toBe("blocked");
  });
});
