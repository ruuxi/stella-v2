/**
 * Built-in tool definitions.
 *
 * One file per tool under this directory exports either:
 *   - a `ToolDefinition` directly (stateless tools), or
 *   - a `createXxxTool(options)` factory returning a `ToolDefinition`
 *     (tools that need wired runtime dependencies).
 *
 * `buildBuiltinTools(options)` instantiates every built-in for a tool host.
 * The host then drops these into a single `Map<name, ToolDefinition>`
 * that drives both the catalog the model sees AND the handler dispatcher.
 *
 * No central description/schema map. No name-string lookup with a placeholder
 * fallback. If a tool isn't in the registry, the agent loop never sees it.
 */

import type { ShellState } from "../shell.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolHostOptions,
  ToolResult,
  ToolUpdateCallback,
} from "../types.js";

import { applyPatchTool } from "./apply-patch.js";
import { editTool } from "./edit.js";
import { createExecCommandTool } from "./exec-command.js";
import { grepTool } from "./grep.js";
import { createHtmlTool } from "./html.js";
import { createDriveTool } from "./drive.js";
import { createDriveTransferTools } from "./drive-transfer.js";
import { createImageGenTool } from "./image-gen.js";
import { createMapTool } from "./map.js";
import { createMultiToolUseParallelTool } from "./multi-tool-use-parallel.js";
import { createCodeTool } from "./code.js";
import { readTool } from "./read.js";
import { createAskUserTool } from "./ask-user.js";
import {
  createRequestSecureInputTool,
  createUseSecureValueTool,
} from "./secure-input.js";
import { createScheduleManageTools } from "./schedule-manage.js";
import { createScriptDraftTool } from "./script-draft.js";
import { createAgentTools } from "./task.js";
import { createConnectorStatusTool } from "./connector-status.js";
import { createSwitchDestinationTool } from "./switch-destination.js";
import { createWebTool } from "./web.js";
import { writeTool } from "./write.js";
import { createWriteStdinTool } from "./write-stdin.js";

import type { StateContext } from "../state.js";
import type { NodeReplKernelRegistry } from "../../computer-use/kernel.js";

export type BuildBuiltinToolsContext = ToolHostOptions & {
  /**
   * Resolved durable state root (`stellaDataDir`). Required here so
   * tools that persist artifacts (html, remember, script_draft) can never
   * silently fall back to the install/repo root.
   */
  stellaDataDir: string;
  /** Initialized PTY shell state shared by Bash / write_stdin. */
  shellState: ShellState;
  /** Initialized state context for the durable spawn_agent / send_message / pause_agent tools. */
  stateContext: StateContext;
  /** ToolHost-owned persistent Node kernels, disposed with the host. */
  nodeReplRegistry: NodeReplKernelRegistry;
  /**
   * Re-entrant tool dispatcher used by `multi_tool_use_parallel` to invoke
   * sibling tools. Provided by the host since the parallel tool needs a
   * reference to the same dispatcher it lives behind.
   */
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

/**
 * Construct every built-in tool for a host. The returned array order doesn't
 * matter — the host indexes them by name.
 */
export const buildBuiltinTools = (
  options: BuildBuiltinToolsContext,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // General-agent surface
  tools.push(
    createExecCommandTool(options.shellState, {
      ...(options.requestBrowserExtensionConnect
        ? {
            requestBrowserExtensionConnect:
              options.requestBrowserExtensionConnect,
          }
        : {}),
    }),
  );
  tools.push(
    createWriteStdinTool(options.shellState, {
      ...(options.requestBrowserExtensionConnect
        ? {
            requestBrowserExtensionConnect:
              options.requestBrowserExtensionConnect,
          }
        : {}),
    }),
  );
  tools.push(applyPatchTool);
  tools.push(writeTool);
  tools.push(editTool);
  tools.push(
    createCodeTool({
      registry: options.nodeReplRegistry,
    }),
  );
  tools.push(
    createImageGenTool({
      getCloudBackendAuth: options.getCloudBackendAuth,
    }),
  );
  tools.push(
    createMultiToolUseParallelTool({
      executeTool: options.executeTool,
    }),
  );
  tools.push(createAskUserTool({ askUser: options.askUser }));
  tools.push(
    createRequestSecureInputTool({
      requestSecureInput: options.requestSecureInput,
      useSecureValue: options.useSecureValue,
    }),
  );
  tools.push(
    createUseSecureValueTool({
      requestSecureInput: options.requestSecureInput,
      useSecureValue: options.useSecureValue,
    }),
  );
  tools.push(createWebTool({ webSearch: options.webSearch }));

  // Orchestrator coordination surface
  tools.push(
    createHtmlTool({
      stellaDataDir: options.stellaDataDir,
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
    }),
  );
  tools.push(
    createMapTool({
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
    }),
  );
  tools.push(...createAgentTools(options.stateContext));
  tools.push(
    createSwitchDestinationTool({
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
      ...(options.switchExecutionDestination
        ? { switchExecutionDestination: options.switchExecutionDestination }
        : {}),
    }),
  );

  // Direct scheduling surface (deferred/demoted): reminder / task / watch
  // triggers plus the sensor-script authoring tool.
  tools.push(
    ...createScheduleManageTools({ scheduleApi: options.scheduleApi }),
  );
  tools.push(
    createScriptDraftTool({
      stellaDataDir: options.stellaDataDir,
      ...(options.getStellaSiteAuth
        ? { getStellaSiteAuth: options.getStellaSiteAuth }
        : {}),
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
    }),
  );

  // (Store agent moved to backend — no local tools.)

  // Demoted orchestrator connector check + inline connect card. Surfaced
  // situationally by the connector-availability system reminder.
  tools.push(
    createConnectorStatusTool({
      stellaDataDir: options.stellaDataDir,
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
      ...(options.requestConnectorConnection
        ? { requestConnectorConnection: options.requestConnectorConnection }
        : {}),
    }),
  );

  // The owner's drive, alongside the local file surface: a file attached
  // earlier in the conversation, or saved by previous work, is reachable by
  // name from either placement rather than only where it was uploaded.
  tools.push(
    createDriveTool({
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
    }),
  );

  tools.push(
    ...createDriveTransferTools({
      ...(options.getCloudBackendAuth
        ? { getCloudBackendAuth: options.getCloudBackendAuth }
        : {}),
    }),
  );

  // Shared file/search surface.
  tools.push(readTool);
  tools.push(grepTool);

  return tools;
};
