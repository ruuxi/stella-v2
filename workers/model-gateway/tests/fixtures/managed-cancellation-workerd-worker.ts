import { WorkerEntrypoint } from "cloudflare:workers";
import {
  GATEWAY_CAPABILITY_ISSUERS,
  type GatewayCapabilityClaims,
} from "@stella/contracts/gateway/capability";
import {
  importCapabilitySigningKey,
  signCapability,
} from "@stella/contracts/gateway/jwt";
import { OwnerRelayGate } from "../../src/gates/owner-relay-gate.js";
import { ModelGatewayControl } from "../../src/model-gateway-control.js";
import type { ManagedCancellationIdentity } from "../../src/managed-cancellation.js";

export { ModelGatewayControl };

type Phase = "prearrival" | "afterauth" | "postheaders";
type FixtureStats = {
  providerStarted: boolean;
  headersReceived: boolean;
  upstreamAborted: boolean;
};
type ControlBinding = {
  cancelManagedRequest(args: {
    capability: string;
    requestId: string;
  }): Promise<{ canceled: boolean }>;
};
type FixtureEnv = Env & {
  CONTROL: ControlBinding;
  OWNER_RELAY_GATE: DurableObjectNamespace<CancellationGateFixture>;
};

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg4YjxPVs7iEYC1wKl
62P/AVNV4u5kAZz/00230NbQL22hRANCAARijtc/Mtkxg7WusVqNKLUDk61dN26F
VnHNC3wt3AC3cmKnVvq8qKTpJZ0/tVcpvLDuMWa+10TLr69XM5WNjTOf
-----END PRIVATE KEY-----`;
const pause = async (ms: number): Promise<void> => scheduler.wait(ms);

export class CancellationGateFixture extends OwnerRelayGate {
  private statsValue: FixtureStats = {
    providerStarted: false,
    headersReceived: false,
    upstreamAborted: false,
  };

  stats(): FixtureStats {
    return this.statsValue;
  }

  async runManagedFixture(
    identity: ManagedCancellationIdentity,
    phase: Phase,
  ): Promise<string> {
    this.statsValue = {
      providerStarted: false,
      headersReceived: false,
      upstreamAborted: false,
    };
    const cancellation = this.beginManagedRequest(identity);
    if (cancellation.canceled) return "canceled-before-provider";
    this.statsValue.providerStarted = true;
    try {
      if (phase === "postheaders") this.statsValue.headersReceived = true;
      await new Promise<void>((resolve) => {
        if (cancellation.signal.aborted) {
          resolve();
          return;
        }
        cancellation.signal.addEventListener("abort", resolve, { once: true });
      });
      this.statsValue.upstreamAborted = cancellation.signal.aborted;
      return cancellation.signal.aborted ? "upstream-aborted" : "completed";
    } finally {
      this.releaseManagedRequest(cancellation.key);
    }
  }
}

const issue = async (): Promise<{
  token: string;
  claims: GatewayCapabilityClaims;
}> => {
  const signing = await importCapabilitySigningKey(PRIVATE_KEY, "fixture-k1");
  return await signCapability(
    {
      iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
      sub: "fixture-owner",
      gen: "generation-1",
      kind: "turn",
      audience: "pro",
      budgetMicroCents: 1_000_000,
      ledgerScope: "owner-relay-v2",
      agentTypes: ["orchestrator"],
      turn: {
        turnId: "fixture-turn",
        conversationId: "fixture-conversation",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/meta/muse-spark-1.3-contributor",
          reasoningEffort: "high",
        },
      },
    },
    signing,
    { ttlMs: 60_000 },
  );
};

export class GatewayWorker extends WorkerEntrypoint<FixtureEnv> {
  async run(phase: Phase): Promise<{ outcome: string; stats: FixtureStats }> {
    const { token, claims } = await issue();
    if (!claims.turn) throw new Error("fixture turn binding missing");
    const requestId = `fixture-${phase}`;
    const identity: ManagedCancellationIdentity = {
      ownerId: claims.sub,
      ownerGeneration: claims.gen,
      capabilityId: claims.jti,
      requestId,
      turnId: claims.turn.turnId,
      conversationId: claims.turn.conversationId,
      expiresAt: claims.exp * 1_000,
    };
    const gate = this.env.OWNER_RELAY_GATE.getByName(claims.sub);
    if (phase === "prearrival") {
      await this.env.CONTROL.cancelManagedRequest({
        capability: token,
        requestId,
      });
    }
    const running = gate.runManagedFixture(identity, phase);
    if (phase !== "prearrival") {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const stats = await gate.stats();
        const ready =
          phase === "postheaders"
            ? stats.headersReceived
            : stats.providerStarted;
        if (ready) break;
        await pause(5);
      }
      await this.env.CONTROL.cancelManagedRequest({
        capability: token,
        requestId,
      });
    }
    return { outcome: await running, stats: await gate.stats() };
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const phase = new URL(request.url).pathname.slice(1) as Phase;
    if (!["prearrival", "afterauth", "postheaders"].includes(phase)) {
      return new Response("ready");
    }
    const gateway = new GatewayWorker({} as ExecutionContext, env);
    return Response.json(await gateway.run(phase));
  },
};
