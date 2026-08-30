export const INTERIOR_SHELL_AUDIENCE = "stella-interior-shell-v1" as const;
export const INTERIOR_SHELL_MAX_TTL_MS = 2 * 60_000;

const TOKEN_VERSION = "v1";
const TOKEN_AAD = new TextEncoder().encode(INTERIOR_SHELL_AUDIENCE);
const TOKEN_MAX_LENGTH = 16_384;
const JWT_MAX_LENGTH = 8_192;
const CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const STABLE_ROUTE_ID =
  /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUSTOM_INTERIOR_BUILD_ID = /^interior-[0-9a-f]{48}$/;
const DEFAULT_INTERIOR_BUILD_ID = /^interior\/[A-Za-z0-9._-]{1,128}$/;
const TOKEN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Keep these lists explicit. A generated interior must not inherit every
 * public Convex function simply because the viewer has an account JWT.
 */
export const INTERIOR_QUERY_UDF_ALLOWLIST = [
  "auth_migration:getMyOwnershipMigrationStatus",
  "cloud_apps:confirmMySessionIdentity",
  "cloud_apps:getCloudRealtimeConfig",
  "cloud_apps:getMyCloudConversationIdentity",
  "cloud_apps:getMyConversation",
  "cloud_apps:getMyConversationHistorySnapshot",
  "cloud_apps:listMyAgentThreads",
  "cloud_apps:listMyAgentThreadsPage",
  "cloud_apps:listMyAppBuilds",
  "cloud_apps:listMyApps",
  "cloud_apps:listMyConversations",
  "cloud_apps:listMyConversationsPage",
  "cloud_apps:listMyRecentAgentThreads",
  "cloud_apps:listMyRunningAgentThreads",
  "cloud_apps:listPendingOpInvocations",
  "cloud_browser:listMyPendingBrowserInteractions",
  "cloud_deployments:listMyInteriorBuilds",
  "cloud_drive:listMyDriveFiles",
  "cloud_engines:listMyEngineConnections",
  "cloud_memory:getMyMemoryPreference",
  "cloud_memory_lifecycle:getMyMemoryWipeStatus",
  "cloud_projects:listMyGithubInstallations",
  "cloud_projects:listMyProjects",
  "cloud_skills:listMySkillHeads",
  "data/canvas_shares:listMine",
  "execution_placement:getMyExecutionDispatchStatus",
  "execution_placement:getMyExecutionPlacementIdentity",
] as const;

export const INTERIOR_MUTATION_UDF_ALLOWLIST = [
  "auth_migration:retryMyLatestFailedOwnershipMigration",
  "cloud_apps:claimOpInvocation",
  "cloud_apps:completeOpInvocation",
  "cloud_apps:createMyConversation",
  "cloud_apps:publishMyAppOperations",
  "cloud_apps:startCloudChat",
  "cloud_engines:setMyCloudEngine",
  "cloud_engines:setMyCloudExecution",
  "cloud_memory:setMyMemoryEnabled",
  "cloud_memory_lifecycle:authorizeMyMemoryReimport",
  "cloud_memory_lifecycle:startMyMemoryWipe",
  "cloud_projects:createMyProject",
  "cloud_projects:finishGithubConnect",
  "cloud_skills:deleteMyMirroredSkill",
  "execution_placement:cancelMyExecutionDispatch",
  "execution_placement:submitMyBrowserExecution",
] as const;

export const INTERIOR_ACTION_UDF_ALLOWLIST = [
  "cloud_apps:deleteMyConversation",
  "cloud_browser:decideMyBrowserInteraction",
  "cloud_browser:getMyBrowserInteraction",
  "cloud_browser:mintMyBrowserLiveViewCapability",
  "cloud_browser:resetMyBrowserProfile",
  "cloud_conversation_edits:forkMyConversation",
  "cloud_conversation_edits:rewindMyConversation",
  "cloud_drive:deleteMyDriveFile",
  "cloud_drive:finalizeDriveUpload",
  "cloud_drive:getMyDriveFileUrl",
  "cloud_drive:prepareDriveUpload",
  "cloud_projects:startGithubAppInstall",
  "data/canvas_shares_actions:publish",
  "data/canvas_shares_actions:revoke",
] as const;

const QUERY_UDFS = new Set<string>(INTERIOR_QUERY_UDF_ALLOWLIST);
const MUTATION_UDFS = new Set<string>(INTERIOR_MUTATION_UDF_ALLOWLIST);
const ACTION_UDFS = new Set<string>(INTERIOR_ACTION_UDF_ALLOWLIST);

