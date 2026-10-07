/**
 * The owner's integrations: Composio connections, X, and the connect cards
 * cloud turns wait on. The catalog itself is global (D1, see
 * `src/integrations/catalog.ts`); this object holds what belongs to the
 * account.
 *
 * - **Composio:** one principal (`stella_<hash>`) per owner and one tool
 *   router session per connected integration. Sessions are created lazily
 *   by the first connect link; status and execution read them. Connections
 *   survive a reset and are revoked at Composio on account deletion.
 * - **Runs** are single-use by request id (`integration_call_receipts`), so
 *   a retried HTTP request can never execute a destructive action twice.
 * - **Connect cards** (`connect_requests`) are created by the orchestrator
 *   (`connect.request`), watched by clients (`connect.pending`), answered by
 *   the user (`connect.decide`) and polled by the waiting turn
 *   (`connect.poll`, which settles `connecting` once Composio reports the
 *   account). An `connect.expire` job moves an unanswered card out of the
 *   live states at its deadline.
 * - **X:** OAuth 2 + PKCE. `x.connectUrl` records a nonce with the PKCE
 *   verifier and signs the state; the callback route verifies the signature
 *   and `x.completeOAuth` consumes the nonce once. Tokens live in `x_tokens`
 *   (Durable Object storage is encrypted at rest) and refresh on use.
 */

import type {
  IntegrationCalls,
  XConnection,
} from "@stella/contracts/backend/integrations";
import { X_OAUTH_CALLBACK_PATH } from "@stella/contracts/backend/integrations";
import type {
  CloudConnectorConnectRequest,
  CloudConnectorConnectState,
} from "@stella/contracts/cloud-connector-connect";
import { sha256Hex } from "../../hash.js";
import {
  SAFE_ACTION_NAME,
  SAFE_INTEGRATION_ID,
  listIntegrationActions,
  listIntegrationCatalog,
  loadExecutableIntegration,
  loadIntegrationAction,
  type ExecutableIntegration,
} from "../../integrations/catalog.js";
import {
  composioConfig,
  composioConnectLink,
  composioDefinitelyRejected,
  composioExecute,
  composioPrincipalFor,
  composioToolkitConnected,
  createComposioSession,
  deleteComposioSession,
  purgeComposioConnection,
  type ComposioConfig,
} from "../../integrations/composio.js";
import {
  buildGoogleAdsMutationProxyRequest,
  normalizeGoogleAdsProxyResponse,
} from "../../integrations/google-ads.js";
import {
  X_API_BASE_URL,
  X_OAUTH_SCOPES,
  X_OAUTH_STATE_TTL_MS,
  X_STATE_KIND,
  buildXAuthorizationUrl,
  generateCodeVerifier,
  parseXScope,
  requestXToken,
  xClient,
  type XTokenResponse,
} from "../../integrations/x.js";
import { signOAuthState } from "../../oauth-state.js";
import {
  empty,
  json,
  literal,
  number,
  object,
  optional,
  string,
  type Parser,
} from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDb, OwnerDbReader, OwnerDomain } from "../registry.js";

const CONNECT_REQUEST_TTL_MS = 5 * 60_000;
const MAX_PENDING_REQUESTS = 8;
const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const X_REFRESH_SKEW_MS = 60_000;
const PURGE_BATCH = 4;
const EXPIRE_JOB = "connect.expire";
const LIVE_STATES: readonly CloudConnectorConnectState[] = ["pending", "connecting"];
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

