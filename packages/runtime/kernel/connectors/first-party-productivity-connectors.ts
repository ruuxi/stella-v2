import {
  getNativeOAuthProviderConfig,
  isNativeOAuthLocalExecutionProductionReady,
  isNativeOAuthProviderConfigReady,
  type NativeOAuthProviderConfig,
  type NativeOAuthProviderConfigOptions,
} from "./native-oauth-provider-config.js";

/**
 * First-party productivity & collaboration connector registry.
 *
 * This is the deliberately NARROW interface for the in-scope productivity
 * connectors. It describes each connector, publishes the canonical comparison
 * actions, and derives readiness from the existing native OAuth provider
 * config. Backend planners are registered separately, but this registry does
 * NOT open a second execution path.
 *
 * Invariants enforced by tests:
 *   - Every connector keeps a stable, lowercase, snake-case id.
 *   - `executionOwner` is single-valued ("native" | "composio"), never both, so
 *     writes are never dual-dispatched.
 *   - Until an entry is both allowlisted for local execution
 *     (`isNativeOAuthLocalExecutionProductionReady`) AND its OAuth app / backend
 *     token exchange is configured in production, the owner stays "composio"
 *     (the Composio fallback). Flipping an entry to native execution is a
 *     deliberate, separately-reviewed change in native-oauth-provider-config.ts.
 */

export type FirstPartyConnectorAuthKind = "oauth2" | "oauth2_bot" | "api_key";

/**
 * Whether the provider's marketplace/app requires review before Stella's app
 * can serve arbitrary end users. "none" = usable immediately once registered;
 * "recommended" = works but distribution/verification is advised; "required" =
 * a review/listing must be granted before general availability.
 */
export type FirstPartyConnectorReviewRequirement =
  | "none"
  | "recommended"
  | "required";

export type FirstPartyConnectorExecutionOwner = "native" | "composio";

export type FirstPartyProductivityAction = {
  name: string;
  operation: "read" | "write" | "destructive";
};

export type FirstPartyProductivityConnector = {
  /** Stable connector id (matches the Store/catalog id). */
  id: string;
  displayName: string;
  authKind: FirstPartyConnectorAuthKind;
  /** Human-facing official API base, for docs/readiness ledgers. */
  officialApi: string;
  /**
   * Id used to resolve the native OAuth provider config. Undefined for
   * backend-owned communication connectors (Slack/Slackbot) that Stella serves
   * exclusively through the Composio boundary today.
   */
  providerConfigId?: string;
  /** Composio toolkit that owns execution until/unless native is enabled. */
  composioToolkit: string;
  /** Another connector this one shares an OAuth app / grant with. */
  sharesOAuthAppWith?: string;
  reviewRequirement: FirstPartyConnectorReviewRequirement;
  note?: string;
};

