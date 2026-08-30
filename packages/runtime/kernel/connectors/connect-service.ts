/**
 * Connector client engine behind the node_repl `connect` client
 * (`createReplConnectClient`) — the first-class agent surface for
 * third-party app integrations (discover / connectors / actions /
 * schema / call), dispatched host-side by the Node REPL kernel.
 *
 * Everything here throws plain Errors (the broker's message included);
 * the REPL kernel serializes them across the worker boundary so agent
 * code sees a thrown Error.
 *
 * Backend Composio actions run through the same trusted path as always:
 * CLI bridge UDS → worker `backend-connector-action-broker` (Ajv input
 * validation + tiered action allowlist) → stella.sh backend.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { callApiConnector } from "./api-client.js";
import {
  resolveNativeConnectorCatalog,
  type NativeCatalogSource,
  type ResolvedNativeCatalog,
} from "./catalog-cache.js";
import { getNativeConnectorReadiness } from "./connection-status.js";
import {
  requestBackendConnectorActionFromBridge,
  requestBackendConnectorActionsFromBridge,
  requestConnectorCredentialFromBridge,
  type BackendConnectorActionResult,
  type ConnectorCredentialResult,
} from "./cli-broker-client.js";
import { discoverConnectors } from "./discovery.js";
import {
  callConnectorBridgeTool,
  closeConnectorBridgeSessions,
  ConnectorAuthError,
  probeConnectorBridgeTools,
  type ConnectorBridgeProbe,
} from "./connector-bridge.js";
import {
  listConfiguredApiConnectors,
  listConfiguredConnectorCommands,
  removeConfiguredConnector,
  saveConfiguredConnectorCommands,
} from "./state.js";
import {
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
  loadConnectorTokenPayload,
} from "./oauth.js";
import {
  getNativeOAuthProviderConfig,
  type NativeOAuthProviderConfig,
} from "./native-oauth-provider-config.js";
import {
  backendIntegrationRunToolName,
  getNativeConnectorCatalogActions,
  getNativeConnectorCatalogEntry,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  listNativeConnectors,
  nativeOAuthApiRequestToolName,
  summarizeActionParams,
  type NativeConnectorCatalogEntry,
} from "./native-integrations.js";
import type { ConnectorCommandConfig, ConnectorToolInfo } from "./types.js";
import { loadGoogleWorkspaceTools } from "../google-workspace/load-google-workspace-tools.js";

export type ConnectClientOptions = {
  stellaAppDir: string;
  /** UDS path of the worker's CLI bridge (credential dialogs + broker). */
  cliBridgeSocketPath?: string;
  /** Non-fatal bridge diagnostics (logged by the host). */
  onBridgeUnreachable?: (message: string) => void;
};

/** Default/hard caps for `connect.actions` listings. */
export const CONNECT_ACTIONS_DEFAULT_LIMIT = 25;
export const CONNECT_ACTIONS_MAX_LIMIT = 100;

/**
 * Broker refusals/failures surface as this error so callers can branch on
 * `reason` without parsing the message. The message carries the broker's
 * own text plus status/request diagnostics.
 */
export class ConnectorBrokerActionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ConnectorBrokerActionError";
  }
}

export type ConnectorAuthHints = {
  authType: "api_key" | "oauth" | undefined;
  resourceUrl?: string;
  oauthClientId?: string;
  oauthResource?: string;
  scopes?: string[];
  preregisteredOAuth?: {
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint?: string;
    responseType?: "code" | "token";
    resourceUrl?: string;
    oauthResource?: string | null;
    callbackUrl?: string;
    callbackId?: string;
    callbackMode?: "local" | "external";
    scopeSeparator?: string;
    usesPkce?: boolean;
    authorizationClientIdParam?: string;
    authorizationRedirectParam?: string;
    authorizationParams?: Record<string, string>;
    tokenRedirectParam?: string;
    tokenAuth?: "body" | "basic";
    tokenExchange?: {
      type: "backend";
      provider: string;
    };
  };
};

export const nativeOAuthAuthHints = (
  id: string,
  config: NativeOAuthProviderConfig | null,
): ConnectorAuthHints | undefined => {
  if (!config) return undefined;
  if (config.flow !== "authorization_code") {
    return {
      authType: "oauth",
      resourceUrl: config.resourceUrl,
      oauthClientId: config.clientId,
      oauthResource: config.oauthResource ?? undefined,
      scopes: config.scopes,
    };
  }
  return {
    authType: "oauth",
    resourceUrl: config.resourceUrl ?? config.authorizationEndpoint,
    oauthClientId: config.clientId,
    oauthResource: config.oauthResource ?? undefined,
    scopes: config.scopes,
    preregisteredOAuth: {
      clientId: config.clientId,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      responseType: config.responseType,
      resourceUrl: config.resourceUrl,
      oauthResource: config.oauthResource,
      callbackUrl: config.callbackUrl,
      callbackId: config.callbackId,
      callbackMode: config.callbackMode,
      scopeSeparator: config.scopeSeparator,
      usesPkce: config.usesPkce,
      authorizationClientIdParam: config.authorizationClientIdParam,
      authorizationRedirectParam: config.authorizationRedirectParam,
      authorizationParams: config.authorizationParams,
      tokenRedirectParam: config.tokenRedirectParam,
      tokenAuth: config.tokenAuth,
      tokenExchange:
        config.tokenExchange?.type === "backend"
          ? {
              type: "backend",
              provider: config.tokenExchange.provider ?? id,
            }
          : undefined,
    },
  };
};

export const resolveConnectorAuthHints = async (
  stellaAppDir: string,
  serverDisplayName: string,
): Promise<ConnectorAuthHints> => {
  const commands = await listConfiguredConnectorCommands(stellaAppDir).catch(
    () => [],
  );
  const apis = await listConfiguredApiConnectors(stellaAppDir).catch(() => []);
  const command = commands.find(
    (entry) => entry.displayName === serverDisplayName,
  );
  if (command) {
    return {
      authType: command.auth?.type === "oauth" ? "oauth" : "api_key",
      resourceUrl: command.url,
      oauthClientId: command.auth?.clientId,
      oauthResource: command.auth?.resource,
      scopes: command.auth?.scopes,
    };
  }
  const api = apis.find((entry) => entry.displayName === serverDisplayName);
  if (api) {
    return {
      authType: api.auth?.type === "oauth" ? "oauth" : "api_key",
      resourceUrl: api.baseUrl,
      oauthClientId: api.auth?.clientId,
      oauthResource: api.auth?.resource,
      scopes: api.auth?.scopes,
    };
  }
  return { authType: undefined };
};

