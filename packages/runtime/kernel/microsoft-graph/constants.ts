/** Default Microsoft Graph REST base. Overridable for tests / sovereign clouds. */
export const MICROSOFT_GRAPH_BASE_URL =
  process.env.STELLA_MICROSOFT_GRAPH_BASE_URL?.trim() ||
  "https://graph.microsoft.com/v1.0";

/** Token endpoint used to refresh the shared Microsoft grant. */
export const MICROSOFT_TOKEN_ENDPOINT =
  process.env.STELLA_MICROSOFT_TOKEN_ENDPOINT?.trim() ||
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * Connector token key for the shared Microsoft identity grant. Must match the
 * `tokenKey` in the native OAuth provider config (`native-oauth:microsoft`) so
 * the same stored credential backs both the connect flow and execution.
 */
export const MICROSOFT_TOKEN_KEY = "native-oauth:microsoft";

/** Default page size for list endpoints. */
export const GRAPH_DEFAULT_PAGE_SIZE = 25;
export const GRAPH_MAX_PAGE_SIZE = 100;
