import type { TSchema } from "@sinclair/typebox";

export const MCP_LIST_MAX_DEADLINE_MS = 15_000;

export const CLOUD_INTEGRATION_TOOL_SPECS = [
  {
    name: "tool_search",
    label: "Search connected tools",
    description:
      "Search the owner's currently connected native integrations for explicitly reviewed read-only actions. Results contain an exact tool name and policy revision for mcp_describe or mcp_call. Missing, mutating, destructive, provider-only, and unclassified actions are never returned.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "What information to read from connected services.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum results (default 8).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as unknown as TSchema,
    codeEligibility: "read_only",
  },
  {
    name: "mcp_list",
    label: "List connected tools",
    description:
      "Enumerate the owner's complete bounded catalog of currently connected, explicitly reviewed read-only MCP tools. Pagination stays inside the owner- and turn-fenced host bridge. The result exposes stable tool identifiers and hash-only protocol receipts, never schemas, cursors, raw JSON-RPC ids, endpoints, tokens, or account identifiers.",
    parameters: {
      type: "object",
      properties: {
        deadline_ms: {
          type: "integer",
          minimum: 1,
          maximum: MCP_LIST_MAX_DEADLINE_MS,
          description: `Optional enumeration deadline in milliseconds (maximum ${MCP_LIST_MAX_DEADLINE_MS}).`,
        },
      },
      additionalProperties: false,
    } as unknown as TSchema,
    codeEligibility: "read_only",
  },
  {
    name: "mcp_describe",
    label: "Describe connected tool",
    description:
      "Load the exact bounded input schema for one read-only connected tool returned by tool_search. The server rechecks owner, connection, lifecycle, migration, and current policy.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Exact tool name returned by tool_search.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    } as unknown as TSchema,
    codeEligibility: "read_only",
  },
  {
    name: "mcp_call",
    label: "Call connected tool",
    description:
      "Call one explicitly read-only connected tool. Pass the exact name and revision returned by tool_search plus arguments matching mcp_describe. The server revalidates all policy and connection state and stores an exact-replay receipt. Mutating or unknown tools cannot be called here.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Exact tool name returned by tool_search.",
        },
        revision: {
          type: "string",
          minLength: 1,
          maxLength: 192,
          description: "Exact policy revision returned by tool_search.",
        },
        arguments: {
          type: "object",
          description: "Arguments matching the schema from mcp_describe.",
          additionalProperties: true,
        },
      },
      required: ["name", "revision", "arguments"],
      additionalProperties: false,
    } as unknown as TSchema,
    codeEligibility: "read_only",
  },
] as const;

export type CloudIntegrationToolName =
  (typeof CLOUD_INTEGRATION_TOOL_SPECS)[number]["name"];
