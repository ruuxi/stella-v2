/**
 * First-party social/media connector adapters.
 *
 * Scope: the in-scope providers of Stella's first-party connector program,
 * limited to the current Composio popularity pages 1-2 social entries —
 * Twitter/X, Instagram, YouTube, Reddit, Facebook, Meta Ads, and LinkedIn.
 * (WhatsApp is intentionally excluded: it is not in the current top 60 and is
 * handled by backend-owned communication services elsewhere.)
 *
 * These adapters are deliberately NARROW. The shared first-party OAuth
 * execution core (see `native-oauth-provider-config.ts` /
 * `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`) is still being built, so this
 * module only describes, per connector:
 *   - the OAuth provider config used for auth/execution (with the Meta shared
 *     grant reused for Facebook / Instagram / Meta Ads),
 *   - the scope-aware readiness of first-party reads vs writes, and
 *   - a small set of REAL representative safe reads and representative writes.
 *
 * It never flips a provider to production-ready and never dispatches a call.
 * Until the core enables native execution (deliberate allowlist change in
 * `native-oauth-provider-config.ts`) these connectors continue to resolve and
 * execute through their preserved Composio fallback, so there is exactly one
 * execution route and writes are never dual-executed.
 *
 * IDs are the canonical catalog IDs (`twitter`, `instagram`, `youtube`,
 * `reddit`, `facebook`, `metaads`, `linkedin`) and must be preserved.
 */

import {
  getNativeOAuthProviderConfig,
  getNativeOAuthProviderSetupGroup,
  hasNativeOAuthProviderClientIdOverride,
  isNativeOAuthLocalExecutionProductionReady,
  type NativeOAuthProviderConfig,
} from "./native-oauth-provider-config.js";

export type SocialConnectorAccess = "read" | "write";

export type SocialConnectorAction = {
  /** Canonical, stable action id (upper snake case). */
  name: string;
  title: string;
  description: string;
  /** Whether the action only reads or also mutates provider state. */
  access: SocialConnectorAccess;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * API path relative to the provider config `resourceUrl`. `{placeholder}`
   * segments are caller-supplied ids (page id, ad account id, etc.).
   */
  path: string;
  /** OAuth scopes this specific action needs to succeed. */
  requiredScopes: readonly string[];
  inputSchema?: Record<string, unknown>;
};

export type SocialConnectorAdapter = {
  /** Canonical catalog id; preserved and shared with the Composio fallback. */
  id: string;
  name: string;
  category: string;
  /**
   * Native OAuth provider config id used for auth + execution. Facebook,
   * Instagram, and Meta Ads all resolve through the shared `meta` provider.
   */
  providerConfigId: string;
  /** Non-empty when this connector authorizes through a shared provider grant. */
  sharedGrant?: { id: string; name: string };
  /** Union of scopes needed for the representative safe reads. */
  readScopes: readonly string[];
  /** Union of scopes needed for the representative writes. */
  writeScopes: readonly string[];
  actions: readonly SocialConnectorAction[];
};

const stringArrayProp = (description: string) => ({
  type: "array" as const,
  items: { type: "string" as const },
  description,
});

const TWITTER_ADAPTER: SocialConnectorAdapter = {
  id: "twitter",
  name: "Twitter/X",
  category: "social media",
  providerConfigId: "twitter",
  readScopes: ["tweet.read", "users.read"],
  writeScopes: ["tweet.write", "users.read"],
  actions: [
    {
      name: "TWITTER_GET_ME",
      title: "Get authenticated user",
      description: "Read the connected X account profile.",
      access: "read",
      method: "GET",
      path: "/users/me",
      requiredScopes: ["tweet.read", "users.read"],
    },
    {
      name: "TWITTER_GET_USER_TWEETS",
      title: "List a user's recent tweets",
      description: "Read the most recent tweets for a user id.",
      access: "read",
      method: "GET",
      path: "/users/{id}/tweets",
      requiredScopes: ["tweet.read", "users.read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "X user id." },
          max_results: {
            type: "number",
            description: "1-100. Defaults to 10.",
          },
        },
      },
    },
    {
      name: "TWITTER_CREATE_TWEET",
      title: "Post a tweet",
      description: "Publish a tweet from the connected account.",
      access: "write",
      method: "POST",
      path: "/tweets",
      requiredScopes: ["tweet.write", "users.read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", description: "Tweet body (<=280 chars)." },
        },
      },
    },
  ],
};