const CONNECTORS: readonly FirstPartyProductivityConnector[] = [
  {
    id: "notion",
    displayName: "Notion",
    authKind: "oauth2",
    officialApi: "https://api.notion.com/v1",
    providerConfigId: "notion",
    composioToolkit: "NOTION",
    reviewRequirement: "recommended",
    note: "Public OAuth integration; confidential client so token exchange runs server-side. API calls require the Notion-Version header.",
  },
  {
    id: "slack",
    displayName: "Slack",
    authKind: "oauth2",
    officialApi: "https://slack.com/api",
    composioToolkit: "SLACK",
    reviewRequirement: "required",
    note: "Backend-owned communication connector. Shares one Slack app/grant with slackbot; user-token scopes. Distribution requires Slack app review for public install.",
  },
  {
    id: "airtable",
    displayName: "Airtable",
    authKind: "oauth2",
    officialApi: "https://api.airtable.com/v0",
    providerConfigId: "airtable",
    composioToolkit: "AIRTABLE",
    reviewRequirement: "none",
    note: "Airtable supports PKCE. The unverified shared-backend manifest currently combines PKCE with confidential client authentication and must be checked against the recovered app before activation.",
  },
  {
    id: "asana",
    displayName: "Asana",
    authKind: "oauth2",
    officialApi: "https://app.asana.com/api/1.0",
    providerConfigId: "asana",
    composioToolkit: "ASANA",
    reviewRequirement: "none",
    note: "Confidential client; token exchange runs server-side.",
  },
  {
    id: "linear",
    displayName: "Linear",
    authKind: "oauth2",
    officialApi: "https://api.linear.app",
    providerConfigId: "linear",
    composioToolkit: "LINEAR",
    reviewRequirement: "none",
    note: "GraphQL API; the disabled shared backend has narrow issue-list and issue-create request planners.",
  },
  {
    id: "jira",
    displayName: "Jira",
    authKind: "oauth2",
    officialApi: "https://api.atlassian.com",
    providerConfigId: "jira",
    composioToolkit: "JIRA",
    sharesOAuthAppWith: "confluence",
    reviewRequirement: "recommended",
    note: "Uses the shared Atlassian 3LO app (provider 'atlassian'); confidential client with server-side token exchange. Native activation still needs an account-owned cloud-id selection resolved from /oauth/token/accessible-resources.",
  },
  {
    id: "clickup",
    displayName: "ClickUp",
    authKind: "oauth2",
    officialApi: "https://api.clickup.com/api/v2",
    providerConfigId: "clickup",
    composioToolkit: "CLICKUP",
    reviewRequirement: "none",
    note: "Env-backed provider: native config only resolves once STELLA_NATIVE_OAUTH_CLICKUP_CLIENT_ID is present. ClickUp OAuth ignores granular scopes.",
  },
  {
    id: "slackbot",
    displayName: "Slack (Bot)",
    authKind: "oauth2_bot",
    officialApi: "https://slack.com/api",
    composioToolkit: "SLACKBOT",
    sharesOAuthAppWith: "slack",
    reviewRequirement: "required",
    note: "Backend-owned communication connector. Bot-token scopes on the same Slack app/grant as slack.",
  },
  {
    id: "monday",
    displayName: "monday.com",
    authKind: "oauth2",
    officialApi: "https://api.monday.com/v2",
    providerConfigId: "monday",
    composioToolkit: "MONDAY",
    reviewRequirement: "recommended",
    note: "GraphQL API; confidential client with server-side token exchange. Public listing requires monday marketplace approval.",
  },
  {
    id: "canvas",
    displayName: "Canvas LMS",
    authKind: "oauth2",
    officialApi: "<install-url>/api/v1",
    providerConfigId: "canvas",
    composioToolkit: "CANVAS",
    reviewRequirement: "required",
    note: "Per-institution developer key: native config only resolves once STELLA_NATIVE_OAUTH_CANVAS_CLIENT_ID and _INSTALL_URL are present. Each Canvas instance issues its own key/approval.",
  },
  {
    id: "7shifts",
    displayName: "7shifts",
    authKind: "api_key",
    officialApi: "https://api.7shifts.com/v2",
    composioToolkit: "7SHIFTS",
    reviewRequirement: "required",
    note: "Partner API access token. The existing local adapter remains disabled until an approved credential and representative company/location calls are verified.",
  },
] as const;

/**
 * Narrow, audited action names used to compare native execution with the
 * existing Composio boundary. This catalog does not route or execute actions.
 */
export const FIRST_PARTY_PRODUCTIVITY_ACTIONS: Readonly<
  Record<string, readonly FirstPartyProductivityAction[]>
> = Object.freeze({
  notion: [
    { name: "NOTION_SEARCH_NOTION_PAGE", operation: "read" },
    { name: "NOTION_CREATE_NOTION_PAGE", operation: "write" },
  ],
  slack: [
    { name: "SLACK_FETCH_CONVERSATION_HISTORY", operation: "read" },
    { name: "SLACK_SEND_MESSAGE", operation: "write" },
  ],
  airtable: [
    { name: "AIRTABLE_LIST_RECORDS", operation: "read" },
    { name: "AIRTABLE_CREATE_RECORDS", operation: "write" },
  ],
  asana: [
    { name: "ASANA_GET_MULTIPLE_TASKS", operation: "read" },
    { name: "ASANA_CREATE_A_TASK", operation: "write" },
  ],
  clickup: [
    { name: "CLICKUP_GET_TASKS", operation: "read" },
    { name: "CLICKUP_CREATE_TASK", operation: "write" },
  ],
  slackbot: [
    { name: "SLACKBOT_FIND_CHANNELS", operation: "read" },
    { name: "SLACKBOT_SEND_MESSAGE", operation: "write" },
  ],
  monday: [
    { name: "MONDAY_BOARDS", operation: "read" },
    { name: "MONDAY_CREATE_ITEM", operation: "write" },
  ],
  linear: [
    { name: "LINEAR_LIST_LINEAR_ISSUES", operation: "read" },
    { name: "LINEAR_CREATE_LINEAR_ISSUE", operation: "write" },
  ],
  jira: [
    { name: "JIRA_GET_ISSUE", operation: "read" },
    { name: "JIRA_CREATE_ISSUE", operation: "write" },
  ],
  canvas: [
    { name: "CANVAS_LIST_COURSES", operation: "read" },
    { name: "CANVAS_CREATE_COURSE", operation: "write" },
  ],
  "7shifts": [
    { name: "7SHIFTS_LIST_SHIFTS", operation: "read" },
    { name: "7SHIFTS_CREATE_DEPARTMENT", operation: "write" },
  ],
});

export const FIRST_PARTY_PRODUCTIVITY_CONNECTORS: Readonly<
  Record<string, FirstPartyProductivityConnector>
> = Object.freeze(
  Object.fromEntries(CONNECTORS.map((entry) => [entry.id, entry])),
);

