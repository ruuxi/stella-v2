import type { ToolContext } from "@stella/runtime/kernel/tools/types.js";
import { CLOUD_TOOL_PROCESS_IDENTITY } from "./cloud-process-isolation.js";

/**
 * The one tool context both cloud execution entry points build: the eager
 * container executor (`agent-turn.ts`) and the lazily attached tool-host
 * daemon (`attached-tool-host.ts`). Keeping it in one place is what lets a
 * single test run the runtime's real identity guard against exactly what the
 * cloud sends, so the two paths cannot drift apart in what the shell accepts.
 *
 * `toolHome` sits beside the checkpointed world, not inside it, and is owned
 * by the tool account (validated by `prepareCloudToolFilesystem` before this
 * context is used). It is therefore declared as the trusted `toolHomeRoot`.
 */
export const cloudAgentToolContext = (args: {
  threadId: string;
  workspaceRoot: string;
  workspaceStateDir: string;
  toolHome: string;
  requestId?: string;
}): ToolContext => ({
  executionHost: "sandbox",
  conversationId: args.threadId,
  deviceId: "cloud",
  requestId: args.requestId ?? crypto.randomUUID(),
  agentType: "general",
  workingDirectory: args.workspaceRoot,
  stellaAppDir: args.workspaceRoot,
  stellaDataDir: args.workspaceStateDir,
  toolWorkspaceRoot: args.workspaceRoot,
  toolHomeRoot: args.toolHome,
  storageMode: "cloud",
  toolProcessIdentity: {
    ...CLOUD_TOOL_PROCESS_IDENTITY,
    home: args.toolHome,
  },
  agentId: args.threadId,
  agentDepth: 1,
  maxAgentDepth: 1,
});
