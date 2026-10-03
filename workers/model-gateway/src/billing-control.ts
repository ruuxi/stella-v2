import type {
  BillingControlRpc,
  GatewayConfigSnapshot,
} from "@stella/contracts/gateway/usage";

/** cloud-builder's billing entrypoint, typed by its contract. */
export const billingControl = (env: Pick<Env, "BILLING">): BillingControlRpc =>
  env.BILLING as unknown as BillingControlRpc;

/** Where pricing and limits come from: `BillingControl.gatewayConfig()`. */
export type GatewayConfigLoader = () => Promise<GatewayConfigSnapshot>;

export const billingGatewayConfig =
  (env: Pick<Env, "BILLING">): GatewayConfigLoader =>
  () =>
    billingControl(env).gatewayConfig();
