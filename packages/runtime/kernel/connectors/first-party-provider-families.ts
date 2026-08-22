import {
  FIRST_PARTY_PRODUCTIVITY_CONNECTORS,
  type FirstPartyProductivityConnector,
} from "./first-party-productivity-connectors.js";
import {
  FIRST_PARTY_CONNECTOR_ADAPTERS,
  type FirstPartyConnectorAdapter,
} from "./first-party-connectors.js";
import {
  listFirstPartyAdapters,
  type FirstPartyAdapterDescriptor,
} from "./first-party-adapters.js";
import {
  getFirstPartyConnectorOwnership,
  type FirstPartyConnectorOwnerFamily,
} from "./first-party-connector-ownership.js";
import {
  listConnectorAdapters,
  type ConnectorAdapter,
} from "./adapters/registry.js";
import {
  listSocialConnectorAdapters,
  type SocialConnectorAdapter,
} from "./social-connectors.js";

/**
 * Reconciled status vocabulary for the remaining page-1/2 provider families.
 * The three axes are deliberately independent:
 *
 * - Composio is retained as the production fallback, without this static
 *   registry claiming that a connector is currently published or connected.
 * - The code stage distinguishes a registered executor from a request planner
 *   or metadata-only adapter; these are not interchangeable readiness claims.
 * - Native activation is externally blocked until setup plus a real connect and
 *   representative call pass. No entry in this registry activates routing.
 */
export type FirstPartyProviderFamilyStatus = {
  connectorId: string;
  toolkitId: string;
  providerKey: string;
  ownerFamily?: FirstPartyConnectorOwnerFamily;
  auth: "oauth" | "api_key";
  adapterSurface: "metadata" | "request_planner";
  fallbackStatus: "retained";
  codeStatus: "executor_ready" | "planner_ready" | "metadata_only";
  activationStatus: "code_blocked" | "external_blocked";
  activationBlockers: readonly string[];
};

const EXECUTOR_READY_CONNECTOR_IDS = new Set([
  "outlook",
  "microsoft_teams",
  "excel",
  "notion",
  "slack",
  "slackbot",
  "airtable",
  "asana",
  "linear",
  "jira",
  "clickup",
  "monday",
  "canvas",
  "github",
  "supabase",
  "firecrawl",
  "tavily",
  "exa",
  "serpapi",
  "perplexityai",
  "posthog",
  "ably",
  "abuseipdb",
  "peopledatalabs",
  "44api",
  "stripe",
  "figma",
  "7shifts",
  "abyssale",
  "0codekit",
  "2chat",
  "twitter",
  "instagram",
  "youtube",
  "reddit",
  "facebook",
  "metaads",
  "linkedin",
  "abstract",
  "apollo",
  "ashby",
  "gong",
  "pipedrive",
  "attio",
  "hubspot",
  "salesforce",
  "21risk",
  "1password",
]);

const PLANNER_READY_CONNECTOR_IDS = new Set([
  "snowflake",
]);

const codeStatusFor = (
  connectorId: string,
  adapterSurface: FirstPartyProviderFamilyStatus["adapterSurface"],
): FirstPartyProviderFamilyStatus["codeStatus"] =>
  EXECUTOR_READY_CONNECTOR_IDS.has(connectorId)
    ? "executor_ready"
    : PLANNER_READY_CONNECTOR_IDS.has(connectorId) ||
        adapterSurface === "request_planner"
      ? "planner_ready"
      : "metadata_only";

const activationStatusFor = (
  codeStatus: FirstPartyProviderFamilyStatus["codeStatus"],
): FirstPartyProviderFamilyStatus["activationStatus"] =>
  codeStatus === "executor_ready" ? "external_blocked" : "code_blocked";

const OAUTH_BLOCKERS = [
  "shared-core provider manifest and server handler production verification",
  "production OAuth app credentials and callback verification",
  "real connect and representative provider call",
] as const;

const API_KEY_BLOCKERS = [
  "deployment enablement plus independent provider-verification allowlists",
  "owner-provided encrypted credential through the protected connect flow",
  "real connect and representative provider call",
] as const;

const plannerImplementationBlockers = (
  codeStatus: FirstPartyProviderFamilyStatus["codeStatus"],
): readonly string[] =>
  codeStatus === "planner_ready"
    ? [
        "reviewed executable descriptor, exact action schemas, and credential placement",
      ]
    : [];

const MICROSOFT_BLOCKERS = [
  "contact@fromyou.ai Microsoft identity or existing tenant membership",
  "owner-confirmed country/region and date of birth if consumer signup is used",
  "Entra app-registration permission and any tenant-required admin consent",
  "production OAuth app credentials and callback verification",
  "representative read and write for each Microsoft connector",
] as const;

const MICROSOFT_STATUS: readonly FirstPartyProviderFamilyStatus[] = [
  ["outlook", "OUTLOOK"],
  ["microsoft_teams", "MICROSOFT_TEAMS"],
  ["excel", "EXCEL"],
].map(([connectorId, toolkitId]) => ({
  connectorId,
  toolkitId,
  providerKey: "microsoft",
  auth: "oauth",
  adapterSurface: "request_planner",
  fallbackStatus: "retained",
  codeStatus: "executor_ready",
  activationStatus: "external_blocked",
  activationBlockers: MICROSOFT_BLOCKERS,
}));

const SOCIAL_BLOCKERS = [
  "production OAuth app credentials, callback verification, and required provider product review",
  "real connect and representative read and write",
] as const;

