import { DurableObject } from "cloudflare:workers";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import { OwnerGate } from "../../src/owner-gate.js";
import {
  LocalOwnerModelGrants,
  type LocalOwnerModelGrantExpectation,
} from "../../src/local-owner-model-grants.js";
import {
  OwnerModelGrantStore,
  type OwnerModelGrant,
  type OwnerModelGrantFreezeRequest,
} from "../../src/owner-model-grants.js";

type Env = {
  OWNER_GATES: DurableObjectNamespace<GrantTestOwnerGate>;
  ORCHESTRATOR_SESSIONS: DurableObjectNamespace<OwnerGrantProtocolReader>;
};

type LeaseInput = {
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  leaseId: string;
};

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

const fenceRequest = (path: string, body: unknown): Request =>
  new Request(`https://owner-gate/owner-fence/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Stands in for OrchestratorSession as the reader side of the protocol. */
export class OwnerGrantProtocolReader extends DurableObject<Env> {
  private readonly readerId = crypto.randomUUID();
  private readonly grants = new LocalOwnerModelGrants(this.readerId);
  private dropNextFreezeAck = false;

  getReaderId(): string {
    return this.readerId;
  }

  /** The next freeze applies locally, but its acknowledgement never returns. */
  loseNextFreezeResponse(): void {
    this.dropNextFreezeAck = true;
  }

  freezeOwnerModelGrants(request: OwnerModelGrantFreezeRequest): {
    frozen: true;
  } {
    this.grants.freeze(request);
    if (this.dropNextFreezeAck) {
      this.dropNextFreezeAck = false;
      throw new Error("lost freeze response");
    }
    return { frozen: true };
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

/** Production OwnerGate; Convex is the test's loopback server. */
export class GrantTestOwnerGate extends OwnerGate {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env as never);
  }

  /** Runs the production alarm now instead of waiting out the retry delay. */
  async runAlarm(): Promise<void> {
    await this.alarm();
  }

  async fenceSnapshot(): Promise<{ fence: unknown; barrier: unknown }> {
    return {
      fence: await this.ctx.storage.get("ownerPurgeFence"),
      barrier: await new OwnerModelGrantStore(
        this.ctx,
        this.ctx.id.name ?? "",
      ).pendingFenceBarrier(),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/") return json({ ok: true });
      const body = await readJson(request);
      const input = leaseInput(body);
      const gate = env.OWNER_GATES.getByName(input.ownerId);
      const reader = env.ORCHESTRATOR_SESSIONS.getByName(input.conversationId);
      if (url.pathname === "/issue") {
        const registered = await gate.fetch(
          fenceRequest("register", {
            ownerId: input.ownerId,
            ownerGeneration: input.ownerGeneration,
            leaseId: input.leaseId,
            turnId: input.turnId,
            sessionId: env.ORCHESTRATOR_SESSIONS.idFromName(
              input.conversationId,
            ).toString(),
            namespace: "orchestrator",
            role: "orchestrator",
          }),
        );
        const lease = (await registered.json()) as { generation?: string };
        if (!registered.ok || !lease.generation) {
          throw new Error(
            `lease register failed: ${registered.status} ${JSON.stringify(lease)}`,
          );
        }
        const grant = await gate.acquireModelGrant({
          ...input,
          readerId: await reader.getReaderId(),
          fenceGeneration: lease.generation,
          policy: body.policy as MemoryPolicy,
        });
        return json({ grant });
      }
      if (url.pathname === "/use") {
        return json(await reader.useGrant(body.grant as OwnerModelGrant));
      }
      if (url.pathname === "/change") {
        if (body.lostOnce === true) await reader.loseNextFreezeResponse();
        const result = await gate.changeMemoryPolicy({
          kind: "preference",
          ownerId: input.ownerId,
          expectedOwnerGeneration: input.ownerGeneration,
          requestId: text(body.requestId) || "change-1",
          expectedRevision: 0,
          memoryEnabled: false,
        });
        return json(result, result.ok ? 200 : result.status);
      }
      if (url.pathname === "/retry-change") {
        await gate.runAlarm();
        return json({ ok: true });
      }
      if (url.pathname === "/begin-fence") {
        const begun = await gate.fetch(
          fenceRequest("begin", {
            ownerId: input.ownerId,
            requestId: "purge-1",
          }),
        );
        return json({ status: begun.status, ...(await gate.fenceSnapshot()) });
      }
      if (url.pathname === "/abort-reader") {
        await reader.abortNow();
        return json({ aborted: true });
      }
      if (url.pathname === "/freeze-stale-reader") {
        const currentReaderId = await reader.getReaderId();
        await reader.freezeOwnerModelGrants({
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
