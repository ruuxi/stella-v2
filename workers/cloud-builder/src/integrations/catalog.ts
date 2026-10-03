/**
 * The Store's integration catalog in D1 (`migrations/0003_integrations.sql`):
 * reads for every surface and the admin publication that replaces one
 * integration with its full action set.
 *
 * An integration is executable only when it is enabled, Composio-backed and
 * has at least one published action; everything else is invisible here.
 */

import type {
  IntegrationAction,
  IntegrationActionsPage,
  IntegrationCatalogEntry,
  IntegrationConnector,
} from "@stella/contracts/backend/integrations";
import { RpcError } from "../owner-store/errors.js";
import { effectiveGoogleAdsActionSchema } from "./google-ads.js";

export const SAFE_INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
export const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;

const MAX_ACTIONS = 2_000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_CATALOG_ROWS = 500;
const DEFAULT_ACTIONS_PAGE = 50;
const MAX_ACTIONS_PAGE = 100;
/** 5 bound values per row, under D1's 100 bound parameters per statement. */
const INSERT_ROWS_PER_STATEMENT = 20;

type StoredIntegration = {
  id: string;
  name?: string;
  provider: string;
  category?: string;
  auth?: string[];
  catalogToolCount?: number;
  actionCount: number;
  description?: string;
  sourceUrl?: string;
  iconUrl?: string;
  connector: IntegrationConnector;
  enabled: boolean;
  usagePolicy: string;
};

type StoredAction = Omit<IntegrationAction, "revision">;

/** An integration resolved for execution. */
export type ExecutableIntegration = {
  id: string;
  toolkit: string;
  record: StoredIntegration;
  updatedAt: number;
};

/** Only the D1 binding: the orchestrator object reads the catalog too. */
type CatalogEnv = { readonly DB?: D1Database };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const dbOf = (env: CatalogEnv): D1Database => {
  if (!env.DB) throw new RpcError("UNAVAILABLE", "Integrations are unavailable right now.");
  return env.DB;
};

const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const isExecutable = (record: StoredIntegration | null): record is StoredIntegration =>
  Boolean(
    record &&
      record.enabled &&
      record.connector?.type === "composio" &&
      readString(record.connector.toolkit) &&
      Number.isSafeInteger(record.actionCount) &&
      record.actionCount > 0,
  );

const toCatalogEntry = (record: StoredIntegration, updatedAt: number): IntegrationCatalogEntry => ({
  id: record.id,
  name: record.name ?? record.provider,
  provider: record.provider,
  category: record.category ?? "integrations",
  auth: record.auth ?? ["OAUTH2"],
  catalogToolCount: record.actionCount,
  description: record.description ?? `Connect ${record.provider} to Stella.`,
  ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
  ...(record.iconUrl ? { iconUrl: record.iconUrl } : {}),
  status: record.usagePolicy === "ready" || record.usagePolicy === "hidden" ? record.usagePolicy : "ready",
  enabled: record.enabled,
  updatedAt,
  connector: record.connector,
});

export const listIntegrationCatalog = async (env: CatalogEnv): Promise<IntegrationCatalogEntry[]> => {
  const { results } = await dbOf(env)
    .prepare("SELECT json, updated_at FROM integration_catalog ORDER BY updated_at DESC LIMIT ?")
    .bind(MAX_CATALOG_ROWS)
    .all<{ json: string; updated_at: number }>();
  return results.flatMap((row) => {
    const record = parseJson<StoredIntegration>(row.json);
    return isExecutable(record) ? [toCatalogEntry(record, row.updated_at)] : [];
  });
};

/** One executable integration by id, or null. */
export const loadExecutableIntegration = async (
  env: CatalogEnv,
  id: string,
): Promise<ExecutableIntegration | null> => {
  const slug = id.trim().toLowerCase();
  if (!SAFE_INTEGRATION_ID.test(slug)) return null;
  const row = await dbOf(env)
    .prepare("SELECT json, updated_at FROM integration_catalog WHERE slug = ?")
    .bind(slug)
    .first<{ json: string; updated_at: number }>();
  const record = row ? parseJson<StoredIntegration>(row.json) : null;
  if (!row || !isExecutable(record)) return null;
  return {
    id: slug,
    toolkit: record.connector.toolkit.trim().toLowerCase(),
    record,
    updatedAt: row.updated_at,
  };
};