export type InteriorRouteBuildIdentity = Readonly<{
  mode: "default" | "custom";
  buildId: string;
}>;

export type InteriorShellSessionClaims = Readonly<{
  audience: typeof INTERIOR_SHELL_AUDIENCE;
  issuer: string;
  stableRouteId: string;
  routeBuild: InteriorRouteBuildIdentity;
  viewerId: string;
  viewerOwnerGeneration: string;
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
  trustedGatewayOrigin: string;
}>;

export type InteriorShellSessionIssueArgs = Readonly<{
  appTokenSigningKey: string;
  issuer: string;
  stableRouteId: string;
  routeBuild: InteriorRouteBuildIdentity;
  viewerId: string;
  viewerOwnerGeneration: string;
  convexJwt: string;
  trustedGatewayOrigin: string;
  now?: number;
  ttlMs?: number;
}>;

export type InteriorShellSessionExpected = Readonly<{
  issuer: string;
  trustedGatewayOrigin: string;
  stableRouteId?: string;
  routeBuild?: InteriorRouteBuildIdentity;
  viewerId?: string;
  viewerOwnerGeneration?: string;
}>;

export type VerifiedInteriorShellSession = Readonly<{
  claims: InteriorShellSessionClaims;
  /** Server-only. Defined as non-enumerable so JSON serialization cannot leak it. */
  convexToken: string;
}>;

export class InteriorShellSessionError extends Error {
  constructor() {
    super("The Stella interior session is invalid or expired.");
    this.name = "InteriorShellSessionError";
  }
}

type TokenPayload = {
  version: 1;
  audience: typeof INTERIOR_SHELL_AUDIENCE;
  issuer: string;
  stableRouteId: string;
  routeMode: "default" | "custom";
  buildId: string;
  viewerId: string;
  viewerOwnerGeneration: string;
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
  trustedGatewayOrigin: string;
  convexJwt: string;
};

