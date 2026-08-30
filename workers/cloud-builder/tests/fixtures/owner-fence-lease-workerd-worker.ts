import { BuildSession } from "../../src/index.js";
import { agentComputeKey } from "../../src/agent-compute-ladder.js";
import {
  turnComputePlan,
  turnComputePlanKey,
} from "../../src/general-agent-turn.js";
import { sha256Hex } from "../../src/hash.js";
import { OwnerFenceStore } from "../../src/owner-fence-store.js";

type FixtureEnv = {
  BUILD_SESSIONS: DurableObjectNamespace<LeaseTestBuildSession>;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
};

type TestTurn = {
  kind: "agent";
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  threadId: string;
  attemptGeneration: number;
  appId: "agent";
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
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
  kind: "run" | "aux" | "world";
  phase: "registering" | "registered" | "unregister_pending";
  registrationGeneration?: string;
  createdAt: number;
  updatedAt: number;
};

const RECEIPT_PREFIX = "ownerFenceLeaseReceipt:";
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
    ownerId,
    ownerGeneration,
    turnId,
    threadId: `thread:${turnId}`,
    attemptGeneration: 1,
    appId: "agent",
    prompt: "fixture",
    turnToken: `token:${turnId}`,
    convexCallbackBase: "https://fixture.invalid",
  };
};

type BuildSessionInternals = {
  registerBuildOwnerFenceLease(args: {
    turn: TestTurn;
    kind: "run" | "aux" | "world";
    role: "run" | "aux" | "world";
    leaseId: string;
    mutateTurn?: boolean;
  }): Promise<{ generation: string; expiresAt: number; leaseId: string }>;
  registerTurn(turn: TestTurn): Promise<string>;
  destroySandboxDurably(
    target: {
      sandboxId: string;
      size: "small" | "large";
      workload: "resident-attachment";
    },
    event: string,
  ): Promise<void>;
  callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response>;
};

