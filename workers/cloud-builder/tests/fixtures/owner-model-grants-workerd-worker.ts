import { DurableObject } from "cloudflare:workers";
import type {
  MemoryPolicy,
  MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import { OwnerMemoryPolicy } from "../../src/memory-policy.js";
import { OwnerFenceStore } from "../../src/owner-fence-store.js";
import { createOwnerFenceHost } from "../../src/owner-fence-do.js";
import {
  LocalOwnerModelGrants,
  type LocalOwnerModelGrantExpectation,
} from "../../src/local-owner-model-grants.js";
import {
  OwnerModelGrantStore,
  type OwnerModelGrant,
  type OwnerModelGrantFreezeRequest,
  type OwnerModelGrantIdentity,
  type OwnerModelGrantRevokeReason,
} from "../../src/owner-model-grants.js";

type Env = {
  OWNER: DurableObjectNamespace<OwnerGrantProtocolOwner>;
  READER: DurableObjectNamespace<OwnerGrantProtocolReader>;
};

type LeaseInput = {
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  leaseId: string;
};

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  ownerGeneration: "owner-generation-1",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 0,
  updatedAt: 1,
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const readJson = async (request: Request): Promise<Record<string, unknown>> =>
  ((await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null) ?? {};

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const leaseInput = (body: Record<string, unknown>): LeaseInput => ({
  ownerId: text(body.ownerId) || "owner-1",
  ownerGeneration: text(body.ownerGeneration) || "owner-generation-1",
  conversationId: text(body.conversationId) || "conversation-1",
  turnId: text(body.turnId) || "turn-1",
  leaseId: text(body.leaseId) || "lease-1",
});

const grantExpectation = (
  grant: OwnerModelGrant,
): LocalOwnerModelGrantExpectation => ({
  ownerId: grant.ownerId,
  ownerGeneration: grant.ownerGeneration,
  conversationId: grant.conversationId,
  turnId: grant.turnId,
  leaseId: grant.leaseId,
  fenceGeneration: grant.fenceGeneration,
  memoryPolicy: grant.memoryPolicy,
});

export class OwnerGrantProtocolReader extends DurableObject<Env> {
  private readonly readerId = crypto.randomUUID();
  private readonly grants = new LocalOwnerModelGrants(this.readerId);

  getReaderId(): string {
    return this.readerId;
  }

  freezeOwnerModelGrants(request: OwnerModelGrantFreezeRequest): {
    frozen: true;
  } {
    this.grants.freeze(request);
    return { frozen: true };
  }

  freezeThenLoseResponse(request: OwnerModelGrantFreezeRequest): never {
    this.grants.freeze(request);
    throw new Error("lost freeze response");
  }

  useGrant(grant: OwnerModelGrant): {
    ok: boolean;
    readerId: string;
    error?: string;
  } {
    const expected = grantExpectation(grant);
    const valid = this.grants.valid(grant, expected);
    if (!valid) return { ok: false, readerId: this.readerId, error: "invalid" };
    const active = this.grants.begin(
      valid,
      expected,
      new AbortController().signal,
    );
    try {
      active.assertValid();
      return { ok: true, readerId: this.readerId };
    } catch (error) {
      return {
        ok: false,
        readerId: this.readerId,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      active.release();
    }
  }

  abortNow(): void {
    this.ctx.abort("reader restart fixture");
  }
}

export class OwnerGrantProtocolOwner extends DurableObject<Env> {
  private modelGrants(): OwnerModelGrantStore {
    return new OwnerModelGrantStore(this.ctx, this.ownerId());
  }

  private ownerId(): string {
    const name = this.ctx.id.name ?? "";
    if (!name) throw new Error("owner id required");
    return name;
  }

  private async currentPolicy(): Promise<MemoryPolicy> {
    return (
      (await this.ctx.storage.get<MemoryPolicy>("transportPolicy")) ?? policy()
    );
  }

  private memoryPolicy(
    freezeMode: "normal" | "lost-once" = "normal",
  ): OwnerMemoryPolicy {
    return new OwnerMemoryPolicy(
      this.ctx,
      this.ownerId(),
      {
        read: async () => await this.currentPolicy(),
        apply: async (change) => {
          const current = await this.currentPolicy();
          if (change.kind === "preference") {
            await this.ctx.storage.put("transportPolicy", {
              ...current,
              memoryEnabled: change.memoryEnabled,
              revision: current.revision + 1,
              updatedAt: current.updatedAt + 1,
            } satisfies MemoryPolicy);
          } else {
            await this.ctx.storage.put("transportPolicy", {
              ...current,
              memoryEpoch: `${current.memoryEpoch}:wiped`,
              revision: current.revision + 1,
              updatedAt: current.updatedAt + 1,
            } satisfies MemoryPolicy);
          }
        },
      },
      {
        issuanceOpen: async () => await this.modelGrants().issuanceOpen(),
        revokeReaders: async (change) => {
          const reason: OwnerModelGrantRevokeReason =
            change.kind === "wipe" ? "memory_wipe" : "memory_policy_change";
          let lostUsed =
            (await this.ctx.storage.get<boolean>("lostFreezeUsed")) === true;
          await this.modelGrants().revokeAll({
            operationId: change.requestId,
            reason,
            ownerGeneration: change.expectedOwnerGeneration,
            freeze: async (request) => {
              const reader = this.env.READER.get(
                this.env.READER.idFromName(request.conversationId),
              );
              if (freezeMode === "lost-once" && !lostUsed) {
                lostUsed = true;
                await this.ctx.storage.put("lostFreezeUsed", true);
                await reader.freezeThenLoseResponse(request);
                return;
              }
              await reader.freezeOwnerModelGrants(request);
            },
          });
        },
      },
    );
  }

  async registerReader(args: {
    conversationId: string;
    readerId: string;
  }): Promise<void> {
    await this.modelGrants().registerReader({
      conversationId: args.conversationId,
      readerId: args.readerId,
    });
  }

  async registerLease(
    input: LeaseInput,
  ): Promise<{ generation: string; expiresAt: number }> {
    const registration = {
      ownerId: input.ownerId,
      ownerGeneration: input.ownerGeneration,
      leaseId: input.leaseId,
      sessionId: this.env.READER.idFromName(input.conversationId).toString(),
      turnId: input.turnId,
      namespace: "orchestrator",
      role: "orchestrator",
    };
    const response = await createOwnerFenceHost({
      ctx: this.ctx,
      env: {} as never,
    }).fetch(
      "register",
      new Request("https://owner-gate/owner-fence/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
      }),
    );
    const payload = (await response.json()) as {
      generation?: string;
      expiresAt?: number;
      error?: string;
      code?: string;
    };
    if (!response.ok) {
      throw new Error(
        `lease register failed: ${response.status} ${JSON.stringify(payload)} ${JSON.stringify(registration)}`,
      );
    }
    if (!payload.generation || typeof payload.expiresAt !== "number") {
      throw new Error("lease register response invalid");
    }
    return { generation: payload.generation, expiresAt: payload.expiresAt };
  }

  async issueGrant(
    input: LeaseInput & { readerId: string },
  ): Promise<OwnerModelGrant> {
    const fence = await this.registerLease(input);
    const current = await this.currentPolicy();
    return await this.memoryPolicy().authorizeGrant(
      current,
      fence.generation,
      async () => {
        const lease = new OwnerFenceStore(this.ctx.storage.sql).activeLease(
          input.leaseId,
        );
        if (
          !lease ||
          lease.ownerId !== input.ownerId ||
          lease.ownerGeneration !== input.ownerGeneration ||
          lease.turnId !== input.turnId ||
          lease.sessionId !==
            this.env.READER.idFromName(input.conversationId).toString() ||
          lease.reservationGeneration !== fence.generation
        ) {
          throw new Error("OWNER_FENCE_CHANGED");
        }
        const result = await this.modelGrants().issueGrant({
          ownerId: input.ownerId,
          ownerGeneration: input.ownerGeneration,
          conversationId: input.conversationId,
          turnId: input.turnId,
          leaseId: input.leaseId,
          fenceGeneration: fence.generation,
          memoryPolicy: current,
          readerId: input.readerId,
          grantId: `${input.leaseId}:${input.readerId}:${fence.expiresAt}`,
          expiresAt: fence.expiresAt,
        } satisfies OwnerModelGrantIdentity);
        if (result.status !== "issued" && result.status !== "replayed") {
          throw new Error(`grant ${result.status}`);
        }
        return result.grant;
      },
    );
  }

  async changeMemoryPolicy(args: {
    change: MemoryPolicyChange;
    freezeMode?: "normal" | "lost-once";
  }): Promise<{ ok: true }> {
    await this.memoryPolicy(args.freezeMode).change(args.change);
    return { ok: true };
  }

  async retryMemoryPolicy(): Promise<{ ok: true }> {
    await this.memoryPolicy().retry();
    return { ok: true };
  }

  async beginFenceWithBarrier(
    input: LeaseInput,
  ): Promise<{ status: number; fence: unknown }> {
    const body = { ownerId: input.ownerId, requestId: "purge-1" };
    const operationId = "purge-1";
    const response = await this.ctx.blockConcurrencyWhile(async () => {
      const host = createOwnerFenceHost({
        ctx: this.ctx,
        env: {} as never,
        beforeAuthorityChange: async ({ path, body: parsed }) => {
          await this.modelGrants().beginFenceBarrier({
            operationId,
            path,
            body: parsed,
          });
          await this.modelGrants().revokeAll({
            operationId,
            reason: "owner_purge",
            ownerGeneration: input.ownerGeneration,
            freeze: async (request) => {
              await this.env.READER.get(
                this.env.READER.idFromName(request.conversationId),
              ).freezeOwnerModelGrants(request);
            },
          });
        },
      });
      const result = await host.fetch(
        "begin",
        new Request("https://owner-gate/owner-fence/begin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (result.ok || result.status < 500)
        await this.modelGrants().completeFenceBarrier(operationId);
      return result;
    });
    return {
      status: response.status,
      fence: await this.ctx.storage.get("ownerPurgeFence"),
    };
  }

  async alarm(): Promise<void> {
    await createOwnerFenceHost({ ctx: this.ctx, env: {} as never }).alarm(
      Date.now(),
    );
    await this.memoryPolicy()
      .retry()
      .catch(() => undefined);
  }

  async snapshot(): Promise<{
    barrier: unknown;
    grantRows: unknown[];
    policy: MemoryPolicy;
  }> {
    return {
      barrier: await this.modelGrants().pendingFenceBarrier(),
      grantRows: this.ctx.storage.sql
        .exec("SELECT * FROM owner_model_grants ORDER BY grant_id")
        .toArray(),
      policy: await this.currentPolicy(),
    };
  }
}

const owner = (
  env: Env,
  ownerId: string,
): DurableObjectStub<OwnerGrantProtocolOwner> =>
  env.OWNER.get(env.OWNER.idFromName(ownerId));

const reader = (
  env: Env,
  conversationId: string,
): DurableObjectStub<OwnerGrantProtocolReader> =>
  env.READER.get(env.READER.idFromName(conversationId));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/") return json({ ok: true });
      const body = await readJson(request);
      const input = leaseInput(body);
      const ownerStub = owner(env, input.ownerId);
      const readerStub = reader(env, input.conversationId);
      if (url.pathname === "/issue") {
        const readerId = await readerStub.getReaderId();
        await ownerStub.registerReader({
          conversationId: input.conversationId,
          readerId,
        });
        return json({
          grant: await ownerStub.issueGrant({ ...input, readerId }),
        });
      }
      if (url.pathname === "/use") {
        return json(await readerStub.useGrant(body.grant as OwnerModelGrant));
      }
      if (url.pathname === "/change") {
        const change: MemoryPolicyChange = {
          kind: "preference",
          ownerId: input.ownerId,
          expectedOwnerGeneration: input.ownerGeneration,
          requestId: text(body.requestId) || "change-1",
          expectedRevision: 0,
          memoryEnabled: false,
        };
        return json(
          await ownerStub.changeMemoryPolicy({
            change,
            freezeMode: body.lostOnce === true ? "lost-once" : "normal",
          }),
        );
      }
      if (url.pathname === "/retry-change") {
        return json(await ownerStub.retryMemoryPolicy());
      }
      if (url.pathname === "/snapshot") return json(await ownerStub.snapshot());
      if (url.pathname === "/begin-fence") {
        return json(await ownerStub.beginFenceWithBarrier(input));
      }
      if (url.pathname === "/abort-reader") {
        await readerStub.abortNow();
        return json({ aborted: true });
      }
      if (url.pathname === "/freeze-stale-reader") {
        const currentReaderId = await readerStub.getReaderId();
        await readerStub.freezeOwnerModelGrants({
          ownerId: input.ownerId,
          ownerGeneration: input.ownerGeneration,
          conversationId: input.conversationId,
          readerId: text(body.readerId) || "stale-reader",
          grants: [
            {
              grantId: text(body.grantId) || "grant",
              expiresAt: Date.now() + 60_000,
            },
          ],
        });
        return json({ ok: true, currentReaderId });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        503,
      );
    }
  },
};
