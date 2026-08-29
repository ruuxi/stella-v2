/**
 * `exec_command` tool — shell execution for Stella agents, with opt-in PTY.
 *
 * Returns immediate output, or a `session_id` when the process is still
 * running so the model can poll / interact via `write_stdin`.
 *
 * The model-visible surface (name, description, parameters) lives in
 * `exec-command-def.ts` so workerd hosts expose the identical tool; this file
 * adds the executable handler for tool-host consumers.
 */

import {
  maybeOfferBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../browser-extension-offer.js";
import { handleExecCommand, type ShellState } from "../shell.js";
import type { ToolDefinition } from "../types.js";
import {
  EXEC_COMMAND_TOOL_DESCRIPTION,
  EXEC_COMMAND_TOOL_NAME,
  EXEC_COMMAND_TOOL_PARAMETERS,
  EXEC_COMMAND_TOOL_PROMPT_SNIPPET,
} from "./exec-command-def.js";

export { EXEC_COMMAND_TOOL_PARAMETERS } from "./exec-command-def.js";

export type ExecCommandToolOptions = {
  /**
   * Desktop hop that renders the inline "connect the Stella browser
   * extension" card in the chat and resolves when the user connects,
   * declines, or the card times out. When omitted, extension-bridge
   * failures surface as plain command output.
   */
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
};

export const createExecCommandTool = (
  shellState: ShellState,
  options: ExecCommandToolOptions = {},
): ToolDefinition => ({
  name: EXEC_COMMAND_TOOL_NAME,
  description: EXEC_COMMAND_TOOL_DESCRIPTION,
  promptSnippet: EXEC_COMMAND_TOOL_PROMPT_SNIPPET,
  parameters: EXEC_COMMAND_TOOL_PARAMETERS,
  execute: async (args, context, extras) => {
    const run = () =>
      handleExecCommand(
        shellState,
        args,
        context,
        extras?.signal,
        extras?.onUpdate,
      );
    const result = await run();
    const command = typeof args.cmd === "string" ? args.cmd : "";
    if (!command || !options.requestBrowserExtensionConnect) return result;
    // stella-browser dead-ends on a missing Chrome extension. Offer the
    // inline connect card and, once the user connects, re-run the exact
    // command so the agent continues transparently.
    return await maybeOfferBrowserExtensionConnect({
      result,
      command,
      requestConnect: options.requestBrowserExtensionConnect,
      rerun: run,
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
      signal: extras?.signal,
    });
  },
});
