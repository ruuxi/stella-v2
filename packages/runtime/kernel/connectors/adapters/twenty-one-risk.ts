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
 * Verified fixed-origin contract (primary evidence):
 * - Origin: `https://21risk.com` (`www.21risk.com` 307-redirects to the apex).
 * - Base path: `/odata/v5/<entity>` with standard OData system query options.
 * - Auth: `Authorization: Bearer <api-key>` (keys are prefixed `21RISK.ND.`);
 *   the apex OData service itself states this in its 401 challenge.
 * - Entity-set names are case-exact and not uniformly cased/pluralized, so each
 *   path is pinned literally rather than derived from the action label.
 *
 * Only entity paths confirmed against the published integration surface are
 * exposed here (`reports`, `organizations`). Compliance, properties, risk models
 * and the other OData entities remain served by the Composio fallback until the
 * auth-gated `$metadata` entity model can be confirmed.
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
    path: `/odata/v5/${entity}`,
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
  baseUrl: "https://21risk.com",
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
      buildRequest: (input) => odata("reports", input),
    },
    {
      name: "TWENTY_ONE_RISK_GET_ORGANIZATIONS",
      title: "Get Organizations",
      description: "Retrieve organizations via OData.",
      kind: "read",
      inputSchema: odataInputSchema,
      buildRequest: (input) => odata("organizations", input),
    },
  ],
};