const YOUTUBE_READONLY = "https://www.googleapis.com/auth/youtube.readonly";
const YOUTUBE_FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";

const YOUTUBE_ADAPTER: SocialConnectorAdapter = {
  id: "youtube",
  name: "YouTube",
  category: "entertainment & media",
  providerConfigId: "youtube",
  readScopes: [YOUTUBE_READONLY],
  writeScopes: [YOUTUBE_FORCE_SSL],
  actions: [
    {
      name: "YOUTUBE_LIST_MY_CHANNELS",
      title: "List my channels",
      description: "Read the channels owned by the connected account.",
      access: "read",
      method: "GET",
      path: "/channels?part=snippet,statistics&mine=true",
      requiredScopes: [YOUTUBE_READONLY],
    },
    {
      name: "YOUTUBE_SEARCH",
      title: "Search videos",
      description: "Read search results for a query.",
      access: "read",
      method: "GET",
      path: "/search?part=snippet",
      requiredScopes: [YOUTUBE_READONLY],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["q"],
        properties: { q: { type: "string", description: "Search query." } },
      },
    },
    {
      name: "YOUTUBE_INSERT_PLAYLIST",
      title: "Create a playlist",
      description: "Create a new playlist on the connected channel.",
      access: "write",
      method: "POST",
      path: "/playlists?part=snippet,status",
      requiredScopes: [YOUTUBE_FORCE_SSL],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["snippet"],
        properties: {
          snippet: { type: "object", additionalProperties: true },
          status: { type: "object", additionalProperties: true },
        },
      },
    },
  ],
};

const REDDIT_ADAPTER: SocialConnectorAdapter = {
  id: "reddit",
  name: "Reddit",
  category: "marketing & social media",
  providerConfigId: "reddit",
  readScopes: ["identity", "read"],
  writeScopes: ["submit"],
  actions: [
    {
      name: "REDDIT_GET_ME",
      title: "Get my account",
      description: "Read the connected Reddit account identity.",
      access: "read",
      method: "GET",
      path: "/api/v1/me",
      requiredScopes: ["identity"],
    },
    {
      name: "REDDIT_GET_SUBREDDIT_HOT",
      title: "List hot posts",
      description: "Read the hot listing for a subreddit.",
      access: "read",
      method: "GET",
      path: "/r/{subreddit}/hot",
      requiredScopes: ["read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["subreddit"],
        properties: {
          subreddit: { type: "string", description: "Subreddit name." },
          limit: { type: "number", description: "1-100. Defaults to 25." },
        },
      },
    },
    {
      name: "REDDIT_SUBMIT",
      title: "Submit a post",
      description: "Submit a self or link post to a subreddit.",
      access: "write",
      method: "POST",
      path: "/api/submit",
      requiredScopes: ["submit"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sr", "kind", "title"],
        properties: {
          sr: { type: "string", description: "Subreddit (without r/)." },
          kind: { type: "string", description: '"self" or "link".' },
          title: { type: "string", description: "Post title." },
          text: { type: "string", description: "Self post body." },
          url: { type: "string", description: "Link post URL." },
        },
      },
    },
  ],
};

