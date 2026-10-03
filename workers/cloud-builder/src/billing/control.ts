import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BillingControlResult,
  BillingControlRpc,
  ConvexOwnerEnforcementState,
  ConvexSessionCapabilityRequest,
  EngineAccessRequest,
  EngineAccessResponse,
  GatewayConfigSnapshot,
  GatewayUsageBatch,
  GatewayUsageBatchResult,
  GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import type { GatewaySessionCapabilityResponse } from "@stella/contracts/gateway/api";
import type { RpcResponse } from "@stella/contracts/backend/protocol";
import { dollarsToMicroCents } from "@stella/model-catalog/pricing";
import { readManagedModelPrices } from "../catalog/prices.js";
import { billingConfig } from "./plans.js";

/** A breaker in USD from the Worker's env, -1 meaning none; else the default. */
const tierCeilingMicroCents = (env: Env, name: string, defaultUsd: number): number => {
  const raw = (env as unknown as Record<string, unknown>)[name];
  const value = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : defaultUsd;
  if (!Number.isFinite(value) || (value < 0 && value !== -1)) {
    throw new Error(`${name} must be -1 or a non-negative USD amount.`);
  }
  return value === -1 ? -1 : dollarsToMicroCents(value);
};

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

  /**
   * The gateway's pricing and limits snapshot. Prices come from D1
   * (`model_prices`, synced by the Cron Trigger); the gateway caches it.
   */
  async gatewayConfig(): Promise<GatewayConfigSnapshot> {
    const { prices, updatedAt } = await readManagedModelPrices(this.env);
    const config = billingConfig(this.env);
    return {
      v: 1,
      prices,
      anonymous: {
        maxRequestsPerOwner: config.anonymousMaxRequests,
        maxRequestsPerIp: config.anonymousMaxRequestsPerIp,
      },
      tierCeilings: [
        {
          audience: "anonymous",
          hourlyMicroCents: tierCeilingMicroCents(this.env, "STELLA_TIER_CEILING_ANON_HOURLY_USD", 20),
          dailyMicroCents: tierCeilingMicroCents(this.env, "STELLA_TIER_CEILING_ANON_DAILY_USD", 200),
        },
        {
          audience: "free",
          hourlyMicroCents: tierCeilingMicroCents(this.env, "STELLA_TIER_CEILING_FREE_HOURLY_USD", 100),
          dailyMicroCents: tierCeilingMicroCents(this.env, "STELLA_TIER_CEILING_FREE_DAILY_USD", 1_000),
        },
      ],
      updatedAt: updatedAt || Date.now(),
    };
  }

  /** One owner's enforcement, from its abuse domain. Seeds the gateway's owner object. */
  async ownerEnforcement(ownerId: string): Promise<ConvexOwnerEnforcementState> {
    if (typeof ownerId !== "string" || !ownerId || ownerId.length > 512) {
      throw new Error("The owner id is invalid.");
    }
    return await this.env.OWNER_GATES.getByName(ownerId).ownerEnforcement();
  }

  /**
   * A fresh access token for the owner's connected engine (the native lane),
   * from the engines domain in the owner's object. Refused as
   * `generation_stale` when the capability predates an owner reset.
   */
  async engineAccess(
    request: EngineAccessRequest,
  ): Promise<BillingControlResult<EngineAccessResponse>> {
    if (
      typeof request?.ownerId !== "string" ||
      !request.ownerId ||
      request.ownerId.length > 512 ||
      typeof request.ownerGeneration !== "string" ||
      !request.ownerGeneration ||
      (request.provider !== "anthropic" && request.provider !== "openai-codex")
    ) {
      return { ok: false, status: 400, code: "bad_request", retryable: false };
    }
    try {
      const response = (await this.env.OWNER_GATES.getByName(request.ownerId).ownerInternal({
        name: "engines.access",
        args: { provider: request.provider },
        ownerGeneration: request.ownerGeneration,
      })) as unknown as RpcResponse;
      if (response.ok) {
        const access = response.value as EngineAccessResponse | null;
        return access
          ? { ok: true, body: access }
          : { ok: false, status: 404, code: null, retryable: false };
      }
      if (response.error.reason === "owner_generation_stale") {
        return { ok: false, status: 409, code: "generation_stale", retryable: false };
      }
      return { ok: false, status: 503, code: null, retryable: response.error.retryable };
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "billing_engine_access_failed",
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