const internalAuthorization = Symbol("interior-shell-authorization");
type InternalSession = VerifiedInteriorShellSession & {
  readonly [internalAuthorization]: (
    scopedToken: string,
    baseVersion: number,
  ) => Record<string, unknown> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
};

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isExactHttpsOrigin = (value: unknown): value is string => {
  if (!isBoundedString(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.pathname === "/" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
};

const validateKey = (value: string): boolean =>
  value.length >= 32 &&
  value.length <= 4_096 &&
  value === value.trim() &&
  /^[\x21-\x7e]+$/.test(value);

const validateBuild = (value: InteriorRouteBuildIdentity): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["mode", "buildId"]) &&
  (value.mode === "default" || value.mode === "custom") &&
  typeof value.buildId === "string" &&
  (value.mode === "default"
    ? DEFAULT_INTERIOR_BUILD_ID.test(value.buildId)
    : CUSTOM_INTERIOR_BUILD_ID.test(value.buildId));

const validateIdentityFields = (value: {
  issuer: unknown;
  stableRouteId: unknown;
  viewerId: unknown;
  viewerOwnerGeneration: unknown;
  trustedGatewayOrigin: unknown;
}): boolean =>
  isBoundedString(value.issuer, 256) &&
  typeof value.stableRouteId === "string" &&
  STABLE_ROUTE_ID.test(value.stableRouteId) &&
  isBoundedString(value.viewerId, 256) &&
  isBoundedString(value.viewerOwnerGeneration, 256) &&
  isExactHttpsOrigin(value.trustedGatewayOrigin);

const validateExpected = (value: InteriorShellSessionExpected): boolean =>
  isBoundedString(value.issuer, 256) &&
  isExactHttpsOrigin(value.trustedGatewayOrigin) &&
  (value.stableRouteId === undefined ||
    (typeof value.stableRouteId === "string" &&
      STABLE_ROUTE_ID.test(value.stableRouteId))) &&
  (value.routeBuild === undefined || validateBuild(value.routeBuild)) &&
  (value.viewerId === undefined || isBoundedString(value.viewerId, 256)) &&
  (value.viewerOwnerGeneration === undefined ||
    isBoundedString(value.viewerOwnerGeneration, 256));

const encodeBase64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decodeBase64url = (value: string, maxBytes: number): Uint8Array => {
  if (!BASE64URL.test(value) || value.length > Math.ceil((maxBytes * 4) / 3)) {
    throw new InteriorShellSessionError();
  }
  const padding = (4 - (value.length % 4)) % 4;
  if (padding === 3) throw new InteriorShellSessionError();
  const bytes = Uint8Array.from(
    atob(
      `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(padding)}`,
    ),
    (char) => char.charCodeAt(0),
  );
  if (bytes.byteLength > maxBytes || encodeBase64url(bytes) !== value) {
    throw new InteriorShellSessionError();
  }
  return bytes;
};

const importEncryptionKey = async (secret: string): Promise<CryptoKey> => {
  if (!validateKey(secret)) throw new InteriorShellSessionError();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
};

const canonicalPayload = (payload: TokenPayload): string =>
  JSON.stringify({
    version: payload.version,
    audience: payload.audience,
    issuer: payload.issuer,
    stableRouteId: payload.stableRouteId,
    routeMode: payload.routeMode,
    buildId: payload.buildId,
    viewerId: payload.viewerId,
    viewerOwnerGeneration: payload.viewerOwnerGeneration,
    tokenId: payload.tokenId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    trustedGatewayOrigin: payload.trustedGatewayOrigin,
    convexJwt: payload.convexJwt,
  });

const payloadFromUnknown = (value: unknown): TokenPayload => {
  if (!isRecord(value)) throw new InteriorShellSessionError();
  const payload: TokenPayload = {
    version: value.version as 1,
    audience: value.audience as typeof INTERIOR_SHELL_AUDIENCE,
    issuer: value.issuer as string,
    stableRouteId: value.stableRouteId as string,
    routeMode: value.routeMode as "default" | "custom",
    buildId: value.buildId as string,
    viewerId: value.viewerId as string,
    viewerOwnerGeneration: value.viewerOwnerGeneration as string,
    tokenId: value.tokenId as string,
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    trustedGatewayOrigin: value.trustedGatewayOrigin as string,
    convexJwt: value.convexJwt as string,
  };
  return payload;
};

const validatePayload = (payload: TokenPayload, now: number): boolean =>
  payload.version === 1 &&
  payload.audience === INTERIOR_SHELL_AUDIENCE &&
  validateIdentityFields(payload) &&
  (payload.routeMode === "default" || payload.routeMode === "custom") &&
  (payload.routeMode === "default"
    ? DEFAULT_INTERIOR_BUILD_ID.test(payload.buildId)
    : CUSTOM_INTERIOR_BUILD_ID.test(payload.buildId)) &&
  TOKEN_ID.test(payload.tokenId) &&
  isNonNegativeInteger(payload.issuedAt) &&
  isNonNegativeInteger(payload.expiresAt) &&
  payload.issuedAt <= now + CLOCK_SKEW_MS &&
  payload.expiresAt > now &&
  payload.expiresAt > payload.issuedAt &&
  payload.expiresAt - payload.issuedAt <= INTERIOR_SHELL_MAX_TTL_MS &&
  isBoundedString(payload.convexJwt, JWT_MAX_LENGTH) &&
  JWT.test(payload.convexJwt);

export const issueInteriorShellSession = async (
  args: InteriorShellSessionIssueArgs,
): Promise<{ token: string; expiresAt: number }> => {
  const now = args.now ?? Date.now();
  const ttlMs = args.ttlMs ?? INTERIOR_SHELL_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > INTERIOR_SHELL_MAX_TTL_MS ||
    !validateKey(args.appTokenSigningKey) ||
    !validateIdentityFields(args) ||
    !validateBuild(args.routeBuild) ||
    !isBoundedString(args.convexJwt, JWT_MAX_LENGTH) ||
    !JWT.test(args.convexJwt)
  ) {
    throw new InteriorShellSessionError();
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new InteriorShellSessionError();
  const payload: TokenPayload = {
    version: 1,
    audience: INTERIOR_SHELL_AUDIENCE,
    issuer: args.issuer,
    stableRouteId: args.stableRouteId,
    routeMode: args.routeBuild.mode,
    buildId: args.routeBuild.buildId,
    viewerId: args.viewerId,
    viewerOwnerGeneration: args.viewerOwnerGeneration,
    tokenId: crypto.randomUUID(),
    issuedAt: now,
    expiresAt,
    trustedGatewayOrigin: args.trustedGatewayOrigin,
    convexJwt: args.convexJwt,
  };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(args.appTokenSigningKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: TOKEN_AAD },
    key,
    encoder.encode(canonicalPayload(payload)),
  );
  return {
    token: `${TOKEN_VERSION}.${encodeBase64url(nonce)}.${encodeBase64url(new Uint8Array(ciphertext))}`,
    expiresAt,
  };
};