const LINKEDIN_ADAPTER: SocialConnectorAdapter = {
  id: "linkedin",
  name: "LinkedIn",
  category: "marketing & social media",
  providerConfigId: "linkedin",
  readScopes: ["openid", "profile"],
  writeScopes: ["w_member_social"],
  actions: [
    {
      name: "LINKEDIN_GET_ME",
      title: "Get my profile",
      description: "Read the connected member's OpenID profile.",
      access: "read",
      method: "GET",
      path: "/userinfo",
      requiredScopes: ["openid", "profile"],
    },
    {
      name: "LINKEDIN_CREATE_POST",
      title: "Create a post",
      description: "Share a UGC post as the connected member.",
      access: "write",
      method: "POST",
      path: "/ugcPosts",
      requiredScopes: ["w_member_social"],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["author", "lifecycleState", "specificContent"],
        properties: {
          author: { type: "string", description: "urn:li:person:{id}." },
          lifecycleState: { type: "string" },
          specificContent: { type: "object", additionalProperties: true },
          visibility: { type: "object", additionalProperties: true },
        },
      },
    },
  ],
};

const META_GRANT = { id: "meta", name: "Meta" } as const;

const FACEBOOK_ADAPTER: SocialConnectorAdapter = {
  id: "facebook",
  name: "Facebook",
  category: "marketing & social media",
  providerConfigId: "meta",
  sharedGrant: META_GRANT,
  readScopes: ["pages_show_list", "pages_read_engagement"],
  writeScopes: ["pages_manage_posts"],
  actions: [
    {
      name: "FACEBOOK_LIST_PAGES",
      title: "List managed Pages",
      description: "Read the Pages the connected user manages.",
      access: "read",
      method: "GET",
      path: "/me/accounts",
      requiredScopes: ["pages_show_list"],
    },
    {
      name: "FACEBOOK_LIST_PAGE_POSTS",
      title: "List Page posts",
      description: "Read recent posts for a managed Page.",
      access: "read",
      method: "GET",
      path: "/{pageId}/posts",
      requiredScopes: ["pages_read_engagement"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pageId"],
        properties: { pageId: { type: "string", description: "Page id." } },
      },
    },
    {
      name: "FACEBOOK_CREATE_PAGE_POST",
      title: "Publish a Page post",
      description: "Publish a text post to a managed Page feed.",
      access: "write",
      method: "POST",
      path: "/{pageId}/feed",
      requiredScopes: ["pages_manage_posts"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pageId", "message"],
        properties: {
          pageId: { type: "string", description: "Page id." },
          message: { type: "string", description: "Post text." },
        },
      },
    },
  ],
};

const INSTAGRAM_ADAPTER: SocialConnectorAdapter = {
  id: "instagram",
  name: "Instagram",
  category: "social media",
  providerConfigId: "meta",
  sharedGrant: META_GRANT,
  readScopes: ["instagram_basic"],
  writeScopes: ["instagram_content_publish"],
  actions: [
    {
      name: "INSTAGRAM_GET_ACCOUNT",
      title: "Get IG account",
      description: "Read an Instagram professional account profile.",
      access: "read",
      method: "GET",
      path: "/{igUserId}?fields=username,followers_count,media_count",
      requiredScopes: ["instagram_basic"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["igUserId"],
        properties: {
          igUserId: { type: "string", description: "IG user id." },
        },
      },
    },
    {
      name: "INSTAGRAM_LIST_MEDIA",
      title: "List media",
      description: "Read recent media for an Instagram account.",
      access: "read",
      method: "GET",
      path: "/{igUserId}/media",
      requiredScopes: ["instagram_basic"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["igUserId"],
        properties: {
          igUserId: { type: "string", description: "IG user id." },
        },
      },
    },
    {
      name: "INSTAGRAM_PUBLISH_MEDIA",
      title: "Publish a media container",
      description: "Publish a previously created media container.",
      access: "write",
      method: "POST",
      path: "/{igUserId}/media_publish",
      requiredScopes: ["instagram_content_publish"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["igUserId", "creation_id"],
        properties: {
          igUserId: { type: "string", description: "IG user id." },
          creation_id: { type: "string", description: "Media container id." },
        },
      },
    },
  ],
};