/**
 * Run `attempt`. If it throws `ConnectorAuthError` AND the bridge socket
 * is wired AND the error carries a `tokenKey`, dial the bridge to pop a
 * credential dialog; on `{ ok: true }` retry once. Anything else (no
 * socket, no tokenKey, user cancel/timeout, second auth failure) rethrows
 * to the caller. Single retry is intentional: a second auth failure means
 * a bad key, not that another round-trip would help.
 */
export const withAuthRetry = async <T>(
  options: ConnectClientOptions,
  attempt: () => Promise<T>,
  explicitHints?: ConnectorAuthHints,
): Promise<T> => {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ConnectorAuthError)) throw error;
    const socketPath = options.cliBridgeSocketPath;
    if (!socketPath || !error.tokenKey) throw error;

    const hints =
      explicitHints ??
      (await resolveConnectorAuthHints(
        options.stellaAppDir,
        error.serverDisplayName,
      ));

    let result: ConnectorCredentialResult;
    try {
      // No `description` — we deliberately let the renderer's canonical
      // copy fire instead of leaking the upstream HTTP status /
      // generic-error verbiage into a user-facing dialog.
      result = await requestConnectorCredentialFromBridge({
        socketPath,
        tokenKey: error.tokenKey,
        displayName: error.serverDisplayName,
        authType: hints.authType,
        resourceUrl: hints.resourceUrl,
        oauthClientId: hints.oauthClientId,
        oauthResource: hints.oauthResource,
        scopes: hints.scopes,
        preregisteredOAuth: hints.preregisteredOAuth,
      });
    } catch (bridgeError) {
      // The bridge was advertised but isn't reachable — fall through to
      // the original auth error so the agent gets a clean signal rather
      // than a confusing "socket refused" string.
      options.onBridgeUnreachable?.(
        `cli-bridge unreachable: ${(bridgeError as Error).message}`,
      );
      throw error;
    }

    if (!result.ok) throw error;
    return await attempt();
  }
};

export const findConnectorCommand = async (
  stellaAppDir: string,
  id: string,
) => {
  const commands = await listConfiguredConnectorCommands(stellaAppDir);
  return commands.find((entry) => entry.id === id);
};

export const findConnectorApi = async (stellaAppDir: string, id: string) => {
  const apis = await listConfiguredApiConnectors(stellaAppDir);
  return apis.find((entry) => entry.id === id);
};

export const withConnectorBridgeCleanup = async <T>(
  stellaAppDir: string,
  command: ConnectorCommandConfig,
  attempt: () => Promise<T>,
): Promise<T> => {
  try {
    return await attempt();
  } finally {
    await closeConnectorBridgeSessions(stellaAppDir, [command.id]);
  }
};

export const connectorAuthStatus = async (
  stellaAppDir: string,
  auth: ConnectorCommandConfig["auth"],
) => {
  if (!auth || auth.type === "none") return "unsupported" as const;
  if (!auth.tokenKey) return "not_logged_in" as const;
  return (await loadConnectorAccessToken(stellaAppDir, auth.tokenKey))
    ? "connected"
    : "not_logged_in";
};

export const nativeCatalogDiagnostics = (
  entry: NativeConnectorCatalogEntry,
  catalogSource: NativeCatalogSource,
) => {
  const toolCount = getNativeConnectorTools(entry).length;
  return {
    catalogSource,
    provider: entry.provider,
    toolCount,
  };
};

/**
 * Catalog policy shared by every consumer here: disk cache / bundled
 * fallback, never a network fetch (the connect client must stay fast and
 * offline-capable; the broker re-resolves the live catalog server-side
 * before running anything).
 */
export const loadConnectCatalog = async (
  stellaAppDir: string,
): Promise<ResolvedNativeCatalog> =>
  resolveNativeConnectorCatalog({ stellaDataDir: stellaAppDir });

export const callBackendNativeIntegration = async (
  options: ConnectClientOptions,
  id: string,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  const socketPath = options.cliBridgeSocketPath?.trim();
  if (!socketPath) {
    throw new Error(
      process.platform === "win32"
        ? "Secure connector action brokering is unavailable on Windows."
        : "The Stella connector action broker is unavailable.",
    );
  }
  const result: BackendConnectorActionResult =
    await requestBackendConnectorActionFromBridge({
      socketPath,
      connectorId: id,
      action,
      input,
    }).catch(() => ({
      ok: false as const,
      reason: "bridge_unavailable",
      message: "The Stella connector broker is unavailable.",
    }));
  if (result.ok) return result.result;
  const diagnosticSuffix = result.status
    ? ` (status ${result.status}${result.requestId ? `, request ${result.requestId}` : ""})`
    : "";
  throw new ConnectorBrokerActionError(
    `${
      result.message ??
      (result.reason === "not_signed_in"
        ? "Sign in to Stella before using this integration."
        : result.reason === "auth_expired"
          ? "Stella sign-in expired. Sign in again before using this integration."
          : "The Stella connector broker could not run this action.")
    }${diagnosticSuffix}`,
    result.reason,
    result.status,
    result.requestId,
  );
};

export const ensureNativeEnabled = async (
  options: ConnectClientOptions,
  id: string,
  catalogEntries: readonly NativeConnectorCatalogEntry[],
): Promise<NativeConnectorCatalogEntry | null> => {
  const entry = getNativeConnectorCatalogEntry(id, catalogEntries);
  if (!entry) return null;
  if (!(await isNativeConnectorEnabled(options.stellaAppDir, id))) {
    throw new Error(
      `${entry.name} is disabled. Enable it in the Store before calling it.`,
    );
  }
  return entry;
};

export type NativeConnectorCallArgs = {
  body: Record<string, unknown>;
  method?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
};