export const parseInteriorShellSession = async (args: {
  token: string;
  appTokenSigningKey: string;
  expected: InteriorShellSessionExpected;
  now?: number;
}): Promise<VerifiedInteriorShellSession> => {
  try {
    const now = args.now ?? Date.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      typeof args.token !== "string" ||
      args.token.length < 32 ||
      args.token.length > TOKEN_MAX_LENGTH ||
      !validateExpected(args.expected)
    ) {
      throw new InteriorShellSessionError();
    }
    const parts = args.token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== TOKEN_VERSION ||
      parts[1].length !== 16
    ) {
      throw new InteriorShellSessionError();
    }
    const nonce = decodeBase64url(parts[1], 12);
    if (nonce.byteLength !== 12) throw new InteriorShellSessionError();
    const ciphertext = decodeBase64url(parts[2], 12 * 1024);
    if (ciphertext.byteLength < 17) throw new InteriorShellSessionError();
    const key = await importEncryptionKey(args.appTokenSigningKey);
    const plaintext = decoder.decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: TOKEN_AAD },
        key,
        ciphertext,
      ),
    );
    const payload = payloadFromUnknown(JSON.parse(plaintext));
    if (
      canonicalPayload(payload) !== plaintext ||
      !validatePayload(payload, now) ||
      payload.issuer !== args.expected.issuer ||
      (args.expected.stableRouteId !== undefined &&
        payload.stableRouteId !== args.expected.stableRouteId) ||
      (args.expected.routeBuild !== undefined &&
        (payload.routeMode !== args.expected.routeBuild.mode ||
          payload.buildId !== args.expected.routeBuild.buildId)) ||
      (args.expected.viewerId !== undefined &&
        payload.viewerId !== args.expected.viewerId) ||
      (args.expected.viewerOwnerGeneration !== undefined &&
        payload.viewerOwnerGeneration !==
          args.expected.viewerOwnerGeneration) ||
      payload.trustedGatewayOrigin !== args.expected.trustedGatewayOrigin
    ) {
      throw new InteriorShellSessionError();
    }
    const claims = Object.freeze({
      audience: INTERIOR_SHELL_AUDIENCE,
      issuer: payload.issuer,
      stableRouteId: payload.stableRouteId,
      routeBuild: Object.freeze({
        mode: payload.routeMode,
        buildId: payload.buildId,
      }),
      viewerId: payload.viewerId,
      viewerOwnerGeneration: payload.viewerOwnerGeneration,
      tokenId: payload.tokenId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      trustedGatewayOrigin: payload.trustedGatewayOrigin,
    }) satisfies InteriorShellSessionClaims;
    const session = { claims } as InternalSession;
    Object.defineProperty(session, "convexToken", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: payload.convexJwt,
    });
    Object.defineProperty(session, internalAuthorization, {
      enumerable: false,
      configurable: false,
      writable: false,
      value: (scopedToken: string, baseVersion: number) =>
        scopedToken === args.token
          ? {
              type: "Authenticate",
              tokenType: "User",
              value: payload.convexJwt,
              baseVersion,
            }
          : null,
    });
    return Object.freeze(session);
  } catch {
    throw new InteriorShellSessionError();
  }
};

export type InteriorConvexPolicyResult =
  | Readonly<{ ok: true; upstreamMessage: Record<string, unknown> }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_message"
        | "authentication_denied"
        | "component_denied"
        | "udf_denied"
        | "event_denied";
    }>;

type JsonBudget = { nodes: number };
const isBoundedJson = (
  value: unknown,
  depth = 0,
  budget: JsonBudget = { nodes: 0 },
): boolean => {
  budget.nodes += 1;
  if (budget.nodes > 8_192 || depth > 24) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 1_048_576;
  if (Array.isArray(value)) {
    return (
      value.length <= 8_192 &&
      value.every((entry) => isBoundedJson(entry, depth + 1, budget))
    );
  }
  if (!isRecord(value) || Object.keys(value).length > 1_024) return false;
  return Object.values(value).every((entry) =>
    isBoundedJson(entry, depth + 1, budget),
  );
};

const validArgs = (value: unknown): value is unknown[] =>
  Array.isArray(value) && isBoundedJson(value);

const componentDenied = (message: Record<string, unknown>): boolean =>
  Object.hasOwn(message, "componentPath");