export const FIRST_PARTY_PRODUCTIVITY_CONNECTOR_IDS: readonly string[] =
  CONNECTORS.map((entry) => entry.id);

export const getFirstPartyProductivityConnector = (
  id: string,
): FirstPartyProductivityConnector | undefined =>
  FIRST_PARTY_PRODUCTIVITY_CONNECTORS[id.trim().toLowerCase()];

const envKey = (id: string, suffix: string) =>
  `STELLA_NATIVE_OAUTH_${id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_${suffix}`;

/**
 * The token-exchange provider a connector's server-held secret belongs to.
 * Falls back to the connector id (e.g. jira -> atlassian).
 */
export const firstPartyProductivityConnectorSecretProvider = (
  id: string,
): string | undefined => {
  const entry = getFirstPartyProductivityConnector(id);
  if (!entry?.providerConfigId) return undefined;
  const config = getNativeOAuthProviderConfig(entry.providerConfigId);
  return (config?.tokenExchange?.provider ?? entry.providerConfigId)
    .trim()
    .toLowerCase();
};

export type FirstPartyProductivityConnectorProdEnv = {
  /** Public OAuth client id (safe to embed / serve). */
  clientIdEnv: string;
  /** Confidential client secret. Belongs only in production Convex env. */
  clientSecretEnv: string;
  /** Set to "1" once the backend can perform token exchange for the provider. */
  backendReadyEnv: string;
  /** Set to "1" once the hosted browser return link is live for the provider. */
  externalCallbackReadyEnv: string;
};

/**
 * Architecture-consistent production env var names for a connector's OAuth app
 * credentials. Backend-owned connectors (Slack/Slackbot) return undefined —
 * their credentials live behind the Composio boundary, not these keys.
 */
export const firstPartyProductivityConnectorProdEnv = (
  id: string,
): FirstPartyProductivityConnectorProdEnv | undefined => {
  const entry = getFirstPartyProductivityConnector(id);
  if (!entry?.providerConfigId) return undefined;
  const secretProvider =
    firstPartyProductivityConnectorSecretProvider(id) ?? entry.providerConfigId;
  return {
    clientIdEnv: envKey(entry.providerConfigId, "CLIENT_ID"),
    clientSecretEnv: envKey(secretProvider, "CLIENT_SECRET"),
    backendReadyEnv: envKey(secretProvider, "BACKEND_READY"),
    externalCallbackReadyEnv: envKey(secretProvider, "EXTERNAL_CALLBACK_READY"),
  };
};

export type FirstPartyProductivityConnectorReadiness = {
  id: string;
  /** True when the native OAuth provider config resolves at all. */
  configResolved: boolean;
  /** True when that config is connectable (app + callback + exchange ready). */
  configReady: boolean;
  /** True when local execution is deliberately allowlisted for this id. */
  localExecutionEnabled: boolean;
  /** True only when execution is allowlisted AND the config is connectable. */
  nativeReady: boolean;
  /** The single execution owner. Never dual-valued. */
  executionOwner: FirstPartyConnectorExecutionOwner;
};

/**
 * Resolve where a connector currently executes and why. Native execution is
 * only claimed when the id is allowlisted for local execution AND its OAuth
 * config is connectable; otherwise the Composio fallback owns it. This is the
 * single arbitration point that keeps writes from being dual-dispatched.
 */
export const resolveFirstPartyProductivityConnectorReadiness = (
  id: string,
  options: NativeOAuthProviderConfigOptions = {},
): FirstPartyProductivityConnectorReadiness | undefined => {
  const entry = getFirstPartyProductivityConnector(id);
  if (!entry) return undefined;
  const localExecutionEnabled = isNativeOAuthLocalExecutionProductionReady(
    entry.id,
  );
  let config: NativeOAuthProviderConfig | null = null;
  if (entry.providerConfigId) {
    config = getNativeOAuthProviderConfig(entry.providerConfigId);
  }
  const configResolved = Boolean(config);
  const configReady = config
    ? isNativeOAuthProviderConfigReady(entry.providerConfigId!, config, options)
    : false;
  const nativeReady = localExecutionEnabled && configReady;
  return {
    id: entry.id,
    configResolved,
    configReady,
    localExecutionEnabled,
    nativeReady,
    executionOwner: nativeReady ? "native" : "composio",
  };
};

export const isFirstPartyProductivityConnectorNativeReady = (
  id: string,
  options: NativeOAuthProviderConfigOptions = {},
): boolean =>
  resolveFirstPartyProductivityConnectorReadiness(id, options)?.nativeReady ===
  true;

export const firstPartyProductivityConnectorExecutionOwner = (
  id: string,
  options: NativeOAuthProviderConfigOptions = {},
): FirstPartyConnectorExecutionOwner =>
  resolveFirstPartyProductivityConnectorReadiness(id, options)
    ?.executionOwner ?? "composio";
