import { DurableObject } from "cloudflare:workers";
import { OwnerLedgerStore } from "./owner-ledger-store.js";
import type { LedgerReserveArgs, LedgerSettleArgs } from "./ledger.js";

/** Legacy owner-v1 authority. Its object identity and per-JTI keys stay unchanged. */
export class OwnerCapabilityLedger extends DurableObject<Env> {
  private readonly ledger: OwnerLedgerStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new OwnerLedgerStore(ctx.storage);
  }
  async reserve(args: LedgerReserveArgs) { return await this.ledger.reserve(args); }
  async settle(args: LedgerSettleArgs & { jti: string }) { return await this.ledger.settle(args); }
  async replay(args: { jti: string; requestId: string }) { return await this.ledger.replay(args); }
  async snapshot(args: { jti: string }) { return await this.ledger.snapshot(args); }
  async alarm() { await this.ledger.alarm(); }
}
