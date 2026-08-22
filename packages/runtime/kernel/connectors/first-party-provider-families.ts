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
 * - Composio is live and remains the sole production execution owner.
 * - The family descriptor is code-ready for the shared-core migration contract.
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
  fallbackStatus: "live";
  codeStatus: "code_ready";
  activationStatus: "external_blocked";
  activationBlockers: readonly string[];
};

const OAUTH_BLOCKERS = [
  "shared-core provider manifest and server handler production verification",
  "production OAuth app credentials and callback verification",
  "real connect and representative provider call",
] as const;

const API_KEY_BLOCKERS = [
  "shared-core per-user API-key vault and credential UI",
  "real connect and representative provider call",
] as const;

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
  fallbackStatus: "live",
  codeStatus: "code_ready",
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
  return {
    connectorId: adapter.id,
    toolkitId: ownership?.toolkitId ?? adapter.id.toUpperCase(),
    providerKey: adapter.providerConfigId,
    ownerFamily: ownership?.ownerFamily,
    auth,
    adapterSurface: "request_planner",
    fallbackStatus: "live",
    codeStatus: "code_ready",
    activationStatus: "external_blocked",
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
): FirstPartyProviderFamilyStatus => ({
  connectorId: connector.id,
  toolkitId: connector.composioToolkit,
  providerKey: providerKeyForProductivity(connector),
  auth: connector.authKind === "api_key" ? "api_key" : "oauth",
  adapterSurface: "request_planner",
  fallbackStatus: "live",
  codeStatus: "code_ready",
  activationStatus: "external_blocked",
  activationBlockers: [
    ...(connector.authKind === "api_key" ? API_KEY_BLOCKERS : OAUTH_BLOCKERS),
    ...(connector.reviewRequirement === "required"
      ? ["provider distribution or institution approval"]
      : []),
    ...(connector.id === "canvas"
      ? ["tenant-specific Canvas origin and developer key"]
      : []),
  ],
});

const developerDataStatus = (
  adapter: FirstPartyConnectorAdapter,
): FirstPartyProviderFamilyStatus => ({
  connectorId: adapter.id,
  toolkitId: adapter.composio.toolkit,
  providerKey: adapter.oauth?.providerConfigId ?? adapter.id,
  ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
  auth: adapter.auth,
  adapterSurface: "metadata",
  fallbackStatus: "live",
  codeStatus: "code_ready",
  activationStatus: "external_blocked",
  activationBlockers: [
    ...(adapter.auth === "oauth" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
    ...(adapter.id === "snowflake"
      ? ["tenant-specific Snowflake account origin and OAuth app"]
      : []),
  ],
});

const designFinanceStatus = (
  adapter: FirstPartyAdapterDescriptor,
): FirstPartyProviderFamilyStatus => ({
  connectorId: adapter.id,
  toolkitId: adapter.composioToolkit,
  providerKey: adapter.id,
  ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
  auth: adapter.auth.kind === "oauth2" ? "oauth" : "api_key",
  adapterSurface: "request_planner",
  fallbackStatus: "live",
  codeStatus: "code_ready",
  activationStatus: "external_blocked",
  activationBlockers: [
    ...(adapter.auth.kind === "oauth2" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
    ...(adapter.requiresBaseUrl ? ["tenant-specific fixed origin"] : []),
  ],
});

const crmStatus = (
  adapter: ConnectorAdapter,
): FirstPartyProviderFamilyStatus => ({
  connectorId: adapter.id,
  toolkitId: adapter.id === "21risk" ? "_21RISK" : adapter.id.toUpperCase(),
  providerKey: adapter.id,
  ownerFamily: getFirstPartyConnectorOwnership(adapter.id)?.ownerFamily,
  auth: adapter.auth,
  adapterSurface: "request_planner",
  fallbackStatus: "live",
  codeStatus: "code_ready",
  activationStatus: "external_blocked",
  activationBlockers: [
    ...(adapter.auth === "oauth" ? OAUTH_BLOCKERS : API_KEY_BLOCKERS),
    ...(adapter.id === "21risk"
      ? ["tenant-specific 21RISK OData origin and base-path confirmation"]
      : []),
  ],
});

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
