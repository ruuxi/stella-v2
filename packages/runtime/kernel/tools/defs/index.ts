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
import { createRecallTool } from "./recall.js";
import { editTool } from "./edit.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFashionControlTools } from "./fashion-control.js";
import { grepTool } from "./grep.js";
import { createHtmlTool } from "./html.js";
import { createImageGenTool } from "./image-gen.js";
import { createMapTool } from "./map.js";
import { createMultiToolUseParallelTool } from "./multi-tool-use-parallel.js";
import { createCodeTool } from "./code.js";
import { readTool } from "./read.js";
import { createRememberTool } from "./remember.js";
import { createRequestCredentialTool } from "./request-credential.js";
import { createScheduleManageTools } from "./schedule-manage.js";
import { createScriptDraftTool } from "./script-draft.js";
import { createAgentTools } from "./task.js";
import { createConnectorStatusTool } from "./connector-status.js";
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
  /** Initialized PTY shell state shared by exec_command / write_stdin. */
  shellState: ShellState;
  /** Initialized state context for the durable spawn_agent / send_input / pause_agent tools. */
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
      getStellaSiteAuth: options.getStellaSiteAuth,
    }),
  );
  tools.push(
    createMultiToolUseParallelTool({
      executeTool: options.executeTool,
    }),
  );
  tools.push(
    createRequestCredentialTool({
      requestCredential: options.requestCredential,
    }),
  );
  tools.push(createWebTool({ webSearch: options.webSearch }));

  // Orchestrator coordination surface
  tools.push(createHtmlTool({ stellaDataDir: options.stellaDataDir }));
  tools.push(createMapTool());
  tools.push(createRecallTool({ contextProvider: options.contextProvider }));
  tools.push(
    createRememberTool({
      stellaDataDir: options.stellaDataDir,
    }),
  );
  tools.push(...createAgentTools(options.stateContext));

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
    }),
  );

  // (Store agent moved to backend — no local tools.)

  // Fashion subagent surface
  tools.push(...createFashionControlTools({ fashionApi: options.fashionApi }));

  // Demoted orchestrator connector check + inline connect card. Surfaced
  // situationally by the connector-availability system reminder.
  tools.push(
    createConnectorStatusTool({
      stellaDataDir: options.stellaDataDir,
      ...(options.getStellaSiteAuth
        ? { getStellaSiteAuth: options.getStellaSiteAuth }
        : {}),
      ...(options.requestConnectorConnection
        ? { requestConnectorConnection: options.requestConnectorConnection }
        : {}),
    }),
  );

  // Shared file/search surface.
  tools.push(readTool);
  tools.push(grepTool);

  return tools;
};
