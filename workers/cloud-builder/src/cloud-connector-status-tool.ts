/**
 * `connector_status` for the cloud orchestrator — the device tool's exact
 * model-visible surface (see `defs/connector-status-def.ts`) over the
 * account's Store integrations.
 *
 * Same contract as the device: pure lookup plus the inline connect card,
 * blocking until the user connects, declines, or the card times out. The
 * card itself is delivered through the conversation (the Durable Object
 * publishes a pending connect request the clients render), and the user's
 * answer resolves the same account-level Composio connection the desktop
 * app would have made.
 */

import type { TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import {
  CONNECTOR_STATUS_SEARCH_TERMS,
  CONNECTOR_STATUS_TOOL_DESCRIPTION,
  CONNECTOR_STATUS_TOOL_LABEL,
  CONNECTOR_STATUS_TOOL_NAME,
  CONNECTOR_STATUS_TOOL_PARAMETERS,
  CONNECTOR_STATUS_TOOL_WORKING_TEXT,
} from "@stella/runtime/kernel/tools/defs/connector-status-def.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import {
  resolveCloudConnectorEntry,
  type CloudConnectorCatalogEntry,
  type CloudConnectorDeclines,
  type CloudConnectorDirectory,
} from "./cloud-connect-client.js";

export type CloudConnectorConnectionRequest = Readonly<{
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
}>;

export type CloudConnectorConnectionOutcome =
  | Readonly<{ ok: true; status: "connected" | "already_connected" }>
  | Readonly<{
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    }>;

/** The cloud hop that renders the inline connect card and awaits the answer. */
export type CloudConnectorConnectionRequester = (
  request: CloudConnectorConnectionRequest,
  signal?: AbortSignal,
) => Promise<CloudConnectorConnectionOutcome>;

export type CloudConnectorStatusToolOptions = Readonly<{
  directory: CloudConnectorDirectory;
  declines?: CloudConnectorDeclines;
  requestConnection?: CloudConnectorConnectionRequester;
}>;

const text = (value: string, details: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  details,
  ...(isError ? { isError: true } : {}),
});

const diagnosticsFor = (
  entry: CloudConnectorCatalogEntry,
  connected: boolean,
) => ({
  id: entry.id,
  catalogSource: "live" as const,
  provider: "backend-composio" as const,
  enabled: connected,
  providerStatus: connected ? "connected" : "not_connected",
  accountVerified: connected,
  toolCount: entry.catalogToolCount,
  executable: connected,
});

export const createCloudConnectorStatusTool = (
  options: CloudConnectorStatusToolOptions,
): CloudCodeSourceAgentTool => ({
  name: CONNECTOR_STATUS_TOOL_NAME,
  label: CONNECTOR_STATUS_TOOL_LABEL,
  workingText: CONNECTOR_STATUS_TOOL_WORKING_TEXT,
  description: CONNECTOR_STATUS_TOOL_DESCRIPTION,
  parameters: CONNECTOR_STATUS_TOOL_PARAMETERS as unknown as TSchema,
  demoted: { searchTerms: CONNECTOR_STATUS_SEARCH_TERMS },
  execute: async (_toolCallId, params, signal) => {
    const args = params as { connector?: unknown; reason?: unknown };
    const query =
      typeof args.connector === "string" ? args.connector.trim() : "";
    if (!query) {
      return text("connector is required (id or name).", {}, true);
    }
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : undefined;

    const catalog = await options.directory.catalog();
    const { entry, suggestions } = resolveCloudConnectorEntry(catalog, query);
    if (!entry) {
      const hint =
        suggestions.length > 0
          ? ` Closest matches: ${suggestions
              .map((candidate) => `${candidate.name} (\`${candidate.id}\`)`)
              .join(", ")}.`
          : "";
      return text(
        `No Store connector matched "${query}".${hint} If no connector fits, proceed via the browser/computer fallback.`,
        {},
        true,
      );
    }

    const connected = await options.directory.isConnected(entry.id, {
      refresh: true,
    });
    const diagnostics = diagnosticsFor(entry, connected);
    if (connected) {
      return text(
        `${entry.name} is connected and exposes ${entry.catalogToolCount} executable tool${entry.catalogToolCount === 1 ? "" : "s"} (integration id \`${entry.id}\`, catalog: live, provider: backend-composio). The provider account is connected. Agents use it inside code: \`await connect.actions("${entry.id}")\` to inspect, \`await connect.call("${entry.id}", …)\` to run.`,
        { ...diagnostics, status: "executable" },
      );
    }

    if (entry.catalogToolCount === 0) {
      return text(
        `${entry.name} exists, but its Store catalog entry exposes no executable tools. It is not ready to use.`,
        { ...diagnostics, status: "not_executable" },
      );
    }

    if (await options.declines?.isDeclined(entry.id)) {
      return text(
        `The user previously declined connecting ${entry.name}, so no connect card was shown. If it comes up, mention once — concisely — that they can connect ${entry.name} from the Store whenever they like, then proceed by other means (agents fall back to the browser). Do not offer again.`,
        { id: entry.id, status: "declined", reason: "declined_previously" },
      );
    }

    if (!options.requestConnection) {
      return text(
        `${entry.name} exists in the catalog and cannot be connected from here (its connect flow isn't available in this session). It is not ready to use; proceed via the browser/computer fallback or the Store.`,
        { ...diagnostics, status: "not_connected", reason: "flow_unavailable" },
      );
    }

    const outcome = await options.requestConnection(
      {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
        category: entry.category,
        ...(reason ? { reason } : {}),
      },
      signal,
    );

    if (outcome.ok) {
      // The connect card resolved an account-level connection; the
      // directory's connection snapshot for this turn is now stale.
      await options.directory.connections({ refresh: true }).catch(() => []);
      return text(
        `${entry.name} is now connected — the user approved the connect card. Continue the original task immediately (do not re-ask what they wanted); agents use it inside code via \`await connect.call("${entry.id}", …)\`.`,
        { id: entry.id, status: "connected" },
      );
    }
    if (outcome.reason === "declined") {
      await options.declines?.recordDecline(entry.id).catch(() => undefined);
      return text(
        `The user declined connecting ${entry.name}. Tell them once — concisely — that they can always connect it from the Store later, then proceed with the task by other means (the executing agent can use the browser). Do not offer ${entry.name} again.`,
        { id: entry.id, status: "declined" },
      );
    }
    if (outcome.reason === "cancelled" && signal?.aborted) {
      return text(
        `The turn was cancelled before the user answered the ${entry.name} connect card.`,
        { id: entry.id, status: "not_connected", reason: "turn_cancelled" },
      );
    }
    if (outcome.reason === "cancelled" || outcome.reason === "timeout") {
      return text(
        `The connect card for ${entry.name} was ${outcome.reason === "timeout" ? "not answered in time" : "dismissed"} — the user neither connected nor declined. Don't re-offer it for now; mention once that ${entry.name} is available in the Store, and proceed via other means (browser fallback).`,
        {
          id: entry.id,
          status: "not_connected",
          reason: outcome.reason === "timeout" ? "timeout" : "dismissed",
        },
      );
    }
    return text(
      `Could not run the ${entry.name} connect flow: ${outcome.reason}. It is not connected. Proceed via the browser/computer fallback.`,
      { id: entry.id, status: "not_connected", reason: outcome.reason },
      true,
    );
  },
});
