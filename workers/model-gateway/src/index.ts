import { handleRequest } from "./router.js";
import { handleUsageBatch } from "./usage-queue.js";
import { billingGatewayConfig } from "./billing-control.js";
import { publishSharedGatewayConfig } from "./shared-config.js";

export { ModelGatewayControl } from "./model-gateway-control.js";
export { CapabilityLedger } from "./ledger.js";
export { NetworkGate, OwnerRelayGate, TierBudget } from "./gates/index.js";
export { handleRequest } from "./router.js";
export { handleUsageBatch } from "./usage-queue.js";

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  queue: (batch, env) => handleUsageBatch(batch, env),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(
      publishSharedGatewayConfig({
        load: billingGatewayConfig(env),
        store: env.CONFIG_SNAPSHOT,
        source: env.STELLA_BACKEND_URL,
      }),
    );
  },
} satisfies ExportedHandler<Env, unknown>;