export const validateInteriorConvexClientMessage = (args: {
  message: unknown;
  session: VerifiedInteriorShellSession;
  scopedToken: string;
}): InteriorConvexPolicyResult => {
  const message = args.message;
  if (!isRecord(message) || typeof message.type !== "string") {
    return { ok: false, reason: "invalid_message" };
  }

  if (message.type === "Connect") {
    if (
      !hasExactKeys(
        message,
        ["type", "sessionId", "connectionCount", "lastCloseReason", "clientTs"],
        ["maxObservedTimestamp"],
      ) ||
      !isBoundedString(message.sessionId, 256) ||
      !isNonNegativeInteger(message.connectionCount) ||
      !isNonNegativeInteger(message.clientTs) ||
      !(
        message.lastCloseReason === null ||
        (typeof message.lastCloseReason === "string" &&
          message.lastCloseReason.length <= 2_048)
      ) ||
      !(
        message.maxObservedTimestamp === undefined ||
        (typeof message.maxObservedTimestamp === "string" &&
          message.maxObservedTimestamp.length <= 64)
      )
    ) {
      return { ok: false, reason: "invalid_message" };
    }
    return { ok: true, upstreamMessage: message };
  }

  if (message.type === "Authenticate") {
    if (
      !hasExactKeys(message, ["type", "tokenType", "value", "baseVersion"]) ||
      message.tokenType !== "User" ||
      typeof message.value !== "string" ||
      !isNonNegativeInteger(message.baseVersion)
    ) {
      return { ok: false, reason: "authentication_denied" };
    }
    const internal = args.session as InternalSession;
    const replacement = internal[internalAuthorization]?.(
      args.scopedToken,
      message.baseVersion,
    );
    if (!replacement || message.value !== args.scopedToken) {
      return { ok: false, reason: "authentication_denied" };
    }
    return { ok: true, upstreamMessage: replacement };
  }

  if (message.type === "ModifyQuerySet") {
    if (
      !hasExactKeys(message, [
        "type",
        "baseVersion",
        "newVersion",
        "modifications",
      ]) ||
      !isNonNegativeInteger(message.baseVersion) ||
      !isNonNegativeInteger(message.newVersion) ||
      !Array.isArray(message.modifications) ||
      message.modifications.length > 1_024
    ) {
      return { ok: false, reason: "invalid_message" };
    }
    for (const modification of message.modifications) {
      if (!isRecord(modification)) {
        return { ok: false, reason: "invalid_message" };
      }
      if (componentDenied(modification)) {
        return { ok: false, reason: "component_denied" };
      }
      if (modification.type === "Remove") {
        if (
          !hasExactKeys(modification, ["type", "queryId"]) ||
          !isNonNegativeInteger(modification.queryId)
        ) {
          return { ok: false, reason: "invalid_message" };
        }
        continue;
      }
      if (
        modification.type !== "Add" ||
        !hasExactKeys(
          modification,
          ["type", "queryId", "udfPath", "args"],
          ["journal"],
        ) ||
        !isNonNegativeInteger(modification.queryId) ||
        typeof modification.udfPath !== "string" ||
        !validArgs(modification.args) ||
        !(
          modification.journal === undefined ||
          modification.journal === null ||
          (typeof modification.journal === "string" &&
            modification.journal.length <= 1_048_576)
        )
      ) {
        return { ok: false, reason: "invalid_message" };
      }
      if (!QUERY_UDFS.has(modification.udfPath)) {
        return { ok: false, reason: "udf_denied" };
      }
    }
    return { ok: true, upstreamMessage: message };
  }

  if (message.type === "Mutation" || message.type === "Action") {
    if (componentDenied(message)) {
      return { ok: false, reason: "component_denied" };
    }
    if (
      !hasExactKeys(message, ["type", "requestId", "udfPath", "args"]) ||
      !isNonNegativeInteger(message.requestId) ||
      typeof message.udfPath !== "string" ||
      !validArgs(message.args)
    ) {
      return { ok: false, reason: "invalid_message" };
    }
    const allowed =
      message.type === "Mutation"
        ? MUTATION_UDFS.has(message.udfPath)
        : ACTION_UDFS.has(message.udfPath);
    return allowed
      ? { ok: true, upstreamMessage: message }
      : { ok: false, reason: "udf_denied" };
  }

  if (message.type === "Event") {
    if (
      !hasExactKeys(message, ["type", "eventType", "event"]) ||
      message.eventType !== "ClientConnect" ||
      !isBoundedJson(message.event)
    ) {
      return { ok: false, reason: "event_denied" };
    }
    return { ok: true, upstreamMessage: message };
  }

  return { ok: false, reason: "invalid_message" };
};
