/**
 * Agents on the desktop: they run on this computer, in a NodeExecutionEnv
 * per working directory. In a conversation stored in the cloud, an agent
 * placed in the cloud runs there as a whole, in the conversation's object,
 * so it keeps working while this computer sleeps (`cloud`); another device
 * is refused here.
 */
import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { RemoteAgentHost, StellaAgentsHost } from "../stella/agents.ts";
import { describePlacement, placementOf, StellaPlacementDoc } from "../stella/placement.ts";

export function desktopAgentsHost(
  options: {
    deviceId?: string;
    cloud?: RemoteAgentHost;
    agentReported?: StellaAgentsHost["agentReported"];
    agentPaused?: StellaAgentsHost["agentPaused"];
    beginAgentRun?: StellaAgentsHost["beginAgentRun"];
  } = {},
): StellaAgentsHost {
  return {
    ...(options.agentReported ? { agentReported: options.agentReported } : {}),
    ...(options.agentPaused ? { agentPaused: options.agentPaused } : {}),
    ...(options.beginAgentRun ? { beginAgentRun: options.beginAgentRun } : {}),
    rootPlacement: { kind: "local" },
    place: (destination, caller) => {
      if (destination.kind === "here") return caller;
      // This very computer, named by its device id, is "here".
      if (destination.kind === "device" && destination.deviceId === options.deviceId) return { kind: "local" };
      if (destination.kind === "cloud") {
        return options.cloud
          ? { kind: "cloud" }
          : { error: "Cloud agents run in conversations stored in the cloud; this one is kept on this computer." };
      }
      return { error: `This computer cannot start an agent on device ${destination.deviceId}; ask from the cloud.` };
    },
    remote: (placement) => (placement.kind === "cloud" ? options.cloud : undefined),
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
