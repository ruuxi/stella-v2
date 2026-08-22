// First-party developer-data & GitHub connector adapters.
//
// This module is the declarative *adapter* layer for a curated set of
// developer-data-search and GitHub connectors that Stella owns end to end:
// GitHub, Supabase, Firecrawl, Tavily, Exa, SerpAPI, Perplexity AI, PostHog,
// Snowflake, Ably, AbuseIPDB, 44API, Abstract, and People Data Labs.
//
// Design boundaries (deliberate — do not "helpfully" widen them):
//
//   * Adapters describe auth (official OAuth / API-key), required scopes or
//     credential fields, a native REST/API shape, representative actions, a
//     stable id, and the authoritative Composio fallback toolkit. They are
//     metadata + policy — they do NOT themselves execute anything.
//   * While the shared local-execution core is still pending, Composio remains
//     the single authoritative executor for every action here. Local execution
//     is gated by FIRST_PARTY_LOCAL_EXECUTION_ENABLED, which is EMPTY by
//     design. Turning an id on there is the one deliberate switch that lets a
//     future native dispatcher run — never infer readiness from the presence
//     of an adapter, config, or credential. This mirrors the equally-empty
//     PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS gate in
//     native-oauth-provider-config.ts and exists so we never dual-execute a
//     mutation against both a native path and Composio.
//   * Composio-owned Search / Browser Tool / Codeinterpreter are NOT wrapped as
//     third-party adapters. They are mapped to Stella's own native web-search,
//     browser, and shell/sandbox capabilities as documented aliases (see
//     NATIVE_CAPABILITY_ALIASES). We prefer parity via native tools over
//     emulating proprietary Composio APIs.
//
// The catalog overlay helper (firstPartyConnectorCatalogOverlay) produces
// backend-composio NativeConnectorCatalogEntry values via the existing
// serverCatalog override seam, so the registry can be wired into the Store
// catalog without modifying the bundled-catalog derivation. It is intentionally
// not auto-applied: production routing stays with the authoritative Store
// catalog until real actions have been verified.

import { getNativeOAuthProviderConfig } from "./native-oauth-provider-config.js";
import type { NativeOAuthProviderConfig } from "./native-oauth-provider-config.js";
import type {
  NativeConnectorCatalogAction,
  NativeConnectorCatalogEntry,
} from "./native-integrations.js";

export type FirstPartyAuthKind = "oauth" | "api_key";

/**
 * Credential/scope-aware status for a first-party adapter. Deliberately narrow
 * and orthogonal to NativeConnectorOAuthSetupStatus (which is OAuth-only): this
 * covers both auth kinds and the shared-core-pending state.
 */
export type FirstPartyConnectorStatus =
  | "ready"
  | "missing_credential"
  | "missing_scopes"
  | "missing_oauth_app"
  | "local_execution_pending";

export type FirstPartyConnectorAction = {
  /** Composio action slug — the authoritative executable id via the fallback. */
  name: string;
  title: string;
  description: string;
  /**
   * Marks state-changing actions. Used to keep boundaries narrow: a native
   * path must never run a mutation while Composio can also run it (no
   * dual-execution). Read-only actions are the safe first candidates for any
   * future native dispatcher.
   */
  mutating?: boolean;
};

export type FirstPartyOAuthAdapter = {
  /**
   * Required OAuth scopes. Kept alongside (not instead of) the provider
   * config's scopes so status checks stay explicit and testable even if the
   * shared OAuth config changes shape.
   */
  scopes: readonly string[];
  /** Stored-credential key (matches the native OAuth provider config). */
  tokenKey: string;
  /** id passed to getNativeOAuthProviderConfig — usually the adapter id. */
  providerConfigId: string;
};

export type FirstPartyApiKeyAdapter = {
  /** Native API base URL, for the future shared-core local execution shape. */
  baseUrl?: string;
  /** How the API key is presented on outbound requests once native exec lands. */
  placement: "authorization_bearer" | "header" | "query" | "basic";
  /** Header name for placement "header" (e.g. "x-api-key", "Key"). */
  headerName?: string;
  /** Query parameter name for placement "query" (e.g. "api_key"). */
  queryParam?: string;
  /** Stored-credential key namespace for the API key. */
  tokenKey: string;
  /** Human label shown in the credential dialog. */
  credentialLabel: string;
  /** Where the user obtains the key. */
  credentialUrl?: string;
};

