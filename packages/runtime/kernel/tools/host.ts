import path from "node:path";
import { AGENT_IDS, getAgentDefinition } from "@stella/contracts/agent-runtime";

import type { Api, Model } from "../../ai/types.js";
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  type FileEditAgentEngine,
  getFileEditToolFamily,
  WRITE_TOOL_NAME,
} from "./file-edit-policy.js";
import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolMetadata,
  ToolHostOptions,
  ToolResult,
} from "./types.js";

import { log, logError, recoverStaleSecretFiles } from "./utils.js";
import {
  createShellState,
  drainCompletedProducedFiles,
  listRunningShellSessionsOwnedBy,
  readShellExitSnapshot,
  watchShellExit,
  type ShellState,
} from "./shell.js";
import { createStateContext, type StateContext } from "./state.js";
import { joinWithTimeout } from "../shared/join-timeout.js";
import {
  createShellToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { buildBuiltinTools } from "./defs/index.js";
import { AGENT_ORCHESTRATION_TOOL_NAMES } from "./defs/task.js";
import type { ToolDefinition as BuiltinToolDefinition } from "./types.js";
import { sanitizeToolError, sanitizeToolResult } from "./safety.js";
import { searchToolCatalog } from "./code-catalog.js";
import {
  NODE_REPL_EXCLUDED_TOOL_NAMES,
  NodeReplKernelRegistry,
} from "../computer-use/kernel.js";
import {
  createMacComputerUseSession,
  shutdownMacStellaComputerSession,
} from "../computer-use/stella-computer-executor.js";
import { createWindowsComputerUseSession } from "../computer-use/windows-session.js";
import { cleanupWindowsStellaComputerSessionDaemon } from "../cli/stella-computer-windows.js";
import { createReplConnectClient } from "../connectors/connect-service.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

const isReservedToolName = (name: string): boolean => name.startsWith("$");

const isAgentAllowedForTool = (
  tool: { agentTypes?: readonly string[] },
  agentType: string | undefined,
): boolean => {
  if (!tool.agentTypes || tool.agentTypes.length === 0) return true;
  if (!agentType) return false;
  return tool.agentTypes.includes(agentType);
};

const isOrchestrationToolWithheld = (
  toolName: string,
  parentOwned: boolean | undefined,
): boolean =>
  parentOwned === true && AGENT_ORCHESTRATION_TOOL_NAMES.includes(toolName);

export const collectReplSearchableTools = (
  tools: Iterable<ToolMetadata>,
  context: ToolContext,
): ToolMetadata[] => {
  const allowedNames = new Set(context.allowedToolNames ?? []);
  const connectorProvider = context.connectorDeliveryTarget?.provider;
  const reachable: ToolMetadata[] = [];
  for (const tool of tools) {
    if (NODE_REPL_EXCLUDED_TOOL_NAMES.has(tool.name)) continue;
    if (!allowedNames.has(tool.name)) continue;
    if (!isAgentAllowedForTool(tool, context.agentType)) continue;
    if (
      isOrchestrationToolWithheld(tool.name, Boolean(context.parentAgentId))
    ) {
      continue;
    }
    const requiredProvider = tool.demoted?.requiredConnectorProvider;
    if (requiredProvider && requiredProvider !== connectorProvider) {
      continue;
    }
    reachable.push(tool);
  }
  return reachable;
};

export const createToolHost = ({
  stellaAppDir,
  stellaDataDir,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaComputerCliPath,
  stellaMediaCliPath,
  stellaXApiCliPath,
  cliBridgeSocketPath,
  requestCredential,
  requestBrowserExtensionConnect,
  requestConnectorConnection,
  agentApi,
  validateSpawnModel,
  validateSpawnModelWithMetadata,
  captureSpawnModelConfig,
  scheduleApi,

  fashionApi,
  extensionTools,
  webSearch,
  getStellaSiteAuth,
  queryConvex,
  actionConvex,
  contextProvider,
}: ToolHostOptions) => {
  const stateRoot = stellaDataDir ?? stellaAppDir;
  const toolCatalog = new Map<string, ToolMetadata>();

  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    getStellaSiteAuth,
    cliBridgeSocketPath,
  });
  const stateContext: StateContext = createStateContext(
    stateRoot,
    agentApi,
    validateSpawnModel,
    validateSpawnModelWithMetadata,
    captureSpawnModelConfig,
  );
  let executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => Promise<ToolResult>;
  const nodeReplRegistry = new NodeReplKernelRegistry({
    browserBinPath: _stellaBrowserBinPath,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    sessionFactory: ({ sessionId, getSignal, timeoutMs }) => {
      if (process.platform === "win32") {
        return createWindowsComputerUseSession();
      }
      if (process.platform === "darwin") {
        return createMacComputerUseSession({
          sessionId,
          getSignal,
          commandTimeoutMs: timeoutMs,
          ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
        });
      }
      throw new Error(
        `Typed Computer Use is not available on ${process.platform}.`,
      );
    },
    disposeSession: async (sessionId) => {
      if (process.platform === "win32") {
        await cleanupWindowsStellaComputerSessionDaemon(sessionId);
      } else {
        shutdownMacStellaComputerSession(sessionId);
      }
    },
    executeTool: (toolName, args, context, signal, onUpdate) =>
      executeTool(toolName, args, context, signal, onUpdate),

    searchTools: (query, context, limit) =>
      searchToolCatalog(
        collectReplSearchableTools(toolCatalog.values(), context),
        query,
        limit,
      ),

    connectClient: createReplConnectClient({
      stellaAppDir: stateRoot,
      ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
      onBridgeUnreachable: (message) =>
        logError("node_repl connect bridge unreachable", message),
    }),
  });

  void recoverStaleSecretFiles(stateRoot)
    .then((result) => {
      if (result.recovered > 0 || result.skipped > 0) {
        log("Recovered stale secret mounts", result);
      }
    })
    .catch((error) => {
      logError("Failed to recover stale secret mounts", error);
    });

  const handlers: Record<string, ToolHandler> = mergeToolHandlers(
    createShellToolHandlers(shellState),
  );

  const builtinTools: BuiltinToolDefinition[] = buildBuiltinTools({
    stellaAppDir,
    stellaDataDir: stateRoot,
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    requestCredential,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    ...(requestConnectorConnection ? { requestConnectorConnection } : {}),
    agentApi,
    scheduleApi,

    fashionApi,
    extensionTools,
    webSearch,
    getStellaSiteAuth,
    queryConvex,
    actionConvex,
    contextProvider,
    shellState,
    stateContext,
    nodeReplRegistry,
    executeTool: (toolName, toolArgs, context, signal, onUpdate) =>
      executeTool(toolName, toolArgs, context, signal, onUpdate),
  });

  const builtinToolNames = new Set<string>();
  for (const tool of builtinTools) {
    if (isReservedToolName(tool.name)) {
      throw new Error(
        `Built-in tool "${tool.name}" uses a reserved "$"-prefixed name; "$" names belong to Node REPL intrinsics like tools.$search.`,
      );
    }
    toolCatalog.set(tool.name, {
      name: tool.name,
      ...(tool.label ? { label: tool.label } : {}),
      ...(tool.workingText ? { workingText: tool.workingText } : {}),
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.demoted ? { demoted: tool.demoted } : {}),
      ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
    });
    handlers[tool.name] = (args, context, extras) =>
      tool.execute(args, context, extras);
    builtinToolNames.add(tool.name);
  }

  const acceptedStartupExtensionTools = (extensionTools ?? []).filter(
    (tool) => {
      if (isReservedToolName(tool.name)) {
        logError(
          `Extension tool "${tool.name}" uses a reserved "$"-prefixed name; skipping registration. "$" names belong to Node REPL intrinsics like tools.$search.`,
        );
        return false;
      }
      if (builtinToolNames.has(tool.name)) {
        logError(
          `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
        );
        return false;
      }
      return true;
    },
  );
  registerExtensionToolHandlers(handlers, acceptedStartupExtensionTools);
  for (const tool of acceptedStartupExtensionTools) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      ...(tool.label ? { label: tool.label } : {}),
      ...(tool.workingText ? { workingText: tool.workingText } : {}),
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.demoted ? { demoted: tool.demoted } : {}),
      ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
    });
  }

  executeTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => {
    const extras: ToolHandlerExtras = {
      ...(signal ? { signal } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    };
    log(`Executing tool: ${toolName}`, {
      args: toolArgs,
      context,
    });

    if (isOrchestrationToolWithheld(toolName, Boolean(context.parentAgentId))) {
      return {
        error: `${toolName} is not available to a subagent. Complete the work in this task and report the result to the agent that started you.`,
      };
    }

    const catalogEntry = toolCatalog.get(toolName);
    if (
      catalogEntry &&
      !isAgentAllowedForTool(catalogEntry, context.agentType)
    ) {
      const allowed = catalogEntry.agentTypes ?? [];

      const formatAllowedAgent = (id: string): string => {
        if (id === AGENT_IDS.ORCHESTRATOR) return "the orchestrator";
        const def = getAgentDefinition(id);
        return def?.name ? `the ${def.name} agent` : `the ${id} agent`;
      };
      const formatted =
        allowed.length === 1
          ? formatAllowedAgent(allowed[0]!)
          : allowed.map(formatAllowedAgent).join(", ");
      return {
        error: `${toolName} is only available to ${formatted}.`,
      } satisfies ToolResult;
    }

    const handler = handlers[toolName];
    if (!handler) {
      const available = Object.keys(handlers);
      logError(`Unknown tool: ${toolName}. Available tools:`, available);
      return { error: `Unknown tool: ${toolName}` } satisfies ToolResult;
    }

    const startedAt = Date.now();
    try {
      const result = sanitizeToolResult(
        await handler(toolArgs, context, extras),
      );
      const duration = Date.now() - startedAt;
      log(`Tool ${toolName} completed in ${duration}ms`, {
        hasResult: "result" in result,
        hasError: "error" in result,
        resultPreview: result.error
          ? result.error.slice(0, 500)
          : typeof result.result === "string"
            ? result.result.slice(0, 500)
            : "(non-string result)",
      });
      return result;
    } catch (error) {
      const duration = Date.now() - startedAt;
      logError(`Tool ${toolName} threw after ${duration}ms:`, error);
      return {
        error: sanitizeToolError(
          `Tool ${toolName} failed: ${(error as Error).message}`,
        ),
      };
    }
  };

  const killAllShells = () => {
    for (const shell of shellState.shells.values()) {
      if (shell.running) shell.kill();
    }
  };

  const killShellsByPort = (port: number) => {
    const portStr = String(port);
    for (const shell of shellState.shells.values()) {
      if (shell.running && shell.command.includes(portStr)) {
        shell.kill();
      }
    }
  };

  const killShell = async (sessionId: string) => {
    const shell = shellState.shells.get(sessionId);
    if (!shell) return;
    if (shell.running) {
      shell.kill();
    }
    const deadline = Date.now() + 1_500;
    while (shell.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const exits: Array<Promise<void>> = [];
      for (const shell of shellState.shells.values()) {
        if (!shell.running) continue;
        exits.push(
          new Promise<void>((resolve) => {
            const dispose = watchShellExit(shellState, shell.id, () => {
              dispose();
              resolve();
            });
          }),
        );
      }
      killAllShells();
      if (exits.length > 0) {
        const joined = await joinWithTimeout(Promise.allSettled(exits), 3_000);
        if (joined === "timeout") {
          console.warn(
            "[tool-host] shell teardown exceeded the shutdown bound; SIGKILL was already dispatched",
          );
        }
      }
      await nodeReplRegistry.dispose();
    })();
    return shutdownPromise;
  };

  const getToolCatalog = (
    agentType?: string,
    options?: {
      model?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
      agentEngine?: FileEditAgentEngine;

      parentOwned?: boolean;
    },
  ) => {
    const fileEditToolFamily = getFileEditToolFamily({
      agentType,
      model: options?.model,
      agentEngine: options?.agentEngine,
    });
    return Array.from(toolCatalog.values()).filter((tool) => {

      if (!isAgentAllowedForTool(tool, agentType)) return false;
      if (isOrchestrationToolWithheld(tool.name, options?.parentOwned)) {
        return false;
      }

      if (
        fileEditToolFamily === "write_edit" &&
        tool.name === APPLY_PATCH_TOOL_NAME
      ) {
        return false;
      }
      if (
        fileEditToolFamily === "apply_patch" &&
        (tool.name === WRITE_TOOL_NAME || tool.name === EDIT_TOOL_NAME)
      ) {
        return false;
      }
      return true;
    });
  };

  const extensionToolNames = new Set<string>();

  return {
    executeTool,
    getToolCatalog,
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),

    listRunningShellSessionIds: (sessionIds?: string[]) => {
      const scope = sessionIds ? new Set(sessionIds) : null;
      const running: string[] = [];
      for (const shell of shellState.shells.values()) {
        if (!shell.running) continue;
        if (scope && !scope.has(shell.id)) continue;
        running.push(shell.id);
      }
      return running;
    },

    listRunningShellSessionsOwnedBy: (agentId: string) =>
      listRunningShellSessionsOwnedBy(shellState, agentId),

    watchShellExit: (sessionId: string, listener: () => void) =>
      watchShellExit(shellState, sessionId, listener),

    readShellExitSnapshot: (sessionId: string) =>
      readShellExitSnapshot(shellState, sessionId),

    drainCompletedShellProducedFiles: (sessionIds?: string[]) =>
      drainCompletedProducedFiles(shellState, sessionIds),

    endBrowserTurn: (
      runId: string,
      behavior: import("../browser-use/client.js").BrowserTurnEndBehavior,
    ) => nodeReplRegistry.endBrowserTurn(runId, behavior),
    killAllShells,
    killShell,
    killShellsByPort,
    shutdown,
    registerExtensionTools: (tools: ToolDefinition[]) => {

      const accepted: ToolDefinition[] = [];
      for (const tool of tools) {
        if (isReservedToolName(tool.name)) {
          logError(
            `Extension tool "${tool.name}" uses a reserved "$"-prefixed name; skipping registration. "$" names belong to Node REPL intrinsics like tools.$search.`,
          );
          continue;
        }
        if (builtinToolNames.has(tool.name)) {
          logError(
            `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
          );
          continue;
        }
        accepted.push(tool);
      }
      registerExtensionToolHandlers(handlers, accepted);
      for (const tool of accepted) {
        toolCatalog.set(tool.name, {
          name: tool.name,
          ...(tool.label ? { label: tool.label } : {}),
          ...(tool.workingText ? { workingText: tool.workingText } : {}),
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.demoted ? { demoted: tool.demoted } : {}),
          ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
        });
        extensionToolNames.add(tool.name);
      }
    },

    unregisterExtensionTools: () => {
      for (const name of extensionToolNames) {
        toolCatalog.delete(name);
        delete handlers[name];
      }
      extensionToolNames.clear();
    },
  };
};
