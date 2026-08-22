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
  /** Used when a provider refreshes at a different endpoint from code exchange. */
  refreshEndpoint?: string;
  tokenEndpointAuth?: "client_secret_post" | "client_secret_basic";
  tokenRequestEncoding?: "form" | "json";
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  /** Relative userinfo path when the token response supplies a tenant API origin. */
  userinfoPath?: string;
  /** Dot paths for providers whose userinfo response is not OpenID-shaped. */
  identityPaths?: { subject: string; email?: string; name?: string };
  userinfoHeaders?: Record<string, string>;
  userinfoRequest?: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  };
  authorizationParams?: Readonly<Record<string, string>>;
  identityMode: ProviderIdentityMode;
  /** Expected OIDC issuer, when identityMode === "oidc". */
  issuer?: string;
  requiresPkce: boolean;
  usesOfflineAccess: boolean;
  /** Explicitly false for providers whose access tokens do not expire. */
  accessTokensExpire?: false;
  /** Some providers configure scopes on the app rather than in the authorize URL. */
  sendsScopesInAuthorization?: boolean;
  /** Defaults to a space. Linear requires comma-delimited scopes. */
  scopeSeparator?: " " | ",";
  /** Refresh this many ms before access-token expiry. */
  refreshSkewMs: number;
  /** Exact registered callback path (no wildcards/loopback in production). */
  callbackPath: string;
  /** Fixed origin first-party executors are allowed to call. Prevents SSRF. */
  apiOrigin: string;
  /** Allowlisted tenant host suffixes for provider-issued API origins. */
  resourceOriginHostSuffixes?: readonly string[];
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
  connectorBindings: {
    twitter: {
      connectScopeGroups: ["write"],
      requiredScopeGroups: ["read"],
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
  connectorBindings: {
    youtube: {
      connectScopeGroups: ["write"],
      requiredScopeGroups: ["read"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const GITHUB: ProviderManifest = {
  key: "github",
  displayName: "GitHub",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  apiOrigin: "https://api.github.com",
  callbackPath: "/api/connectors/oauth/callback",
  requiresPkce: true,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  refreshSkewMs: 0,
  identityMode: "userinfo",
  userinfoPath: "/user",
  userinfoHeaders: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Stella/1.0 (contact@fromyou.ai)",
  },
  identityPaths: {
    subject: "id",
    email: "email",
    name: "name",
  },
  scopeGroups: {
    github_all: { scopes: ["repo", "read:user", "user:email"] },
  },
  connectorBindings: {
    github: {
      connectScopeGroups: ["github_all"],
      requiredScopeGroups: ["github_all"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const SUPABASE: ProviderManifest = {
  key: "supabase",
  displayName: "Supabase",
  authorizationEndpoint: "https://api.supabase.com/v1/oauth/authorize",
  tokenEndpoint: "https://api.supabase.com/v1/oauth/token",
  tokenEndpointAuth: "client_secret_basic",
  apiOrigin: "https://api.supabase.com",
  callbackPath: "/api/connectors/oauth/callback",
  requiresPkce: true,
  sendsScopesInAuthorization: false,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  identityMode: "userinfo",
  userinfoPath: "/v1/profile",
  identityPaths: {
    subject: "gotrue_id",
    email: "primary_email",
    name: "username",
  },
  // Supabase configures Management API access on the OAuth application. Its
  // dynamic `scope` parameter is deprecated, so `all` is a local proof marker
  // rather than a value sent to the authorization endpoint.
  scopeGroups: {
    all: { scopes: ["all"] },
  },
  connectorBindings: {
    supabase: {
      connectScopeGroups: ["all"],
      requiredScopeGroups: ["all"],
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
  connectorBindings: {
    facebook: {
      connectScopeGroups: ["social_all"],
      requiredScopeGroups: ["facebook_read"],
    },
    instagram: {
      connectScopeGroups: ["social_all"],
      requiredScopeGroups: ["instagram_read"],
    },
    metaads: {
      connectScopeGroups: ["social_all"],
      requiredScopeGroups: ["metaads_read"],
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
  connectorBindings: {
    reddit: {
      connectScopeGroups: ["write"],
      requiredScopeGroups: ["read"],
    },
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
  connectorBindings: {
    linkedin: {
      connectScopeGroups: ["member_write"],
      requiredScopeGroups: ["read"],
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

const HUBSPOT: ProviderManifest = {
  key: "hubspot",
  displayName: "HubSpot",
  authorizationEndpoint: "https://app.hubspot.com/oauth/authorize",
  tokenEndpoint: "https://api.hubapi.com/oauth/v3/token",
  userinfoEndpoint: "https://api.hubapi.com/integrations/v1/me",
  identityPaths: { subject: "portalId" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.hubapi.com",
  scopeGroups: {
    contacts_read: { scopes: ["crm.objects.contacts.read"] },
    contacts_write: {
      scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    },
    hubspot: {
      scopes: [
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
        "crm.objects.companies.read",
      ],
    },
  },
  connectorBindings: {
    hubspot: {
      connectScopeGroups: ["hubspot"],
      requiredScopeGroups: ["hubspot"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const GONG: ProviderManifest = {
  key: "gong",
  displayName: "Gong",
  authorizationEndpoint: "https://app.gong.io/oauth2/authorize",
  tokenEndpoint: "https://app.gong.io/oauth2/generate-customer-token",
  tokenEndpointAuth: "client_secret_basic",
  userinfoPath: "/v2/workspaces",
  identityPaths: {
    subject: "workspaces.0.id",
    name: "workspaces.0.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.gong.io",
  resourceOriginHostSuffixes: ["api.gong.io"],
  scopeGroups: {
    users_read: { scopes: ["api:workspaces:read", "api:users:read"] },
    calls_write: {
      scopes: ["api:workspaces:read", "api:users:read", "api:calls:create"],
    },
    gong: {
      scopes: [
        "api:workspaces:read",
        "api:users:read",
        "api:calls:read:basic",
        "api:calls:read:transcript",
        "api:calls:create",
      ],
    },
  },
  connectorBindings: {
    gong: {
      connectScopeGroups: ["gong"],
      requiredScopeGroups: ["gong"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const PIPEDRIVE: ProviderManifest = {
  key: "pipedrive",
  displayName: "Pipedrive",
  authorizationEndpoint: "https://oauth.pipedrive.com/oauth/authorize",
  tokenEndpoint: "https://oauth.pipedrive.com/oauth/token",
  tokenEndpointAuth: "client_secret_basic",
  userinfoPath: "/api/v1/users/me",
  identityPaths: {
    subject: "data.id",
    email: "data.email",
    name: "data.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  sendsScopesInAuthorization: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.pipedrive.com",
  resourceOriginHostSuffixes: ["pipedrive.com"],
  scopeGroups: {
    deals_read: { scopes: ["deals:read"] },
    deals_write: { scopes: ["deals:read", "deals:full"] },
    pipedrive: {
      scopes: ["deals:read", "deals:full", "contacts:read", "contacts:full"],
    },
  },
  connectorBindings: {
    pipedrive: {
      connectScopeGroups: ["pipedrive"],
      requiredScopeGroups: ["pipedrive"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const SALESFORCE: ProviderManifest = {
  key: "salesforce",
  displayName: "Salesforce",
  authorizationEndpoint:
    "https://login.salesforce.com/services/oauth2/authorize",
  tokenEndpoint: "https://login.salesforce.com/services/oauth2/token",
  userinfoEndpoint: "https://login.salesforce.com/services/oauth2/userinfo",
  identityPaths: { subject: "user_id", email: "email", name: "name" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://login.salesforce.com",
  resourceOriginHostSuffixes: ["salesforce.com", "force.com"],
  scopeGroups: {
    api_read: { scopes: ["api", "refresh_token"] },
    api_write: { scopes: ["api", "refresh_token"] },
  },
  connectorBindings: {
    salesforce: {
      connectScopeGroups: ["api_write"],
      requiredScopeGroups: ["api_write"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const ATTIO: ProviderManifest = {
  key: "attio",
  displayName: "Attio",
  authorizationEndpoint: "https://app.attio.com/authorize",
  tokenEndpoint: "https://app.attio.com/oauth/token",
  userinfoEndpoint: "https://api.attio.com/v2/self",
  identityPaths: { subject: "workspace_id", name: "workspace_name" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  sendsScopesInAuthorization: false,
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.attio.com",
  scopeGroups: {
    records_read: {
      scopes: ["object_configuration:read", "record_permission:read"],
    },
    records_write: {
      scopes: ["object_configuration:read", "record_permission:read-write"],
    },
    attio: {
      scopes: [
        "object_configuration:read",
        "record_permission:read",
        "record_permission:read-write",
        "list_entry:read",
      ],
    },
  },
  connectorBindings: {
    attio: {
      connectScopeGroups: ["attio"],
      requiredScopeGroups: ["attio"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const FIGMA: ProviderManifest = {
  key: "figma",
  displayName: "Figma",
  authorizationEndpoint: "https://www.figma.com/oauth",
  tokenEndpoint: "https://api.figma.com/v1/oauth/token",
  refreshEndpoint: "https://api.figma.com/v1/oauth/refresh",
  tokenEndpointAuth: "client_secret_basic",
  userinfoEndpoint: "https://api.figma.com/v1/me",
  identityPaths: { subject: "id", email: "email", name: "handle" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: true,
  scopeSeparator: ",",
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.figma.com",
  scopeGroups: {
    figma: {
      scopes: [
        "current_user:read",
        "file_content:read",
        "file_metadata:read",
        "file_comments:read",
        "file_comments:write",
        "projects:read",
      ],
    },
  },
  connectorBindings: {
    figma: {
      connectScopeGroups: ["figma"],
      requiredScopeGroups: ["figma"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const STRIPE: ProviderManifest = {
  key: "stripe",
  displayName: "Stripe",
  authorizationEndpoint: "https://connect.stripe.com/oauth/authorize",
  tokenEndpoint: "https://connect.stripe.com/oauth/token",
  tokenEndpointAuth: "client_secret_basic",
  userinfoEndpoint: "https://api.stripe.com/v1/account",
  identityPaths: {
    subject: "id",
    email: "email",
    name: "business_profile.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.stripe.com",
  scopeGroups: { stripe: { scopes: ["read_write"] } },
  connectorBindings: {
    stripe: {
      connectScopeGroups: ["stripe"],
      requiredScopeGroups: ["stripe"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const NOTION: ProviderManifest = {
  key: "notion",
  displayName: "Notion",
  authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
  tokenEndpoint: "https://api.notion.com/v1/oauth/token",
  tokenEndpointAuth: "client_secret_basic",
  tokenRequestEncoding: "json",
  userinfoEndpoint: "https://api.notion.com/v1/users/me",
  identityPaths: {
    subject: "id",
    email: "bot.owner.user.person.email",
    name: "name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  sendsScopesInAuthorization: false,
  authorizationParams: { owner: "user" },
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.notion.com",
  scopeGroups: {
    integration: { scopes: ["integration:configured"] },
  },
  connectorBindings: {
    notion: {
      connectScopeGroups: ["integration"],
      requiredScopeGroups: ["integration"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const SLACK: ProviderManifest = {
  key: "slack",
  displayName: "Slack",
  authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.access",
  tokenEndpointAuth: "client_secret_post",
  userinfoEndpoint: "https://slack.com/api/auth.test",
  identityPaths: { subject: "user_id", name: "user" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://slack.com",
  scopeGroups: {
    collaboration: {
      scopes: ["channels:history", "channels:read", "chat:write"],
    },
  },
  connectorBindings: {
    slack: {
      connectScopeGroups: ["collaboration"],
      requiredScopeGroups: ["collaboration"],
    },
    slackbot: {
      connectScopeGroups: ["collaboration"],
      requiredScopeGroups: ["collaboration"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const AIRTABLE: ProviderManifest = {
  key: "airtable",
  displayName: "Airtable",
  authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
  tokenEndpoint: "https://airtable.com/oauth2/v1/token",
  tokenEndpointAuth: "client_secret_basic",
  userinfoEndpoint: "https://api.airtable.com/v0/meta/whoami",
  identityMode: "userinfo",
  requiresPkce: true,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.airtable.com",
  scopeGroups: {
    records: {
      scopes: [
        "data.records:read",
        "data.records:write",
        "schema.bases:read",
        "user.email:read",
      ],
    },
  },
  connectorBindings: {
    airtable: {
      connectScopeGroups: ["records"],
      requiredScopeGroups: ["records"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const ASANA: ProviderManifest = {
  key: "asana",
  displayName: "Asana",
  authorizationEndpoint: "https://app.asana.com/-/oauth_authorize",
  tokenEndpoint: "https://app.asana.com/-/oauth_token",
  userinfoEndpoint: "https://app.asana.com/api/1.0/users/me",
  identityPaths: {
    subject: "data.gid",
    email: "data.email",
    name: "data.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: true,
  sendsScopesInAuthorization: false,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://app.asana.com",
  scopeGroups: { account: { scopes: ["default"] } },
  connectorBindings: {
    asana: {
      connectScopeGroups: ["account"],
      requiredScopeGroups: ["account"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const CLICKUP: ProviderManifest = {
  key: "clickup",
  displayName: "ClickUp",
  authorizationEndpoint: "https://app.clickup.com/api",
  tokenEndpoint: "https://api.clickup.com/api/v2/oauth/token",
  tokenRequestEncoding: "json",
  userinfoEndpoint: "https://api.clickup.com/api/v2/user",
  identityPaths: {
    subject: "user.id",
    email: "user.email",
    name: "user.username",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  sendsScopesInAuthorization: false,
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.clickup.com",
  scopeGroups: { workspace: { scopes: ["workspace:configured"] } },
  connectorBindings: {
    clickup: {
      connectScopeGroups: ["workspace"],
      requiredScopeGroups: ["workspace"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const MONDAY: ProviderManifest = {
  key: "monday",
  displayName: "monday.com",
  authorizationEndpoint: "https://auth.monday.com/oauth2/authorize",
  tokenEndpoint: "https://auth.monday.com/oauth2/token",
  userinfoEndpoint: "https://api.monday.com/v2",
  userinfoRequest: {
    method: "POST",
    body: { query: "{ me { id name email } }" },
  },
  identityPaths: {
    subject: "data.me.id",
    email: "data.me.email",
    name: "data.me.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.monday.com",
  scopeGroups: {
    boards: { scopes: ["me:read", "boards:read", "boards:write"] },
  },
  connectorBindings: {
    monday: {
      connectScopeGroups: ["boards"],
      requiredScopeGroups: ["boards"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const LINEAR: ProviderManifest = {
  key: "linear",
  displayName: "Linear",
  authorizationEndpoint: "https://linear.app/oauth/authorize",
  tokenEndpoint: "https://api.linear.app/oauth/token",
  tokenEndpointAuth: "client_secret_basic",
  userinfoEndpoint: "https://api.linear.app/graphql",
  userinfoRequest: {
    method: "POST",
    body: { query: "{ viewer { id name email } }" },
  },
  identityPaths: {
    subject: "data.viewer.id",
    email: "data.viewer.email",
    name: "data.viewer.name",
  },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: false,
  accessTokensExpire: false,
  scopeSeparator: ",",
  refreshSkewMs: 0,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.linear.app",
  scopeGroups: { issues: { scopes: ["read", "write"] } },
  connectorBindings: {
    linear: {
      connectScopeGroups: ["issues"],
      requiredScopeGroups: ["issues"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const ATLASSIAN: ProviderManifest = {
  key: "atlassian",
  displayName: "Atlassian",
  authorizationEndpoint: "https://auth.atlassian.com/authorize",
  tokenEndpoint: "https://auth.atlassian.com/oauth/token",
  tokenRequestEncoding: "json",
  userinfoEndpoint: "https://api.atlassian.com/me",
  identityPaths: { subject: "account_id", email: "email", name: "name" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: true,
  authorizationParams: { audience: "api.atlassian.com", prompt: "consent" },
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://api.atlassian.com",
  scopeGroups: {
    jira: {
      scopes: [
        "offline_access",
        "read:me",
        "read:jira-user",
        "read:jira-work",
        "write:jira-work",
      ],
    },
  },
  connectorBindings: {
    jira: {
      connectScopeGroups: ["jira"],
      requiredScopeGroups: ["jira"],
    },
  },
  verificationStatus: "unverified",
  registrationVersion: 1,
};

const CANVAS: ProviderManifest = {
  key: "canvas",
  displayName: "Canvas LMS",
  authorizationEndpoint: "https://canvas.instructure.com/login/oauth2/auth",
  tokenEndpoint: "https://canvas.instructure.com/login/oauth2/token",
  userinfoEndpoint: "https://canvas.instructure.com/api/v1/users/self/profile",
  identityPaths: { subject: "id", email: "primary_email", name: "name" },
  identityMode: "userinfo",
  requiresPkce: false,
  usesOfflineAccess: true,
  refreshSkewMs: 5 * 60 * 1000,
  callbackPath: "/api/connectors/oauth/callback",
  apiOrigin: "https://canvas.instructure.com",
  resourceOriginHostSuffixes: ["instructure.com"],
  scopeGroups: {
    courses: {
      scopes: [
        "url:GET|/api/v1/courses",
        "url:POST|/api/v1/accounts/:account_id/courses",
      ],
    },
  },
  connectorBindings: {
    canvas: {
      connectScopeGroups: ["courses"],
      requiredScopeGroups: ["courses"],
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
  [GITHUB.key]: GITHUB,
  [SUPABASE.key]: SUPABASE,
  [META.key]: META,
  [REDDIT.key]: REDDIT,
  [LINKEDIN.key]: LINKEDIN,
  [MOCK_PROVIDER.key]: MOCK_PROVIDER,
  [HUBSPOT.key]: HUBSPOT,
  [GONG.key]: GONG,
  [PIPEDRIVE.key]: PIPEDRIVE,
  [SALESFORCE.key]: SALESFORCE,
  [ATTIO.key]: ATTIO,
  [FIGMA.key]: FIGMA,
  [STRIPE.key]: STRIPE,
  [NOTION.key]: NOTION,
  [SLACK.key]: SLACK,
  [AIRTABLE.key]: AIRTABLE,
  [ASANA.key]: ASANA,
  [CLICKUP.key]: CLICKUP,
  [MONDAY.key]: MONDAY,
  [LINEAR.key]: LINEAR,
  [ATLASSIAN.key]: ATLASSIAN,
  [CANVAS.key]: CANVAS,
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

/** Validate a provider-issued tenant URL before it can influence any fetch. */
export const resolveProviderResourceOrigin = (
  manifest: ProviderManifest,
  candidate: unknown,
): string => {
  if (typeof candidate !== "string" || !candidate.trim())
    return manifest.apiOrigin;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConnectorError("code_exchange_failed");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConnectorError("code_exchange_failed");
  }
  const suffixes = manifest.resourceOriginHostSuffixes ?? [];
  const hostname = url.hostname.toLowerCase();
  if (
    suffixes.length === 0 ||
    !suffixes.some((suffix) => {
      const normalized = suffix.toLowerCase().replace(/^\./u, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    })
  ) {
    throw new ConnectorError("code_exchange_failed");
  }
  return url.origin;
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
  if (binding) return [...binding.connectScopeGroups];
  if (manifest.connectorBindings) {
    throw new ConnectorError("unregistered_scope");
  }
  return [...requested];
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
  if (args.manifest.sendsScopesInAuthorization !== false) {
    url.searchParams.set(
      "scope",
      args.scopes.join(args.manifest.scopeSeparator ?? " "),
    );
  }
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
  const body = new URLSearchParams(args.body);
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.manifest.tokenEndpointAuth === "client_secret_basic") {
    body.delete("client_id");
    body.delete("client_secret");
    headers.authorization = basicAuthorization(
      args.clientId,
      args.clientSecret,
    );
  }
  if (args.manifest.tokenRequestEncoding === "json") {
    headers["content-type"] = "application/json";
    return { headers, body: JSON.stringify(Object.fromEntries(body)) };
  }
  headers["content-type"] = "application/x-www-form-urlencoded";
  return { headers, body: body.toString() };
};

export const parseScopeString = (scope: unknown): string[] => {
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string");
  }
  if (typeof scope === "string") {
    return scope.split(/[\s,]+/u).filter(Boolean);
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
  httpsOnly("refreshEndpoint", manifest.refreshEndpoint);
  httpsOnly("revocationEndpoint", manifest.revocationEndpoint);
  httpsOnly("userinfoEndpoint", manifest.userinfoEndpoint);
  httpsOnly("apiOrigin", manifest.apiOrigin);
  if (!manifest.callbackPath.startsWith("/")) {
    problems.push(`${manifest.key}.callbackPath must be an absolute path`);
  }
  if (manifest.userinfoPath && !manifest.userinfoPath.startsWith("/")) {
    problems.push(`${manifest.key}.userinfoPath must be an absolute path`);
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
  if (
    manifest.identityMode === "userinfo" &&
    !manifest.userinfoEndpoint &&
    !manifest.userinfoPath
  ) {
    problems.push(
      `${manifest.key} is userinfo but has no userinfo endpoint or path`,
    );
  }
  return problems;
};