const METAADS_ADAPTER: SocialConnectorAdapter = {
  id: "metaads",
  name: "Meta Ads",
  category: "advertising & marketing",
  providerConfigId: "meta",
  sharedGrant: META_GRANT,
  readScopes: ["ads_read"],
  writeScopes: ["ads_management"],
  actions: [
    {
      name: "METAADS_LIST_AD_ACCOUNTS",
      title: "List ad accounts",
      description: "Read the ad accounts the connected user can access.",
      access: "read",
      method: "GET",
      path: "/me/adaccounts",
      requiredScopes: ["ads_read"],
    },
    {
      name: "METAADS_LIST_CAMPAIGNS",
      title: "List campaigns",
      description: "Read campaigns for an ad account.",
      access: "read",
      method: "GET",
      path: "/{adAccountId}/campaigns",
      requiredScopes: ["ads_read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["adAccountId"],
        properties: {
          adAccountId: {
            type: "string",
            description: "Ad account id (act_XXXX).",
          },
          fields: stringArrayProp("Campaign fields to return."),
        },
      },
    },
    {
      name: "METAADS_UPDATE_CAMPAIGN_STATUS",
      title: "Pause or resume a campaign",
      description: "Update a campaign's delivery status.",
      access: "write",
      method: "POST",
      path: "/{campaignId}",
      requiredScopes: ["ads_management"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId", "status"],
        properties: {
          campaignId: { type: "string", description: "Campaign id." },
          status: {
            type: "string",
            description: '"ACTIVE" or "PAUSED".',
          },
        },
      },
    },
  ],
};

const SOCIAL_CONNECTOR_ADAPTERS: readonly SocialConnectorAdapter[] = [
  TWITTER_ADAPTER,
  INSTAGRAM_ADAPTER,
  YOUTUBE_ADAPTER,
  REDDIT_ADAPTER,
  FACEBOOK_ADAPTER,
  METAADS_ADAPTER,
  LINKEDIN_ADAPTER,
];

