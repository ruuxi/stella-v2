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
import { dreamTool } from "./dream.js";
import { editTool } from "./edit.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFashionControlTools } from "./fashion-control.js";
import { grepTool } from "./grep.js";
import { createHtmlTool } from "./html.js";
import { createImageGenTool } from "./image-gen.js";
import { createMapTool } from "./map.js";
import { createMultiToolUseParallelTool } from "./multi-tool-use-parallel.js";
import { createNodeReplTool } from "./node-repl.js";
import { readTool } from "./read.js";
import { createRememberTool } from "./remember.js";
import { createRequestCredentialTool } from "./request-credential.js";
import { createScheduleManageTools } from "./schedule-manage.js";
import { createScriptDraftTool } from "./script-draft.js";
import { strReplaceTool } from "./str-replace.js";
import { createAgentTools } from "./task.js";
import { createConnectorStatusTool } from "./connector-status.js";
import { createWebTool } from "./web.js";
import { writeTool } from "./write.js";
import { createWriteStdinTool } from "./write-stdin.js";

import type { StateContext } from "../state.js";
import type { NodeReplKernelRegistry } from "../../computer-use/kernel.js";

export type BuildBuiltinToolsContext = ToolHostOptions & {

  stellaDataDir: string;

  shellState: ShellState;

  stateContext: StateContext;

  nodeReplRegistry: NodeReplKernelRegistry;

  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

export const buildBuiltinTools = (
  options: BuildBuiltinToolsContext,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

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
    createNodeReplTool({
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

  tools.push(createHtmlTool({ stellaDataDir: options.stellaDataDir }));
  tools.push(createMapTool());
  tools.push(createRecallTool({ contextProvider: options.contextProvider }));
  tools.push(
    createRememberTool({
      stellaDataDir: options.stellaDataDir,
    }),
  );
  tools.push(...createAgentTools(options.stateContext));

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

  tools.push(...createFashionControlTools({ fashionApi: options.fashionApi }));

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

  tools.push(readTool);
  tools.push(grepTool);
  tools.push(strReplaceTool);
  tools.push(dreamTool);

  return tools;
};