export const callNativeConnector = async (
  options: ConnectClientOptions,
  id: string,
  action: string,
  args: NativeConnectorCallArgs,
  catalogEntries: readonly NativeConnectorCatalogEntry[],
): Promise<unknown> => {
  const { stellaAppDir } = options;
  const locallyEnabled = await isNativeConnectorEnabled(stellaAppDir, id);
  const locallyResolved = getNativeConnectorCatalogEntry(id, catalogEntries);
  // A freshly authenticated desktop may have a live authoritative Store
  // entry before this process has a disk cache. Do not reinterpret bundled
  // metadata as executable, but allow the trusted broker to resolve and
  // authorize the canonical backend identity for an already-enabled id.
  if (
    locallyEnabled &&
    options.cliBridgeSocketPath?.trim() &&
    (!locallyResolved ||
      (locallyResolved.provider !== "backend-composio" &&
        locallyResolved.localExecution !== "production-ready"))
  ) {
    const runAction = backendIntegrationRunToolName(id);
    if (action === runAction) {
      const nestedAction = args.body.action;
      if (typeof nestedAction !== "string" || !nestedAction.trim()) {
        throw new Error(`${runAction} requires an action string.`);
      }
      const nestedArgs = args.body.arguments;
      return await callBackendNativeIntegration(
        options,
        id,
        nestedAction.trim(),
        nestedArgs &&
          typeof nestedArgs === "object" &&
          !Array.isArray(nestedArgs)
          ? (nestedArgs as Record<string, unknown>)
          : {},
      );
    }
    return await callBackendNativeIntegration(options, id, action, args.body);
  }
  const entry = await ensureNativeEnabled(options, id, catalogEntries);
  if (!entry) return null;
  if (
    entry.provider !== "backend-composio" &&
    entry.localExecution !== "production-ready"
  ) {
    throw new Error(
      `${entry.name} local execution is incomplete. A live or cached authoritative Store catalog entry is required.`,
    );
  }
  if (entry.provider === "backend-composio") {
    const runAction = backendIntegrationRunToolName(id);
    if (action === runAction) {
      const nestedAction = args.body.action;
      if (typeof nestedAction !== "string" || !nestedAction.trim()) {
        throw new Error(`${runAction} requires an action string.`);
      }
      const nestedArgs = args.body.arguments;
      return await callBackendNativeIntegration(
        options,
        id,
        nestedAction.trim(),
        nestedArgs &&
          typeof nestedArgs === "object" &&
          !Array.isArray(nestedArgs)
          ? (nestedArgs as Record<string, unknown>)
          : {},
      );
    }
    return await callBackendNativeIntegration(options, id, action, args.body);
  }
  const allowedTools = new Set(
    getNativeConnectorTools(entry).map((tool) => tool.name),
  );
  if (
    entry.provider === "oauth-catalog" &&
    id === "linear" &&
    action === "LINEAR_RUN_QUERY_OR_MUTATION"
  ) {
    if (typeof args.body.query !== "string" || !args.body.query.trim()) {
      throw new Error(
        "LINEAR_RUN_QUERY_OR_MUTATION requires a GraphQL `query` string.",
      );
    }
    const config = getNativeOAuthProviderConfig(id);
    const tokenPayload = config?.tokenKey
      ? await loadConnectorTokenPayload(stellaAppDir, config.tokenKey)
      : null;
    const baseUrl = tokenPayload?.resourceUrl ?? config?.resourceUrl;
    const tokenKey = config?.tokenKey;
    if (!baseUrl || !tokenKey) {
      throw new Error(
        `${entry.name} does not expose a native GraphQL endpoint yet.`,
      );
    }
    return await withAuthRetry(
      options,
      () =>
        callApiConnector(
          stellaAppDir,
          {
            id,
            displayName: entry.name,
            baseUrl,
            auth: {
              type: "oauth",
              tokenKey,
              scheme: "bearer",
              headerName: "Authorization",
            },
          },
          {
            method: "POST",
            path: "/graphql",
            body: args.body,
          },
        ),
      nativeOAuthAuthHints(id, config),
    );
  }
  const callNativeOAuthApiPath = async (
    path: string,
    pathOptions: {
      method?: string;
      query?: Record<string, string | number | boolean>;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ) => {
    const config = getNativeOAuthProviderConfig(id);
    const tokenKey = config?.tokenKey;
    if (!tokenKey) {
      throw new Error(
        `${entry.name} does not expose a native REST endpoint yet.`,
      );
    }
    const tokenInQuery = config?.apiAuthPlacement === "access_token_query";
    const attempt = async () => {
      const tokenPayload = await loadConnectorTokenPayload(
        stellaAppDir,
        tokenKey,
      );
      const baseUrl = tokenPayload?.resourceUrl ?? config?.resourceUrl;
      if (!baseUrl) {
        throw new Error(
          `${entry.name} does not expose a native REST endpoint yet.`,
        );
      }
      if (tokenInQuery && !tokenPayload?.accessToken) {
        throw new ConnectorAuthError(
          0,
          entry.name,
          tokenKey,
          `${entry.name} is not connected yet.`,
        );
      }
      const queryAccessToken =
        tokenInQuery && tokenPayload?.accessToken
          ? tokenPayload.accessToken
          : null;
      return await callApiConnector(
        stellaAppDir,
        {
          id,
          displayName: entry.name,
          baseUrl,
          auth: tokenInQuery
            ? { type: "none" }
            : {
                type: "oauth",
                tokenKey,
                scheme: config?.apiAuthScheme ?? "bearer",
                headerName: "Authorization",
              },
        },
        {
          method: pathOptions.method,
          path,
          query: {
            ...(config?.apiQueryParams ?? {}),
            ...(queryAccessToken ? { access_token: queryAccessToken } : {}),
            ...(pathOptions.query ?? {}),
          },
          body:
            pathOptions.body && Object.keys(pathOptions.body).length
              ? pathOptions.body
              : undefined,
          headers: pathOptions.headers,
        },
      );
    };
    return await withAuthRetry(
      options,
      attempt,
      nativeOAuthAuthHints(id, config),
    );
  };
  if (entry.provider === "oauth-catalog" && action.startsWith("/")) {
    return await callNativeOAuthApiPath(action, {
      method: args.method,
      query: args.query,
      body: args.body,
      headers: args.headers,
    });
  }
  if (
    entry.provider === "oauth-catalog" &&
    action === nativeOAuthApiRequestToolName(id)
  ) {
    const path = args.body.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(`${action} requires a \`path\` string beginning with /.`);
    }
    const method = args.body.method;
    const query = args.body.query;
    const body = args.body.body;
    const headers = args.body.headers;
    return await callNativeOAuthApiPath(path, {
      method: typeof method === "string" ? method : args.method,
      query:
        query && typeof query === "object" && !Array.isArray(query)
          ? (query as Record<string, string | number | boolean>)
          : args.query,
      body:
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {},
      headers:
        headers && typeof headers === "object" && !Array.isArray(headers)
          ? Object.fromEntries(
              Object.entries(headers).flatMap(([key, value]) =>
                typeof value === "string" ? [[key, value]] : [],
              ),
            )
          : args.headers,
    });
  }
  if (!allowedTools.has(action)) {
    throw new Error(
      `${entry.name} does not expose ${action}. List its actions with connect.actions("${id}").`,
    );
  }
  if (entry.provider !== "google-workspace") {
    throw new Error(
      `${entry.name} is connected for OAuth catalog metadata, but Stella does not have a native tool dispatcher for it yet.`,
    );
  }
  const { callTool, disconnect } = await loadGoogleWorkspaceTools({
    stellaAppDir,
  });
  try {
    if (callTool) return await callTool(action, args.body);
    throw new Error("Google Workspace tools are unavailable.");
  } finally {
    await disconnect().catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// MCP connector management (connect.addMcp / connect.remove)
// ---------------------------------------------------------------------------

/** Marks skills this module generated so remove/refresh never touch user files. */
const MCP_GENERATED_SKILL_MARKER = "<!-- stella-connect-mcp-skill -->";
/**
 * Sentinel inside a generated MCP skill whose probe was deferred on auth.
 * `connect.actions`/`connect.schema` regenerate the skill automatically the
 * first time a tools listing succeeds after the credential lands (that is
 * the folded-in replacement for the old CLI's `refresh-skill`).
 */
const MCP_SKILL_DEFERRED_MARKER =
  "Action list deferred until credentials are configured";
/** Same cap as the native skill generator's ACTIONS.md top-N. */
const MCP_SKILL_ACTIONS_LIMIT = 30;

const connectorSkillDir = (stellaAppDir: string, id: string) =>
  path.join(stellaAppDir, "skills", id);

/** Mirrors the old CLI's `safeId`, throwing instead of exiting. */
export const validateMcpConnectorId = (value: string): string => {
  const id = value.trim().toLowerCase();
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    !/^[a-z0-9._-]+$/u.test(id)
  ) {
    throw new Error(
      `Invalid connector id: ${value}. Use lowercase letters, digits, ".", "_", "-".`,
    );
  }
  return id;
};

export type AddMcpTransport =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string };

