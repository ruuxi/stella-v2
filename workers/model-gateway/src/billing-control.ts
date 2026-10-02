import type { BillingControlRpc } from "@stella/contracts/gateway/usage";

/** cloud-builder's billing entrypoint, typed by its contract. */
export const billingControl = (env: Pick<Env, "BILLING">): BillingControlRpc =>
  env.BILLING as unknown as BillingControlRpc;
