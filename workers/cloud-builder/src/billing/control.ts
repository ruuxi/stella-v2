import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BillingControlResult,
  BillingControlRpc,
  ConvexSessionCapabilityRequest,
  GatewayUsageBatch,
  GatewayUsageBatchResult,
  GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import type { GatewaySessionCapabilityResponse } from "@stella/contracts/gateway/api";

/**
 * The model gateway's way into billing, over a service binding: session
 * capabilities for client runtimes, and the usage it settles. A service
 * binding runs where the gateway's request runs, so a session exchange from
 * a client still reaches the owner's object from the client's edge.
 */
export class BillingControl extends WorkerEntrypoint<Env> implements BillingControlRpc {
  async issueSessionCapability(
    request: ConvexSessionCapabilityRequest,
  ): Promise<BillingControlResult<GatewaySessionCapabilityResponse>> {
    if (typeof request?.ownerId !== "string" || !request.ownerId || request.ownerId.length > 512) {
      return { ok: false, status: 400, code: "bad_request", retryable: false };
    }
    try {
      return await this.env.OWNER_GATES.getByName(request.ownerId).issueSessionCapability(request);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "billing_session_capability_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return { ok: false, status: null, code: null, retryable: true };
    }
  }

  /** Settle a batch. Throws when any owner's share should be redelivered. */
  async ingestUsage(batch: GatewayUsageBatch): Promise<GatewayUsageBatchResult> {
    const byOwner = new Map<string, GatewayUsageEvent[]>();
    for (const event of batch.events) {
      const events = byOwner.get(event.ownerId) ?? [];
      events.push(event);
      byOwner.set(event.ownerId, events);
    }
    const results = await Promise.all(
      [...byOwner].map(([ownerId, events]) =>
        this.env.OWNER_GATES.getByName(ownerId).applyGatewayUsage(events),
      ),
    );
    return {
      accepted: results.flatMap((result) => result.accepted),
      duplicate: results.flatMap((result) => result.duplicate),
      rejected: results.flatMap((result) => result.rejected),
    };
  }
}
