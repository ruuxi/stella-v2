import { ConnectorError } from "../errors";

export type DesignFinanceProviderRequest = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  bodyEncoding?: "json" | "form";
};

const requiredString = (
  input: Record<string, unknown>,
  key: string,
): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorError("invalid_input");
  }
  return value.trim();
};

const queryPath = (
  path: string,
  input: Record<string, unknown>,
  keys: readonly string[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const key of keys) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
};

export const DESIGN_FINANCE_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, "read" | "write">>>
> = {
  figma: {
    FIGMA_GET_ME: "read",
    FIGMA_GET_FILE: "read",
    FIGMA_LIST_FILE_COMMENTS: "read",
    FIGMA_POST_FILE_COMMENT: "write",
  },
  stripe: {
    STRIPE_GET_BALANCE: "read",
    STRIPE_LIST_CUSTOMERS: "read",
    STRIPE_CREATE_CUSTOMER: "write",
    STRIPE_CREATE_REFUND: "write",
  },
};

export const DESIGN_FINANCE_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  figma: {
    FIGMA_GET_ME: ["current_user:read"],
    FIGMA_GET_FILE: ["file_content:read", "file_metadata:read"],
    FIGMA_LIST_FILE_COMMENTS: ["file_comments:read"],
    FIGMA_POST_FILE_COMMENT: ["file_comments:write"],
  },
  stripe: {
    STRIPE_GET_BALANCE: ["read_write"],
    STRIPE_LIST_CUSTOMERS: ["read_write"],
    STRIPE_CREATE_CUSTOMER: ["read_write"],
    STRIPE_CREATE_REFUND: ["read_write"],
  },
};

export const DESIGN_FINANCE_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  figma: { figma: Object.keys(DESIGN_FINANCE_ACTION_OPERATIONS.figma) },
  stripe: { stripe: Object.keys(DESIGN_FINANCE_ACTION_OPERATIONS.stripe) },
};

export const buildDesignFinanceProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): DesignFinanceProviderRequest | null => {
  switch (`${providerKey}:${action}`) {
    case "figma:FIGMA_GET_ME":
      return { method: "GET", path: "/v1/me" };
    case "figma:FIGMA_GET_FILE": {
      const fileKey = encodeURIComponent(requiredString(input, "file_key"));
      return {
        method: "GET",
        path: queryPath(`/v1/files/${fileKey}`, input, [
          "version",
          "ids",
          "depth",
          "geometry",
          "branch_data",
        ]),
      };
    }
    case "figma:FIGMA_LIST_FILE_COMMENTS": {
      const fileKey = encodeURIComponent(requiredString(input, "file_key"));
      return {
        method: "GET",
        path: queryPath(`/v1/files/${fileKey}/comments`, input, ["as_md"]),
      };
    }
    case "figma:FIGMA_POST_FILE_COMMENT": {
      const fileKey = encodeURIComponent(requiredString(input, "file_key"));
      return {
        method: "POST",
        path: `/v1/files/${fileKey}/comments`,
        body: {
          message: requiredString(input, "message"),
          ...(input.client_meta && typeof input.client_meta === "object"
            ? { client_meta: input.client_meta }
            : {}),
        },
      };
    }
    case "stripe:STRIPE_GET_BALANCE":
      return { method: "GET", path: "/v1/balance" };
    case "stripe:STRIPE_LIST_CUSTOMERS":
      return {
        method: "GET",
        path: queryPath("/v1/customers", input, [
          "limit",
          "email",
          "starting_after",
          "ending_before",
        ]),
      };
    case "stripe:STRIPE_CREATE_CUSTOMER":
      return {
        method: "POST",
        path: "/v1/customers",
        body: input,
        bodyEncoding: "form",
      };
    case "stripe:STRIPE_CREATE_REFUND":
      if (
        typeof input.charge !== "string" &&
        typeof input.payment_intent !== "string"
      ) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "POST",
        path: "/v1/refunds",
        body: input,
        bodyEncoding: "form",
      };
    default:
      return null;
  }
};
