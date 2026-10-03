import type { Env } from "./build-session/shared/env.js";
import { syncModelPrices } from "./catalog/prices.js";

/**
 * The worker's one Cron Trigger (`17 3 * * *`). Each global sweep adds itself
 * here; a failing sweep is logged and doesn't stop the others.
 */
export async function runScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const sweeps: Array<[string, () => Promise<unknown>]> = [
    ["model prices", () => syncModelPrices(env)],
  ];
  for (const [name, sweep] of sweeps) {
    try {
      await sweep();
    } catch (error) {
      console.error(`[cron] ${name} failed`, error);
    }
  }
}
