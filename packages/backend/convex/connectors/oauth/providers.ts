import { ConnectorError } from "../errors";
import { isProviderEnabled, mockProviderAllowed } from "../env";

/**
 * Static provider registrations. Non-secret facts only: endpoints, PKCE/refresh
 * semantics, identity adapter, callback path, scope groups, verification state.
 * Client ids/secrets live exclusively in deployment env (see `env.ts`).
 *
 * Convex requires statically analyzable modules, so this is a source registry,
 * not a database-provided or dynamically imported one.
 */

export type ProviderIdentityMode = "oidc" | "userinfo";

export type ProviderScopeGroup = {
  /** Immutable scope set requested for this capability group. */
  scopes: readonly string[];
};

export type ProviderManifest = {
  key: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  identityMode: ProviderIdentityMode;
  /** Expected OIDC issuer, when identityMode === "oidc". */
  issuer?: string;
  requiresPkce: boolean;
  usesOfflineAccess: boolean;
  /** Refresh this many ms before access-token expiry. */
  refreshSkewMs: number;
  /** Exact registered callback path (no wildcards/loopback in production). */
  callbackPath: string;
  /** Fixed origin first-party executors are allowed to call. Prevents SSRF. */
  apiOrigin: string;
  scopeGroups: Readonly<Record<string, ProviderScopeGroup>>;
  verificationStatus: "unverified" | "in_review" | "verified";
  registrationVersion: number;
};

const GOOGLE_WORKSPACE: ProviderManifest = {
  key: "google-workspace",
  displayName: "Google",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  identityMode: "oidc",
  issuer: "https://accounts.google.com",
  requiresPkce: true,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://www.googleapis.com",
  // NOTE: the exact action->scope matrix must be mechanically generated from
  // the shipped executor registry before provider-console registration. These
  // groups are the design baseline; `google_all` is the deduped union.
  scopeGroups: {
    identity: { scopes: ["openid", "email", "profile"] },
    gmail: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    },
    drive: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/drive",
      ],
    },
    docs: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/documents",
      ],
    },
    sheets: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    },
    calendar: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      ],
    },
    tasks: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/tasks",
      ],
    },
    google_all: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/tasks",
      ],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

/**
 * Deterministic fake provider used only by the connector test suite. Its
 * endpoints resolve to a non-routable test origin and it is registered only
 * when `STELLA_CONNECTOR_OAUTH_ALLOW_MOCK` is set. It is never present in
 * production.
 */
export const MOCK_PROVIDER_KEY = "mock";
export const MOCK_PROVIDER_ORIGIN = "https://mock-provider.stella.test";

const MOCK_PROVIDER: ProviderManifest = {
  key: MOCK_PROVIDER_KEY,
  displayName: "Mock Provider",
  authorizationEndpoint: `${MOCK_PROVIDER_ORIGIN}/authorize`,
  tokenEndpoint: `${MOCK_PROVIDER_ORIGIN}/token`,
  revocationEndpoint: `${MOCK_PROVIDER_ORIGIN}/revoke`,
  userinfoEndpoint: `${MOCK_PROVIDER_ORIGIN}/userinfo`,
  identityMode: "userinfo",
  requiresPkce: true,
  usesOfflineAccess: true,
  refreshSkewMs: 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: MOCK_PROVIDER_ORIGIN,
  scopeGroups: {
    profile: { scopes: ["mock.profile"] },
    read: { scopes: ["mock.profile", "mock.read"] },
    write: { scopes: ["mock.profile", "mock.read", "mock.write"] },
    all: { scopes: ["mock.profile", "mock.read", "mock.write"] },
  },
  verificationStatus: "verified",
  registrationVersion: 1,
};

const STATIC_MANIFESTS: Readonly<Record<string, ProviderManifest>> = {
  [GOOGLE_WORKSPACE.key]: GOOGLE_WORKSPACE,
  [MOCK_PROVIDER.key]: MOCK_PROVIDER,
};

/** All manifests visible in this deployment (mock only behind the env flag). */
export const listProviderManifests = (): ProviderManifest[] =>
  Object.values(STATIC_MANIFESTS).filter(
    (manifest) =>
      manifest.key !== MOCK_PROVIDER_KEY || mockProviderAllowed(),
  );

export const getProviderManifest = (
  providerKey: string,
): ProviderManifest | null => {
  const key = providerKey.trim().toLowerCase();
  const manifest = STATIC_MANIFESTS[key];
  if (!manifest) return null;
  if (manifest.key === MOCK_PROVIDER_KEY && !mockProviderAllowed()) return null;
  return manifest;
};

