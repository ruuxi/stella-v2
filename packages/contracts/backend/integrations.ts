/**
 * Store integrations (Composio-backed connectors), X, and the inline connect
 * card a cloud orchestrator turn shows.
 *
 * - **Catalog:** global, in D1 (`integration_catalog`, `integration_actions`),
 *   published by `POST /api/admin/native-integrations/upsert`.
 * - **Connections:** account-level, in the owner's object: one Composio
 *   session per integration under the owner's Composio principal. A service
 *   connected on one surface is connected on every surface.
 * - **X:** OAuth 2 tokens in the owner's object; requests proxy through
 *   `x.request`. The OAuth callback is `X_OAUTH_CALLBACK_PATH` on the
 *   backend origin.
 * - **Connect cards:** `connect.pending` lists what a cloud turn is waiting
 *   on; `connect.decide` answers it.
 *
 * The same calls are served over HTTP for the runtime, Electron and the CLI:
 * `/api/native-integrations/{catalog,actions,connections,status,connect-link,run}`,
 * `/api/native-oauth/{providers,token}` and `/api/x/{connect-url,connections,request}`.
 */

import type {
  CloudConnectorConnectDecision,
  CloudConnectorConnectDecisionResult,
  CloudConnectorConnectRequest,
} from "../cloud-connector-connect.js";

export const X_OAUTH_CALLBACK_PATH = "/api/x/oauth_callback";

export type IntegrationConnector = {
  type: "composio";
  toolkit: string;
  actionNamespace?: string;
  provider?: string;
};

/** One Store integration as the catalog lists it. */
export type IntegrationCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  category: string;
  auth: string[];
  /** The number of published, schema-bearing actions. */
  catalogToolCount: number;
  description: string;
  sourceUrl?: string;
  iconUrl?: string;
  status: string;
  enabled: boolean;
  updatedAt: number;
  connector?: IntegrationConnector;
};

export type IntegrationAction = {
  name: string;
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    source: "composio_tool_tags";
  };
  /** Changes whenever the action's publication does. */
  revision: string;
  inputSchema: Record<string, unknown>;
};

export type IntegrationActionsPage = {
  id: string;
  actionCount: number;
  updatedAt: number;
  actions: IntegrationAction[];
  nextCursor: string | null;
};

export type XConnection = {
  xUserId: string;
  username: string;
  name?: string;
  scopes: string[];
  updatedAt: number;
  accessTokenExpiresAt?: number;
};

export type IntegrationCalls = {
  /** The executable Store catalog. */
  "integrations.catalog": {
    args: Record<string, never>;
    result: { integrations: IntegrationCatalogEntry[] };
  };
  /**
   * One integration's actions, a page at a time, or the one named `action`.
   * `NOT_FOUND` when the integration or action is not executable.
   */
  "integrations.actions": {
    args: { id: string; action?: string; query?: string; cursor?: string; limit?: number };
    result: IntegrationActionsPage;
  };
  /** The owner's integrations with a Composio session, each with its live status. */
  "integrations.connections": {
    args: Record<string, never>;
    result: { connections: Array<{ id: string; connected: boolean }> };
  };
  /** Whether one integration is connected now. Never creates a session. */
  "integrations.status": {
    args: { id: string };
    result: { connected: boolean };
  };
  /** The hosted OAuth page that connects one integration. */
  "integrations.connectLink": {
    args: { id: string };
    result: { url: string };
  };
  /**
   * Run one published action. `requestId` is single-use: a repeat is
   * refused (`CONFLICT`, reason `request_reused`) rather than run twice. An
   * integration that is not connected is `CONFLICT`, reason `not_connected`.
   */
  "integrations.run": {
    args: { id: string; action: string; input: Record<string, unknown>; requestId: string };
    result: unknown;
  };
  /**
   * Answer a connect card. `connect` returns the hosted OAuth page to open;
   * the waiting turn sees the connection on its next poll.
   */
  "connect.decide": {
    args: {
      requestId: string;
      expectedRevision: number;
      decisionRequestId: string;
      decision: CloudConnectorConnectDecision;
    };
    result: CloudConnectorConnectDecisionResult;
  };
  /** X's authorize page for this owner, valid for ten minutes. */
  "x.connectUrl": {
    args: Record<string, never>;
    result: { url: string; expiresAt: number };
  };
  "x.connections": {
    args: Record<string, never>;
    result: { connections: XConnection[] };
  };
  /** Proxy one X API v2 request with the owner's token. */
  "x.request": {
    args: {
      method?: string;
      path: string;
      query?: Record<string, unknown>;
      body?: unknown;
    };
    result: { status: number; payload: unknown };
  };
};

export type IntegrationViews = {
  /** Connect cards still waiting on the user, newest first. */
  "connect.pending": {
    args: Record<string, never>;
    result: CloudConnectorConnectRequest[];
  };
};
