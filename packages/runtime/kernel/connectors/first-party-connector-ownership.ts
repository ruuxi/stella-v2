/**
 * Canonical ownership for the reviewed Composio pages 1-2 connector set.
 *
 * An entry can reuse metadata from another module, but it has exactly one
 * family that may add it to an execution registry. This prevents the same
 * public connector id from being independently migrated by two families.
 */
export type FirstPartyConnectorOwnerFamily =
  | "design_finance_ops"
  | "developer_data"
  | "social"
  | "crm_recruiting_sales";

export type FirstPartyConnectorOwnership = {
  connectorId: string;
  toolkitId: string;
  ownerFamily: FirstPartyConnectorOwnerFamily;
  auth: "oauth" | "api_key";
};

export const AUTHORITATIVE_PAGE_1_2_CONNECTOR_OWNERSHIP = [
  {
    connectorId: "figma",
    toolkitId: "FIGMA",
    ownerFamily: "design_finance_ops",
    auth: "oauth",
  },
  {
    connectorId: "stripe",
    toolkitId: "STRIPE",
    ownerFamily: "design_finance_ops",
    auth: "oauth",
  },
  {
    connectorId: "1password",
    toolkitId: "_1PASSWORD",
    ownerFamily: "design_finance_ops",
    auth: "api_key",
  },
  {
    connectorId: "abyssale",
    toolkitId: "ABYSSALE",
    ownerFamily: "design_finance_ops",
    auth: "api_key",
  },
  {
    connectorId: "0codekit",
    toolkitId: "0CODEKIT",
    ownerFamily: "design_finance_ops",
    auth: "api_key",
  },
  {
    connectorId: "peopledatalabs",
    toolkitId: "PEOPLEDATALABS",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "firecrawl",
    toolkitId: "FIRECRAWL",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "tavily",
    toolkitId: "TAVILY",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "exa",
    toolkitId: "EXA",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "serpapi",
    toolkitId: "SERPAPI",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "perplexityai",
    toolkitId: "PERPLEXITYAI",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "posthog",
    toolkitId: "POSTHOG",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "ably",
    toolkitId: "ABLY",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "abuseipdb",
    toolkitId: "ABUSEIPDB",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "snowflake",
    toolkitId: "SNOWFLAKE",
    ownerFamily: "developer_data",
    auth: "oauth",
  },
  {
    connectorId: "abstract",
    toolkitId: "ABSTRACT",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "44api",
    toolkitId: "44API",
    ownerFamily: "developer_data",
    auth: "api_key",
  },
  {
    connectorId: "21risk",
    toolkitId: "_21RISK",
    ownerFamily: "crm_recruiting_sales",
    auth: "api_key",
  },
  {
    connectorId: "2chat",
    toolkitId: "_2CHAT",
    ownerFamily: "social",
    auth: "api_key",
  },
  {
    connectorId: "7shifts",
    toolkitId: "7SHIFTS",
    ownerFamily: "design_finance_ops",
    auth: "api_key",
  },
  {
    connectorId: "apollo",
    toolkitId: "APOLLO",
    ownerFamily: "crm_recruiting_sales",
    auth: "api_key",
  },
  {
    connectorId: "ashby",
    toolkitId: "ASHBY",
    ownerFamily: "crm_recruiting_sales",
    auth: "api_key",
  },
  {
    connectorId: "gong",
    toolkitId: "GONG",
    ownerFamily: "crm_recruiting_sales",
    auth: "oauth",
  },
  {
    connectorId: "pipedrive",
    toolkitId: "PIPEDRIVE",
    ownerFamily: "crm_recruiting_sales",
    auth: "oauth",
  },
  {
    connectorId: "attio",
    toolkitId: "ATTIO",
    ownerFamily: "crm_recruiting_sales",
    auth: "oauth",
  },
  {
    connectorId: "hubspot",
    toolkitId: "HUBSPOT",
    ownerFamily: "crm_recruiting_sales",
    auth: "oauth",
  },
  {
    connectorId: "salesforce",
    toolkitId: "SALESFORCE",
    ownerFamily: "crm_recruiting_sales",
    auth: "oauth",
  },
] as const satisfies readonly FirstPartyConnectorOwnership[];

const OWNERSHIP_BY_ID = new Map(
  AUTHORITATIVE_PAGE_1_2_CONNECTOR_OWNERSHIP.map((entry) => [
    entry.connectorId,
    entry,
  ]),
);

export const getFirstPartyConnectorOwnership = (
  connectorId: string,
): FirstPartyConnectorOwnership | undefined =>
  OWNERSHIP_BY_ID.get(connectorId.trim().toLowerCase());
