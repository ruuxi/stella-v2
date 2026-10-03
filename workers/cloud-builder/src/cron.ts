import type { Env } from "./build-session/shared/env.js";

/**
 * The worker's one Cron Trigger (`17 3 * * *`). Each global sweep adds itself
 * here; a failing sweep is logged and doesn't stop the others.
 */
export async function runScheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const sweeps: Array<[string, () => Promise<unknown>]> = [];
  for (const [name, sweep] of sweeps) {
    try {
      await sweep();
    } catch (error) {
      console.error(`[cron] ${name} failed`, error);
    }
  }
}