export type AddMcpOptions = {
  id: string;
  name?: string;
  description?: string;
  transport: AddMcpTransport;
  auth?: {
    type: "oauth" | "api_key";
    tokenKey?: string;
    headerName?: string;
    scheme?: "bearer" | "basic" | "oauth" | "raw";
  };
};

export type AddMcpResult = {
  imported: ConnectorCommandConfig;
  toolCount: number;
  skillPath: string;
  probeDeferred?: true;
  hint?: string;
};

export type RemoveConnectorResult = {
  removed: { commands: number; apis: number };
  deletedTokenKeys: string[];
  skillRemoved: boolean;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isStringRecordValue = (
  value: unknown,
): value is Record<string, string> =>
  isPlainRecord(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

/** Strict shape check for `connect.addMcp` options with actionable errors. */
export const parseAddMcpOptions = (raw: Record<string, unknown>): {
  command: ConnectorCommandConfig;
} => {
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    throw new Error("connect.addMcp requires an id string.");
  }
  const id = validateMcpConnectorId(raw.id);
  const displayName =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;

  const transport = raw.transport;
  if (!isPlainRecord(transport)) {
    throw new Error(
      'connect.addMcp requires transport: { url } or { command, args?, env?, cwd? }.',
    );
  }
  const url = typeof transport.url === "string" ? transport.url.trim() : "";
  const commandName =
    typeof transport.command === "string" ? transport.command.trim() : "";
  if (Boolean(url) === Boolean(commandName)) {
    throw new Error(
      "connect.addMcp transport must have exactly one of url or command.",
    );
  }
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`connect.addMcp transport.url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("connect.addMcp transport.url must be http(s).");
    }
  }
  if (transport.args !== undefined && !isStringArray(transport.args)) {
    throw new Error("connect.addMcp transport.args must be an array of strings.");
  }
  if (transport.env !== undefined && !isStringRecordValue(transport.env)) {
    throw new Error(
      "connect.addMcp transport.env must be a string-to-string record.",
    );
  }
  if (transport.cwd !== undefined && typeof transport.cwd !== "string") {
    throw new Error("connect.addMcp transport.cwd must be a string.");
  }

  let auth: ConnectorCommandConfig["auth"] = { type: "none" };
  if (raw.auth !== undefined) {
    if (!isPlainRecord(raw.auth)) {
      throw new Error("connect.addMcp auth must be a plain object.");
    }
    const authType = raw.auth.type;
    if (authType !== "oauth" && authType !== "api_key") {
      throw new Error('connect.addMcp auth.type must be "oauth" or "api_key".');
    }
    const tokenKey =
      typeof raw.auth.tokenKey === "string" && raw.auth.tokenKey.trim()
        ? raw.auth.tokenKey.trim()
        : id;
    const headerName =
      typeof raw.auth.headerName === "string" && raw.auth.headerName.trim()
        ? raw.auth.headerName.trim()
        : undefined;
    const scheme = raw.auth.scheme;
    if (
      scheme !== undefined &&
      scheme !== "bearer" &&
      scheme !== "basic" &&
      scheme !== "oauth" &&
      scheme !== "raw"
    ) {
      throw new Error(
        'connect.addMcp auth.scheme must be "bearer" | "basic" | "oauth" | "raw".',
      );
    }
    auth = {
      type: authType,
      tokenKey,
      ...(headerName ? { headerName } : {}),
      ...(scheme ? { scheme } : {}),
    };
  }

  const command: ConnectorCommandConfig = url
    ? {
        id,
        displayName,
        ...(description ? { description } : {}),
        transport: "streamable_http",
        url,
        auth,
      }
    : {
        id,
        displayName,
        ...(description ? { description } : {}),
        transport: "stdio",
        command: commandName,
        args: isStringArray(transport.args) ? transport.args : [],
        ...(typeof transport.cwd === "string" && transport.cwd
          ? { cwd: transport.cwd }
          : {}),
        ...(isStringRecordValue(transport.env) &&
        Object.keys(transport.env).length
          ? { env: transport.env }
          : {}),
        auth,
      };
  return { command };
};

/** Port of the old CLI skill generator, teaching connect.* instead of a shell CLI. */
export const writeGeneratedMcpSkill = async (
  stellaAppDir: string,
  command: ConnectorCommandConfig,
  tools: ConnectorToolInfo[],
  options: { probeDeferred?: boolean; instructions?: string } = {},
): Promise<string> => {
  const skillDir = connectorSkillDir(stellaAppDir, command.id);
  await fs.mkdir(skillDir, { recursive: true });
  const shownTools = tools.slice(0, MCP_SKILL_ACTIONS_LIMIT);
  const remaining = tools.length - shownTools.length;
  const toolLines = shownTools.length
    ? shownTools
        .map((tool) => {
          const description = tool.description
            ? ` - ${collapseLine(tool.description, 200)}`
            : "";
          return `- \`${tool.name}\`${description}`;
        })
        .join("\n") +
      (remaining > 0
        ? `\n\n${remaining} more actions are not listed here. Find them with \`await connect.actions("${command.id}", { query: "<keywords>" })\`.`
        : "")
    : options.probeDeferred
      ? `- _${MCP_SKILL_DEFERRED_MARKER}. The list fills in automatically the first time \`await connect.actions("${command.id}")\` succeeds after auth._`
      : `- List available actions with \`await connect.actions("${command.id}")\`.`;
  const description =
    command.description ??
    `Use the ${command.displayName} connector from Stella.`;
  const instructionsSection = options.instructions
    ? `\n## Server instructions\n\n${options.instructions.trim()}\n`
    : "";
  const body = `---
name: ${command.id}
description: ${description.replace(/\n+/gu, " ")}
---
${MCP_GENERATED_SKILL_MARKER}

# ${command.displayName}

Imported MCP connector. Use the frozen \`connect\` client inside \`code\`:

\`\`\`js
await connect.actions("${command.id}", { query: "<keywords>" }); // find actions (capped list)
await connect.schema("${command.id}", "<ACTION>");               // full input schema for one action
await connect.call("${command.id}", "<ACTION>", { /* args */ }); // execute; throws on refusal
\`\`\`
${instructionsSection}
## Actions

${toolLines}
`;
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, body, "utf-8");
  return skillPath;
};

