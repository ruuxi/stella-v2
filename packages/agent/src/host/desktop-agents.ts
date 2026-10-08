/**
 * Agents on the desktop: they run on this computer, in a NodeExecutionEnv
 * per working directory. Agents placed elsewhere (the cloud, another device)
 * are refused here until this host can reach them.
 */
import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { StellaAgentsHost } from "../stella/agents.ts";
import { describePlacement, placementOf, StellaPlacementDoc } from "../stella/placement.ts";

export function desktopAgentsHost(options: { deviceId?: string } = {}): StellaAgentsHost {
  return {
    rootPlacement: { kind: "local" },
    place: (destination, caller) => {
      if (destination.kind === "here") return caller;
      // This very computer, named by its device id, is "here".
      if (destination.kind === "device" && destination.deviceId === options.deviceId) return { kind: "local" };
      return { error: `This computer cannot start an agent on ${destination.kind === "cloud" ? "the cloud" : `device ${destination.deviceId}`} yet.` };
    },
  };
}

/** One environment per working directory; agents on this computer share it. */
export function desktopEnvironments(defaultCwd: string) {
  const envs = new Map<string, NodeExecutionEnv>();
  return {
    env: async ({ conversationId, cwd, read }: EnvTarget, context: Context) => {
      const placement = placementOf(await read.snapshot(StellaPlacementDoc, conversationId, context)) ?? { kind: "local" };
      if (placement.kind !== "local") throw new Error(`This computer cannot reach ${describePlacement(placement)}.`);
      const directory = cwd ?? defaultCwd;
      let env = envs.get(directory);
      if (!env) {
        env = new NodeExecutionEnv({ cwd: directory });
        envs.set(directory, env);
      }
      return env;
    },
    cleanup: async (context: Context) => {
      for (const env of envs.values()) await env.cleanup(context);
      envs.clear();
    },
  };
}