/** Production BuildSession plus observation/fault-injection fixture routes. */
export class LeaseTestBuildSession extends BuildSession {
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env as never);
    Object.defineProperty(this, "sandbox", {
      value: (sandboxId: string) => ({
        setKeepAlive: async () => undefined,
        destroy: async () => {
          const failureKey = `__test:sandboxDestroyFailures:${sandboxId}`;
          const failures =
            (await this.ctx.storage.get<number>(failureKey)) ?? 0;
          if (failures > 0) {
            const [destroyDebts, retirements, compute, receipts] =
              await Promise.all([
                this.ctx.storage.list({
                  prefix: "sandbox-lifecycle:v1:destroy-pending:",
                }),
                this.ctx.storage.list({
                  prefix: "ownerFenceSandboxWorldRetirement:",
                }),
                this.ctx.storage.list({ prefix: "agentCompute:" }),
                this.ctx.storage.list({ prefix: RECEIPT_PREFIX }),
              ]);
            // The key uses a preserved durability prefix solely so terminal
            // cleanup cannot erase the observation before the test process
            // wakes. Production reconciliation ignores this non-debt phase.
            await this.ctx.storage.put(
              `ownerFenceSandboxWorldRetirement:__test_observation:${sandboxId}`,
              {
                schemaVersion: 1,
                phase: "test_observation",
                destroyDebts: [...destroyDebts.values()],
                retirements: [...retirements.values()],
                compute: [...compute.values()],
                receipts: [...receipts.values()],
              },
            );
            await this.ctx.storage.put(failureKey, failures - 1);
            throw new Error("fixture destroy failed");
          }
          await this.ctx.storage.put(
            `__test:sandboxActive:${sandboxId}`,
            false,
          );
        },
      }),
    });
  }

  private internals(): BuildSessionInternals {
    return this as unknown as BuildSessionInternals;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/owner-fence/")) return await super.fetch(request);
    if (path === "/__test/fence-snapshot") {
      const fence =
        await this.ctx.storage.get<Record<string, unknown>>("ownerPurgeFence");
      const store = new OwnerFenceStore(this.ctx.storage.sql);
      store.initialize();
      return json({
        fence: fence ?? null,
        active: store.activeLeases(),
        nextExpiry: store.nextExpiry(),
        alarmAt: await this.ctx.storage.getAlarm(),
      });
    }
    if (path === "/__test/client-snapshot") {
      const receipts = await this.ctx.storage.list<LeaseReceipt>({
        prefix: RECEIPT_PREFIX,
      });
      const retirementEntries = await this.ctx.storage.list({
        prefix: "ownerFenceSandboxWorldRetirement:",
      });
      return json({
        receipts: [...receipts.values()],
        compute: [
          ...(
            await this.ctx.storage.list({ prefix: "agentCompute:" })
          ).values(),
        ],
        retirements: [
          ...[...retirementEntries.entries()]
            .filter(([key]) => !key.includes(":__test_observation:"))
            .map(([, value]) => value),
        ],
        failureObservations: [
          ...[...retirementEntries.entries()]
            .filter(([key]) => key.includes(":__test_observation:"))
            .map(([, value]) => value),
        ],
        destroyDebts: [
          ...(
            await this.ctx.storage.list({
              prefix: "sandbox-lifecycle:v1:destroy-pending:",
            })
          ).values(),
        ],
        sandboxes: [
          ...(
            await this.ctx.storage.list({ prefix: "__test:sandboxActive:" })
          ).entries(),
        ],
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
    if (path === "/__test/register-world") {
      try {
        return json(
          await this.internals().registerBuildOwnerFenceLease({
            turn,
            kind: "world",
            role: "world",
            leaseId,
          }),
        );
      } catch {
        return json({ code: "world_busy" }, 409);
      }
    }
    if (path === "/__test/seed-orphaned-attach") {
      const sandboxId = text(body, "sandboxId");
      if (!sandboxId) return json({ error: "sandboxId is required" }, 400);
      turn.execution = {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      };
      turn.ownerPurgeGeneration = await this.internals().registerTurn(turn);
      const grant = await this.internals().registerBuildOwnerFenceLease({
        turn,
        kind: "world",
        role: "world",
        leaseId,
      });
      const receipt = await this.ctx.storage.get<LeaseReceipt>(
        receiptKey(leaseId),
      );
      if (!receipt) return json({ error: "missing world receipt" }, 500);
      const { registrationGeneration: _lost, ...registering } = receipt;
      await this.ctx.storage.put({
        turn,
        turnId: turn.turnId,
        terminal: false,
        [turnComputePlanKey(turn.turnId, 1)]: turnComputePlan({
          turnId: turn.turnId,
          attemptGeneration: 1,
          execution: turn.execution,
          browserResume: false,
          residentDisabled: false,
          now: Date.now(),
        }),
        [agentComputeKey(turn.turnId, 1)]: {
          schemaVersion: 2,
          turnId: turn.turnId,
          attemptGeneration: 1,
          phase: "attaching",
          instanceSize: "small",
          sandboxId,
          attachReason: "filesystem_tool",
          worldLease: { leaseId, phase: "registering" },
        },
        [receiptKey(leaseId)]: {
          ...registering,
          phase: "registering",
          updatedAt: Date.now(),
        },
        [`__test:sandboxActive:${sandboxId}`]: true,
        [`__test:sandboxDestroyFailures:${sandboxId}`]: 1,
      });
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return json({
        seeded: true,
        sandboxId,
        leaseId,
        generation: grant.generation,
        sessionId: this.ctx.id.toString(),
      });
    }
    if (path === "/__test/seed-live-renewal") {
      const sandboxId = text(body, "sandboxId");
      if (!sandboxId) return json({ error: "sandboxId is required" }, 400);
      const initialExpiresAt = Date.now() + 2_000;
      const response = await this.internals().callOwnerFence(
        turn.ownerId,
        "register",
        {
          leaseId,
          sessionId: this.ctx.id.toString(),
          turnId: turn.turnId,
          ownerGeneration: turn.ownerGeneration,
          role: "world",
          expiresAt: initialExpiresAt,
        },
      );
      const grant = (await response.json()) as { generation?: string };
      if (!response.ok || !grant.generation) {
        return json({ error: "world registration failed" }, 500);
      }
      turn.execution = {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      };
      await this.ctx.storage.put({
        turn,
        turnId: turn.turnId,
        terminal: false,
        agentWatchdogDeadlineAt: Date.now() + 60_000,
        [agentComputeKey(turn.turnId, 1)]: {
          schemaVersion: 2,
          turnId: turn.turnId,
          attemptGeneration: 1,
          phase: "attached",
          instanceSize: "small",
          sandboxId,
          attachReason: "process_tool",
          worldLease: {
            leaseId,
            phase: "registered",
            generation: grant.generation,
            expiresAt: initialExpiresAt,
          },
        },
      });
      (
        this as unknown as {
          agentTurnExecutions: Map<string, unknown>;
        }
      ).agentTurnExecutions.set(turn.turnId, {});
      await this.ctx.storage.setAlarm(Date.now() + 500);
      return json({ seeded: true, initialExpiresAt });
    }
    if (path === "/__test/simulate-normal-destroy-failure") {
      const sandboxId = text(body, "sandboxId");
      if (!sandboxId) return json({ error: "sandboxId is required" }, 400);
      const grant = await this.internals().registerBuildOwnerFenceLease({
        turn,
        kind: "world",
        role: "world",
        leaseId,
      });
      await this.ctx.storage.put({
        turn,
        [agentComputeKey(turn.turnId, 1)]: {
          schemaVersion: 2,
          turnId: turn.turnId,
          attemptGeneration: 1,
          phase: "attached",
          instanceSize: "small",
          sandboxId,
          attachReason: "process_tool",
          worldLease: {
            leaseId,
            phase: "registered",
            generation: grant.generation,
            expiresAt: grant.expiresAt,
          },
        },
        [`__test:sandboxActive:${sandboxId}`]: true,
        [`__test:sandboxDestroyFailures:${sandboxId}`]: 1,
      });
      try {
        await this.internals().destroySandboxDurably(
          { sandboxId, size: "small", workload: "resident-attachment" },
          "fixture_normal_teardown",
        );
      } catch {
        const asserted = await this.internals().callOwnerFence(
          turn.ownerId,
          "assert",
          {
            leaseId,
            ownerGeneration: turn.ownerGeneration,
            generation: grant.generation,
          },
        );
        return json(
          {
            simulated: true,
            worldStillActive: asserted.ok,
            destroyDebts: [
              ...(
                await this.ctx.storage.list({
                  prefix: "sandbox-lifecycle:v1:destroy-pending:",
                })
              ).values(),
            ],
            retirements: [
              ...(
                await this.ctx.storage.list({
                  prefix: "ownerFenceSandboxWorldRetirement:",
                })
              ).values(),
            ],
          },
          503,
        );
      }
      return json({ error: "destroy unexpectedly succeeded" }, 500);
    }
    if (path === "/__test/sandbox-state") {
      const sandboxId = text(body, "sandboxId");
      return json({
        active: await this.ctx.storage.get(`__test:sandboxActive:${sandboxId}`),
        failures: await this.ctx.storage.get(
          `__test:sandboxDestroyFailures:${sandboxId}`,
        ),
      });
    }
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
      const ownerHash = await sha256Hex(ownerId);
      const headers = new Headers(request.headers);
      headers.set("x-stella-owner-fence-id", ownerId);
      return await forward(
        env.BUILD_SESSIONS.getByName(`owner-purge-${ownerHash}`),
        new Request(request, { headers }),
        owner[2],
      );
    }
    return json({ error: "Not found" }, 404);
  },
};
