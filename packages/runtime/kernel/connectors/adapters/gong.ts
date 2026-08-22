import {
  optionalRecord,
  requireString,
  seg,
  type ConnectorAdapter,
} from "./types.js";

/**
 * Gong API v2 — https://gong.app.gong.io/settings/api/documentation
 * Auth: OAuth2 (bearer). Base: https://api.gong.io
 */
export const GONG_ADAPTER: ConnectorAdapter = {
  id: "gong",
  displayName: "Gong",
  auth: "oauth",
  baseUrl: "https://api.gong.io",
  apiAuthScheme: "bearer",
  scopes: [
    "api:calls:read:basic",
    "api:calls:read:extensive",
    "api:calls:read:transcript",
    "api:users:read",
    "api:calls:create",
  ],
  docsUrl: "https://gong.app.gong.io/settings/api/documentation",
  actions: [
    {
      name: "GONG_LIST_CALLS",
      title: "List Calls",
      description:
        "List calls in a date range (fromDateTime / toDateTime, ISO-8601).",
      kind: "read",
      scopes: ["api:calls:read:basic"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromDateTime: { type: "string" },
          toDateTime: { type: "string" },
          cursor: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/v2/calls",
        query: {
          ...(typeof input.fromDateTime === "string"
            ? { fromDateTime: input.fromDateTime }
            : {}),
          ...(typeof input.toDateTime === "string"
            ? { toDateTime: input.toDateTime }
            : {}),
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        },
      }),
    },
    {
      name: "GONG_GET_CALL",
      title: "Get Call",
      description: "Retrieve metadata for a single call by id.",
      kind: "read",
      scopes: ["api:calls:read:basic"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["callId"],
        properties: { callId: { type: "string" } },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: `/v2/calls/${seg(requireString(input, "callId", "GONG_GET_CALL"))}`,
      }),
    },
    {
      name: "GONG_RETRIEVE_TRANSCRIPTS",
      title: "Retrieve Call Transcripts",
      description:
        "Retrieve transcripts for calls matching a filter (call ids and/or date range).",
      kind: "read",
      scopes: ["api:calls:read:transcript"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filter: { type: "object", additionalProperties: true },
          cursor: { type: "string" },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: "/v2/calls/transcript",
        body: {
          filter: optionalRecord(input, "filter") ?? {},
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        },
      }),
    },
    {
      name: "GONG_LIST_USERS",
      title: "List Users",
      description: "List Gong users in the workspace.",
      kind: "read",
      scopes: ["api:users:read"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { cursor: { type: "string" } },
      },
      buildRequest: (input) => ({
        method: "GET",
        path: "/v2/users",
        ...(typeof input.cursor === "string"
          ? { query: { cursor: input.cursor } }
          : {}),
      }),
    },
    {
      name: "GONG_ADD_CALL",
      title: "Add Call",
      description:
        "Register a call recording in Gong from a call metadata payload.",
      kind: "write",
      scopes: ["api:calls:create"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["call"],
        properties: { call: { type: "object", additionalProperties: true } },
      },
      buildRequest: (input) => {
        const call = optionalRecord(input, "call");
        if (!call) throw new Error("GONG_ADD_CALL requires a `call` object.");
        return { method: "POST", path: "/v2/calls", body: call };
      },
    },
  ],
};
