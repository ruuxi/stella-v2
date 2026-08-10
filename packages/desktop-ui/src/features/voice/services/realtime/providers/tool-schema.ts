import type { RealtimeSessionTool } from "./types";

const UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
] as const;

/**
 * OpenAI Realtime requires function parameters to be a plain root object and
 * rejects root combinators. The runtime still validates tool input against the
 * complete original schema before execution, so removing provider-incompatible
 * root constraints does not weaken the execution boundary.
 */
export const toRealtimeProviderTool = (
  tool: RealtimeSessionTool,
): RealtimeSessionTool => {
  const parameters = { ...tool.parameters };
  for (const key of UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS) {
    delete parameters[key];
  }
  return {
    ...tool,
    parameters: {
      ...parameters,
      type: "object",
      properties:
        typeof parameters.properties === "object" &&
        parameters.properties !== null &&
        !Array.isArray(parameters.properties)
          ? parameters.properties
          : {},
    },
  };
};