export const INTEGRATIONS_MIGRATION = {
  id: "integrations.1-init",
  statements: [
    `CREATE TABLE integration_principal (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       composio_user_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE integration_connections (
       integration_id TEXT PRIMARY KEY,
       toolkit TEXT NOT NULL,
       session_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE integration_call_receipts (
       request_id TEXT PRIMARY KEY,
       fingerprint TEXT NOT NULL,
       state TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE connect_requests (
       request_id TEXT PRIMARY KEY,
       conversation_id TEXT NOT NULL,
       turn_id TEXT NOT NULL,
       integration_id TEXT NOT NULL,
       name TEXT NOT NULL,
       description TEXT,
       icon_url TEXT,
       category TEXT,
       reason TEXT,
       state TEXT NOT NULL,
       revision INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       decision_request_id TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    "CREATE INDEX connect_requests_by_turn ON connect_requests (turn_id, integration_id)",
    "CREATE INDEX connect_requests_by_state ON connect_requests (state, created_at)",
    `CREATE TABLE x_tokens (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       x_user_id TEXT NOT NULL,
       username TEXT NOT NULL,
       name TEXT,
       access_token TEXT NOT NULL,
       refresh_token TEXT,
       scopes TEXT NOT NULL,
       access_token_expires_at INTEGER,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE oauth_nonces (
       nonce TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       data TEXT,
       expires_at INTEGER NOT NULL
     )`,
  ],
};

type ConnectRow = {
  request_id: string;
  conversation_id: string;
  turn_id: string;
  integration_id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  category: string | null;
  reason: string | null;
  state: string;
  revision: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

type XTokenRow = {
  x_user_id: string;
  username: string;
  name: string | null;
  access_token: string;
  refresh_token: string | null;
  scopes: string;
  access_token_expires_at: number | null;
  updated_at: number;
};

// ── Shared helpers ────────────────────────────────────────────────────────

const requireComposio = (env: Cloudflare.Env): ComposioConfig => {
  const config = composioConfig(env);
  if (!config) throw new RpcError("UNAVAILABLE", "Integrations are not configured on this server.");
  return config;
};

const requireIntegration = async (
  env: Cloudflare.Env,
  id: string,
): Promise<ExecutableIntegration> => {
  const integration = await loadExecutableIntegration(env, id);
  if (!integration) throw new RpcError("NOT_FOUND", "This integration is not available.");
  return integration;
};

const connectionOf = (db: OwnerDbReader, integrationId: string) =>
  db.one<{ session_id: string; toolkit: string }>(
    "SELECT session_id, toolkit FROM integration_connections WHERE integration_id = ?",
    integrationId,
  );

const principalOf = async (ctx: OwnerContext): Promise<string> => {
  const row = ctx.db.one<{ composio_user_id: string }>(
    "SELECT composio_user_id FROM integration_principal WHERE id = 1",
  );
  if (row) return row.composio_user_id;
  const userId = await composioPrincipalFor(ctx.ownerId);
  ctx.db.run(
    "INSERT OR IGNORE INTO integration_principal (id, composio_user_id, created_at) VALUES (1, ?, ?)",
    userId,
    ctx.now,
  );
  return userId;
};

/** The integration's session, created on first use. */
const ensureSession = async (
  ctx: OwnerContext,
  config: ComposioConfig,
  integration: ExecutableIntegration,
): Promise<string> => {
  const existing = connectionOf(ctx.db, integration.id);
  if (existing) return existing.session_id;
  const sessionId = await createComposioSession(config, await principalOf(ctx), integration.toolkit);
  // Another request may have created one while this create was in flight.
  const raced = connectionOf(ctx.db, integration.id);
  if (raced) {
    await deleteComposioSession(config, sessionId).catch(() => undefined);
    return raced.session_id;
  }
  ctx.db.run(
    "INSERT INTO integration_connections (integration_id, toolkit, session_id, created_at) VALUES (?, ?, ?, ?)",
    integration.id,
    integration.toolkit,
    sessionId,
    ctx.now,
  );
  return sessionId;
};

/** Whether the owner's session for an integration has a connected account now. */
const isConnected = async (ctx: OwnerContext, integrationId: string): Promise<boolean> => {
  const connection = connectionOf(ctx.db, integrationId);
  const config = composioConfig(ctx.env);
  if (!connection || !config) return false;
  try {
    return await composioToolkitConnected(config, connection.session_id, connection.toolkit);
  } catch (error) {
    console.error(JSON.stringify({
      event: "integration_status_failed",
      integrationId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
};

const connectLink = async (ctx: OwnerContext, id: string): Promise<{ url: string }> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "integrations.connectLink",
    { count: 20, windowMs: 10 * 60_000 },
    "Too many connection attempts. Wait a moment and try again.",
  );
  const integration = await requireIntegration(ctx.env, id);
  const config = requireComposio(ctx.env);
  try {
    const sessionId = await ensureSession(ctx, config, integration);
    return { url: await composioConnectLink(config, sessionId, integration.toolkit) };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    console.error(JSON.stringify({
      event: "integration_connect_link_failed",
      integrationId: integration.id,
      message: error instanceof Error ? error.message : String(error),
    }));
    throw new RpcError("UNAVAILABLE", "Could not create the connection link.");
  }
};

const listConnections = async (
  ctx: OwnerContext,
): Promise<IntegrationCalls["integrations.connections"]["result"]> => {
  const rows = ctx.db.all<{ integration_id: string }>(
    "SELECT integration_id FROM integration_connections ORDER BY integration_id",
  );
  return {
    connections: await Promise.all(
      rows.map(async (row) => ({
        id: row.integration_id,
        connected: await isConnected(ctx, row.integration_id),
      })),
    ),
  };
};

// ── Runs ──────────────────────────────────────────────────────────────────

const settleReceipt = (db: OwnerDb, requestId: string, state: string, now: number): void => {
  db.run(
    "UPDATE integration_call_receipts SET state = ?, updated_at = ? WHERE request_id = ? AND state = 'dispatching'",
    state,
    now,
    requestId,
  );
};

const runAction = async (
  ctx: OwnerContext,
  args: IntegrationCalls["integrations.run"]["args"],
): Promise<unknown> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "integrations.run",
    { count: 60, windowMs: 60_000 },
    "Too many integration requests. Wait a moment and try again.",
  );
  const resolved = await loadIntegrationAction(ctx.env, args.id, args.action);
  if (!resolved) throw new RpcError("BAD_REQUEST", "Integration action is not allowed.");
  const { integration, action } = resolved;
  const connection = connectionOf(ctx.db, integration.id);
  if (!connection) {
    throw new RpcError("CONFLICT", "Connect this integration before using it.", { reason: "not_connected" });
  }
  const config = requireComposio(ctx.env);
  let proxy: Record<string, unknown> | null;
  try {
    proxy = buildGoogleAdsMutationProxyRequest(integration.toolkit, action.name, args.input);
  } catch {
    throw new RpcError("BAD_REQUEST", "Invalid Google Ads mutation input.");
  }
  const fingerprint = await sha256Hex(
    JSON.stringify({
      id: integration.id,
      action: action.name,
      revision: action.revision,
      sessionId: connection.session_id,
      input: args.input,
    }),
  );
  ctx.db.run("DELETE FROM integration_call_receipts WHERE created_at < ?", ctx.now - RECEIPT_RETENTION_MS);
  if (ctx.db.one("SELECT 1 AS used FROM integration_call_receipts WHERE request_id = ?", args.requestId)) {
    throw new RpcError("CONFLICT", "This integration request was already used.", { reason: "request_reused" });
  }
  ctx.db.run(
    `INSERT INTO integration_call_receipts (request_id, fingerprint, state, created_at, updated_at)
     VALUES (?, ?, 'dispatching', ?, ?)`,
    args.requestId,
    fingerprint,
    ctx.now,
    ctx.now,
  );
  let payload: Record<string, unknown>;
  try {
    if (!(await composioToolkitConnected(config, connection.session_id, connection.toolkit))) {
      settleReceipt(ctx.db, args.requestId, "failed", Date.now());
      throw new RpcError("CONFLICT", "This integration is no longer connected.", { reason: "not_connected" });
    }
    payload = await composioExecute(
      config,
      connection.session_id,
      proxy ? { proxy } : { action: action.name, input: args.input },
    );
  } catch (error) {
    if (error instanceof RpcError) throw error;
    // Only a provider rejection proves nothing ran; anything else may have.
    settleReceipt(ctx.db, args.requestId, composioDefinitelyRejected(error) ? "failed" : "unknown", Date.now());
    console.error(JSON.stringify({
      event: "integration_run_failed",
      integrationId: integration.id,
      requestId: args.requestId,
      message: error instanceof Error ? error.message : String(error),
    }));
    throw new RpcError("UNAVAILABLE", "Could not run the integration action.", { retryable: false });
  }
  settleReceipt(ctx.db, args.requestId, "succeeded", Date.now());
  return proxy ? normalizeGoogleAdsProxyResponse(payload) : payload;
};

// ── Connect cards ─────────────────────────────────────────────────────────

const toRequest = (row: ConnectRow, now: number): CloudConnectorConnectRequest => ({
  schemaVersion: 1,
  requestId: row.request_id,
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  integrationId: row.integration_id,
  name: row.name,
  ...(row.description ? { description: row.description } : {}),
  ...(row.icon_url ? { iconUrl: row.icon_url } : {}),
  ...(row.category ? { category: row.category } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  // A deadline the expiry job has not reached yet still reads expired.
  state:
    LIVE_STATES.includes(row.state as CloudConnectorConnectState) && row.expires_at <= now
      ? "expired"
      : (row.state as CloudConnectorConnectState),
  revision: row.revision,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const connectRow = (db: OwnerDbReader, requestId: string) =>
  db.one<ConnectRow>("SELECT * FROM connect_requests WHERE request_id = ?", requestId);

/** Move a card to `state` if it is still in one of `from`. Answers the card as it is now. */
const settleConnect = (
  ctx: OwnerContext,
  requestId: string,
  state: CloudConnectorConnectState,
  from: readonly CloudConnectorConnectState[],
  decisionRequestId?: string,
): CloudConnectorConnectRequest | null => {
  const row = connectRow(ctx.db, requestId);
  if (!row) return null;
  const current = toRequest(row, ctx.now);
  // Expiry moves a card that is live in storage; every other move needs it
  // live by the clock too.
  const fromState = state === "expired" ? (row.state as CloudConnectorConnectState) : current.state;
  if (!from.includes(fromState)) return current;
  ctx.db.run(
    `UPDATE connect_requests SET state = ?, revision = revision + 1, updated_at = ?,
       decision_request_id = COALESCE(?, decision_request_id)
     WHERE request_id = ?`,
    state,
    ctx.now,
    decisionRequestId ?? null,
    requestId,
  );
  if (!LIVE_STATES.includes(state)) ctx.jobs.cancel(`${EXPIRE_JOB}:${requestId}`);
  return toRequest(connectRow(ctx.db, requestId)!, ctx.now);
};

const trimmed = (max: number): Parser<string | undefined> => (value, path) => {
  if (value === undefined || value === null) return undefined;
  const text = string({ max: max * 4 })(value, path).trim();
  return text ? text.slice(0, max) : undefined;
};

const parseConnectCreate = object({
  conversationId: string({ min: 1, max: 200 }),
  turnId: string({ min: 1, max: 200 }),
  integrationId: string({ min: 1, max: 128 }),
  name: string({ min: 1, max: 480 }),
  description: trimmed(500),
  iconUrl: trimmed(1_000),
  category: trimmed(80),
  reason: trimmed(300),
});

const createConnectRequest = (ctx: OwnerContext, raw: unknown): CloudConnectorConnectRequest => {
  const args = parseConnectCreate(raw);
  const integrationId = args.integrationId.trim().toLowerCase();
  // One live card per (turn, integration): a retried tool call finds it.
  const live = ctx.db
    .all<ConnectRow>(
      "SELECT * FROM connect_requests WHERE turn_id = ? AND integration_id = ? ORDER BY created_at DESC LIMIT 4",
      args.turnId,
      integrationId,
    )
    .map((row) => toRequest(row, ctx.now))
    .find((request) => LIVE_STATES.includes(request.state));
  if (live) return live;
  const requestId = `cc-${crypto.randomUUID()}`;
  const expiresAt = ctx.now + CONNECT_REQUEST_TTL_MS;
  ctx.db.run(
    `INSERT INTO connect_requests (request_id, conversation_id, turn_id, integration_id, name,
       description, icon_url, category, reason, state, revision, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
    requestId,
    args.conversationId,
    args.turnId,
    integrationId,
    args.name.trim().slice(0, 120),
    args.description ?? null,
    args.iconUrl ?? null,
    args.category ?? null,
    args.reason ?? null,
    expiresAt,
    ctx.now,
    ctx.now,
  );
  ctx.jobs.schedule(EXPIRE_JOB, expiresAt, { requestId }, { id: `${EXPIRE_JOB}:${requestId}` });
  return toRequest(connectRow(ctx.db, requestId)!, ctx.now);
};

const parseRequestId = object({ requestId: string({ min: 1, max: 128 }) });

/** The waiting turn's poll: settles `expired` and, once connected, `connected`. */
const pollConnectRequest = async (
  ctx: OwnerContext,
  raw: unknown,
): Promise<CloudConnectorConnectRequest | null> => {
  const { requestId } = parseRequestId(raw);
  const row = connectRow(ctx.db, requestId);
  if (!row) return null;
  const current = toRequest(row, ctx.now);
  if (current.state === "expired" && row.state !== "expired") {
    return settleConnect(ctx, requestId, "expired", LIVE_STATES);
  }
  // The OAuth hop ends on Composio's hosted page with no callback to us, so
  // each poll of a `connecting` card asks Composio whether it finished.
  if (current.state === "connecting" && (await isConnected(ctx, row.integration_id))) {
    return settleConnect(ctx, requestId, "connected", ["connecting"]);
  }
  return current;
};

const decideConnectRequest = async (
  ctx: OwnerContext,
  args: IntegrationCalls["connect.decide"]["args"],
): Promise<IntegrationCalls["connect.decide"]["result"]> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "connect.decide",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many connect decisions. Wait a moment and try again.",
  );
  const row = connectRow(ctx.db, args.requestId);
  if (!row) throw new RpcError("NOT_FOUND", "Connect request not found.");
  const current = toRequest(row, ctx.now);
  if (current.revision !== args.expectedRevision || !LIVE_STATES.includes(current.state)) {
    throw new RpcError("CONFLICT", "This connect request changed. Refresh it and try again.");
  }
  if (args.decision === "decline") {
    return {
      request: settleConnect(ctx, args.requestId, "declined", LIVE_STATES, args.decisionRequestId) ?? current,
    };
  }
  const integration = await loadExecutableIntegration(ctx.env, current.integrationId);
  if (!integration) throw new RpcError("NOT_FOUND", "This integration cannot be connected here.");
  const config = requireComposio(ctx.env);
  let url: string;
  try {
    url = await composioConnectLink(config, await ensureSession(ctx, config, integration), integration.toolkit);
  } catch (error) {
    console.error(JSON.stringify({
      event: "connect_decide_link_failed",
      integrationId: integration.id,
      message: error instanceof Error ? error.message : String(error),
    }));
    throw new RpcError("UNAVAILABLE", "Could not create the connection link.");
  }
  // The link took a network round trip; settle against the clock now.
  const request =
    settleConnect({ ...ctx, now: Date.now() }, args.requestId, "connecting", LIVE_STATES, args.decisionRequestId) ??
    current;
  return { request, url };
};