export type FirstPartyConnectorAdapter = {
  /** Stable id — equals the lowercased Composio toolkit slug. */
  id: string;
  name: string;
  category: string;
  description: string;
  auth: FirstPartyAuthKind;
  oauth?: FirstPartyOAuthAdapter;
  apiKey?: FirstPartyApiKeyAdapter;
  representativeActions: readonly FirstPartyConnectorAction[];
  /** Authoritative executor while the shared local-execution core is pending. */
  composio: { toolkit: string };
  sourceUrl: string;
  iconUrl?: string;
};

const asActions = (
  entries: readonly FirstPartyConnectorAction[],
): readonly FirstPartyConnectorAction[] => entries;

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * GitHub — first-party OAuth (device flow). The native OAuth provider config
 * (github) ships a real Stella client id, so this adapter is credential-aware
 * out of the box; execution still routes through Composio until the shared
 * core is enabled.
 */
const GITHUB: FirstPartyConnectorAdapter = {
  id: "github",
  name: "GitHub",
  category: "developer tools",
  description:
    "Search repositories, read repo/PR/issue data, and manage issues and pull requests on GitHub.",
  auth: "oauth",
  oauth: {
    scopes: ["repo", "read:user", "user:email"],
    tokenKey: "native-oauth:github",
    providerConfigId: "github",
  },
  representativeActions: asActions([
    {
      name: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
      title: "List repositories",
      description: "List repositories the authenticated user can access.",
    },
    {
      name: "GITHUB_GET_A_REPOSITORY",
      title: "Get a repository",
      description: "Fetch a single repository's metadata.",
    },
    {
      name: "GITHUB_SEARCH_REPOSITORIES",
      title: "Search repositories",
      description: "Search public and accessible repositories by query.",
    },
    {
      name: "GITHUB_LIST_PULL_REQUESTS",
      title: "List pull requests",
      description: "List pull requests for a repository.",
    },
    {
      name: "GITHUB_SEARCH_ISSUES",
      title: "Search issues and PRs",
      description: "Search issues and pull requests with qualifiers.",
    },
    {
      name: "GITHUB_CREATE_AN_ISSUE",
      title: "Create an issue",
      description: "Open a new issue in a repository.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "GITHUB" },
  sourceUrl: "https://github.com",
};

/**
 * Supabase — first-party OAuth (Management API). Uses a backend token
 * exchange, so status stays "missing_oauth_app" until the Stella OAuth app +
 * backend exchange are provisioned.
 */
const SUPABASE: FirstPartyConnectorAdapter = {
  id: "supabase",
  name: "Supabase",
  category: "developer tools",
  description:
    "Manage Supabase projects, organizations, and database branches via the Management API.",
  auth: "oauth",
  oauth: {
    scopes: ["all"],
    tokenKey: "native-oauth:supabase",
    providerConfigId: "supabase",
  },
  representativeActions: asActions([
    {
      name: "SUPABASE_LIST_ALL_PROJECTS",
      title: "List projects",
      description: "List all Supabase projects for the account.",
    },
    {
      name: "SUPABASE_GET_PROJECT",
      title: "Get a project",
      description: "Fetch details for a single Supabase project.",
    },
    {
      name: "SUPABASE_LIST_ALL_ORGANIZATIONS",
      title: "List organizations",
      description: "List organizations the account belongs to.",
    },
    {
      name: "SUPABASE_CREATE_A_PROJECT",
      title: "Create a project",
      description: "Provision a new Supabase project.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "SUPABASE" },
  sourceUrl: "https://supabase.com",
};

/**
 * Snowflake — first-party OAuth. Account-scoped resource URL is resolved from
 * env/config at connect time; backend token exchange is required.
 */
const SNOWFLAKE: FirstPartyConnectorAdapter = {
  id: "snowflake",
  name: "Snowflake",
  category: "data warehouse",
  description:
    "Run SQL statements and inspect databases, schemas, and tables in Snowflake.",
  auth: "oauth",
  oauth: {
    scopes: ["session:role-any"],
    tokenKey: "native-oauth:snowflake",
    providerConfigId: "snowflake",
  },
  representativeActions: asActions([
    {
      name: "SNOWFLAKE_LIST_DATABASES",
      title: "List databases",
      description: "List databases available to the connected role.",
    },
    {
      name: "SNOWFLAKE_DESCRIBE_TABLE",
      title: "Describe a table",
      description: "Return the column definitions for a table.",
    },
    {
      name: "SNOWFLAKE_EXECUTE_SQL_QUERY",
      title: "Execute a SQL statement",
      description:
        "Run a SQL statement via the Snowflake SQL API. May mutate data.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "SNOWFLAKE" },
  sourceUrl: "https://www.snowflake.com",
};

const FIRECRAWL: FirstPartyConnectorAdapter = {
  id: "firecrawl",
  name: "Firecrawl",
  category: "web scraping",
  description:
    "Scrape, crawl, map, and search the web and extract structured content with Firecrawl.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.firecrawl.dev",
    placement: "authorization_bearer",
    tokenKey: "native-apikey:firecrawl",
    credentialLabel: "Firecrawl API key",
    credentialUrl: "https://www.firecrawl.dev/app/api-keys",
  },
  representativeActions: asActions([
    {
      name: "FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM",
      title: "Scrape a URL",
      description: "Scrape a single URL and return clean markdown/JSON.",
    },
    {
      name: "FIRECRAWL_SEARCH",
      title: "Search the web",
      description: "Search the web and optionally scrape the top results.",
    },
    {
      name: "FIRECRAWL_CRAWL",
      title: "Start a web crawl",
      description: "Crawl a site starting from a URL. Long-running job.",
      mutating: true,
    },
    {
      name: "FIRECRAWL_CRAWL_GET",
      title: "Get crawl status",
      description: "Retrieve the status and results of a crawl job.",
    },
  ]),
  composio: { toolkit: "FIRECRAWL" },
  sourceUrl: "https://www.firecrawl.dev",
};

const TAVILY: FirstPartyConnectorAdapter = {
  id: "tavily",
  name: "Tavily",
  category: "web search",
  description:
    "Run web search, page extraction, site mapping, and crawling tuned for AI agents.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.tavily.com",
    placement: "authorization_bearer",
    tokenKey: "native-apikey:tavily",
    credentialLabel: "Tavily API key",
    credentialUrl: "https://app.tavily.com/home",
  },
  representativeActions: asActions([
    {
      name: "TAVILY_SEARCH",
      title: "Search the web",
      description: "Web search with depth, domain, and content controls.",
    },
    {
      name: "TAVILY_EXTRACT",
      title: "Extract page content",
      description: "Extract clean, structured content from URLs.",
    },
    {
      name: "TAVILY_MAP",
      title: "Map a website",
      description: "Discover the pages/URLs of a website.",
    },
    {
      name: "TAVILY_CRAWL",
      title: "Crawl a website",
      description: "Graph-based crawl with path/domain filters.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "TAVILY" },
  sourceUrl: "https://tavily.com",
};

const EXA: FirstPartyConnectorAdapter = {
  id: "exa",
  name: "Exa",
  category: "web search",
  description:
    "Neural/keyword web search, content retrieval, and citation-backed answers with Exa.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.exa.ai",
    placement: "header",
    headerName: "x-api-key",
    tokenKey: "native-apikey:exa",
    credentialLabel: "Exa API key",
    credentialUrl: "https://dashboard.exa.ai/api-keys",
  },
  representativeActions: asActions([
    {
      name: "EXA_SEARCH",
      title: "Search the web",
      description: "Neural or keyword web search with content options.",
    },
    {
      name: "EXA_GET_CONTENTS_ACTION",
      title: "Get contents",
      description: "Fetch text, highlights, and summaries for URLs.",
    },
    {
      name: "EXA_ANSWER",
      title: "Answer a question",
      description: "Generate a direct, citation-backed answer.",
    },
  ]),
  composio: { toolkit: "EXA" },
  sourceUrl: "https://exa.ai",
};

const SERPAPI: FirstPartyConnectorAdapter = {
  id: "serpapi",
  name: "SerpAPI",
  category: "web search",
  description:
    "Real-time structured search-engine results (Google, Bing, News, Maps, and more) via SerpAPI.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://serpapi.com",
    placement: "query",
    queryParam: "api_key",
    tokenKey: "native-apikey:serpapi",
    credentialLabel: "SerpAPI key",
    credentialUrl: "https://serpapi.com/manage-api-key",
  },
  representativeActions: asActions([
    {
      name: "SERPAPI_SEARCH",
      title: "Google search",
      description: "Real-time Google organic search results.",
    },
    {
      name: "SERPAPI_NEWS_SEARCH",
      title: "News search",
      description: "Search Google News for articles.",
    },
    {
      name: "SERPAPI_BING_SEARCH",
      title: "Bing search",
      description: "Real-time Bing search results.",
    },
  ]),
  composio: { toolkit: "SERPAPI" },
  sourceUrl: "https://serpapi.com",
};

const PERPLEXITYAI: FirstPartyConnectorAdapter = {
  id: "perplexityai",
  name: "Perplexity AI",
  category: "artificial intelligence",
  description:
    "Web-grounded chat completions, raw ranked search results, and agentic workflows via Perplexity Sonar.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.perplexity.ai",
    placement: "authorization_bearer",
    tokenKey: "native-apikey:perplexityai",
    credentialLabel: "Perplexity API key",
    credentialUrl: "https://www.perplexity.ai/settings/api",
  },
  representativeActions: asActions([
    {
      name: "PERPLEXITYAI_SEARCH",
      title: "Search the web",
      description: "Raw ranked web search results (no LLM processing).",
    },
    {
      name: "PERPLEXITYAI_CREATE_CHAT_COMPLETION",
      title: "Chat completion",
      description: "Web-grounded Sonar chat completion with citations.",
    },
    {
      name: "PERPLEXITYAI_EXECUTE_AGENT",
      title: "Run an agent",
      description: "Multi-step agentic workflow with built-in tools.",
    },
  ]),
  composio: { toolkit: "PERPLEXITYAI" },
  sourceUrl: "https://www.perplexity.ai",
};

const POSTHOG: FirstPartyConnectorAdapter = {
  id: "posthog",
  name: "PostHog",
  category: "analytics",
  description:
    "Query product analytics, insights, events, and feature flags in PostHog.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://us.posthog.com",
    placement: "authorization_bearer",
    tokenKey: "native-apikey:posthog",
    credentialLabel: "PostHog personal API key",
    credentialUrl: "https://us.posthog.com/settings/user-api-keys",
  },
  representativeActions: asActions([
    {
      name: "POSTHOG_LIST_PROJECTS",
      title: "List projects",
      description: "List projects in the PostHog organization.",
    },
    {
      name: "POSTHOG_GET_INSIGHTS",
      title: "Get insights",
      description: "Fetch saved insights / analytics results.",
    },
    {
      name: "POSTHOG_LIST_FEATURE_FLAGS",
      title: "List feature flags",
      description: "List feature flags for a project.",
    },
    {
      name: "POSTHOG_CREATE_EVENT",
      title: "Capture an event",
      description: "Send an analytics event to PostHog.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "POSTHOG" },
  sourceUrl: "https://posthog.com",
};

const ABLY: FirstPartyConnectorAdapter = {
  id: "ably",
  name: "Ably",
  category: "developer tools",
  description:
    "Publish messages, inspect channels and presence, and read stats on the Ably realtime platform.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://rest.ably.io",
    placement: "basic",
    tokenKey: "native-apikey:ably",
    credentialLabel: "Ably API key",
    credentialUrl: "https://ably.com/accounts",
  },
  representativeActions: asActions([
    {
      name: "ABLY_GET_CHANNEL_HISTORY",
      title: "Get channel history",
      description: "Retrieve message history for a channel.",
    },
    {
      name: "ABLY_LIST_CHANNELS",
      title: "List channels",
      description: "List currently active channels.",
    },
    {
      name: "ABLY_GET_STATS",
      title: "Get stats",
      description: "Read account/application usage statistics.",
    },
    {
      name: "ABLY_PUBLISH_MESSAGE",
      title: "Publish a message",
      description: "Publish a message to a channel.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "ABLY" },
  sourceUrl: "https://ably.com",
};

const ABUSEIPDB: FirstPartyConnectorAdapter = {
  id: "abuseipdb",
  name: "AbuseIPDB",
  category: "security",
  description:
    "Check IP reputation, retrieve reports, and inspect the abuse blacklist via AbuseIPDB.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.abuseipdb.com/api/v2",
    placement: "header",
    headerName: "Key",
    tokenKey: "native-apikey:abuseipdb",
    credentialLabel: "AbuseIPDB API key",
    credentialUrl: "https://www.abuseipdb.com/account/api",
  },
  representativeActions: asActions([
    {
      name: "ABUSEIPDB_CHECK_IP",
      title: "Check an IP",
      description: "Check the abuse confidence score for an IP address.",
    },
    {
      name: "ABUSEIPDB_GET_BLACKLIST",
      title: "Get blacklist",
      description: "Retrieve the abuse blacklist.",
    },
    {
      name: "ABUSEIPDB_CHECK_BLOCK",
      title: "Check a CIDR block",
      description: "Check a subnet/CIDR block for abuse reports.",
    },
    {
      name: "ABUSEIPDB_REPORT_IP",
      title: "Report an IP",
      description: "Report an abusive IP address.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "ABUSEIPDB" },
  sourceUrl: "https://www.abuseipdb.com",
};

const ABSTRACT: FirstPartyConnectorAdapter = {
  id: "abstract",
  name: "Abstract",
  category: "developer tools",
  description:
    "Validate emails and phone numbers and look up IP geolocation with Abstract API.",
  auth: "api_key",
  apiKey: {
    // Abstract exposes one host per product; email validation is representative.
    baseUrl: "https://emailvalidation.abstractapi.com/v1",
    placement: "query",
    queryParam: "api_key",
    tokenKey: "native-apikey:abstract",
    credentialLabel: "Abstract API key",
    credentialUrl: "https://app.abstractapi.com",
  },
  representativeActions: asActions([
    {
      name: "ABSTRACT_VALIDATE_EMAIL",
      title: "Validate an email",
      description: "Validate an email address and check deliverability.",
    },
    {
      name: "ABSTRACT_VALIDATE_PHONE",
      title: "Validate a phone number",
      description: "Validate and format a phone number.",
    },
    {
      name: "ABSTRACT_GET_IP_GEOLOCATION",
      title: "IP geolocation",
      description: "Look up geolocation details for an IP address.",
    },
  ]),
  composio: { toolkit: "ABSTRACT" },
  sourceUrl: "https://www.abstractapi.com",
};

const PEOPLE_DATA_LABS: FirstPartyConnectorAdapter = {
  id: "people_data_labs",
  name: "People Data Labs",
  category: "data enrichment",
  description:
    "Enrich and search person and company records with the People Data Labs API.",
  auth: "api_key",
  apiKey: {
    baseUrl: "https://api.peopledatalabs.com",
    placement: "header",
    headerName: "X-Api-Key",
    tokenKey: "native-apikey:people_data_labs",
    credentialLabel: "People Data Labs API key",
    credentialUrl: "https://dashboard.peopledatalabs.com",
  },
  representativeActions: asActions([
    {
      name: "PEOPLE_DATA_LABS_PERSON_ENRICH",
      title: "Enrich a person",
      description: "Enrich one person by email, name, company, or profile URL.",
    },
    {
      name: "PEOPLE_DATA_LABS_PERSON_SEARCH",
      title: "Search people",
      description:
        "Search the person dataset with an Elasticsearch query or SQL.",
    },
    {
      name: "PEOPLE_DATA_LABS_COMPANY_ENRICH",
      title: "Enrich a company",
      description: "Enrich one company by website, name, profile, or ticker.",
    },
    {
      name: "PEOPLE_DATA_LABS_COMPANY_SEARCH",
      title: "Search companies",
      description: "Search the company dataset with a query or SQL.",
    },
  ]),
  composio: { toolkit: "PEOPLE_DATA_LABS" },
  sourceUrl: "https://www.peopledatalabs.com",
};

const FORTYFOUR_API: FirstPartyConnectorAdapter = {
  id: "44api",
  name: "44API",
  category: "taxes",
  description:
    "Validate VAT/tax identifiers, return company details, and manage account IP whitelists via 44API.",
  auth: "api_key",
  apiKey: {
    placement: "authorization_bearer",
    tokenKey: "native-apikey:44api",
    credentialLabel: "44API key",
    credentialUrl: "https://44api.com",
  },
  representativeActions: asActions([
    {
      name: "FORTYFOUR_API_VALIDATE_VAT_NUMBER",
      title: "Validate a VAT number",
      description: "Validate a VAT/tax ID and return company details.",
    },
    {
      name: "FORTYFOUR_API_LIST_WHITELISTED_IPS",
      title: "List whitelisted IPs",
      description: "List IP addresses on the account whitelist.",
    },
    {
      name: "FORTYFOUR_API_ADD_WHITELISTED_IP",
      title: "Add a whitelisted IP",
      description: "Add an IP address to the account whitelist.",
      mutating: true,
    },
    {
      name: "FORTYFOUR_API_REMOVE_WHITELISTED_IP",
      title: "Remove a whitelisted IP",
      description: "Remove an IP address from the account whitelist.",
      mutating: true,
    },
  ]),
  composio: { toolkit: "44API" },
  sourceUrl: "https://44api.com",
};

export const FIRST_PARTY_CONNECTOR_ADAPTERS: readonly FirstPartyConnectorAdapter[] =
  [
    GITHUB,
    SUPABASE,
    SNOWFLAKE,
    FIRECRAWL,
    TAVILY,
    EXA,
    SERPAPI,
    PERPLEXITYAI,
    POSTHOG,
    ABLY,
    ABUSEIPDB,
    ABSTRACT,
    PEOPLE_DATA_LABS,
    FORTYFOUR_API,
  ];

const ADAPTERS_BY_ID: ReadonlyMap<string, FirstPartyConnectorAdapter> = new Map(
  FIRST_PARTY_CONNECTOR_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

export const getFirstPartyConnectorAdapter = (
  id: string,
): FirstPartyConnectorAdapter | undefined =>
  ADAPTERS_BY_ID.get(id.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Local execution gate (deliberately empty — never dual-execute)
// ---------------------------------------------------------------------------

/**
 * Affirmative, reviewed allowlist of first-party ids whose native execution
 * dispatcher may run. EMPTY by design while the shared local-execution core is
 * pending: every action here executes through Composio. Enabling an id is the
 * one deliberate switch that activates native execution, and must only happen
 * once that id's real actions have been verified — otherwise a native path and
 * Composio could both run the same (possibly mutating) action.
 */
const FIRST_PARTY_LOCAL_EXECUTION_ENABLED = new Set<string>([]);

export const isFirstPartyLocalExecutionEnabled = (id: string): boolean =>
  FIRST_PARTY_LOCAL_EXECUTION_ENABLED.has(id.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Credential/scope-aware status
// ---------------------------------------------------------------------------

export type FirstPartyConnectorStatusInput = {
  /** True when a token/API key is stored for this adapter. */
  hasCredential?: boolean;
  /** OAuth scopes actually granted (from the token response), if known. */
  grantedScopes?: readonly string[];
  /**
   * Whether a Stella OAuth client app is registered for this provider. When
   * omitted, resolved from the native OAuth provider config's client id.
   */
  hasOAuthApp?: boolean;
};

const oauthAppIsRegistered = (
  adapter: FirstPartyConnectorAdapter,
  explicit: boolean | undefined,
): boolean => {
  if (typeof explicit === "boolean") return explicit;
  if (!adapter.oauth) return false;
  const config: NativeOAuthProviderConfig | null = getNativeOAuthProviderConfig(
    adapter.oauth.providerConfigId,
  );
  return Boolean(config?.clientId && config.clientId.trim());
};

/**
 * Resolve a credential/scope-aware status for an adapter. This is pure and
 * side-effect free so it can back both UI status and tests; the caller supplies
 * whether a credential is stored (and, for OAuth, which scopes were granted).
 */
export const firstPartyConnectorStatus = (
  adapter: FirstPartyConnectorAdapter,
  input: FirstPartyConnectorStatusInput = {},
): FirstPartyConnectorStatus => {
  if (adapter.auth === "oauth") {
    if (!oauthAppIsRegistered(adapter, input.hasOAuthApp)) {
      return "missing_oauth_app";
    }
    if (!input.hasCredential) return "missing_credential";
    const required = adapter.oauth?.scopes ?? [];
    if (input.grantedScopes && required.length > 0) {
      const granted = new Set(input.grantedScopes);
      const missing = required.filter((scope) => !granted.has(scope));
      if (missing.length > 0) return "missing_scopes";
    }
    return "ready";
  }
  // api_key
  if (!input.hasCredential) return "missing_credential";
  return "ready";
};

/** Required scopes/credential fields, for status UIs and connect dialogs. */
export const firstPartyConnectorCredentialRequirement = (
  adapter: FirstPartyConnectorAdapter,
): { kind: FirstPartyAuthKind; scopes?: readonly string[]; label?: string } =>
  adapter.auth === "oauth"
    ? { kind: "oauth", scopes: adapter.oauth?.scopes ?? [] }
    : { kind: "api_key", label: adapter.apiKey?.credentialLabel };

// ---------------------------------------------------------------------------
// Catalog overlay (uses the existing serverCatalog override seam)
// ---------------------------------------------------------------------------

const toCatalogAction = (
  action: FirstPartyConnectorAction,
): NativeConnectorCatalogAction => ({
  name: action.name,
  title: action.title,
  description: action.description,
});

const adapterAuthLabels = (adapter: FirstPartyConnectorAdapter): string[] =>
  adapter.auth === "oauth" ? ["OAUTH2"] : ["API_KEY"];

/**
 * Produce backend-composio catalog entries for the first-party adapters, ready
 * to pass as a serverCatalog override to buildNativeConnectorCatalog. Composio
 * is the authoritative executor (provider "backend-composio"), so this never
 * enables a native mutation path. Not auto-applied: production routing stays
 * with the authoritative Store catalog until real actions are verified.
 */
export const firstPartyConnectorCatalogOverlay =
  (): NativeConnectorCatalogEntry[] =>
    FIRST_PARTY_CONNECTOR_ADAPTERS.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      category: adapter.category,
      auth: adapterAuthLabels(adapter),
      catalogToolCount: adapter.representativeActions.length,
      availability: "ready" as const,
      provider: "backend-composio" as const,
      description: adapter.description,
      sourceUrl: adapter.sourceUrl,
      ...(adapter.iconUrl ? { iconUrl: adapter.iconUrl } : {}),
      connectable: true,
      backendConnector: {
        type: "composio" as const,
        toolkit: adapter.composio.toolkit,
      },
      actions: adapter.representativeActions.map(toCatalogAction),
    }));

// ---------------------------------------------------------------------------
// Native-capability aliases for Composio-owned tools
// ---------------------------------------------------------------------------

export type NativeCapability = "web_search" | "browser" | "shell_sandbox";

export type NativeCapabilityAlias = {
  /** Composio toolkit id (lowercased) being aliased. */
  id: string;
  /** Composio toolkit slug. */
  composioToolkit: string;
  name: string;
  /** The Stella native capability that supersedes it. */
  nativeCapability: NativeCapability;
  /** The Stella native tool id that provides parity. */
  nativeToolId: string;
  /** Aliased + deprecated: prefer the native tool; do not emulate the API. */
  status: "aliased_deprecated";
  rationale: string;
};

/**
 * Composio-owned Search / Browser Tool / Codeinterpreter are mapped to Stella's
 * own native web-search (`web`), browser (`stella-browser`), and shell/sandbox
 * (`exec_command`) capabilities. We do not wrap these as connectors: parity via
 * native tools is defensible and avoids emulating proprietary Composio APIs.
 */
export const NATIVE_CAPABILITY_ALIASES: readonly NativeCapabilityAlias[] = [
  {
    id: "composio_search",
    composioToolkit: "COMPOSIO_SEARCH",
    name: "Composio Search",
    nativeCapability: "web_search",
    nativeToolId: "web",
    status: "aliased_deprecated",
    rationale:
      "Stella's native `web` tool already performs live web search and page fetching. Prefer it over Composio Search; no third-party connector is registered.",
  },
  {
    id: "browser_tool",
    composioToolkit: "BROWSER_TOOL",
    name: "Composio Browser Tool",
    nativeCapability: "browser",
    nativeToolId: "stella-browser",
    status: "aliased_deprecated",
    rationale:
      "Stella drives a first-party browser via `stella-browser` (navigate, interact, extract, screenshot). Prefer it over Composio's cloud Browser Tool; no third-party connector is registered.",
  },
  {
    id: "codeinterpreter",
    composioToolkit: "CODEINTERPRETER",
    name: "Composio Codeinterpreter",
    nativeCapability: "shell_sandbox",
    nativeToolId: "exec_command",
    status: "aliased_deprecated",
    rationale:
      "Stella runs code in its own shell/sandbox via `exec_command` (and the node_repl runtime). Prefer them over Composio's Codeinterpreter sandbox; no third-party connector is registered.",
  },
];

const ALIASES_BY_ID: ReadonlyMap<string, NativeCapabilityAlias> = new Map(
  NATIVE_CAPABILITY_ALIASES.map((alias) => [alias.id, alias]),
);

export const getNativeCapabilityAlias = (
  id: string,
): NativeCapabilityAlias | undefined =>
  ALIASES_BY_ID.get(id.trim().toLowerCase());

/** True when an id is a Composio-owned tool mapped to a native capability. */
export const isNativeCapabilityAlias = (id: string): boolean =>
  ALIASES_BY_ID.has(id.trim().toLowerCase());
