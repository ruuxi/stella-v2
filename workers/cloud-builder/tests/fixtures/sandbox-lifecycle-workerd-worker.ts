import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import {
  advanceSandboxDestroyDebt,
  clearSandboxDestroyDebt,
  createSandboxDestroyDebt,
  listSandboxDestroyDebts,
  persistSandboxDestroyDebt,
  sandboxLifecycleId,
  type SandboxDestroyDebt,
} from "../../src/sandbox-lifecycle.js";

type FixtureEnv = {
  LIFECYCLE_PROOF: DurableObjectNamespace<SandboxLifecycleProof>;
  SANDBOX_PROOF: DurableObjectNamespace<SandboxSdkProof>;
};

const target = {
  sandboxId: "workerd-lifecycle-proof",
  size: "small" as const,
  workload: "resident-attachment" as const,
};

type Snapshot = {
  debts: number;
  attemptCount: number | null;
  alarmScheduled: boolean;
  completed: boolean;
};

type AbaSnapshot = Snapshot & {
  oldId: string;
  successorId: string;
  oldDestroyed: boolean;
  successorDestroyed: boolean;
};

export class SandboxSdkProof extends DurableObject<FixtureEnv> {
  async configure(): Promise<void> {}

  async setKeepAlive(_enabled: boolean): Promise<void> {}

  async destroy(): Promise<void> {
    await this.ctx.storage.put("destroyed", true);
  }

  async wasDestroyed(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("destroyed")) === true;
  }
}

export class SandboxLifecycleProof extends DurableObject<FixtureEnv> {
  async seed(): Promise<Snapshot> {
    const createdAt = Date.now();
    const debt: SandboxDestroyDebt = {
      ...createSandboxDestroyDebt(target, createdAt),
      // Leave enough time for the test to stop Workerd before the alarm fires.
      nextAttemptAt: createdAt + 1_000,
    };
    await this.ctx.storage.delete(["completed", "aba", "oldId", "successorId"]);
    await persistSandboxDestroyDebt(this.ctx.storage, debt);
    return await this.snapshot();
  }

  async seedCommittedThenFault(): Promise<void> {
    const createdAt = Date.now();
    await this.ctx.storage.delete(["completed", "aba", "oldId", "successorId"]);
    await persistSandboxDestroyDebt(this.ctx.storage, {
      ...createSandboxDestroyDebt(target, createdAt),
      nextAttemptAt: createdAt + 1_000,
    });
    throw new Error("fixture crash after atomic commit");
  }

  async seedAba(): Promise<AbaSnapshot> {
    const base = {
      ownerId: "owner-reused",
      ownerGeneration: "generation-reused",
      turnId: "turn-reused",
      turnToken: "turn-token-reused",
    };
    const [oldId, successorId] = await Promise.all([
      sandboxLifecycleId("agent", { ...base, attemptGeneration: 1 }),
      sandboxLifecycleId("agent", { ...base, attemptGeneration: 2 }),
    ]);
    const createdAt = Date.now();
    await this.ctx.storage.delete("completed");
    await this.ctx.storage.put({ oldId, successorId, aba: true });
    await persistSandboxDestroyDebt(
      this.ctx.storage,
      createSandboxDestroyDebt(
        { sandboxId: oldId, size: "small", workload: "agent" },
        createdAt,
      ),
    );
    return await this.abaSnapshot();
  }

  async snapshot(): Promise<Snapshot> {
    const debts = await listSandboxDestroyDebts(this.ctx.storage);
    return {
      debts: debts.length,
      attemptCount: debts[0]?.attemptCount ?? null,
      alarmScheduled: (await this.ctx.storage.getAlarm()) !== null,
      completed: (await this.ctx.storage.get<boolean>("completed")) === true,
    };
  }

  async alarm(): Promise<void> {
    const debts = await listSandboxDestroyDebts(this.ctx.storage);
    if ((await this.ctx.storage.get<boolean>("aba")) === true) {
      for (const debt of debts) {
        const sandbox = getSandbox(
          this.env.SANDBOX_PROOF as DurableObjectNamespace<any>,
          debt.target.sandboxId,
          {
            transport: "rpc",
            enableDefaultSession: false,
            keepAlive: true,
            normalizeId: true,
            labels: {
              service: "sandbox-lifecycle-workerd-proof",
              workload: debt.target.workload,
            },
          },
        );
        await sandbox.setKeepAlive(false);
        await sandbox.destroy();
        await clearSandboxDestroyDebt(this.ctx.storage, debt);
      }
      await this.ctx.storage.put("completed", true);
      return;
    }
    for (const debt of debts) {
      if (debt.attemptCount === 0) {
        // First alarm models a failed container destroy. The exact debt is
        // advanced and re-armed using the same production helper.
        await persistSandboxDestroyDebt(
          this.ctx.storage,
          advanceSandboxDestroyDebt(debt, Date.now()),
        );
      } else {
        // The retry models a confirmed destroy and clears only this tuple.
        await clearSandboxDestroyDebt(this.ctx.storage, debt);
        await this.ctx.storage.put("completed", true);
      }
    }
  }

  async abaSnapshot(): Promise<AbaSnapshot> {
    const [snapshot, oldId, successorId] = await Promise.all([
      this.snapshot(),
      this.ctx.storage.get<string>("oldId"),
      this.ctx.storage.get<string>("successorId"),
    ]);
    if (!oldId || !successorId) throw new Error("ABA fixture not seeded");
    const [oldDestroyed, successorDestroyed] = await Promise.all([
      this.env.SANDBOX_PROOF.getByName(oldId).wasDestroyed(),
      this.env.SANDBOX_PROOF.getByName(successorId).wasDestroyed(),
    ]);
    return {
      ...snapshot,
      oldId,
      successorId,
      oldDestroyed,
      successorDestroyed,
    };
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const proof = env.LIFECYCLE_PROOF.getByName("sandbox-lifecycle-proof");
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/seed") {
      return Response.json(await proof.seed());
    }
    if (request.method === "POST" && pathname === "/seed-committed-fault") {
      try {
        await proof.seedCommittedThenFault();
      } catch {
        return Response.json({ faulted: true }, { status: 503 });
      }
    }
    if (request.method === "POST" && pathname === "/seed-aba") {
      return Response.json(await proof.seedAba());
    }
    if (request.method === "GET" && pathname === "/aba-snapshot") {
      return Response.json(await proof.abaSnapshot());
    }
    if (request.method === "GET" && pathname === "/snapshot") {
      return Response.json(await proof.snapshot());
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<FixtureEnv>;
