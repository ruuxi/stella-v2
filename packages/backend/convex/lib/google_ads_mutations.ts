const GOOGLE_ADS_API_VERSION = "v23";

const GOOGLE_ADS_MUTATION_SERVICES = {
  GOOGLEADS_MUTATE_AD_GROUP_ADS: "adGroupAds",
  GOOGLEADS_MUTATE_AD_GROUP_ASSETS: "adGroupAssets",
  GOOGLEADS_MUTATE_AD_GROUP_BID_MODIFIERS: "adGroupBidModifiers",
  GOOGLEADS_MUTATE_AD_GROUP_CRITERIA: "adGroupCriteria",
  GOOGLEADS_MUTATE_AD_GROUPS: "adGroups",
  GOOGLEADS_MUTATE_ASSETS: "assets",
  GOOGLEADS_MUTATE_BIDDING_STRATEGIES: "biddingStrategies",
  GOOGLEADS_MUTATE_CAMPAIGN_ASSETS: "campaignAssets",
  GOOGLEADS_MUTATE_CAMPAIGN_BUDGETS: "campaignBudgets",
  GOOGLEADS_MUTATE_CAMPAIGN_CRITERIA: "campaignCriteria",
  GOOGLEADS_MUTATE_CAMPAIGN_LABELS: "campaignLabels",
  GOOGLEADS_MUTATE_CAMPAIGNS: "campaigns",
  GOOGLEADS_MUTATE_CONVERSION_ACTIONS: "conversionActions",
  GOOGLEADS_MUTATE_LABELS: "labels",
} as const;

const GOOGLE_ADS_RESERVED_FIELD_ALIASES: Record<string, string> = {
  type_: "type",
};

const googleAdsMutationInputSchema = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        minProperties: 1,
        additionalProperties: true,
      },
    },
    customer_id: { type: "string", pattern: "^[0-9 -]{1,32}$" },
    customerId: { type: "string", pattern: "^[0-9 -]{1,32}$" },
    validate_only: { type: "boolean" },
    validateOnly: { type: "boolean" },
    partial_failure: { type: "boolean" },
    partialFailure: { type: "boolean" },
    response_content_type: {
      type: "string",
      enum: ["UNSPECIFIED", "RESOURCE_NAME_ONLY", "MUTABLE_RESOURCE"],
    },
    responseContentType: {
      type: "string",
      enum: ["UNSPECIFIED", "RESOURCE_NAME_ONLY", "MUTABLE_RESOURCE"],
    },
  },
  required: ["operations"],
  additionalProperties: false,
} as const;

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const valuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const providerFieldName = (name: string) => {
  const reservedAlias = GOOGLE_ADS_RESERVED_FIELD_ALIASES[name];
  if (reservedAlias) return reservedAlias;
  if (name.endsWith("_")) return name;
  return name.replace(/_([a-z0-9])/gu, (_match, character: string) =>
    character.toUpperCase(),
  );
};

const toProviderJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toProviderJson);
  if (!isJsonObject(value)) return value;
  const result: JsonObject = {};
  for (const [name, child] of Object.entries(value)) {
    const providerName = providerFieldName(name);
    const providerValue = toProviderJson(child);
    if (
      Object.prototype.hasOwnProperty.call(result, providerName) &&
      !valuesEqual(result[providerName], providerValue)
    ) {
      throw new Error(`Conflicting Google Ads field aliases: ${providerName}`);
    }
    result[providerName] = providerValue;
  }
  return result;
};

const normalizeCustomerId = (value: unknown) => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[ -]/gu, "");
  return /^\d{1,20}$/u.test(normalized) ? normalized : null;
};

const customerIdFromOperations = (value: unknown): string | null => {
  if (typeof value === "string") {
    const match = /^customers\/(\d{1,20})(?:\/|$)/u.exec(value);
    return match?.[1] ?? null;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const customerId = customerIdFromOperations(child);
      if (customerId) return customerId;
    }
    return null;
  }
  if (!isJsonObject(value)) return null;
  for (const child of Object.values(value)) {
    const customerId = customerIdFromOperations(child);
    if (customerId) return customerId;
  }
  return null;
};

const encodeBase64Utf8 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
};

export const isGoogleAdsMutationAction = (action: string) =>
  Object.prototype.hasOwnProperty.call(GOOGLE_ADS_MUTATION_SERVICES, action);

export const effectiveGoogleAdsActionSchema = (
  toolkit: string,
  action: string,
  schema: JsonObject,
): JsonObject =>
  toolkit.toLowerCase() === "googleads" && isGoogleAdsMutationAction(action)
    ? structuredClone(googleAdsMutationInputSchema)
    : schema;

export const buildGoogleAdsMutationProxyRequest = (
  toolkit: string,
  action: string,
  input: JsonObject,
) => {
  if (
    toolkit.toLowerCase() !== "googleads" ||
    !isGoogleAdsMutationAction(action)
  ) {
    return null;
  }
  const snakeCustomerId = normalizeCustomerId(input.customer_id);
  const camelCustomerId = normalizeCustomerId(input.customerId);
  if (
    snakeCustomerId &&
    camelCustomerId &&
    snakeCustomerId !== camelCustomerId
  ) {
    throw new Error("Conflicting Google Ads customer IDs.");
  }
  const customerId =
    snakeCustomerId ??
    camelCustomerId ??
    customerIdFromOperations(input.operations);
  if (!customerId) return null;
  const requestBody = Object.fromEntries(
    Object.entries(input).filter(
      ([name]) => name !== "customer_id" && name !== "customerId",
    ),
  );
  const providerBody = toProviderJson(requestBody) as JsonObject;
  const service =
    GOOGLE_ADS_MUTATION_SERVICES[
      action as keyof typeof GOOGLE_ADS_MUTATION_SERVICES
    ];
  return {
    toolkit_slug: "googleads",
    endpoint: `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/${service}:mutate`,
    method: "POST",
    binary_body: {
      base64: encodeBase64Utf8(JSON.stringify(providerBody)),
      content_type: "application/json",
    },
  };
};

export const normalizeGoogleAdsProxyResponse = (payload: JsonObject) => {
  const status =
    typeof payload.status === "number" && Number.isFinite(payload.status)
      ? payload.status
      : 502;
  if (status >= 200 && status < 300) {
    return { successful: true, data: payload.data ?? {} };
  }
  return {
    successful: false,
    data: { status_code: status },
    error: JSON.stringify(payload.data ?? {}),
  };
};
