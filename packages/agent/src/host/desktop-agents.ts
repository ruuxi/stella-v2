/**
 * Agents on the desktop: they run on this computer, their tools in a
 * NodeExecutionEnv per working directory. In a conversation stored in the
 * cloud, an agent placed in the cloud runs there as a whole, in the
 * conversation's object, so it keeps working while this computer sleeps
 * (`cloud`); one placed on another of the owner's computers stays here with
 * only its tools there (`execution`), as does any conversation whose tools
 * `switch_destination` moved.
 */
import { mkdir } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defaultAgentDirectory } from "@stella/runtime/kernel/agents/agent-directory";
import type { RemoteAgentHost, StellaAgentsHost } from "../stella/agents.ts";

export function desktopAgentsHost(
  options: {
    deviceId?: string;
    cloud?: RemoteAgentHost;
    agentReported?: StellaAgentsHost["agentReported"];
    agentPaused?: StellaAgentsHost["agentPaused"];
    beginAgentRun?: StellaAgentsHost["beginAgentRun"];
    ensureModel?: StellaAgentsHost["ensureModel"];
    /** Reports and notes for Stella, which go where she runs. */
    deliverReport?: StellaAgentsHost["deliverReport"];
    deliverNote?: StellaAgentsHost["deliverNote"];
    directory?: StellaAgentsHost["directory"];
    /** The Stella data directory (`~/.stella`): new agents start in a folder of their own under it. */
    dataDir?: string;
    /** Where a conversation's tools can run away from this computer. */
    execution?: StellaAgentsHost["execution"];
  } = {},
): StellaAgentsHost {
  return {
    ...(options.agentReported ? { agentReported: options.agentReported } : {}),
    ...(options.agentPaused ? { agentPaused: options.agentPaused } : {}),
    ...(options.beginAgentRun ? { beginAgentRun: options.beginAgentRun } : {}),
    ...(options.ensureModel ? { ensureModel: options.ensureModel } : {}),
    ...(options.deliverReport ? { deliverReport: options.deliverReport } : {}),
    ...(options.deliverNote ? { deliverNote: options.deliverNote } : {}),
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.dataDir ? { agentDirectory: (threadId: string) => defaultAgentDirectory(options.dataDir!, threadId) } : {}),
    ...(options.execution ? { execution: options.execution } : {}),
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
      if (destination.kind === "device" && !destination.whole && options.execution && !options.execution.localOnly) {
        return { kind: "device", deviceId: destination.deviceId };
      }
      return {
        error: destination.whole
          ? `This computer cannot start a whole agent on device ${destination.deviceId}. Leave out whole_agent: the agent then stays here and runs its tools there.`
          : `This chat is stored only on this computer, so its agents can only run here.`,
      };
    },
    remote: (placement) => (placement.kind === "cloud" ? options.cloud : undefined),
  };
}

/** One environment per working directory; agents on this computer share it. */
export function desktopEnvironments(defaultCwd: string) {
  const envs = new Map<string, NodeExecutionEnv>();
  return {
    env: async ({ cwd }: EnvTarget, _context: Context) => {
      // A conversation whose tools run elsewhere reaches them through its
      // tools (`desktopCoding`); its prompt still reads this one.
      const directory = cwd ?? defaultCwd;
      let env = envs.get(directory);
      if (!env) {
        // An agent's own folder exists once it first works there.
        if (cwd) await mkdir(directory, { recursive: true }).catch(() => undefined);
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
