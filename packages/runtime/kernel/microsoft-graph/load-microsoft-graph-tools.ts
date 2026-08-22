/**
 * Loads first-party Microsoft Graph tools (Outlook, Teams, Excel) backed by
 * the shared `native-oauth:microsoft` grant.
 *
 * IMPORTANT: this loader is intentionally NOT wired into the runtime tool
 * registration yet. Local Graph execution stays dormant behind the connector
 * readiness gate (see native-integrations `localExecution` and
 * PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS) so it never dual-executes with the
 * Composio fallback. Flip production routing only after a real connect + tool
 * call have passed against a registered Entra app.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRuntimeLogger } from "../debug.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { loadConnectorAccessToken } from "../connectors/oauth.js";
import { setMicrosoftGraphProjectRoot } from "./paths.js";
import { MICROSOFT_TOKEN_KEY } from "./constants.js";
import { MICROSOFT_GRAPH_SCOPES } from "./scopes.js";
import { MicrosoftAuthManager } from "./MicrosoftAuthManager.js";
import { GraphClient } from "./GraphClient.js";
import { OutlookService } from "./OutlookService.js";
import { TeamsService } from "./TeamsService.js";
import { ExcelService } from "./ExcelService.js";
import {
  MICROSOFT_GRAPH_TOOL_ALLOWLIST,
  toMicrosoftGraphToolRegistrationName,
  type MicrosoftGraphToolName,
} from "./tool-allowlist.js";
import { MICROSOFT_GRAPH_TOOL_METADATA } from "./microsoft-graph-tool-metadata.js";
import { formatMicrosoftGraphCallToolResult } from "./format-microsoft-graph-result.js";

const logger = createRuntimeLogger("microsoft-graph");

const AUTH_ERROR_PATTERN =
  /\bauth\b|oauth|sign[._-]?in|login|consent|credential|unauthorized|unauthenticated|reconnect|not connected|\b403\b|\b401\b/i;

export type MicrosoftGraphCallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

const buildHandlers = (
  outlook: OutlookService,
  teams: TeamsService,
  excel: ExcelService,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> => ({
  "outlook.listMessages": (args) => outlook.listMessages(args as never),
  "outlook.getMessage": (args) => outlook.getMessage(args as never),
  "outlook.sendMail": (args) => outlook.sendMail(args as never),
  "outlook.createDraft": (args) => outlook.createDraft(args as never),
  "outlook.listEvents": (args) => outlook.listEvents(args as never),
  "outlook.createEvent": (args) => outlook.createEvent(args as never),
  "teams.listJoinedTeams": () => teams.listJoinedTeams(),
  "teams.listChannels": (args) => teams.listChannels(args as never),
  "teams.listChannelMessages": (args) =>
    teams.listChannelMessages(args as never),
  "teams.sendChannelMessage": (args) =>
    teams.sendChannelMessage(args as never),
  "excel.listWorksheets": (args) => excel.listWorksheets(args as never),
  "excel.getRange": (args) => excel.getRange(args as never),
  "excel.updateRange": (args) => excel.updateRange(args as never),
  "excel.listTables": (args) => excel.listTables(args as never),
  "excel.addTableRows": (args) => excel.addTableRows(args as never),
});

export const loadMicrosoftGraphTools = async (options: {
  stellaAppDir: string;
  onAuthStateChanged?: (authenticated: boolean) => void;
}): Promise<{
  tools: ToolDefinition[];
  disconnect: () => Promise<void>;
  callTool: MicrosoftGraphCallToolFn;
  hasStoredCredentials: boolean;
}> => {
  const root = path.join(options.stellaAppDir, "microsoft-graph");
  await mkdir(root, { recursive: true, mode: 0o700 });
  setMicrosoftGraphProjectRoot(root);

  const authManager = new MicrosoftAuthManager(
    options.stellaAppDir,
    MICROSOFT_GRAPH_SCOPES,
  );
  const graph = new GraphClient({ getAccessToken: authManager.getAccessToken });
  const outlook = new OutlookService(graph);
  const teams = new TeamsService(graph);
  const excel = new ExcelService(graph);
  const handlers = buildHandlers(outlook, teams, excel);

  const callMicrosoftGraphTool: MicrosoftGraphCallToolFn = async (
    name,
    args,
  ) => {
    if (!(await loadConnectorAccessToken(options.stellaAppDir, MICROSOFT_TOKEN_KEY))) {
      options.onAuthStateChanged?.(false);
      return {
        error:
          "Microsoft is not connected. Enable Outlook / Microsoft Teams / Excel in the Store first.",
      };
    }
    try {
      const handler = handlers[name];
      if (!handler) return { error: `Unknown Microsoft Graph tool: ${name}` };
      const formatted = formatMicrosoftGraphCallToolResult(
        await handler(args),
      );
      if ("error" in formatted && AUTH_ERROR_PATTERN.test(formatted.error ?? "")) {
        options.onAuthStateChanged?.(false);
      } else if (!("error" in formatted)) {
        options.onAuthStateChanged?.(true);
      }
      return formatted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (AUTH_ERROR_PATTERN.test(message)) {
        options.onAuthStateChanged?.(false);
      }
      return { error: `Microsoft Graph tool failed: ${message}` };
    }
  };

  const toolsOut: ToolDefinition[] = [];
  for (const toolName of MICROSOFT_GRAPH_TOOL_ALLOWLIST) {
    const meta = MICROSOFT_GRAPH_TOOL_METADATA[toolName as MicrosoftGraphToolName];
    if (!meta) {
      logger.warn("microsoft_graph.missing_metadata", { toolName });
      continue;
    }
    if (!handlers[toolName]) {
      logger.warn("microsoft_graph.missing_handler", { toolName });
      continue;
    }
    const execute = async (
      executeArgs: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> => callMicrosoftGraphTool(toolName, executeArgs);
    toolsOut.push({
      name: toMicrosoftGraphToolRegistrationName(toolName),
      description: meta.description,
      agentTypes: ["general"],
      parameters: meta.parameters,
      execute,
    });
  }

  logger.info("microsoft_graph.direct.ready", {
    toolCount: toolsOut.length,
    dataRoot: root,
  });

  const disconnect = async () => {
    await authManager.clearAuth();
  };

  const hasStoredCredentials = Boolean(
    await loadConnectorAccessToken(options.stellaAppDir, MICROSOFT_TOKEN_KEY),
  );

  return {
    tools: toolsOut,
    disconnect,
    callTool: callMicrosoftGraphTool,
    hasStoredCredentials,
  };
};