const pendingConnectRequests = (db: OwnerDbReader, now: number): CloudConnectorConnectRequest[] =>
  db
    .all<ConnectRow>(
      `SELECT * FROM connect_requests WHERE state IN ('pending', 'connecting') AND expires_at > ?
        ORDER BY created_at DESC LIMIT ?`,
      now,
      MAX_PENDING_REQUESTS,
    )
    .map((row) => toRequest(row, now));

// ── X ─────────────────────────────────────────────────────────────────────

const requireXClient = (env: Cloudflare.Env) => {
  const client = xClient(env);
  if (!client || !env.CLOUD_BUILDER_PUBLIC_URL) {
    throw new RpcError("UNAVAILABLE", "X is not configured on this server.");
  }
  return { client, redirectUri: `${env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, "")}${X_OAUTH_CALLBACK_PATH}` };
};

const xConnectUrl = async (ctx: OwnerContext): Promise<{ url: string; expiresAt: number }> => {
  const { client, redirectUri } = requireXClient(ctx.env);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "x.connectUrl",
    { count: 10, windowMs: 10 * 60_000 },
    "Too many X connect requests. Please wait before trying again.",
  );
  const nonce = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const expiresAt = ctx.now + X_OAUTH_STATE_TTL_MS;
  ctx.db.run("DELETE FROM oauth_nonces WHERE expires_at <= ?", ctx.now);
  ctx.db.run(
    "INSERT INTO oauth_nonces (nonce, kind, data, expires_at) VALUES (?, ?, ?, ?)",
    nonce,
    X_STATE_KIND,
    JSON.stringify({ codeVerifier }),
    expiresAt,
  );
  const state = await signOAuthState(ctx.env, {
    ownerId: ctx.ownerId,
    kind: X_STATE_KIND,
    nonce,
    exp: expiresAt,
  });
  return {
    url: await buildXAuthorizationUrl({ clientId: client.clientId, redirectUri, state, codeVerifier }),
    expiresAt,
  };
};

