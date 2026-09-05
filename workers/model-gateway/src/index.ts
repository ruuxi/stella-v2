import { handleRequest } from "./router.js";
import { handleUsageBatch } from "./usage-queue.js";

export { OwnerCapabilityLedger } from "./owner-capability-ledger.js";
export { CapabilityLedger } from "./ledger.js";
export { NetworkGate, OwnerRelayGate, TierBudget } from "./gates/index.js";
export { handleRequest } from "./router.js";
export { handleUsageBatch } from "./usage-queue.js";

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  queue: (batch, env) => handleUsageBatch(batch, env),
} satisfies ExportedHandler<Env, unknown>;
