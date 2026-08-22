import {
  optionalRecord,
  requireString,
  seg,
  type ConnectorAdapter,
} from "./types.js";

const API_VERSION = "v60.0";
const dataPath = (suffix: string) => `/services/data/${API_VERSION}${suffix}`;

/**
 * Salesforce REST API — https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/
 * Auth: OAuth2 (bearer). Base: the token's instance URL (resourceUrl captured
 * at connect time); the declared base is the login host for discovery only.
 */
export const SALESFORCE_ADAPTER: ConnectorAdapter = {
  id: "salesforce",
  displayName: "Salesforce",
  auth: "oauth",
  baseUrl: "https://login.salesforce.com",
  apiAuthScheme: "bearer",
  scopes: ["api", "refresh_token"],
  docsUrl:
    "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
  actions: [
    {
      name: "SALESFORCE_SOQL_QUERY",
      title: "SOQL Query",
      description: "Run a read-only SOQL query and return matching records.",
      kind: "read",
      scopes: ["api"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["q"],
        properties: { q: { type: "string" } },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: dataPath("/query"),
        query: { q: requireString(input, "q", "SALESFORCE_SOQL_QUERY") },
      }),
    },
    {
      name: "SALESFORCE_GET_RECORD",
      title: "Get Record",
      description: "Retrieve a single sObject record by type and id.",
      kind: "read",
      scopes: ["api"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sobject", "id"],
        properties: {
          sobject: { type: "string" },
          id: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: dataPath(
          `/sobjects/${seg(requireString(input, "sobject", "SALESFORCE_GET_RECORD"))}/${seg(requireString(input, "id", "SALESFORCE_GET_RECORD"))}`,
        ),
        ...(Array.isArray(input.fields) && input.fields.length
          ? { query: { fields: input.fields.join(",") } }
          : {}),
      }),
    },
    {
      name: "SALESFORCE_CREATE_RECORD",
      title: "Create Record",
      description: "Create an sObject record of the given type from a fields map.",
      kind: "write",
      scopes: ["api"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sobject", "fields"],
        properties: {
          sobject: { type: "string" },
          fields: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const fields = optionalRecord(input, "fields");
        if (!fields) {
          throw new Error("SALESFORCE_CREATE_RECORD requires a `fields` object.");
        }
        return {
          method: "POST",
          path: dataPath(
            `/sobjects/${seg(requireString(input, "sobject", "SALESFORCE_CREATE_RECORD"))}`,
          ),
          body: fields,
        };
      },
    },
    {
      name: "SALESFORCE_UPDATE_RECORD",
      title: "Update Record",
      description: "Update fields on an existing sObject record by type and id.",
      kind: "write",
      scopes: ["api"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sobject", "id", "fields"],
        properties: {
          sobject: { type: "string" },
          id: { type: "string" },
          fields: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const fields = optionalRecord(input, "fields");
        if (!fields) {
          throw new Error("SALESFORCE_UPDATE_RECORD requires a `fields` object.");
        }
        return {
          method: "PATCH",
          path: dataPath(
            `/sobjects/${seg(requireString(input, "sobject", "SALESFORCE_UPDATE_RECORD"))}/${seg(requireString(input, "id", "SALESFORCE_UPDATE_RECORD"))}`,
          ),
          body: fields,
        };
      },
    },
    {
      name: "SALESFORCE_CREATE_LEAD",
      title: "Create Lead",
      description: "Create a Lead record from a fields map (LastName required).",
      kind: "write",
      scopes: ["api"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["fields"],
        properties: {
          fields: { type: "object", additionalProperties: true },
        },
      },
      buildRequest: (input) => {
        const fields = optionalRecord(input, "fields");
        if (!fields) {
          throw new Error("SALESFORCE_CREATE_LEAD requires a `fields` object.");
        }
        return {
          method: "POST",
          path: dataPath("/sobjects/Lead"),
          body: fields,
        };
      },
    },
  ],
};
