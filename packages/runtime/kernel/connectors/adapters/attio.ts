import {
  optionalRecord,
  requireString,
  seg,
  type ConnectorAdapter,
} from "./types.js";

/**
 * Attio API v2 — https://developers.attio.com/reference
 * Auth: OAuth2 (bearer). Base: https://api.attio.com
 */
export const ATTIO_ADAPTER: ConnectorAdapter = {
  id: "attio",
  displayName: "Attio",
  auth: "oauth",
  baseUrl: "https://api.attio.com",
  apiAuthScheme: "bearer",
  scopes: [
    "record_permission:read",
    "record_permission:read-write",
    "object_configuration:read",
    "list_entry:read",
  ],
  docsUrl: "https://developers.attio.com/reference",
  actions: [
    {
      name: "ATTIO_LIST_OBJECTS",
      title: "List Objects",
      description: "List the objects (schemas) configured in the workspace.",
      kind: "read",
      scopes: ["object_configuration:read"],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      buildRequest: () => ({ method: "GET", path: "/v2/objects" }),
    },
    {
      name: "ATTIO_QUERY_RECORDS",
      title: "Query Records",
      description:
        "Query records for an object (e.g. people, companies) with an optional filter.",
      kind: "read",
      scopes: ["record_permission:read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["object"],
        properties: {
          object: { type: "string" },
          filter: { type: "object", additionalProperties: true },
          sorts: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: `/v2/objects/${seg(requireString(input, "object", "ATTIO_QUERY_RECORDS"))}/records/query`,
        body: {
          ...(optionalRecord(input, "filter")
            ? { filter: optionalRecord(input, "filter") }
            : {}),
          ...(Array.isArray(input.sorts) ? { sorts: input.sorts } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        },
      }),
    },
    {
      name: "ATTIO_GET_RECORD",
      title: "Get Record",
      description: "Retrieve a single record by object and record id.",
      kind: "read",
      scopes: ["record_permission:read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["object", "recordId"],
        properties: {
          object: { type: "string" },
          recordId: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: `/v2/objects/${seg(requireString(input, "object", "ATTIO_GET_RECORD"))}/records/${seg(requireString(input, "recordId", "ATTIO_GET_RECORD"))}`,
      }),
    },
    {
      name: "ATTIO_CREATE_RECORD",
      title: "Create Record",
      description: "Create a record for an object from an attribute values map.",
      kind: "write",
      scopes: ["record_permission:read-write"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["object", "values"],
        properties: {
          object: { type: "string" },
          values: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const values = optionalRecord(input, "values");
        if (!values) {
          throw new Error("ATTIO_CREATE_RECORD requires a `values` object.");
        }
        return {
          method: "POST",
          path: `/v2/objects/${seg(requireString(input, "object", "ATTIO_CREATE_RECORD"))}/records`,
          body: { data: { values } },
        };
      },
    },
    {
      name: "ATTIO_UPDATE_RECORD",
      title: "Update Record",
      description: "Update attribute values on an existing record.",
      kind: "write",
      scopes: ["record_permission:read-write"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["object", "recordId", "values"],
        properties: {
          object: { type: "string" },
          recordId: { type: "string" },
          values: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const values = optionalRecord(input, "values");
        if (!values) {
          throw new Error("ATTIO_UPDATE_RECORD requires a `values` object.");
        }
        return {
          method: "PATCH",
          path: `/v2/objects/${seg(requireString(input, "object", "ATTIO_UPDATE_RECORD"))}/records/${seg(requireString(input, "recordId", "ATTIO_UPDATE_RECORD"))}`,
          body: { data: { values } },
        };
      },
    },
  ],
};
