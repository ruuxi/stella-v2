import { requireString, type ConnectorAdapter } from "./types.js";

/**
 * Apollo.io API v1 — https://docs.apollo.io/reference
 * Auth: API key via the `X-Api-Key` header. Base: https://api.apollo.io
 */
export const APOLLO_ADAPTER: ConnectorAdapter = {
  id: "apollo",
  displayName: "Apollo",
  auth: "api_key",
  baseUrl: "https://api.apollo.io",
  apiAuthScheme: "raw",
  authHeaderName: "X-Api-Key",
  docsUrl: "https://docs.apollo.io/reference",
  actions: [
    {
      name: "APOLLO_PEOPLE_SEARCH",
      title: "People Search",
      description:
        "Search Apollo's people database by titles, keywords, and location.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          q_keywords: { type: "string" },
          person_titles: { type: "array", items: { type: "string" } },
          person_locations: { type: "array", items: { type: "string" } },
          page: { type: "number" },
          per_page: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v1/mixed_people/search",
        body: { ...input },
      }),
    },
    {
      name: "APOLLO_ORGANIZATION_SEARCH",
      title: "Organization Search",
      description: "Search Apollo's organization/company database.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          q_organization_name: { type: "string" },
          organization_locations: { type: "array", items: { type: "string" } },
          page: { type: "number" },
          per_page: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v1/mixed_companies/search",
        body: { ...input },
      }),
    },
    {
      name: "APOLLO_PEOPLE_ENRICH",
      title: "Enrich Person",
      description:
        "Enrich a single person by email, name, domain, or LinkedIn URL.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          email: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          domain: { type: "string" },
          linkedin_url: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v1/people/match",
        body: { ...input },
      }),
    },
    {
      name: "APOLLO_CREATE_CONTACT",
      title: "Create Contact",
      description: "Create a contact in the Apollo account.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["first_name", "last_name"],
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "string" },
          organization_name: { type: "string" },
          title: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v1/contacts",
        body: {
          ...input,
          first_name: requireString(
            input,
            "first_name",
            "APOLLO_CREATE_CONTACT",
          ),
          last_name: requireString(input, "last_name", "APOLLO_CREATE_CONTACT"),
        },
      }),
    },
    {
      name: "APOLLO_CREATE_TASK",
      title: "Create Task",
      description: "Create an outreach task for contacts in Apollo.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["priority", "type", "contact_ids"],
        properties: {
          priority: { type: "string" },
          type: { type: "string" },
          contact_ids: { type: "array", items: { type: "string" } },
          note: { type: "string" },
          due_at: { type: "string" },
        },
      },
      buildRequest: (input) => {
        if (!Array.isArray(input.contact_ids) || input.contact_ids.length === 0) {
          throw new Error("APOLLO_CREATE_TASK requires a `contact_ids` array.");
        }
        return {
          method: "POST",
          path: "/v1/tasks/bulk_create",
          body: {
            ...input,
            priority: requireString(input, "priority", "APOLLO_CREATE_TASK"),
            type: requireString(input, "type", "APOLLO_CREATE_TASK"),
          },
        };
      },
    },
  ],
};
