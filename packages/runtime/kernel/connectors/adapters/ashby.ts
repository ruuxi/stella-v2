import {
  optionalRecord,
  requireString,
  type ConnectorAdapter,
} from "./types.js";

/**
 * Ashby API — https://developers.ashbyhq.com/reference
 * Auth: API key via HTTP Basic (key as username, blank password). All
 * endpoints are POST. Base: https://api.ashbyhq.com
 *
 * The stored credential is the pre-encoded Basic value `base64(apiKey + ":")`,
 * applied with the `basic` scheme.
 */
export const ASHBY_ADAPTER: ConnectorAdapter = {
  id: "ashby",
  displayName: "Ashby",
  auth: "api_key",
  baseUrl: "https://api.ashbyhq.com",
  apiAuthScheme: "basic",
  docsUrl: "https://developers.ashbyhq.com/reference",
  actions: [
    {
      name: "ASHBY_LIST_CANDIDATES",
      title: "List Candidates",
      description: "List candidates with cursor-based pagination.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number" },
          cursor: { type: "string" },
          syncToken: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/candidate.list",
        body: {
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
          ...(typeof input.syncToken === "string"
            ? { syncToken: input.syncToken }
            : {}),
        },
      }),
    },
    {
      name: "ASHBY_SEARCH_CANDIDATES",
      title: "Search Candidates",
      description: "Search candidates by email and/or name.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          email: { type: "string" },
          name: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/candidate.search",
        body: {
          ...(typeof input.email === "string" ? { email: input.email } : {}),
          ...(typeof input.name === "string" ? { name: input.name } : {}),
        },
      }),
    },
    {
      name: "ASHBY_CREATE_CANDIDATE",
      title: "Create Candidate",
      description:
        "Create a candidate with a name and optional contact fields.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["name"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phoneNumber: { type: "string" },
          linkedInUrl: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/candidate.create",
        body: {
          ...input,
          name: requireString(input, "name", "ASHBY_CREATE_CANDIDATE"),
        },
      }),
    },
    {
      name: "ASHBY_LIST_JOBS",
      title: "List Jobs",
      description: "List jobs with cursor-based pagination.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number" },
          cursor: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/job.list",
        body: {
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        },
      }),
    },
    {
      name: "ASHBY_CREATE_NOTE",
      title: "Create Candidate Note",
      description: "Add a note to a candidate.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "note"],
        properties: {
          candidateId: { type: "string" },
          note: { type: "string" },
          sendNotifications: { type: "boolean" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/candidate.createNote",
        body: {
          candidateId: requireString(input, "candidateId", "ASHBY_CREATE_NOTE"),
          note: requireString(input, "note", "ASHBY_CREATE_NOTE"),
          ...(typeof input.sendNotifications === "boolean"
            ? { sendNotifications: input.sendNotifications }
            : {}),
        },
      }),
    },
  ],
};