/**
 * Auto-refresh for auth-deferred imports: once a real tools listing
 * succeeds, rewrite the stub skill with the actual action list (and the
 * server's `instructions`, if it published any). No-ops on user-authored
 * or already-complete skills.
 */
const refreshDeferredMcpSkill = async (
  stellaAppDir: string,
  command: ConnectorCommandConfig,
  probe: ConnectorBridgeProbe,
): Promise<void> => {
  if (probe.tools.length === 0) return;
  const skillPath = path.join(
    connectorSkillDir(stellaAppDir, command.id),
    "SKILL.md",
  );
  const content = await fs.readFile(skillPath, "utf-8").catch(() => null);
  if (
    !content?.includes(MCP_GENERATED_SKILL_MARKER) ||
    !content.includes(MCP_SKILL_DEFERRED_MARKER)
  ) {
    return;
  }
  await writeGeneratedMcpSkill(stellaAppDir, command, probe.tools, {
    ...(probe.instructions ? { instructions: probe.instructions } : {}),
  });
};

/**
 * Shared MCP tools listing: probe through the bridge (popping the auth
 * dialog on 401/403 via `withAuthRetry`), then opportunistically complete
 * a deferred generated skill while the session is still warm.
 */
const probeMcpConnector = async (
  options: ConnectClientOptions,
  command: ConnectorCommandConfig,
): Promise<ConnectorBridgeProbe> => {
  const probe = await withConnectorBridgeCleanup(
    options.stellaAppDir,
    command,
    () =>
      withAuthRetry(options, () =>
        probeConnectorBridgeTools(options.stellaAppDir, command),
      ),
  );
  await refreshDeferredMcpSkill(options.stellaAppDir, command, probe).catch(
    () => undefined,
  );
  return probe;
};

/**
 * `connect.addMcp` engine: validate → probe (auth failures deferred,
 * other failures fatal) → persist to commands.json → generate the
 * connector skill.
 */