const readTokenString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const expiresAtOf = (body: XTokenResponse, issuedAt: number): number | null =>
  typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
    ? issuedAt + Math.floor(body.expires_in) * 1000
    : null;

const parseCompleteOAuth = object({
  nonce: string({ min: 1, max: 128 }),
  code: optional(string({ max: 2_048 })),
  error: optional(string({ max: 512 })),
});

/** The X callback, after the route verified the signed state. */
const completeXOAuth = async (ctx: OwnerContext, raw: unknown): Promise<{ username: string }> => {
  const args = parseCompleteOAuth(raw);
  const nonce = ctx.db.one<{ data: string | null; expires_at: number }>(
    "SELECT data, expires_at FROM oauth_nonces WHERE nonce = ? AND kind = ?",
    args.nonce,
    X_STATE_KIND,
  );
  // Consumed before anything else: a state works once.
  ctx.db.run("DELETE FROM oauth_nonces WHERE nonce = ?", args.nonce);
  if (!nonce || nonce.expires_at <= ctx.now) {
    throw new RpcError("CONFLICT", "Invalid or expired OAuth state. Please start the X connection again.");
  }
  if (args.error) throw new RpcError("BAD_REQUEST", "X authorization was cancelled.");
  if (!args.code) throw new RpcError("BAD_REQUEST", "Missing authorization code.");
  const codeVerifier = readTokenString((JSON.parse(nonce.data ?? "{}") as { codeVerifier?: unknown }).codeVerifier);
  if (!codeVerifier) throw new RpcError("CONFLICT", "Invalid OAuth state. Please start the X connection again.");
  const { client, redirectUri } = requireXClient(ctx.env);
  const token = await requestXToken(client, {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const accessToken = readTokenString(token.body.access_token);
  if (!token.ok || !accessToken) {
    console.error(JSON.stringify({
      event: "x_token_exchange_failed",
      status: token.status,
      error: readTokenString(token.body.error),
    }));
    throw new RpcError("BAD_REQUEST", "X token exchange failed. Please retry the connection.");
  }
  const me = await fetch(`${X_API_BASE_URL}/2/users/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const profile = ((await me.json().catch(() => null)) ?? {}) as { data?: Record<string, unknown> };
  const xUserId = readTokenString(profile.data?.id);
  const username = readTokenString(profile.data?.username);
  if (!me.ok || !xUserId || !username) {
    console.error(JSON.stringify({ event: "x_profile_lookup_failed", status: me.status }));
    throw new RpcError("BAD_REQUEST", "Could not read the connected X account.");
  }
  const now = Date.now();
  const scopes = parseXScope(token.body.scope);
  ctx.db.run(
    `INSERT INTO x_tokens (id, x_user_id, username, name, access_token, refresh_token, scopes,
       access_token_expires_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET x_user_id = excluded.x_user_id, username = excluded.username,
       name = excluded.name, access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, scopes = excluded.scopes,
       access_token_expires_at = excluded.access_token_expires_at, updated_at = excluded.updated_at`,
    xUserId,
    username,
    readTokenString(profile.data?.name),
    accessToken,
    readTokenString(token.body.refresh_token),
    JSON.stringify(scopes.length > 0 ? scopes : [...X_OAUTH_SCOPES]),
    expiresAtOf(token.body, now),
    now,
  );
  return { username };
};

const xConnections = (db: OwnerDbReader): { connections: XConnection[] } => {
  const row = db.one<XTokenRow>("SELECT * FROM x_tokens WHERE id = 1");
  return {
    connections: row
      ? [
          {
            xUserId: row.x_user_id,
            username: row.username,
            ...(row.name ? { name: row.name } : {}),
            scopes: JSON.parse(row.scopes) as string[],
            updatedAt: row.updated_at,
            ...(row.access_token_expires_at !== null
              ? { accessTokenExpiresAt: row.access_token_expires_at }
              : {}),
          },
        ]
      : [],
  };
};

/** The owner's X access token, refreshed when it is about to expire. */
const xAccessToken = async (ctx: OwnerContext): Promise<string> => {
  const row = ctx.db.one<XTokenRow>("SELECT * FROM x_tokens WHERE id = 1");
  if (!row) throw new RpcError("FORBIDDEN", "X is not connected. Run `stella-x-api connect` first.");
  if (row.access_token_expires_at === null || row.access_token_expires_at > Date.now() + X_REFRESH_SKEW_MS) {
    return row.access_token;
  }
  const client = xClient(ctx.env);
  if (!row.refresh_token || !client) {
    throw new RpcError("FORBIDDEN", "X connection expired. Reconnect X in Stella.");
  }
  const token = await requestXToken(client, { grant_type: "refresh_token", refresh_token: row.refresh_token });
  const accessToken = readTokenString(token.body.access_token);
  if (!token.ok || !accessToken) {
    console.error(JSON.stringify({ event: "x_token_refresh_failed", status: token.status }));
    throw new RpcError("FORBIDDEN", "X connection expired. Reconnect X in Stella.");
  }
  const now = Date.now();
  const scopes = parseXScope(token.body.scope);
  ctx.db.run(
    `UPDATE x_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
       scopes = COALESCE(?, scopes), access_token_expires_at = ?, updated_at = ? WHERE id = 1`,
    accessToken,
    readTokenString(token.body.refresh_token),
    scopes.length > 0 ? JSON.stringify(scopes) : null,
    expiresAtOf(token.body, now),
    now,
  );
  return accessToken;
};

const X_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const xRequest = async (
  ctx: OwnerContext,
  args: IntegrationCalls["x.request"]["args"],
): Promise<{ status: number; payload: unknown }> => {
  const method = (args.method ?? "GET").toUpperCase();
  const rawPath = args.path.trim();
  const path = rawPath.startsWith(`${X_API_BASE_URL}/2/`) ? rawPath.slice(X_API_BASE_URL.length) : rawPath;
  if (!(X_METHODS as readonly string[]).includes(method) || !path.startsWith("/2/")) {
    throw new RpcError("BAD_REQUEST", "Provide method and an X API v2 path such as /2/users/me.");
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "x.request",
    { count: 120, windowMs: 60_000 },
    "Too many X requests. Wait a moment and try again.",
  );
  const accessToken = await xAccessToken(ctx);
  const url = new URL(path, X_API_BASE_URL);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  const upstream = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(method === "GET" || args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (upstream.headers.get("content-type") ?? "").includes("application/json")
    ? await upstream.json().catch(() => null)
    : { text: await upstream.text().catch(() => "") };
  return { status: upstream.status, payload };
};

// ── Purge ─────────────────────────────────────────────────────────────────

/**
 * Reset keeps the account's connections (Composio and X), like any account
 * setting; deletion revokes every Composio account the principal holds and
 * drops everything.
 */
const purgeIntegrations = async (
  ctx: OwnerContext,
  mode: "reset" | "delete",
): Promise<{ pending: boolean }> => {
  for (const { request_id } of ctx.db.all<{ request_id: string }>("SELECT request_id FROM connect_requests")) {
    ctx.jobs.cancel(`${EXPIRE_JOB}:${request_id}`);
  }
  ctx.db.run("DELETE FROM connect_requests");
  ctx.db.run("DELETE FROM integration_call_receipts");
  ctx.db.run("DELETE FROM oauth_nonces");
  if (mode === "reset") return { pending: false };

  const rows = ctx.db.all<{ integration_id: string; toolkit: string; session_id: string }>(
    "SELECT integration_id, toolkit, session_id FROM integration_connections LIMIT ?",
    PURGE_BATCH,
  );
  if (rows.length > 0) {
    const config = composioConfig(ctx.env);
    if (!config) {
      console.error(JSON.stringify({ event: "integration_purge_unconfigured" }));
      return { pending: true };
    }
    const userId = await principalOf(ctx);
    for (const row of rows) {
      try {
        await purgeComposioConnection(config, {
          sessionId: row.session_id,
          toolkit: row.toolkit,
          userId,
        });
        ctx.db.run("DELETE FROM integration_connections WHERE integration_id = ?", row.integration_id);
      } catch (error) {
        console.error(JSON.stringify({
          event: "integration_purge_failed",
          integrationId: row.integration_id,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (ctx.db.one("SELECT 1 AS left FROM integration_connections LIMIT 1")) return { pending: true };
  }
  ctx.db.run("DELETE FROM integration_principal");
  ctx.db.run("DELETE FROM x_tokens");
  return { pending: false };
};

// ── Registration ──────────────────────────────────────────────────────────

const integrationId = (): Parser<string> => (value, path) => {
  const id = string({ min: 1, max: 128 })(value, path).trim().toLowerCase();
  if (!SAFE_INTEGRATION_ID.test(id)) throw new RpcError("BAD_REQUEST", "Integration id is invalid.");
  return id;
};

const jsonObject = (maxBytes: number): Parser<Record<string, unknown>> => (value, path) => {
  const parsed = json({ maxBytes })(value, path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcError("BAD_REQUEST", `${path || "value"} must be an object.`);
  }
  return parsed as Record<string, unknown>;
};

const parseRun = object({
  id: integrationId(),
  action: string({ min: 2, max: 128, pattern: SAFE_ACTION_NAME }),
  input: jsonObject(512 * 1024),
  requestId: string({ min: 8, max: 128, pattern: SAFE_REQUEST_ID }),
});

export const integrationsDomain = {
  name: "integrations",
  migrations: [INTEGRATIONS_MIGRATION],
  calls: {
    "integrations.catalog": {
      scope: "global",
      parse: empty(),
      handler: async (ctx) => ({ integrations: await listIntegrationCatalog(ctx.env) }),
    },
    "integrations.actions": {
      scope: "global",
      parse: object({
        id: integrationId(),
        action: optional(string({ min: 2, max: 128, pattern: SAFE_ACTION_NAME })),
        query: optional(string({ max: 200 })),
        cursor: optional(string({ max: 128 })),
        limit: optional(number({ int: true, min: 1, max: 100 })),
      }),
      handler: async (ctx, args) => {
        const page = await listIntegrationActions(ctx.env, args);
        if (!page) throw new RpcError("NOT_FOUND", "Executable integration actions are unavailable.");
        return page;
      },
    },
    "integrations.connections": {
      scope: "owner",
      parse: empty(),
      handler: listConnections,
    },
    "integrations.status": {
      scope: "owner",
      parse: object({ id: integrationId() }),
      handler: async (ctx, args) => {
        await requireIntegration(ctx.env, args.id);
        return { connected: await isConnected(ctx, args.id) };
      },
    },
    "integrations.connectLink": {
      scope: "owner",
      parse: object({ id: integrationId() }),
      handler: (ctx, args) => connectLink(ctx, args.id),
    },
    "integrations.run": {
      scope: "owner",
      parse: parseRun,
      handler: runAction,
    },
    "connect.decide": {
      scope: "owner",
      parse: object({
        requestId: string({ min: 1, max: 128 }),
        expectedRevision: number({ int: true, min: 0 }),
        decisionRequestId: string({ min: 1, max: 128 }),
        decision: literal("connect", "decline"),
      }),
      handler: decideConnectRequest,
    },
    "x.connectUrl": {
      scope: "owner",
      parse: empty(),
      handler: xConnectUrl,
    },
    "x.connections": {
      scope: "owner",
      parse: empty(),
      handler: (ctx) => xConnections(ctx.db),
    },
    "x.request": {
      scope: "owner",
      parse: object({
        method: optional(string({ max: 10 })),
        path: string({ min: 1, max: 2_048 }),
        query: optional(jsonObject(64 * 1024)),
        body: optional(json({ maxBytes: 512 * 1024 })),
      }),
      handler: xRequest,
    },
  },
  views: {
    "connect.pending": {
      parse: empty(),
      read: (ctx) => pendingConnectRequests(ctx.db, ctx.now),
    },
  },
  jobs: {
    [EXPIRE_JOB]: {
      run: (ctx, payload) => {
        const requestId = (payload as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId === "string") settleConnect(ctx, requestId, "expired", LIVE_STATES);
      },
    },
  },
  internal: {
    /** The orchestrator shows a connect card. */
    "connect.request": createConnectRequest,
    "connect.poll": pollConnectRequest,
    "connect.cancel": (ctx, raw) => settleConnect(ctx, parseRequestId(raw).requestId, "canceled", LIVE_STATES),
    /** `cloud-connect-client.ts`: the cloud orchestrator's `connect.*`. */
    "integrations.connections": (ctx) => listConnections(ctx),
    "integrations.run": (ctx, raw) => runAction(ctx, parseRun(raw)),
    /** `GET /api/x/oauth_callback`, after the signed state verified. */
    "x.completeOAuth": completeXOAuth,
  },
  purge: purgeIntegrations,
} satisfies OwnerDomain;
