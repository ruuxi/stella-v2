import type { RealtimeSessionTool } from "./types";

const UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
] as const;

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
