import { GraphApiError } from "./GraphClient.js";
import { logToFile } from "./logger.js";

export type ServiceContent = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

/** Wraps a successful payload as an MCP-style text tool result. */
export const ok = (payload: unknown): ServiceContent => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

/** Wraps a failure, logging a redacted diagnostic and surfacing the message. */
export const fail = (context: string, error: unknown): ServiceContent => {
  const message =
    error instanceof GraphApiError
      ? `${error.message}${error.code ? ` (${error.code})` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  logToFile(`Error during ${context}: ${message}`);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
};