export const addMcpConnector = async (
  options: ConnectClientOptions,
  raw: Record<string, unknown>,
): Promise<AddMcpResult> => {
  const { stellaAppDir } = options;
  const { command } = parseAddMcpOptions(raw);

  // Probe before persisting (a broken server must not get silently
  // imported); auth failures are non-fatal because the user already
  // declared the auth shape — credentials land on first use instead.
  let probe: ConnectorBridgeProbe = { tools: [] };
  let probeDeferred = false;
  let probeDeferredReason: string | undefined;
  try {
    probe = await withConnectorBridgeCleanup(stellaAppDir, command, () =>
      withAuthRetry(
        options,
        () => probeConnectorBridgeTools(stellaAppDir, command),
        {
          authType: command.auth?.type === "oauth" ? "oauth" : "api_key",
          resourceUrl: command.url,
        },
      ),
    );
  } catch (error) {
    if (
      error instanceof ConnectorAuthError &&
      command.auth &&
      command.auth.type !== "none"
    ) {
      probeDeferred = true;
      probeDeferredReason = error.message;
    } else {
      throw error;
    }
  }

  const existing = await listConfiguredConnectorCommands(stellaAppDir);
  const next = new Map(existing.map((entry) => [entry.id, entry]));
  next.set(command.id, command);
  await saveConfiguredConnectorCommands(
    stellaAppDir,
    [...next.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  );
  const skillPath = await writeGeneratedMcpSkill(
    stellaAppDir,
    command,
    probe.tools,
    {
      probeDeferred,
      ...(probe.instructions ? { instructions: probe.instructions } : {}),
    },
  );
  return {
    imported: command,
    toolCount: probe.tools.length,
    skillPath,
    ...(probeDeferred
      ? {
          probeDeferred: true as const,
          hint: `The server requires auth (${collapseLine(probeDeferredReason, 200)}). The connector was saved anyway: the credential dialog pops on first use, and the skill's action list fills in automatically once await connect.actions("${command.id}") succeeds.`,
        }
      : {}),
  };
};

/**
 * `connect.remove` engine: drop from commands.json/api-connectors.json →
 * close live bridge sessions → delete the generated skill → delete stored
 * credentials for the connector's tokenKeys (fixing the old CLI's
 * token-leak wart).
 */
export const removeMcpConnector = async (
  options: ConnectClientOptions,
  rawId: string,
  resolved: ResolvedNativeCatalog,
): Promise<RemoveConnectorResult> => {
  const { stellaAppDir } = options;
  const id = validateMcpConnectorId(rawId);
  if (getNativeConnectorCatalogEntry(id, resolved.entries)) {
    throw new Error(
      `${id} is a native Store integration. Disable it in the Store instead of connect.remove.`,
    );
  }
  const [command, api] = await Promise.all([
    findConnectorCommand(stellaAppDir, id),
    findConnectorApi(stellaAppDir, id),
  ]);
  if (!command && !api) {
    throw new Error(
      `Connector is not installed: ${id}. List installed connectors with connect.connectors().`,
    );
  }
  const removed = await removeConfiguredConnector(stellaAppDir, id);
  await closeConnectorBridgeSessions(stellaAppDir, [id]);

  const tokenKeys = [
    ...new Set(
      [
        ...removed.removedCommands.map((entry) => entry.auth?.tokenKey),
        ...removed.removedApis.map((entry) => entry.auth?.tokenKey),
      ].filter((key): key is string => Boolean(key)),
    ),
  ];
  await deleteConnectorAccessTokens(stellaAppDir, tokenKeys);

  let skillRemoved = false;
  const skillDir = connectorSkillDir(stellaAppDir, id);
  const skillContent = await fs
    .readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    .catch(() => null);
  if (skillContent?.includes(MCP_GENERATED_SKILL_MARKER)) {
    await fs.rm(skillDir, { recursive: true, force: true });
    skillRemoved = true;
  }

  return {
    removed: {
      commands: removed.removedCommands.length,
      apis: removed.removedApis.length,
    },
    deletedTokenKeys: tokenKeys,
    skillRemoved,
  };
};

// ---------------------------------------------------------------------------
// Discovery / listing surface (shared by the CLI and the REPL client)
// ---------------------------------------------------------------------------

export type DetailedDiscoveryMatch = {
  id: string;
  name: string;
  kind: "native" | "mcp" | "api";
  category?: string;
  description: string;
  enabled: boolean;
  connected: boolean;
  declined: boolean;
  next: string;
  catalogSource?: NativeCatalogSource;
  provider?: NativeConnectorCatalogEntry["provider"];
  toolCount?: number;
  providerStatus?: string;
  accountVerified?: boolean;
  executable?: boolean;
};

/**
 * Discovery enriched with live connection state and a `next` hint per
 * match, so `connect.discover` tells the agent what to do with each
 * result instead of leaving it to guess.
 */
export const discoverConnectorsDetailed = async (
  options: ConnectClientOptions,
  query: string,
  resolved: ResolvedNativeCatalog,
): Promise<DetailedDiscoveryMatch[]> => {
  const { stellaAppDir } = options;
  const native = await listNativeConnectors(stellaAppDir, {}, resolved.entries);
  const enabledNativeIds = new Set(
    native.filter((entry) => entry.enabled).map((entry) => entry.id),
  );
  const matches = await discoverConnectors(stellaAppDir, query, {
    catalogOverride: resolved.entries,
    enabledNativeIds,
  });
  return await Promise.all(
    matches.map(async (match) => {
      let connected = false;
      let nativeEntry: NativeConnectorCatalogEntry | undefined;
      let nativeReadiness:
        | Awaited<ReturnType<typeof getNativeConnectorReadiness>>
        | undefined;
      if (match.kind === "native") {
        nativeEntry = getNativeConnectorCatalogEntry(
          match.id,
          resolved.entries,
        );
        nativeReadiness = nativeEntry
          ? await getNativeConnectorReadiness(stellaAppDir, nativeEntry)
          : undefined;
        connected = nativeReadiness?.executable ?? false;
      } else {
        const config =
          match.kind === "mcp"
            ? await findConnectorCommand(stellaAppDir, match.id)
            : await findConnectorApi(stellaAppDir, match.id);
        const authStatus = await connectorAuthStatus(
          stellaAppDir,
          config?.auth,
        );
        // "unsupported" means the connector needs no credential — it is
        // usable as-is.
        connected = authStatus === "connected" || authStatus === "unsupported";
      }
      const next = connected
        ? `Ready. Inspect actions: await connect.actions("${match.id}").`
        : match.declined
          ? "The user previously declined connecting this in chat. Do not offer it again; they can enable it in the Store."
          : match.kind === "native"
            ? `Not connected. Connect offers are handled by the orchestrator's connector_status tool (inline connect card) or the Store — do not initiate one from here unless the user explicitly asked this turn. Proceed via the browser/computer fallback meanwhile.`
            : `Configured but not authorized. Calling it pops the auth dialog: await connect.actions("${match.id}").`;
      return {
        id: match.id,
        name: match.name,
        kind: match.kind,
        ...(match.category ? { category: match.category } : {}),
        description: match.description,
        enabled: match.enabled,
        connected,
        ...(match.kind === "native" && nativeEntry
          ? {
              ...nativeCatalogDiagnostics(
                nativeEntry,
                resolved.sources[nativeEntry.id] ?? resolved.source,
              ),
              providerStatus: nativeReadiness?.authStatus,
              accountVerified: nativeReadiness?.accountVerified ?? false,
              executable: nativeReadiness?.executable ?? false,
            }
          : {}),
        declined: match.declined,
        next,
      };
    }),
  );
};

const collapseLine = (value: string | undefined, max = 140): string => {
  const collapsed = (value ?? "").replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
};

export type ConnectorSummary = {
  id: string;
  name: string;
  kind: "native" | "mcp" | "api";
  connected: boolean;
  description: string;
};

/** Enabled/connected connectors as one-liners (REPL `connect.connectors()`). */
export const listEnabledConnectorSummaries = async (
  options: ConnectClientOptions,
  resolved: ResolvedNativeCatalog,
): Promise<ConnectorSummary[]> => {
  const { stellaAppDir } = options;
  const [native, commands, apis] = await Promise.all([
    listNativeConnectors(stellaAppDir, {}, resolved.entries),
    listConfiguredConnectorCommands(stellaAppDir).catch(() => []),
    listConfiguredApiConnectors(stellaAppDir).catch(() => []),
  ]);
  const summaries: ConnectorSummary[] = await Promise.all(
    native
      .filter((entry) => entry.enabled)
      .map(async (entry) => {
        const readiness = await getNativeConnectorReadiness(
          stellaAppDir,
          entry,
        );
        return {
          id: entry.id,
          name: entry.name,
          kind: "native" as const,
          connected: readiness.executable,
          description: collapseLine(entry.description),
        };
      }),
  );
  for (const command of commands) {
    const authStatus = await connectorAuthStatus(stellaAppDir, command.auth);
    summaries.push({
      id: command.id,
      name: command.displayName,
      kind: "mcp",
      connected: authStatus === "connected" || authStatus === "unsupported",
      description: collapseLine(command.description),
    });
  }
  for (const api of apis) {
    const authStatus = await connectorAuthStatus(stellaAppDir, api.auth);
    summaries.push({
      id: api.id,
      name: api.displayName,
      kind: "api",
      connected: authStatus === "connected" || authStatus === "unsupported",
      description: collapseLine(api.description),
    });
  }
  return summaries;
};

export type ConnectorActionSummary = {
  name: string;
  description: string;
  params?: string;
};

export type ConnectorActionsList = {
  connector: string;
  total: number;
  shown: number;
  actions: ConnectorActionSummary[];
  hint?: string;
};

type ActionLike = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const filterActionsByQuery = (
  actions: readonly ActionLike[],
  query: string | undefined,
): ActionLike[] => {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return [...actions];
  return actions.filter((action) => {
    const haystack = `${action.name} ${action.description ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
};

export const clampActionLimit = (limit: unknown): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return CONNECT_ACTIONS_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(CONNECT_ACTIONS_MAX_LIMIT, Math.floor(limit)));
};

const toActionsList = (
  connector: string,
  actions: readonly ActionLike[],
  listOptions: { query?: string; limit?: number },
): ConnectorActionsList => {
  const filtered = filterActionsByQuery(actions, listOptions.query);
  const limit = clampActionLimit(listOptions.limit);
  const shownActions = filtered.slice(0, limit).map((action) => ({
    name: action.name,
    description: collapseLine(action.description),
    ...(action.inputSchema
      ? { params: summarizeActionParams(action.inputSchema) }
      : {}),
  }));
  return {
    connector,
    total: filtered.length,
    shown: shownActions.length,
    actions: shownActions,
    ...(filtered.length > shownActions.length
      ? {
          hint: `Showing ${shownActions.length} of ${filtered.length}. Narrow with { query } or raise { limit } (max ${CONNECT_ACTIONS_MAX_LIMIT}). connect.schema("${connector}", "<ACTION>") returns one full input schema.`,
        }
      : {}),
  };
};

/** Capped, filterable action listing for one connector. */
export const listConnectorActionSummaries = async (
  options: ConnectClientOptions,
  id: string,
  listOptions: { query?: string; limit?: number },
  resolved: ResolvedNativeCatalog,
): Promise<ConnectorActionsList> => {
  const native = getNativeConnectorCatalogEntry(id, resolved.entries);
  if (native) {
    const catalogActions = getNativeConnectorCatalogActions(native);
    if (
      catalogActions.length === 0 &&
      native.provider === "backend-composio" &&
      options.cliBridgeSocketPath?.trim()
    ) {
      const backendActions = await requestBackendConnectorActionsFromBridge({
        socketPath: options.cliBridgeSocketPath.trim(),
        connectorId: id,
        ...(listOptions.query?.trim()
          ? { query: listOptions.query.trim() }
          : {}),
        limit: clampActionLimit(listOptions.limit),
      }).catch(() => null);
      if (backendActions?.ok) {
        return toActionsList(id, backendActions.actions, listOptions);
      }
    }
    const source: ActionLike[] = catalogActions.length
      ? catalogActions.map((action) => ({
          name: action.name,
          description: action.description ?? action.title,
          ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
        }))
      : getNativeConnectorTools(native).map((tool) => ({
          name: tool.name,
          description: tool.description,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        }));
    return toActionsList(id, source, listOptions);
  }
  const command = await findConnectorCommand(options.stellaAppDir, id);
  if (command) {
    const probe = await probeMcpConnector(options, command);
    return toActionsList(
      id,
      probe.tools.map((tool: ConnectorToolInfo) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      })),
      listOptions,
    );
  }
  const api = await findConnectorApi(options.stellaAppDir, id);
  if (api) {
    return {
      connector: id,
      total: 0,
      shown: 0,
      actions: [],
      hint: `${api.displayName} is a REST API connector. Call paths directly: connect.call("${id}", "/some/path", { method: "GET", query: {} }).`,
    };
  }
  throw new Error(
    `Connector is not installed or known: ${id}. Search with connect.discover("<keywords>").`,
  );
};

export type ConnectorActionSchema = {
  connector: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown> | null;
  note?: string;
};

/** Full input schema for one action (on-demand replacement for ACTIONS.md). */
export const getConnectorActionSchema = async (
  options: ConnectClientOptions,
  id: string,
  action: string,
  resolved: ResolvedNativeCatalog,
): Promise<ConnectorActionSchema> => {
  const wanted = action.trim();
  const native = getNativeConnectorCatalogEntry(id, resolved.entries);
  const finish = (match: ActionLike & { title?: string }) => ({
    connector: id,
    name: match.name,
    ...(match.title ? { title: match.title } : {}),
    ...(match.description
      ? { description: collapseLine(match.description, 500) }
      : {}),
    inputSchema: match.inputSchema ?? null,
    ...(match.inputSchema
      ? {}
      : {
          note: "No input schema is published locally; the backend validates arguments when the action runs.",
        }),
  });
  if (native) {
    const catalogMatch = getNativeConnectorCatalogActions(native).find(
      (candidate) => candidate.name === wanted,
    );
    if (catalogMatch) return finish(catalogMatch);
    const toolMatch = getNativeConnectorTools(native).find(
      (tool) => tool.name === wanted,
    );
    if (toolMatch) return finish(toolMatch);
    if (
      native.provider === "backend-composio" &&
      options.cliBridgeSocketPath?.trim()
    ) {
      const backendActions = await requestBackendConnectorActionsFromBridge({
        socketPath: options.cliBridgeSocketPath.trim(),
        connectorId: id,
        action: wanted,
      }).catch(() => null);
      const backendMatch = backendActions?.ok
        ? backendActions.actions.find((candidate) => candidate.name === wanted)
        : undefined;
      if (backendMatch) return finish(backendMatch);
    }
    throw new Error(
      `Unknown action ${wanted} for ${id}. List actions with connect.actions("${id}", { query: "<keywords>" }).`,
    );
  }
  const command = await findConnectorCommand(options.stellaAppDir, id);
  if (command) {
    const probe = await probeMcpConnector(options, command);
    const match = probe.tools.find((tool) => tool.name === wanted);
    if (match) return finish(match);
    throw new Error(
      `Unknown action ${wanted} for ${id}. List actions with connect.actions("${id}").`,
    );
  }
  throw new Error(
    `Connector is not installed or known: ${id}. Search with connect.discover("<keywords>").`,
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toStringRecord = (value: unknown): Record<string, string> | undefined =>
  isPlainRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key, entry]] : [],
        ),
      )
    : undefined;

const toQueryRecord = (
  value: unknown,
): Record<string, string | number | boolean> | undefined =>
  isPlainRecord(value)
    ? (Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) =>
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean"
            ? [[key, entry]]
            : [],
        ),
      ) as Record<string, string | number | boolean>)
    : undefined;

/**
 * Execute a connector action with REPL-shaped arguments. `target` is an
 * action name, or (for REST-capable connectors) an API path beginning with
 * "/" whose `args` may carry `{ method, query, body, headers }`.
 */
export const callConnectorAction = async (
  options: ConnectClientOptions,
  id: string,
  target: string,
  args: Record<string, unknown>,
  resolved: ResolvedNativeCatalog,
): Promise<unknown> => {
  const pathArgs = () => {
    const { method, query, headers, body, ...rest } = args;
    return {
      body: isPlainRecord(body) ? body : rest,
      method: typeof method === "string" ? method : undefined,
      query: toQueryRecord(query),
      headers: toStringRecord(headers),
    };
  };
  const isKnownNative =
    getNativeConnectorCatalogEntry(id, resolved.entries) !== undefined;
  // An enabled id with a bridge socket may execute through the trusted
  // broker even when the local catalog cannot resolve it (fresh desktop
  // sign-in before the disk cache exists).
  const brokerEligible =
    !isKnownNative &&
    options.cliBridgeSocketPath?.trim() &&
    (await isNativeConnectorEnabled(options.stellaAppDir, id));
  if (isKnownNative || brokerEligible) {
    if (target.startsWith("/")) {
      return await callNativeConnector(
        options,
        id,
        target,
        pathArgs(),
        resolved.entries,
      );
    }
    return await callNativeConnector(
      options,
      id,
      target,
      { body: args },
      resolved.entries,
    );
  }
  if (target.startsWith("/")) {
    const api = await findConnectorApi(options.stellaAppDir, id);
    if (!api) throw new Error(`API connector is not installed: ${id}`);
    const { body, method, query, headers } = pathArgs();
    return await withAuthRetry(options, () =>
      callApiConnector(options.stellaAppDir, api, {
        method,
        path: target,
        query: query ?? {},
        body: Object.keys(body).length ? body : undefined,
        headers: headers ?? {},
      }),
    );
  }
  const command = await findConnectorCommand(options.stellaAppDir, id);
  if (!command) {
    throw new Error(
      `Connector is not installed: ${id}. Search with connect.discover("<keywords>").`,
    );
  }
  return await withConnectorBridgeCleanup(options.stellaAppDir, command, () =>
    withAuthRetry(options, () =>
      callConnectorBridgeTool(options.stellaAppDir, command, target, args),
    ),
  );
};

// ---------------------------------------------------------------------------
// node_repl `connect` client
// ---------------------------------------------------------------------------

/**
 * Host-side implementation of the frozen `connect` object inside node_repl.
 * The Node REPL kernel dispatches worker `connect-call` messages onto these
 * methods; results/thrown Errors are serialized back into the REPL.
 */
export type ReplConnectClient = {
  discover(query: string): Promise<unknown>;
  connectors(): Promise<unknown>;
  actions(
    id: string,
    options?: { query?: string; limit?: number },
  ): Promise<unknown>;
  schema(id: string, action: string): Promise<unknown>;
  call(
    id: string,
    action: string,
    args?: Record<string, unknown>,
  ): Promise<unknown>;
  addMcp(options: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
};

export const createReplConnectClient = (
  options: ConnectClientOptions,
): ReplConnectClient => {
  const catalog = () => loadConnectCatalog(options.stellaAppDir);
  return {
    discover: async (query) => {
      const trimmed = typeof query === "string" ? query.trim() : "";
      if (!trimmed) {
        throw new Error("connect.discover requires a non-empty query string.");
      }
      const matches = await discoverConnectorsDetailed(
        options,
        trimmed,
        await catalog(),
      );
      return { query: trimmed, matches };
    },
    connectors: async () =>
      await listEnabledConnectorSummaries(options, await catalog()),
    actions: async (id, listOptions) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("connect.actions requires a connector id.");
      }
      const opts = isPlainRecord(listOptions) ? listOptions : {};
      return await listConnectorActionSummaries(
        options,
        id.trim(),
        {
          ...(typeof opts.query === "string" ? { query: opts.query } : {}),
          ...(typeof opts.limit === "number" ? { limit: opts.limit } : {}),
        },
        await catalog(),
      );
    },
    schema: async (id, action) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("connect.schema requires a connector id.");
      }
      if (typeof action !== "string" || !action.trim()) {
        throw new Error("connect.schema requires an action name.");
      }
      return await getConnectorActionSchema(
        options,
        id.trim(),
        action,
        await catalog(),
      );
    },
    call: async (id, action, args) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("connect.call requires a connector id.");
      }
      if (typeof action !== "string" || !action.trim()) {
        throw new Error("connect.call requires an action name or /path.");
      }
      const input = args === undefined ? {} : args;
      if (!isPlainRecord(input)) {
        throw new Error("connect.call args must be a plain object.");
      }
      return await callConnectorAction(
        options,
        id.trim(),
        action.trim(),
        input,
        await catalog(),
      );
    },
    addMcp: async (addOptions) => {
      if (!isPlainRecord(addOptions)) {
        throw new Error("connect.addMcp requires an options object.");
      }
      return await addMcpConnector(options, addOptions);
    },
    remove: async (id) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("connect.remove requires a connector id.");
      }
      return await removeMcpConnector(options, id.trim(), await catalog());
    },
  };
};
