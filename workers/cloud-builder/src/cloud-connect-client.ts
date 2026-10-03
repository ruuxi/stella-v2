/**
 * Host-side `connect` client for the cloud orchestrator's code sandbox.
 *
 * Same surface as the device kernel's `connect` (see
 * `connectors/connect-worker-api.ts`), backed by the Store's Composio
 * integrations: the global catalog in D1 and the owner object's
 * `integrations.*` internals, instead of a local catalog cache and CLI
 * bridge. Connectors belong to the account, not the device, so a service
 * connected anywhere is usable here.
 *
 * Custom MCP/API connectors (`addMcp`/`remove`) are device-local — stdio
 * processes, generated skills, on-disk credentials — and stay that way.
 */

import {
  scoreConnectorMatch,
  tokenizeConnectorQuery,
} from "@stella/runtime/kernel/connectors/discovery-score.js";
import {
  redactSensitiveText,
  sanitizeSensitiveData,
} from "@stella/contracts/sensitive-data";
import type {
  IntegrationActionsPage,
  IntegrationCatalogEntry,
} from "@stella/contracts/backend/integrations";
import type { CloudConnectClient } from "./cloud-code-tool.js";
import { RpcError } from "./owner-store/errors.js";

/** Persisted per-conversation memory of connect offers the user declined. */
export type CloudConnectorDeclines = Readonly<{
  isDeclined(id: string): Promise<boolean>;
  recordDecline(id: string): Promise<void>;
}>;

/**
 * Where the directory reads: the global catalog (D1) and the owner's
 * connections and runs (the owner object's `integrations.*` internals).
 */
