import {
  type ConnectorAdapter,
  type ConnectorAdapterRequest,
} from "./types.js";

/**
 * 21RISK OData API — https://21risk.com/docs
 * Auth: API key. Category: risk & compliance (audits, reports, actions).
 * Composio toolkit slug: `_21RISK`. Stella id: `21risk` (leading underscores
 * are not permitted by the catalog id policy).
 *
 * The representative surface is read-only OData retrieval (reports, compliance,
 * organizations, properties, risk models). All actions accept standard OData
 * query options ($top/$skip/$filter/$select/$orderby).
 *
 * NOTE: the exact OData base path must be confirmed against the tenant's
 * published API root before native activation (see ADAPTERS.md).
 */
const odata = (
  entity: string,
  input: Record<string, unknown>,
): ConnectorAdapterRequest => {
  const query: Record<string, string | number | boolean> = {};
  if (typeof input.top === "number") query.$top = input.top;
  if (typeof input.skip === "number") query.$skip = input.skip;
  if (typeof input.count === "boolean") query.$count = input.count;
  if (typeof input.filter === "string") query.$filter = input.filter;
  if (typeof input.select === "string") query.$select = input.select;
  if (typeof input.orderby === "string") query.$orderby = input.orderby;
  if (typeof input.expand === "string") query.$expand = input.expand;
  return {
    method: "GET",
    path: `/odata/${entity}`,
    ...(Object.keys(query).length ? { query } : {}),
  };
};

const odataInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    top: { type: "number" },
    skip: { type: "number" },
    count: { type: "boolean" },
    filter: { type: "string" },
    select: { type: "string" },
    orderby: { type: "string" },
    expand: { type: "string" },
  },
} as const;

export const TWENTY_ONE_RISK_ADAPTER: ConnectorAdapter = {
  id: "21risk",
  displayName: "21RISK",
  auth: "api_key",
  baseUrl: "https://api.21risk.com",
  apiAuthScheme: "bearer",
  docsUrl: "https://21risk.com/docs",
  actions: [
    {
      name: "TWENTY_ONE_RISK_GET_REPORTS",
      title: "Get Reports",
      description:
        "Retrieve audit reports (draft, published, scheduled) via OData.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("Reports", input),
    },
    {
      name: "TWENTY_ONE_RISK_GET_COMPLIANCE",
      title: "Get Compliance",
      description:
        "Retrieve compliance data for sites, categories, or questions via OData.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("Compliance", input),
    },
    {
      name: "TWENTY_ONE_RISK_GET_ORGANIZATIONS",
      title: "Get Organizations",
      description: "Retrieve organizations via OData.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("Organizations", input),
    },
    {
      name: "TWENTY_ONE_RISK_GET_PROPERTIES",
      title: "Get Properties",
      description:
        "Retrieve site properties, including COPE information, via OData.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("Properties", input),
    },
    {
      name: "TWENTY_ONE_RISK_GET_RISK_MODELS",
      title: "Get Risk Models",
      description: "Retrieve risk models used for audits and compliance.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("RiskModels", input),
    },
  ],
};