const socialStatus = (
  adapter: SocialConnectorAdapter,
): FirstPartyProviderFamilyStatus => {
  const ownership = getFirstPartyConnectorOwnership(adapter.id);
  const auth = ownership?.auth ?? "oauth";
  const codeStatus = codeStatusFor(adapter.id, "request_planner");
  return {
    connectorId: adapter.id,
    toolkitId: ownership?.toolkitId ?? adapter.id.toUpperCase(),
    providerKey: adapter.providerConfigId,
    ownerFamily: ownership?.ownerFamily,
    auth,
    adapterSurface: "request_planner",
    fallbackStatus: "retained",
    codeStatus,
    activationStatus: activationStatusFor(codeStatus),
    activationBlockers: auth === "api_key" ? API_KEY_BLOCKERS : SOCIAL_BLOCKERS,
  };
};

const providerKeyForProductivity = (
  connector: FirstPartyProductivityConnector,
): string => {
  if (connector.id === "jira") return "atlassian";
  if (connector.id === "slackbot") return "slack";
  return connector.id;
};

const productivityStatus = (
  connector: FirstPartyProductivityConnector,
): FirstPartyProviderFamilyStatus => {
  const codeStatus = codeStatusFor(connector.id, "request_planner");
  return {
    connectorId: connector.id,
    toolkitId: connector.composioToolkit,
    providerKey: providerKeyForProductivity(connector),
    auth: connector.authKind === "api_key" ? "api_key" : "oauth",
    adapterSurface: "request_planner",
    fallbackStatus: "retained",
    codeStatus,
    activationStatus: activationStatusFor(codeStatus),
    activationBlockers: [
      ...plannerImplementationBlockers(codeStatus),
      ...(connector.authKind === "api_key" ? API_KEY_BLOCKERS : OAUTH_BLOCKERS),
      ...(connector.reviewRequirement === "required"
        ? ["provider distribution or institution approval"]
        : []),
      ...(connector.id === "canvas"
        ? ["tenant-specific Canvas origin and developer key"]
        : []),
    ],
  };
};

const developerDataStatus = (
  adapter: FirstPartyConnectorAdapter,
): FirstPartyProviderFamilyStatus => {
  const codeStatus = codeStatusFor(adapter.id, "metadata");
  return {
    connectorId: adapter.id,
    toolkitId: adapter.composio.toolkit,
    providerKey: adapter.oauth?.providerConfigId ?? adapter.id,
    ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
    auth: adapter.auth,
    adapterSurface: "metadata",
    fallbackStatus: "retained",
    codeStatus,
    activationStatus: activationStatusFor(codeStatus),
    activationBlockers: [
      ...plannerImplementationBlockers(codeStatus),
      ...(adapter.auth === "oauth" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
      ...(adapter.id === "snowflake"
        ? ["tenant-specific Snowflake account origin and OAuth app"]
        : []),
    ],
  };
};

const designFinanceStatus = (
  adapter: FirstPartyAdapterDescriptor,
): FirstPartyProviderFamilyStatus => {
  const codeStatus = codeStatusFor(adapter.id, "request_planner");
  return {
    connectorId: adapter.id,
    toolkitId: adapter.composioToolkit,
    providerKey: adapter.id,
    ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
    auth: adapter.auth.kind === "oauth2" ? "oauth" : "api_key",
    adapterSurface: "request_planner",
    fallbackStatus: "retained",
    codeStatus,
    activationStatus: activationStatusFor(codeStatus),
    activationBlockers: [
      ...plannerImplementationBlockers(codeStatus),
      ...(adapter.auth.kind === "oauth2" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
      ...(adapter.requiresBaseUrl ? ["tenant-specific fixed origin"] : []),
    ],
  };
};

const crmStatus = (
  adapter: ConnectorAdapter,
): FirstPartyProviderFamilyStatus => {
  const codeStatus = codeStatusFor(adapter.id, "request_planner");
  return {
    connectorId: adapter.id,
    toolkitId: adapter.id === "21risk" ? "_21RISK" : adapter.id.toUpperCase(),
    providerKey: adapter.id,
    ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
    auth: adapter.auth,
    adapterSurface: "request_planner",
    fallbackStatus: "retained",
    codeStatus,
    activationStatus: activationStatusFor(codeStatus),
    activationBlockers: [
      ...plannerImplementationBlockers(codeStatus),
      ...(adapter.auth === "oauth" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
    ],
  };
};

export const FIRST_PARTY_PROVIDER_FAMILY_STATUS: readonly FirstPartyProviderFamilyStatus[] =
  [
    ...MICROSOFT_STATUS,
    ...Object.values(FIRST_PARTY_PRODUCTIVITY_CONNECTORS)
      .filter((connector) => !getFirstPartyConnectorOwnership(connector.id))
      .map(productivityStatus),
    ...FIRST_PARTY_CONNECTOR_ADAPTERS.map(developerDataStatus),
    ...listFirstPartyAdapters()
      .filter(
        (adapter) =>
          getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily !== "social",
      )
      .map(designFinanceStatus),
    ...listConnectorAdapters().map(crmStatus),
    ...listSocialConnectorAdapters().map(socialStatus),
  ];

const STATUS_BY_ID = new Map(
  FIRST_PARTY_PROVIDER_FAMILY_STATUS.map((status) => [
    status.connectorId,
    status,
  ]),
);

export const getFirstPartyProviderFamilyStatus = (
  connectorId: string,
): FirstPartyProviderFamilyStatus | undefined =>
  STATUS_BY_ID.get(connectorId.trim().toLowerCase());