export type CloudConnectorSource = Readonly<{
  catalog(): Promise<readonly IntegrationCatalogEntry[]>;
  actions(args: {
    id: string;
    action?: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<IntegrationActionsPage | null>;
  connections(): Promise<{ connections: ReadonlyArray<{ id: string; connected: boolean }> }>;
  run(args: {
    id: string;
    action: string;
    input: Record<string, unknown>;
    requestId: string;
  }): Promise<unknown>;
}>;

export type CloudConnectClientContext = Readonly<{
  source: CloudConnectorSource;
  declines?: CloudConnectorDeclines;
}>;

export type CloudConnectorCatalogEntry = Readonly<{
  id: string;
  name: string;
  category: string;
  description: string;
  iconUrl?: string;
  sourceUrl?: string;
  catalogToolCount: number;
  toolkit: string;
}>;

export type CloudConnectorConnection = Readonly<{
  id: string;
  connected: boolean;
}>;

const DISCOVER_MAX_MATCHES = 8;
const ACTIONS_DEFAULT_LIMIT = 25;
const ACTIONS_MAX_LIMIT = 100;
/** The catalog's largest action page. */
const ACTIONS_PAGE_LIMIT = 100;
const SAFE_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ACTION = /^[A-Z][A-Z0-9_]{1,127}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const collapseLine = (value: string | undefined, max = 140): string => {
  const collapsed = (value ?? "").replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
};

/**
 * Compact one-line parameter summary for an action's input schema
 * ("required: a, b; optional: c, d, +3"), byte-identical to the device
 * client's rendering so the model reads one format.
 */
const summarizeActionParams = (schema?: Record<string, unknown>): string => {
  if (!schema) return "";
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const propertyNames = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  if (propertyNames.length === 0 && required.length === 0) return "";
  const requiredSet = new Set(required);
  const optional = propertyNames.filter((name) => !requiredSet.has(name));
  const renderNames = (names: readonly string[]) =>
    `${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6}` : ""}`;
  const parts: string[] = [];
  if (required.length > 0) parts.push(`required: ${renderNames(required)}`);
  if (optional.length > 0) parts.push(`optional: ${renderNames(optional)}`);
  return parts.join("; ");
};

const clampActionLimit = (limit: unknown): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return ACTIONS_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(ACTIONS_MAX_LIMIT, Math.floor(limit)));
};

const sourceErrorMessage = (error: unknown, fallback: string): string =>
  redactSensitiveText(
    error instanceof Error && error.message.trim()
      ? error.message.slice(0, 1_000)
      : fallback,
  );

type ActionRecord = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const readActionRecord = (value: unknown): ActionRecord | null => {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema } : {}),
  };
};

export const readCloudConnectorCatalogEntry = (
  value: unknown,
): CloudConnectorCatalogEntry | null => {
  if (!isRecord(value)) return null;
  const connector = isRecord(value.connector) ? value.connector : null;
  if (connector?.type !== "composio") return null;
  const id = typeof value.id === "string" ? value.id.trim().toLowerCase() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  const toolkit =
    typeof connector.toolkit === "string"
      ? connector.toolkit.trim().toUpperCase()
      : "";
  if (!id || !name || !description || !toolkit) return null;
  return {
    id,
    name,
    description,
    toolkit,
    category:
      typeof value.category === "string" && value.category.trim()
        ? value.category.trim()
        : "integrations",
    catalogToolCount:
      typeof value.catalogToolCount === "number" ? value.catalogToolCount : 0,
    ...(typeof value.iconUrl === "string" && value.iconUrl.trim()
      ? { iconUrl: value.iconUrl.trim() }
      : {}),
    ...(typeof value.sourceUrl === "string" && value.sourceUrl.trim()
      ? { sourceUrl: value.sourceUrl.trim() }
      : {}),
  };
};

/**
 * Resolve a connector id or display name against the catalog the way the
 * device `connector_status` tool does: exact id/name first, then the shared
 * scorer with the same acceptance threshold.
 */
export const resolveCloudConnectorEntry = (
  catalog: readonly CloudConnectorCatalogEntry[],
  query: string,
): {
  entry: CloudConnectorCatalogEntry | null;
  suggestions: CloudConnectorCatalogEntry[];
} => {
  const normalized = query.trim().toLowerCase();
  const exact = catalog.find(
    (entry) =>
      entry.id === normalized || entry.name.trim().toLowerCase() === normalized,
  );
  if (exact) return { entry: exact, suggestions: [] };
  const tokens = tokenizeConnectorQuery(query);
  const ranked = catalog
    .map((entry) => ({ entry, score: scoreConnectorMatch(tokens, entry) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 0 && ranked[0]!.score >= 20) {
    return { entry: ranked[0]!.entry, suggestions: [] };
  }
  return {
    entry: null,
    suggestions: ranked.slice(0, 3).map(({ entry }) => entry),
  };
};

/**
 * The account's connector state for one turn: the Store catalog plus the
 * owner's live connections. Both are memoized per turn; `connect.call` and
 * `connector_status` re-read connections after a connect card resolves.
 */
export class CloudConnectorDirectory {
  #catalog: Promise<readonly CloudConnectorCatalogEntry[]> | undefined;
  #connections: Promise<readonly CloudConnectorConnection[]> | undefined;
  readonly #context: CloudConnectClientContext;

  constructor(context: CloudConnectClientContext) {
    this.#context = context;
  }

  catalog(): Promise<readonly CloudConnectorCatalogEntry[]> {
    return (this.#catalog ??= (async () => {
      const entries = await this.#context.source.catalog();
      return Object.freeze(
        entries
          .map(readCloudConnectorCatalogEntry)
          .filter(
            (entry): entry is CloudConnectorCatalogEntry => entry !== null,
          ),
      );
    })().catch((error) => {
      this.#catalog = undefined;
      throw new Error(sourceErrorMessage(error, "The integration catalog is unavailable."));
    }));
  }

  connections(options?: {
    refresh?: boolean;
  }): Promise<readonly CloudConnectorConnection[]> {
    if (options?.refresh) this.#connections = undefined;
    return (this.#connections ??= (async () => {
      const { connections } = await this.#context.source.connections();
      return Object.freeze(
        connections.map((entry) => ({ id: entry.id, connected: entry.connected === true })),
      );
    })().catch((error) => {
      this.#connections = undefined;
      throw new Error(sourceErrorMessage(error, "Connected integrations are unavailable."));
    }));
  }

  async isConnected(id: string, options?: { refresh?: boolean }): Promise<boolean> {
    const connections = await this.connections(options);
    return connections.some((entry) => entry.id === id && entry.connected);
  }

  async isDeclined(id: string): Promise<boolean> {
    return (await this.#context.declines?.isDeclined(id)) ?? false;
  }

  async listActions(
    id: string,
    options: { query?: string; limit?: number },
  ): Promise<{ total: number; actions: ActionRecord[] }> {
    const actions: ActionRecord[] = [];
    let total = 0;
    let cursor: string | null = null;
    const wanted = clampActionLimit(options.limit);
    do {
      const page: IntegrationActionsPage | null = await this.#context.source
        .actions({
          id,
          ...(options.query?.trim() ? { query: options.query.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: ACTIONS_PAGE_LIMIT,
        })
        .catch((error: unknown) => {
          throw new Error(sourceErrorMessage(error, "Integration action catalog failed."));
        });
      if (!page) {
        throw new Error(
          `Connector is not installed or known: ${id}. Search with connect.discover("<keywords>").`,
        );
      }
      total = page.actionCount;
      for (const raw of page.actions) {
        const action = readActionRecord(raw);
        if (action) actions.push(action);
      }
      cursor = page.nextCursor;
    } while (cursor && actions.length < wanted);
    return { total: Math.max(total, actions.length), actions };
  }

  async getAction(id: string, action: string): Promise<ActionRecord | null> {
    const page = await this.#context.source.actions({ id, action }).catch((error: unknown) => {
      throw new Error(sourceErrorMessage(error, "Integration action lookup failed."));
    });
    return page ? readActionRecord(page.actions[0]) : null;
  }

  async run(
    id: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return sanitizeSensitiveData(
        await this.#context.source.run({ id, action, input, requestId: crypto.randomUUID() }),
      );
    } catch (error) {
      if (error instanceof RpcError && error.reason === "not_connected") {
        throw new Error(
          `${id} is not connected for this account. Offer the inline connect card with tools.connector_status({ connector: "${id}" }) (or the Store), then retry.`,
        );
      }
      throw new Error(sourceErrorMessage(error, "Integration action failed."));
    }
  }
}

const requireConnectorId = (id: string): string => {
  const normalized = id.trim().toLowerCase();
  if (!SAFE_CONNECTOR_ID.test(normalized)) {
    throw new Error(`Connector id "${id}" is not valid.`);
  }
  return normalized;
};

const nextHint = (
  entry: CloudConnectorCatalogEntry,
  connected: boolean,
  declined: boolean,
): string =>
  connected
    ? `Ready. Inspect actions: await connect.actions("${entry.id}").`
    : declined
      ? "The user previously declined connecting this in chat. Do not offer it again; they can enable it in the Store."
      : `Not connected. Connect offers are handled by the orchestrator's connector_status tool (inline connect card) or the Store — do not initiate one from here unless the user explicitly asked this turn. Proceed via the browser/computer fallback meanwhile.`;

export const createCloudConnectClient = (
  directory: CloudConnectorDirectory,
): CloudConnectClient => ({
  discover: async (query) => {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("connect.discover requires a non-empty query string.");
    }
    const [catalog, connections] = await Promise.all([
      directory.catalog(),
      directory.connections(),
    ]);
    const tokens = tokenizeConnectorQuery(trimmed);
    const ranked = catalog
      .map((entry) => ({ entry, score: scoreConnectorMatch(tokens, entry) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.name.localeCompare(right.entry.name),
      )
      .slice(0, DISCOVER_MAX_MATCHES);
    const matches = await Promise.all(
      ranked.map(async ({ entry }) => {
        const connection = connections.find((row) => row.id === entry.id);
        const connected = connection?.connected === true;
        const declined = await directory.isDeclined(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          kind: "native" as const,
          category: entry.category,
          description: collapseLine(entry.description),
          enabled: connection !== undefined,
          connected,
          provider: "backend-composio" as const,
          toolCount: entry.catalogToolCount,
          executable: connected,
          declined,
          next: nextHint(entry, connected, declined),
        };
      }),
    );
    return { query: trimmed, matches };
  },
  connectors: async () => {
    const [catalog, connections] = await Promise.all([
      directory.catalog(),
      directory.connections(),
    ]);
    return connections.flatMap((connection) => {
      const entry = catalog.find((candidate) => candidate.id === connection.id);
      if (!entry) return [];
      return [
        {
          id: entry.id,
          name: entry.name,
          kind: "native" as const,
          connected: connection.connected,
          description: collapseLine(entry.description),
        },
      ];
    });
  },
  actions: async (id, options) => {
    const connectorId = requireConnectorId(id);
    const listOptions = {
      ...(typeof options.query === "string" ? { query: options.query } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
    };
    const { total, actions } = await directory.listActions(
      connectorId,
      listOptions,
    );
    const limit = clampActionLimit(listOptions.limit);
    const shown = actions.slice(0, limit).map((action) => ({
      name: action.name,
      description: collapseLine(action.description ?? action.title),
      ...(action.inputSchema
        ? { params: summarizeActionParams(action.inputSchema) }
        : {}),
    }));
    return {
      connector: connectorId,
      total,
      shown: shown.length,
      actions: shown,
      ...(total > shown.length
        ? {
            hint: `Showing ${shown.length} of ${total}. Narrow with { query } or raise { limit } (max ${ACTIONS_MAX_LIMIT}). connect.schema("${connectorId}", "<ACTION>") returns one full input schema.`,
          }
        : {}),
    };
  },
  schema: async (id, action) => {
    const connectorId = requireConnectorId(id);
    const wanted = action.trim();
    const match = await directory.getAction(connectorId, wanted);
    if (!match) {
      throw new Error(
        `Unknown action ${wanted} for ${connectorId}. List actions with connect.actions("${connectorId}", { query: "<keywords>" }).`,
      );
    }
    return {
      connector: connectorId,
      name: match.name,
      ...(match.title ? { title: match.title } : {}),
      ...(match.description
        ? { description: collapseLine(match.description, 500) }
        : {}),
      inputSchema: match.inputSchema ?? null,
      ...(match.inputSchema
        ? {}
        : {
            note: "No input schema is published; the backend validates arguments when the action runs.",
          }),
    };
  },
  call: async (id, action, args) => {
    const connectorId = requireConnectorId(id);
    const target = action.trim();
    if (target.startsWith("/")) {
      throw new Error(
        "REST-style paths are only available for API connectors installed on the desktop; call a named Store action here.",
      );
    }
    if (!SAFE_ACTION.test(target)) {
      throw new Error(
        `Action "${target}" is not a valid Store action name. List actions with connect.actions("${connectorId}").`,
      );
    }
    if (!isRecord(args)) {
      throw new Error("connect.call args must be a plain object.");
    }
    return await directory.run(connectorId, target, args);
  },
  addMcp: async () => {
    throw new Error(
      "connect.addMcp is desktop-only: custom MCP servers run on the user's computer. In the cloud, connect reaches the Store integrations the account has connected.",
    );
  },
  remove: async () => {
    throw new Error(
      "connect.remove is desktop-only: custom connectors live on the user's computer. Store integrations are disconnected from the Store.",
    );
  },
});
