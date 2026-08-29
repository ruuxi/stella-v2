/**
 * `write_stdin` tool — continue/poll a pipe-backed or PTY exec session.
 *
 * Pass empty `chars` to poll for more output without sending input.
 * Required: `session_id` returned by a still-running `exec_command`.
 *
 * The model-visible surface (name, description, parameters) lives in
 * `write-stdin-def.ts` so workerd hosts expose the identical tool; this file
 * adds the executable handler for tool-host consumers.
 */

import {
  maybeOfferBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../browser-extension-offer.js";
import {
  handleExecCommand,
  handleWriteStdin,
  type ShellState,
} from "../shell.js";
import type { ToolDefinition } from "../types.js";
import {
  WRITE_STDIN_TOOL_DESCRIPTION,
  WRITE_STDIN_TOOL_NAME,
  WRITE_STDIN_TOOL_PARAMETERS,
  WRITE_STDIN_TOOL_PROMPT_SNIPPET,
} from "./write-stdin-def.js";

export { WRITE_STDIN_TOOL_PARAMETERS } from "./write-stdin-def.js";

export type WriteStdinToolOptions = {
  /** See `ExecCommandToolOptions.requestBrowserExtensionConnect`. */
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
};

export const createWriteStdinTool = (
  shellState: ShellState,
  options: WriteStdinToolOptions = {},
): ToolDefinition => ({
  name: WRITE_STDIN_TOOL_NAME,
  description: WRITE_STDIN_TOOL_DESCRIPTION,
  promptSnippet: WRITE_STDIN_TOOL_PROMPT_SNIPPET,
  parameters: WRITE_STDIN_TOOL_PARAMETERS,
  execute: async (args, context, extras) => {
    const result = await handleWriteStdin(
      shellState,
      args,
      context,
      extras?.signal,
    );
    if (!options.requestBrowserExtensionConnect) return result;
    // A cold-start stella-browser failure usually outlives exec_command's
    // default yield (the daemon waits up to 60s for the extension), so the
    // "Extension not connected" error typically surfaces on a poll here
    // rather than on the original exec_command call. Same offer + re-run
    // flow, reconstructing the command from the completed session record.
    const payload = result.details;
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const command = typeof record?.command === "string" ? record.command : "";
    if (!command) return result;
    return await maybeOfferBrowserExtensionConnect({
      result,
      command,
      requestConnect: options.requestBrowserExtensionConnect,
      rerun: () =>
        handleExecCommand(
          shellState,
          {
            cmd: command,
            ...(typeof record?.cwd === "string" ? { workdir: record.cwd } : {}),
          },
          context,
          extras?.signal,
          extras?.onUpdate,
        ),
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
      signal: extras?.signal,
    });
  },
});