/**
 * Resolve a manifest and confirm it is enabled for use (present + in the env
 * allowlist). Throws a classified error otherwise. Fails closed.
 */
export const requireEnabledProvider = (
  providerKey: string,
): ProviderManifest => {
  const manifest = getProviderManifest(providerKey);
  if (!manifest) throw new ConnectorError("provider_not_configured");
  // The mock provider is self-enabling under its dev/test flag so the suite
  // does not have to also populate the runtime allowlist.
  if (manifest.key === MOCK_PROVIDER_KEY) return manifest;
  if (!isProviderEnabled(manifest.key)) {
    throw new ConnectorError("provider_disabled");
  }
  return manifest;
};

/** Deduplicated union of the scopes referenced by the given group ids. */
export const scopesForGroups = (
  manifest: ProviderManifest,
  groupIds: readonly string[],
): string[] => {
  if (groupIds.length === 0) throw new ConnectorError("unregistered_scope");
  const out = new Set<string>();
  for (const groupId of groupIds) {
    const group = manifest.scopeGroups[groupId];
    if (!group) throw new ConnectorError("unregistered_scope");
    for (const scope of group.scopes) out.add(scope);
  }
  return [...out];
};

/** Whether the granted scope set is a superset of every required scope. */
export const grantedScopesSatisfy = (
  granted: readonly string[],
  required: readonly string[],
): boolean => {
  const grantedSet = new Set(granted);
  return required.every((scope) => grantedSet.has(scope));
};

// ---------------------------------------------------------------------------
// PKCE / state primitives (S256, provider-neutral)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

/** >= 32 bytes of entropy for CSRF state. */
export const generateOAuthState = (): string => randomBase64Url(32);

/** 43-128 char PKCE verifier. */
export const generatePkceVerifier = (): string => randomBase64Url(48);

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const pkceChallengeS256 = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
};

/** Build the provider authorization URL. Redirect is always the hosted callback. */
export const buildAuthorizationUrl = (args: {
  manifest: ProviderManifest;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
}): string => {
  const url = new URL(args.manifest.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scopes.join(" "));
  url.searchParams.set("state", args.state);
  if (args.manifest.requiresPkce) {
    url.searchParams.set("code_challenge", args.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (args.manifest.usesOfflineAccess) {
    // Google-family offline access + incremental authorization semantics.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
};

export const buildTokenExchangeBody = (args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): string => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  if (args.codeVerifier) body.set("code_verifier", args.codeVerifier);
  return body.toString();
};

export const buildRefreshBody = (args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): string =>
  new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  }).toString();

export const parseScopeString = (scope: unknown): string[] => {
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string");
  }
  if (typeof scope === "string") {
    return scope.split(/\s+/u).filter(Boolean);
  }
  return [];
};

/**
 * Build-time-style invariant check: every provider manifest is internally
 * consistent (https endpoints, non-empty scope groups, sane callback path).
 * Exercised by the test suite so a malformed manifest never ships.
 */
export const validateManifest = (manifest: ProviderManifest): string[] => {
  const problems: string[] = [];
  const httpsOnly = (label: string, value: string | undefined) => {
    if (value && !value.startsWith("https://")) {
      problems.push(`${manifest.key}.${label} must be https`);
    }
  };
  httpsOnly("authorizationEndpoint", manifest.authorizationEndpoint);
  httpsOnly("tokenEndpoint", manifest.tokenEndpoint);
  httpsOnly("revocationEndpoint", manifest.revocationEndpoint);
  httpsOnly("userinfoEndpoint", manifest.userinfoEndpoint);
  httpsOnly("apiOrigin", manifest.apiOrigin);
  if (!manifest.callbackPath.startsWith("/")) {
    problems.push(`${manifest.key}.callbackPath must be an absolute path`);
  }
  if (Object.keys(manifest.scopeGroups).length === 0) {
    problems.push(`${manifest.key} has no scope groups`);
  }
  for (const [groupId, group] of Object.entries(manifest.scopeGroups)) {
    if (group.scopes.length === 0) {
      problems.push(`${manifest.key}.${groupId} has no scopes`);
    }
  }
  if (manifest.identityMode === "oidc" && !manifest.issuer) {
    problems.push(`${manifest.key} is oidc but has no issuer`);
  }
  if (manifest.identityMode === "userinfo" && !manifest.userinfoEndpoint) {
    problems.push(`${manifest.key} is userinfo but has no userinfoEndpoint`);
  }
  return problems;
};
