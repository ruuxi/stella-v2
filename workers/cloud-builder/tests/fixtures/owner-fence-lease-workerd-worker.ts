import { BuildSession, OrchestratorSession } from "../../src/index.js";
import { OwnerFenceStore } from "../../src/owner-fence-store.js";
import {
  OwnerGate,
  type OwnerGateFenceLeaseRequest,
} from "../../src/owner-gate.js";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";

type FixtureEnv = {
  BUILD_SESSIONS: DurableObjectNamespace<LeaseTestBuildSession>;
  OWNER_GATES: DurableObjectNamespace<LeaseTestOwnerGate>;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
};

type TestTurn = {
  kind: "agent";
  conversationId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  threadId: string;
  attemptGeneration: number;
  appId: "agent";
  prompt: string;
  ownerPurgeLeaseId?: string;
  ownerPurgeGeneration?: string;
  execution?: {
    engine: "stella";
    provider: "stella";
    model: "stella/default";
    reasoningEffort: "default";
  };
};

type LeaseReceipt = {
  schemaVersion: 1;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  leaseId: string;
  kind: "run" | "aux";
  phase: "registering" | "registered" | "unregister_pending";
  registrationGeneration?: string;
  createdAt: number;
  updatedAt: number;
};

const RECEIPT_PREFIX = "buildOwnerFenceLeaseReceipt:";
const receiptKey = (leaseId: string): string => `${RECEIPT_PREFIX}${leaseId}`;
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const parse = async (request: Request): Promise<Record<string, unknown>> =>
  ((await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null) ?? {};

const text = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === "string" ? body[key] : "";

const turnFrom = (body: Record<string, unknown>): TestTurn => {
  const ownerId = text(body, "ownerId");
  const ownerGeneration = text(body, "ownerGeneration");
  const turnId = text(body, "turnId");
  if (!ownerId || !ownerGeneration || !turnId) {
    throw new Error("ownerId, ownerGeneration and turnId are required");
  }
  return {
    kind: "agent",
    conversationId: "conversation-1",
    ownerId,
    ownerGeneration,
    turnId,
    threadId: `thread:${turnId}`,
    attemptGeneration: 1,
    appId: "agent",
    prompt: "fixture",
  };
};

type BuildSessionInternals = {
  registerBuildOwnerFenceLease(args: {
    turn: TestTurn;
    kind: "run" | "aux";
    role: "run" | "aux";
    leaseId: string;
    mutateTurn?: boolean;
  }): Promise<{ generation: string; expiresAt: number; leaseId: string }>;
  registerTurn(turn: TestTurn): Promise<string>;
  callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response>;
};

type OwnerGateInternals = {
  scheduleAlarm(now: number): Promise<void>;
};

/** Production OwnerGate plus observation routes for its colocated fence. */
export class LeaseTestOwnerGate extends OwnerGate {
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env as never);
  }

  /** No Convex here: every owner is writable at `generation:<ownerId>`. */
  protected override async fetchSnapshot(
    ownerId: string,
  ): Promise<OwnerSnapshot> {
    return {
      v: 1,
      ownerId,
      ownerGeneration: `generation:${ownerId}`,
      writable: true,
      plan: "pro",
      allowance: { audience: "pro", budgetMicroCents: 250_000_000 },
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      },
      connectedEngines: [],
      fetchedAt: Date.now(),
      ttlMs: 300_000,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/turn-state") {
      if (request.method === "POST") {
        const body = await parse(request);
        try {
          await OrchestratorSession.prototype["putTurnState"].call(this, {
            "probe:a": body.value,
            "probe:b": body.fail ? () => undefined : body.value,
          });
        } catch {
          return json({ failed: true }, 400);
        }
      }
      return json({
        a: this.ctx.storage.kv.get("probe:a"),
        b: this.ctx.storage.kv.get("probe:b"),
      });
    }
    if (path === "/__test/snapshot-with-lease") {
      const body = await parse(request);
      return json(
        await this.snapshotWithFenceLease({
          lease: body as unknown as OwnerGateFenceLeaseRequest,
        }),
      );
    }
    if (path === "/__test/fence-snapshot") {
      await this.status();
      const fence =
        await this.ctx.storage.get<Record<string, unknown>>("ownerPurgeFence");
      const store = new OwnerFenceStore(this.ctx.storage.sql);
      store.initialize();
      const gateDeadlines = this.ctx.storage.sql
        .exec<{
          dispatch_id: string;
          payload_json: string | null;
          payload_expires_at: number | null;
        }>(
          `SELECT dispatch_id, payload_json, payload_expires_at
             FROM dispatches
            ORDER BY dispatch_id`,
        )
        .toArray();
      return json({
        fence: fence ?? null,
        active: store.activeLeases(),
        nextExpiry: store.nextExpiry(),
        gateDeadlines,
        alarmAt: await this.ctx.storage.getAlarm(),
      });
    }
    if (path === "/__test/seed-gate-alarm") {
      const body = await parse(request);
      const dispatchId = text(body, "dispatchId");
      const delayMs = body.delayMs;
      if (
        !dispatchId ||
        typeof delayMs !== "number" ||
        !Number.isSafeInteger(delayMs) ||
        delayMs < 250 ||
        delayMs > 10_000
      ) {
        return json({ error: "Invalid gate alarm." }, 400);
      }
      await this.status();
      const now = Date.now();
      const deadline = now + delayMs;
      this.ctx.storage.sql.exec(
        `INSERT INTO dispatches (
           dispatch_id, idempotency_key, owner_generation, kind, ingress,
           subject, conversation_id, required_capabilities,
           routing_fingerprint, state, on_no_eligible_computer, revision,
           payload_json, payload_hash, payload_expires_at, cloud_attempts,
           gate_held, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        dispatchId,
        `idempotency:${dispatchId}`,
        "generation:test",
        "chat",
        "fixture",
        "fixture",
        `conversation:${dispatchId}`,
        "[]",
        `routing:${dispatchId}`,
        "failed",
        "fail",
        1,
        "{}",
        `payload:${dispatchId}`,
        deadline,
        0,
        0,
        now,
        now,
      );
      await (this as unknown as OwnerGateInternals).scheduleAlarm(now);
      return json({ seeded: true, deadline });
    }
    return await super.fetch(request);
  }
}

/** Production BuildSession plus observation/fault-injection fixture routes. */
export class LeaseTestBuildSession extends BuildSession {
  private internals(): BuildSessionInternals {
    return this as unknown as BuildSessionInternals;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/client-snapshot") {
      const receipts = await this.ctx.storage.list<LeaseReceipt>({
        prefix: RECEIPT_PREFIX,
      });
      return json({
        receipts: [...receipts.values()],
        alarmAt: await this.ctx.storage.getAlarm(),
      });
    }
    const body = await parse(request);
    let turn: TestTurn;
    try {
      turn = turnFrom(body);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "bad request" },
        400,
      );
    }
    const leaseId = text(body, "leaseId");
    if (!leaseId) return json({ error: "leaseId is required" }, 400);
    if (path === "/__test/simulate-lost-register") {
      const grant = await this.internals().registerBuildOwnerFenceLease({
        turn,
        kind: "run",
        role: "run",
        leaseId,
      });
      const key = receiptKey(leaseId);
      const receipt = await this.ctx.storage.get<LeaseReceipt>(key);
      if (!receipt) return json({ error: "missing receipt" }, 500);
      const { registrationGeneration: _lost, ...withoutResponse } = receipt;
      await this.ctx.storage.put(key, {
        ...withoutResponse,
        phase: "registering",
        updatedAt: Date.now(),
      });
      return json({ simulated: true, leaseId: grant.leaseId }, 503);
    }
    if (path === "/__test/replay-register") {
      return json(
        await this.internals().registerBuildOwnerFenceLease({
          turn,
          kind: "run",
          role: "run",
          leaseId,
        }),
      );
    }
    if (path === "/__test/simulate-lost-unregister") {
      const grant = await this.internals().registerBuildOwnerFenceLease({
        turn,
        kind: "run",
        role: "run",
        leaseId,
      });
      const key = receiptKey(leaseId);
      const current = await this.ctx.storage.get<LeaseReceipt>(key);
      if (!current) return json({ error: "missing receipt" }, 500);
      const pending = {
        ...current,
        phase: "unregister_pending" as const,
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(key, pending);
      const response = await this.internals().callOwnerFence(
        turn.ownerId,
        "unregister",
        {
          leaseId,
          sessionId: this.ctx.id.toString(),
          turnId: turn.turnId,
          ownerGeneration: turn.ownerGeneration,
          generation: grant.generation,
        },
      );
      if (!response.ok) return json({ error: "remote retirement failed" }, 500);
      // The remote commit is real; retaining pending models a lost response.
      await this.ctx.storage.put(key, pending);
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return json({ simulated: true, leaseId }, 503);
    }
    return json({ error: "Not found" }, 404);
  }
}

const forward = async (
  stub: DurableObjectStub,
  request: Request,
  targetPath: string,
): Promise<Response> => {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  return await stub.fetch(`https://fixture.invalid${targetPath}`, {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });
};

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true });
    const client = url.pathname.match(/^\/client\/([^/]+)(\/.*)$/u);
    if (client) {
      return await forward(
        env.BUILD_SESSIONS.getByName(`client-${client[1]}`),
        request,
        client[2],
      );
    }
    const owner = url.pathname.match(/^\/owner\/([^/]+)(\/.*)$/u);
    if (owner) {
      const ownerId = decodeURIComponent(owner[1]);
      const headers = new Headers(request.headers);
      headers.set("x-stella-owner-fence-id", ownerId);
      return await forward(
        env.OWNER_GATES.getByName(ownerId),
        new Request(request, { headers }),
        owner[2],
      );
    }
    return json({ error: "Not found" }, 404);
  },
};
