import { DurableObject } from "cloudflare:workers";
import {
  applyPublicDecision,
  consumeGrant,
  expireAuthorization,
  readGrantStatus,
  type AuthorizationState,
  type PublicDecisionOutcome,
} from "./state-machine.js";

const STATE_KEY = "authorization";

export type StoredAuthorizationInput = Readonly<{
  schemaVersion: 1;
  userCode: string;
  deviceCodeDigest: string;
  createdAt: number;
  expiresAt: number;
}>;

export type DeviceCodeFixtureEnv = Readonly<{
  DEVICE_AUTHORIZATIONS: DurableObjectNamespace<DeviceAuthorizationSession>;
  ACTIVATION_PAGE_RATE_LIMITER: RateLimit;
  ACTIVATION_DECISION_RATE_LIMITER: RateLimit;
  PUBLIC_ORIGIN: string;
}>;

export class DeviceAuthorizationSession extends DurableObject<DeviceCodeFixtureEnv> {
  private readonly durableState: DurableObjectState;

  constructor(ctx: DurableObjectState, env: DeviceCodeFixtureEnv) {
    super(ctx, env);
    this.durableState = ctx;
  }

  async create(input: StoredAuthorizationInput): Promise<{ created: boolean }> {
    const created = await this.durableState.storage.transaction(async (txn) => {
      const existing = await txn.get<AuthorizationState>(STATE_KEY);
      if (existing !== undefined) return false;
      const state: AuthorizationState = {
        schemaVersion: 1,
        userCode: input.userCode,
        deviceCodeDigest: input.deviceCodeDigest,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      };
      await txn.put(STATE_KEY, state);
      return true;
    });
    if (created) await this.durableState.storage.setAlarm(input.expiresAt);
    return { created };
  }

  async publicDecision(
    decision: "approve" | "deny",
  ): Promise<{ outcome: PublicDecisionOutcome | "not_found" }> {
    return await this.durableState.storage.transaction(async (txn) => {
      const current = await txn.get<AuthorizationState>(STATE_KEY);
      if (current === undefined) return { outcome: "not_found" as const };
      const result = applyPublicDecision(current, decision, Date.now());
      if (result.state !== current) await txn.put(STATE_KEY, result.state);
      return { outcome: result.outcome };
    });
  }

  async status(deviceCodeDigest: string) {
    return await this.durableState.storage.transaction(async (txn) => {
      const current = await txn.get<AuthorizationState>(STATE_KEY);
      const result = readGrantStatus(current, deviceCodeDigest, Date.now());
      if (result.state !== undefined && result.state !== current) {
        await txn.put(STATE_KEY, result.state);
      }
      return result.response;
    });
  }

  async consume(deviceCodeDigest: string, consumerId: string) {
    return await this.durableState.storage.transaction(async (txn) => {
      const current = await txn.get<AuthorizationState>(STATE_KEY);
      const result = consumeGrant(
        current,
        deviceCodeDigest,
        Date.now(),
        consumerId,
      );
      if (result.state !== undefined && result.state !== current) {
        await txn.put(STATE_KEY, result.state);
      }
      return result.response;
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const result = await this.durableState.storage.transaction(async (txn) => {
      const current = await txn.get<AuthorizationState>(STATE_KEY);
      if (current === undefined) return undefined;
      if (current.cleanupAt !== undefined && now >= current.cleanupAt) {
        await txn.delete(STATE_KEY);
        return undefined;
      }
      const expired = expireAuthorization(current, now);
      if (expired !== current) await txn.put(STATE_KEY, expired);
      return expired.cleanupAt;
    });
    if (result !== undefined) await this.durableState.storage.setAlarm(result);
  }
}