const SOCIAL_CONNECTOR_BY_ID = new Map(
  SOCIAL_CONNECTOR_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

export const SOCIAL_CONNECTOR_IDS: readonly string[] =
  SOCIAL_CONNECTOR_ADAPTERS.map((adapter) => adapter.id);

export const isSocialConnectorId = (id: string): boolean =>
  SOCIAL_CONNECTOR_BY_ID.has(id.trim().toLowerCase());

export const getSocialConnectorAdapter = (
  id: string,
): SocialConnectorAdapter | undefined =>
  SOCIAL_CONNECTOR_BY_ID.get(id.trim().toLowerCase());

export const listSocialConnectorAdapters =
  (): readonly SocialConnectorAdapter[] => SOCIAL_CONNECTOR_ADAPTERS;

const isSubset = (
  required: readonly string[],
  granted: ReadonlySet<string>,
): boolean => required.every((scope) => granted.has(scope));

const missingScopes = (
  required: readonly string[],
  granted: ReadonlySet<string>,
): string[] => required.filter((scope) => !granted.has(scope));

/**
 * Active execution route for a social connector.
 *
 * `composio-fallback` is the shipped route: the shared first-party core has
 * not enabled native execution for this provider, so the connector resolves
 * and runs through its preserved Composio backend. `native-first-party` is
 * only reported once the provider is on the reviewed production-ready allowlist
 * AND its OAuth config resolves as ready — the same gate the execution path
 * enforces, so the two routes can never both fire for one call.
 */
export type SocialConnectorExecutionRoute =
  | "composio-fallback"
  | "native-first-party";

export type SocialConnectorActionStatus = {
  name: string;
  access: SocialConnectorAccess;
  method: SocialConnectorAction["method"];
  path: string;
  requiredScopes: readonly string[];
  /** True when every required scope is present in the granted set. */
  available: boolean;
  missingScopes: readonly string[];
};

export type SocialConnectorScopeStatus = {
  id: string;
  name: string;
  providerConfigId: string;
  sharedGrant?: { id: string; name: string };
  /** Whether Stella has a registered OAuth app (client id) for the provider. */
  hasProviderApp: boolean;
  /** Scopes the resolved provider config would request, if known. */
  grantedScopes: readonly string[];
  readScopes: readonly string[];
  writeScopes: readonly string[];
  readReady: boolean;
  writeReady: boolean;
  missingReadScopes: readonly string[];
  missingWriteScopes: readonly string[];
  actions: readonly SocialConnectorActionStatus[];
  /** The single execution route currently in effect (never dual). */
  executionRoute: SocialConnectorExecutionRoute;
};

export type SocialConnectorScopeStatusOptions = {
  /**
   * Explicit granted scope set. When omitted, the resolved native OAuth
   * provider config's scopes are used (env-driven), which lets the shared
   * grant flow through for Meta connectors without re-reading the app config.
   */
  grantedScopes?: readonly string[];
  /**
   * Injected provider config, primarily for tests. Falls back to
   * `getNativeOAuthProviderConfig(providerConfigId)`.
   */
  config?: NativeOAuthProviderConfig | null;
};

const resolveGrantedScopes = (
  adapter: SocialConnectorAdapter,
  options: SocialConnectorScopeStatusOptions,
): { scopes: string[]; hasProviderApp: boolean } => {
  if (options.grantedScopes) {
    return {
      scopes: [...options.grantedScopes],
      hasProviderApp: hasNativeOAuthProviderClientIdOverride(
        adapter.providerConfigId,
      ),
    };
  }
  const config =
    options.config !== undefined
      ? options.config
      : getNativeOAuthProviderConfig(adapter.providerConfigId);
  return {
    scopes: config?.scopes ? [...config.scopes] : [],
    hasProviderApp:
      Boolean(config?.clientId) ||
      hasNativeOAuthProviderClientIdOverride(adapter.providerConfigId),
  };
};

/**
 * Per-connector, scope-aware first-party status. Pure and deterministic given
 * an explicit `grantedScopes`/`config`; otherwise it reflects the current
 * environment's resolved provider config. Reads/writes are reported
 * independently so a connector can be read-ready before its write scopes clear
 * partner review.
 */
export const getSocialConnectorScopeStatus = (
  id: string,
  options: SocialConnectorScopeStatusOptions = {},
): SocialConnectorScopeStatus | undefined => {
  const adapter = getSocialConnectorAdapter(id);
  if (!adapter) return undefined;
  const { scopes, hasProviderApp } = resolveGrantedScopes(adapter, options);
  const grantedSet = new Set(scopes);
  const actions: SocialConnectorActionStatus[] = adapter.actions.map(
    (action) => ({
      name: action.name,
      access: action.access,
      method: action.method,
      path: action.path,
      requiredScopes: action.requiredScopes,
      available: isSubset(action.requiredScopes, grantedSet),
      missingScopes: missingScopes(action.requiredScopes, grantedSet),
    }),
  );
  const executionRoute: SocialConnectorExecutionRoute =
    isNativeOAuthLocalExecutionProductionReady(adapter.providerConfigId)
      ? "native-first-party"
      : "composio-fallback";
  return {
    id: adapter.id,
    name: adapter.name,
    providerConfigId: adapter.providerConfigId,
    ...(adapter.sharedGrant
      ? { sharedGrant: adapter.sharedGrant }
      : getNativeOAuthProviderSetupGroup(adapter.providerConfigId)
        ? {
            sharedGrant: getNativeOAuthProviderSetupGroup(
              adapter.providerConfigId,
            ),
          }
        : {}),
    hasProviderApp,
    grantedScopes: scopes,
    readScopes: adapter.readScopes,
    writeScopes: adapter.writeScopes,
    readReady: isSubset(adapter.readScopes, grantedSet),
    writeReady: isSubset(adapter.writeScopes, grantedSet),
    missingReadScopes: missingScopes(adapter.readScopes, grantedSet),
    missingWriteScopes: missingScopes(adapter.writeScopes, grantedSet),
    actions,
    executionRoute,
  };
};

/** Representative safe reads and writes, in catalog-action shape. */
export const getSocialConnectorActions = (
  id: string,
): readonly SocialConnectorAction[] =>
  getSocialConnectorAdapter(id)?.actions ?? [];
