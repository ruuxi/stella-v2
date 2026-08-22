import {
  optionalRecord,
  requireString,
  seg,
  type ConnectorAdapter,
} from "./types.js";

/**
 * Pipedrive API v1 — https://developers.pipedrive.com/docs/api/v1
 * Auth: OAuth2 (bearer). Base: https://api.pipedrive.com/v1
 */
export const PIPEDRIVE_ADAPTER: ConnectorAdapter = {
  id: "pipedrive",
  displayName: "Pipedrive",
  auth: "oauth",
  baseUrl: "https://api.pipedrive.com/v1",
  apiAuthScheme: "bearer",
  scopes: [
    "deals:read",
    "deals:full",
    "contacts:read",
    "contacts:full",
    "activities:full",
  ],
  docsUrl: "https://developers.pipedrive.com/docs/api/v1",
  actions: [
    {
      name: "PIPEDRIVE_LIST_DEALS",
      title: "List Deals",
      description: "List deals with optional status filter and paging.",
      kind: "read",
      scopes: ["deals:read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          start: { type: "number" },
          limit: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/deals",
        query: {
          ...(typeof input.status === "string"
            ? { status: input.status }
            : {}),
          ...(typeof input.start === "number" ? { start: input.start } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        },
      }),
    },
    {
      name: "PIPEDRIVE_SEARCH_PERSONS",
      title: "Search Persons",
      description: "Search persons (contacts) by a free-text term.",
      kind: "read",
      scopes: ["contacts:read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["term"],
        properties: {
          term: { type: "string" },
          fields: { type: "string" },
          limit: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/persons/search",
        query: {
          term: requireString(input, "term", "PIPEDRIVE_SEARCH_PERSONS"),
          ...(typeof input.fields === "string"
            ? { fields: input.fields }
            : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        },
      }),
    },
    {
      name: "PIPEDRIVE_CREATE_PERSON",
      title: "Create Person",
      description: "Create a person (contact) with name and optional details.",
      kind: "write",
      scopes: ["contacts:full"],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["name"],
        properties: {
          name: { type: "string" },
          email: { type: "array", items: { type: "string" } },
          phone: { type: "array", items: { type: "string" } },
          org_id: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/persons",
        body: {
          ...input,
          name: requireString(input, "name", "PIPEDRIVE_CREATE_PERSON"),
        },
      }),
    },
    {
      name: "PIPEDRIVE_CREATE_DEAL",
      title: "Create Deal",
      description: "Create a deal with a title and optional value/person.",
      kind: "write",
      scopes: ["deals:full"],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["title"],
        properties: {
          title: { type: "string" },
          value: { type: "number" },
          currency: { type: "string" },
          person_id: { type: "number" },
          org_id: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/deals",
        body: {
          ...input,
          title: requireString(input, "title", "PIPEDRIVE_CREATE_DEAL"),
        },
      }),
    },
    {
      name: "PIPEDRIVE_UPDATE_DEAL",
      title: "Update Deal",
      description: "Update fields on an existing deal by id.",
      kind: "write",
      scopes: ["deals:full"],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["id", "fields"],
        properties: {
          id: { type: "number" },
          fields: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const id = input.id;
        if (typeof id !== "number" && typeof id !== "string") {
          throw new Error("PIPEDRIVE_UPDATE_DEAL requires a numeric `id`.");
        }
        const fields = optionalRecord(input, "fields");
        if (!fields) {
          throw new Error("PIPEDRIVE_UPDATE_DEAL requires a `fields` object.");
        }
        return {
          method: "PUT",
          path: `/deals/${seg(String(id))}`,
          body: fields,
        };
      },
    },
    {
      name: "PIPEDRIVE_ADD_NOTE",
      title: "Add Note",
      description: "Add a note attached to a deal, person, or organization.",
      kind: "write",
      scopes: ["deals:full"],
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["content"],
        properties: {
          content: { type: "string" },
          deal_id: { type: "number" },
          person_id: { type: "number" },
          org_id: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/notes",
        body: {
          ...input,
          content: requireString(input, "content", "PIPEDRIVE_ADD_NOTE"),
        },
      }),
    },
  ],
};
