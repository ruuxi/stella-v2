import { type ConnectorAdapter } from "./types.js";

/**
 * People Data Labs API v5 — https://docs.peopledatalabs.com/docs
 * Auth: API key via the `X-Api-Key` header. Base: https://api.peopledatalabs.com
 *
 * PDL is an enrichment/data provider; its representative surface is read-only
 * (person/company enrichment and search). No mutating endpoints are exposed.
 */
export const PEOPLE_DATA_LABS_ADAPTER: ConnectorAdapter = {
  id: "people_data_labs",
  displayName: "People Data Labs",
  auth: "api_key",
  baseUrl: "https://api.peopledatalabs.com",
  apiAuthScheme: "raw",
  authHeaderName: "X-Api-Key",
  docsUrl: "https://docs.peopledatalabs.com/docs",
  actions: [
    {
      name: "PEOPLE_DATA_LABS_PERSON_ENRICH",
      title: "Person Enrich",
      description:
        "Enrich a single person by email, name+company, or a profile URL.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          company: { type: "string" },
          profile: { type: "string" },
          min_likelihood: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/v5/person/enrich",
        query: Object.fromEntries(
          Object.entries(input).flatMap(([key, value]) =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
              ? [[key, value]]
              : [],
          ),
        ),
      }),
    },
    {
      name: "PEOPLE_DATA_LABS_PERSON_SEARCH",
      title: "Person Search",
      description:
        "Search the person dataset with an Elasticsearch query or SQL string.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          query: { type: "object", additionalProperties: true },
          sql: { type: "string" },
          size: { type: "number" },
          scroll_token: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v5/person/search",
        body: { ...input },
      }),
    },
    {
      name: "PEOPLE_DATA_LABS_COMPANY_ENRICH",
      title: "Company Enrich",
      description: "Enrich a company by website, name, profile, or ticker.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          website: { type: "string" },
          name: { type: "string" },
          profile: { type: "string" },
          ticker: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/v5/company/enrich",
        query: Object.fromEntries(
          Object.entries(input).flatMap(([key, value]) =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
              ? [[key, value]]
              : [],
          ),
        ),
      }),
    },
    {
      name: "PEOPLE_DATA_LABS_COMPANY_SEARCH",
      title: "Company Search",
      description: "Search the company dataset with a query or SQL string.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          query: { type: "object", additionalProperties: true },
          sql: { type: "string" },
          size: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v5/company/search",
        body: { ...input },
      }),
    },
  ],
};
