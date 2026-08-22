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

export type ProviderConnectorBinding = {
  /** Scope groups requested when this connector starts a new consent flow. */
  connectScopeGroups: readonly string[];
  /** Minimum scope groups required for this connector to report ready. */
  requiredScopeGroups: readonly string[];
};

export type ProviderManifest = {
  key: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  tokenEndpointAuth?: "client_secret_post" | "client_secret_basic";
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  /** Dot paths for providers whose userinfo response is not OpenID-shaped. */
  identityPaths?: { subject: string; email?: string; name?: string };
  userinfoHeaders?: Record<string, string>;
  authorizationParams?: Readonly<Record<string, string>>;
  identityMode: ProviderIdentityMode;
  /** Expected OIDC issuer, when identityMode === "oidc". */
  issuer?: string;
  requiresPkce: boolean;
  usesOfflineAccess: boolean;
  /** Provider-specific authorization parameters (never secrets). */
  authorizationParams?: Readonly<Record<string, string>>;
  /** Refresh this many ms before access-token expiry. */
  refreshSkewMs: number;
  /** Exact registered callback path (no wildcards/loopback in production). */
  callbackPath: string;
  /** Fixed origin first-party executors are allowed to call. Prevents SSRF. */
  apiOrigin: string;
  scopeGroups: Readonly<Record<string, ProviderScopeGroup>>;
  /** Optional provider-family connector registry for shared-account grants. */
  connectorBindings?: Readonly<Record<string, ProviderConnectorBinding>>;
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
  authorizationParams: {
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  },
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

const TWITTER: ProviderManifest = {
  key: "twitter",
  displayName: "X",
  authorizationEndpoint: "https://x.com/i/oauth2/authorize",
  tokenEndpoint: "https://api.x.com/2/oauth2/token",
  tokenEndpointAuth: "client_secret_basic",
  revocationEndpoint: "https://api.x.com/2/oauth2/revoke",
  userinfoEndpoint: "https://api.x.com/2/users/me",
  identityPaths: { subject: "data.id", name: "data.name" },
  identityMode: "userinfo",
  requiresPkce: true,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.x.com",
  scopeGroups: {
    read: { scopes: ["tweet.read", "users.read", "offline.access"] },
    write: {
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const YOUTUBE: ProviderManifest = {
  key: "youtube",
  displayName: "YouTube",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  identityMode: "oidc",
  issuer: "https://accounts.google.com",
  requiresPkce: true,
  usesOfflineAccess: true,
  authorizationParams: {
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  },
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://www.googleapis.com",
  scopeGroups: {
    read: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    },
    write: {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/youtube.force-ssl",
      ],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

/** Facebook, Instagram, and Meta Ads deliberately share one Meta user grant. */
const META: ProviderManifest = {
  key: "meta",
  displayName: "Meta",
  authorizationEndpoint: "https://www.facebook.com/dialog/oauth",
  tokenEndpoint: "https://graph.facebook.com/oauth/access_token",
  revocationEndpoint: "https://graph.facebook.com/me/permissions",
  userinfoEndpoint: "https://graph.facebook.com/me?fields=id,name,email",
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  refreshSkewMs: 24 * 60 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://graph.facebook.com",
  scopeGroups: {
    facebook_read: {
      scopes: ["public_profile", "pages_show_list", "pages_read_engagement"],
    },
    facebook_write: {
      scopes: [
        "public_profile",
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
      ],
    },
    instagram_read: {
      scopes: [
        "public_profile",
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
      ],
    },
    instagram_write: {
      scopes: [
        "public_profile",
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ],
    },
    metaads_read: { scopes: ["public_profile", "ads_read"] },
    metaads_write: {
      scopes: ["public_profile", "ads_read", "ads_management"],
    },
    social_all: {
      scopes: [
        "public_profile",
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "instagram_basic",
        "instagram_content_publish",
        "ads_read",
        "ads_management",
      ],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const REDDIT: ProviderManifest = {
  key: "reddit",
  displayName: "Reddit",
  authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
  tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
  tokenEndpointAuth: "client_secret_basic",
  revocationEndpoint: "https://www.reddit.com/api/v1/revoke_token",
  userinfoEndpoint: "https://oauth.reddit.com/api/v1/me",
  identityPaths: { subject: "id", name: "name" },
  userinfoHeaders: { "user-agent": "Stella/1.0 by contact@fromyou.ai" },
  authorizationParams: { duration: "permanent" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://oauth.reddit.com",
  scopeGroups: {
    read: { scopes: ["identity", "read"] },
    write: { scopes: ["identity", "read", "submit"] },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const LINKEDIN: ProviderManifest = {
  key: "linkedin",
  displayName: "LinkedIn",
  authorizationEndpoint: "https://www.linkedin.com/oauth/v2/authorization",
  tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
  userinfoEndpoint: "https://api.linkedin.com/v2/userinfo",
  identityMode: "oidc",
  issuer: "https://www.linkedin.com/oauth",
  requiresPkce: false,
  usesOfflineAccess: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.linkedin.com",
  scopeGroups: {
    read: { scopes: ["openid", "profile", "email"] },
    member_write: {
      scopes: ["openid", "profile", "email", "w_member_social"],
    },
    organization_write: {
      scopes: [
        "openid",
        "profile",
        "email",
        "r_organization_social",
        "w_organization_social",
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

const MICROSOFT_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
] as const;

const MICROSOFT_OUTLOOK_SCOPES = [
  ...MICROSOFT_IDENTITY_SCOPES,
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
] as const;

const MICROSOFT_TEAMS_SCOPES = [
  ...MICROSOFT_IDENTITY_SCOPES,
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
] as const;

const MICROSOFT_EXCEL_SCOPES = [
  ...MICROSOFT_IDENTITY_SCOPES,
  "Files.ReadWrite",
] as const;

const MICROSOFT_ALL_SCOPES = [
  ...new Set([
    ...MICROSOFT_OUTLOOK_SCOPES,
    ...MICROSOFT_TEAMS_SCOPES,
    ...MICROSOFT_EXCEL_SCOPES,
  ]),
];

/**
 * One delegated Entra grant backs Outlook, Teams, and Excel. Connecting any
 * member requests the complete reviewed union, while readiness remains scoped
 * to each connector's actual minimum permissions.
 */
const MICROSOFT: ProviderManifest = {
  key: "microsoft",
  displayName: "Microsoft",
  authorizationEndpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  userinfoEndpoint:
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
  identityMode: "userinfo",
  requiresPkce: true,
  usesOfflineAccess: true,
  authorizationParams: { prompt: "select_account" },
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://graph.microsoft.com",
  scopeGroups: {
    identity: { scopes: MICROSOFT_IDENTITY_SCOPES },
    outlook: { scopes: MICROSOFT_OUTLOOK_SCOPES },
    microsoft_teams: { scopes: MICROSOFT_TEAMS_SCOPES },
    excel: { scopes: MICROSOFT_EXCEL_SCOPES },
    microsoft_all: { scopes: MICROSOFT_ALL_SCOPES },
  },
  connectorBindings: {
    outlook: {
      connectScopeGroups: ["microsoft_all"],
      requiredScopeGroups: ["outlook"],
    },
    microsoft_teams: {
      connectScopeGroups: ["microsoft_all"],
      requiredScopeGroups: ["microsoft_teams"],
    },
    excel: {
      connectScopeGroups: ["microsoft_all"],
      requiredScopeGroups: ["excel"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const STATIC_MANIFESTS: Readonly<Record<string, ProviderManifest>> = {
  [GOOGLE_WORKSPACE.key]: GOOGLE_WORKSPACE,
  [MICROSOFT.key]: MICROSOFT,
  [TWITTER.key]: TWITTER,
  [YOUTUBE.key]: YOUTUBE,
  [META.key]: META,
  [REDDIT.key]: REDDIT,
  [LINKEDIN.key]: LINKEDIN,
  [MOCK_PROVIDER.key]: MOCK_PROVIDER,
};

/** All manifests visible in this deployment (mock only behind the env flag). */
export const listProviderManifests = (): ProviderManifest[] =>
  Object.values(STATIC_MANIFESTS).filter(
    (manifest) => manifest.key !== MOCK_PROVIDER_KEY || mockProviderAllowed(),
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

export const connectScopeGroupsForConnector = (
  manifest: ProviderManifest,
  connectorId: string,
  requested: readonly string[],
): string[] => {
  const binding =
    manifest.connectorBindings?.[connectorId.trim().toLowerCase()];
  return binding ? [...binding.connectScopeGroups] : [...requested];
};

export const connectorBindingsSatisfiedByScopes = (
  manifest: ProviderManifest,
  grantedScopes: readonly string[],
): Array<{ connectorId: string; requiredScopeGroups: string[] }> => {
  const out: Array<{ connectorId: string; requiredScopeGroups: string[] }> = [];
  for (const [connectorId, binding] of Object.entries(
    manifest.connectorBindings ?? {},
  )) {
    const required = scopesForGroups(manifest, binding.requiredScopeGroups);
    if (grantedScopesSatisfy(grantedScopes, required)) {
      out.push({
        connectorId,
        requiredScopeGroups: [...binding.requiredScopeGroups],
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// PKCE / state primitives (S256, provider-neutral)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
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
  for (const [key, value] of Object.entries(
    args.manifest.authorizationParams ?? {},
  )) {
    url.searchParams.set(key, value);
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

const basicAuthorization = (clientId: string, clientSecret: string): string => {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
};

/** Apply provider-specific token endpoint authentication without exposing credentials. */
export const buildTokenEndpointRequest = (args: {
  manifest: ProviderManifest;
  clientId: string;
  clientSecret: string;
  body: string;
}): { headers: Record<string, string>; body: string } => {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (args.manifest.tokenEndpointAuth !== "client_secret_basic") {
    return { headers, body: args.body };
  }
  const body = new URLSearchParams(args.body);
  body.delete("client_id");
  body.delete("client_secret");
  headers.authorization = basicAuthorization(args.clientId, args.clientSecret);
  return { headers, body: body.toString() };
};

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
  for (const [connectorId, binding] of Object.entries(
    manifest.connectorBindings ?? {},
  )) {
    if (!connectorId.trim()) {
      problems.push(`${manifest.key} has an empty connector binding id`);
    }
    for (const groupId of [
      ...binding.connectScopeGroups,
      ...binding.requiredScopeGroups,
    ]) {
      if (!manifest.scopeGroups[groupId]) {
        problems.push(
          `${manifest.key}.${connectorId} references unknown scope group ${groupId}`,
        );
      }
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