const toAction = (row: { json: string; updated_at: number }): IntegrationAction | null => {
  const stored = parseJson<StoredAction>(row.json);
  if (!stored || !isRecord(stored.inputSchema)) return null;
  return { ...stored, revision: String(row.updated_at) };
};

/**
 * A page of one integration's actions in name order, optionally filtered by
 * words that must all appear in the name, title or description. The cursor is
 * the last name of the previous page. With `action`, just that one.
 */
export const listIntegrationActions = async (
  env: CatalogEnv,
  args: { id: string; action?: string; query?: string; cursor?: string; limit?: number },
): Promise<IntegrationActionsPage | null> => {
  if (args.action) {
    const found = await loadIntegrationAction(env, args.id, args.action);
    return found
      ? {
          id: found.integration.id,
          actionCount: 1,
          updatedAt: found.integration.updatedAt,
          actions: [found.action],
          nextCursor: null,
        }
      : null;
  }
  const integration = await loadExecutableIntegration(env, args.id);
  if (!integration) return null;
  const limit = Math.min(Math.max(Math.floor(args.limit ?? DEFAULT_ACTIONS_PAGE), 1), MAX_ACTIONS_PAGE);
  const words = (args.query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 8);
  const clauses = ["slug = ?"];
  const params: (string | number)[] = [integration.id];
  if (args.cursor) {
    clauses.push("action > ?");
    params.push(args.cursor);
  }
  for (const word of words) {
    clauses.push("search_text LIKE ? ESCAPE '\\'");
    params.push(`%${word.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`);
  }
  const { results } = await dbOf(env)
    .prepare(
      `SELECT action, json, updated_at FROM integration_actions WHERE ${clauses.join(" AND ")}
        ORDER BY action LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<{ action: string; json: string; updated_at: number }>();
  const page = results.slice(0, limit);
  return {
    id: integration.id,
    actionCount: integration.record.actionCount,
    updatedAt: integration.updatedAt,
    actions: page.flatMap((row) => {
      const action = toAction(row);
      return action ? [action] : [];
    }),
    nextCursor: results.length > limit ? page[page.length - 1]!.action : null,
  };
};

/** One published action of an executable integration, or null. */
export const loadIntegrationAction = async (
  env: CatalogEnv,
  id: string,
  action: string,
): Promise<{ integration: ExecutableIntegration; action: IntegrationAction } | null> => {
  const integration = await loadExecutableIntegration(env, id);
  if (!integration || !SAFE_ACTION_NAME.test(action)) return null;
  const row = await dbOf(env)
    .prepare("SELECT json, updated_at FROM integration_actions WHERE slug = ? AND action = ?")
    .bind(integration.id, action)
    .first<{ json: string; updated_at: number }>();
  const parsed = row ? toAction(row) : null;
  return parsed ? { integration, action: parsed } : null;
};

// ── Publication ───────────────────────────────────────────────────────────

const optionalText = (value: unknown, max: number): string | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? null : trimmed;
};

const normalizeActions = (value: unknown, toolkit: string): StoredAction[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RpcError("BAD_REQUEST", "At least one schema-bearing action is required.");
  }
  if (value.length > MAX_ACTIONS) {
    throw new RpcError("BAD_REQUEST", `Integration action count exceeds ${MAX_ACTIONS}.`);
  }
  const names = new Set<string>();
  const actions = value.map((raw): StoredAction => {
    if (!isRecord(raw)) throw new RpcError("BAD_REQUEST", "Every integration action must be an object.");
    const name = readString(raw.name);
    if (!name || !SAFE_ACTION_NAME.test(name) || names.has(name)) {
      throw new RpcError("BAD_REQUEST", `Integration action name is invalid or duplicated: ${name ?? "<missing>"}.`);
    }
    names.add(name);
    const title = optionalText(raw.title, 512);
    const description = optionalText(raw.description, 16_384);
    if (title === null || description === null) {
      throw new RpcError("BAD_REQUEST", `Integration action text is invalid: ${name}.`);
    }
    if (!isRecord(raw.inputSchema)) {
      throw new RpcError("BAD_REQUEST", `Integration action is missing an object input schema: ${name}.`);
    }
    const inputSchema = effectiveGoogleAdsActionSchema(toolkit, name, raw.inputSchema);
    if (new TextEncoder().encode(JSON.stringify(inputSchema)).byteLength > MAX_SCHEMA_BYTES) {
      throw new RpcError("BAD_REQUEST", `Integration action schema is too large: ${name}.`);
    }
    const annotations = isRecord(raw.annotations) ? raw.annotations : null;
    return {
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(annotations &&
      annotations.source === "composio_tool_tags" &&
      typeof annotations.readOnlyHint === "boolean" &&
      typeof annotations.destructiveHint === "boolean" &&
      typeof annotations.idempotentHint === "boolean"
        ? {
            annotations: {
              readOnlyHint: annotations.readOnlyHint,
              destructiveHint: annotations.destructiveHint,
              idempotentHint: annotations.idempotentHint,
              source: "composio_tool_tags" as const,
            },
          }
        : {}),
      inputSchema,
    };
  });
  return actions.sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Replace one integration and its whole action set. The body is what the
 * publish script sends: the Store record plus `actions` with object
 * `inputSchema`s. One D1 batch, so it lands whole or not at all.
 */
export const publishIntegration = async (
  env: CatalogEnv,
  body: unknown,
  now = Date.now(),
): Promise<{ actionCount: number }> => {
  if (!isRecord(body)) throw new RpcError("BAD_REQUEST", "Invalid integration payload.");
  const id = readString(body.id)?.toLowerCase();
  if (!id || !SAFE_INTEGRATION_ID.test(id)) throw new RpcError("BAD_REQUEST", "Integration id is invalid.");
  const connector = isRecord(body.connector) ? body.connector : null;
  if (
    readString(body.provider)?.toLowerCase() !== "composio" ||
    connector?.type !== "composio" ||
    readString(connector.toolkit)?.toLowerCase() !== id ||
    (connector.provider !== undefined && readString(connector.provider)?.toLowerCase() !== "composio")
  ) {
    throw new RpcError("BAD_REQUEST", "Only matching Composio Store integrations can be published.");
  }
  if (typeof body.enabled !== "boolean" || !readString(body.usagePolicy)) {
    throw new RpcError("BAD_REQUEST", "Integration enabled and usagePolicy are required.");
  }
  const actions = normalizeActions(body.actions, id);
  const text = (key: string, max: number) => {
    const value = optionalText(body[key], max);
    if (value === null) throw new RpcError("BAD_REQUEST", `Integration ${key} is invalid.`);
    return value;
  };
  const auth = Array.isArray(body.auth)
    ? body.auth.filter((entry): entry is string => typeof entry === "string").slice(0, 8)
    : undefined;
  const record: StoredIntegration = {
    id,
    provider: "composio",
    actionCount: actions.length,
    connector: {
      type: "composio",
      toolkit: id,
      provider: "composio",
      ...(readString(connector.actionNamespace) ? { actionNamespace: readString(connector.actionNamespace)! } : {}),
    },
    enabled: body.enabled,
    usagePolicy: readString(body.usagePolicy)!,
    ...(text("name", 200) ? { name: text("name", 200)! } : {}),
    ...(text("category", 120) ? { category: text("category", 120)! } : {}),
    ...(auth ? { auth } : {}),
    ...(typeof body.catalogToolCount === "number" && Number.isSafeInteger(body.catalogToolCount)
      ? { catalogToolCount: body.catalogToolCount }
      : {}),
    ...(text("description", 4_000) ? { description: text("description", 4_000)! } : {}),
    ...(text("sourceUrl", 2_000) ? { sourceUrl: text("sourceUrl", 2_000)! } : {}),
    ...(text("iconUrl", 2_000) ? { iconUrl: text("iconUrl", 2_000)! } : {}),
  };

  const db = dbOf(env);
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM integration_actions WHERE slug = ?").bind(id),
  ];
  for (let offset = 0; offset < actions.length; offset += INSERT_ROWS_PER_STATEMENT) {
    const chunk = actions.slice(offset, offset + INSERT_ROWS_PER_STATEMENT);
    statements.push(
      db
        .prepare(
          `INSERT INTO integration_actions (slug, action, json, search_text, updated_at) VALUES ${chunk
            .map(() => "(?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(
          ...chunk.flatMap((action) => [
            id,
            action.name,
            JSON.stringify(action),
            [action.name, action.title, action.description].filter(Boolean).join(" ").toLowerCase(),
            now,
          ]),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO integration_catalog (slug, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .bind(id, JSON.stringify(record), now),
  );
  await db.batch(statements);
  return { actionCount: actions.length };
};
