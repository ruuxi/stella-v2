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
  auth: "oauth" | "api_key";
  adapterSurface: "metadata" | "request_planner";
  fallbackStatus: "live";
  codeStatus: "code_ready";
  activationStatus: "external_blocked";
  activationBlockers: readonly string[];
};

const OAUTH_BLOCKERS = [
  "shared-core provider manifest and server handler",
  "production OAuth app credentials and callback verification",
  "real connect and representative provider call",
] as const;

const API_KEY_BLOCKERS = [
  "shared-core per-user API-key vault and credential UI",
  "real connect and representative provider call",
] as const;

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
  adapterSurface: "metadata",
  fallbackStatus: "live",
  codeStatus: "code_ready",
  activationStatus: "external_blocked",
  activationBlockers: [
    ...OAUTH_BLOCKERS,
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

export const FIRST_PARTY_PROVIDER_FAMILY_STATUS: readonly FirstPartyProviderFamilyStatus[] =
  [
    ...Object.values(FIRST_PARTY_PRODUCTIVITY_CONNECTORS).map(
      productivityStatus,
    ),
    ...FIRST_PARTY_CONNECTOR_ADAPTERS.map(developerDataStatus),
    ...listFirstPartyAdapters().map(designFinanceStatus),
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
