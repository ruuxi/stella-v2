import { ConnectorError } from "../errors";
import { isProviderEnabled } from "../env";
import {
  buildApiKeyProviderRequest,
  DEFERRED_API_KEY_PROVIDERS,
  type ApiKeyProviderRequest,
  type DeferredApiKeyProvider,
} from "../executors/api_key";

/**
 * Customer-hosted "connect profile" providers. These differ from the fixed
 * origin API-key providers in exactly one way: the HTTPS origin is supplied and
 * bound per owner (their self-hosted 1Password Connect server), never compiled
 * into backend code. The credential is a bearer token placed in `Authorization`
 * and is only ever sent to the bound origin (see `hosted_connect/execute.ts`).
 *
 * Everything else — the exact action set, the reviewed relative-path request
 * plans, and the operation classification — is shared with the deferred planner
 * catalog in `executors/api_key.ts`, so there is one source of truth for the
 * request shape and it cannot drift from what was reviewed.
 */

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  additionalProperties = true,
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties,
});

export type HostedConnectActionDescriptor = {
  operation: "read" | "write";
  inputSchema: Record<string, unknown>;
};

export type HostedConnectProviderDescriptor = {
  connectorId: string;
  providerKey: string;
  displayName: string;
  /** Label for the token entry in the desktop prompt. */
  credentialLabel: string;
  /** Label for the origin entry in the desktop prompt. */
  originLabel: string;
  /** Placeholder shown for the origin field. */
  originPlaceholder: string;
  /** Token placement. Only bearer is supported for hosted connect today. */
  tokenPlacement: { type: "bearer" };
  actions: Readonly<Record<string, HostedConnectActionDescriptor>>;
};

const ONEPASSWORD_ACTIONS = {
  ONEPASSWORD_LIST_VAULTS: {
    operation: "read",
    inputSchema: objectSchema({ filter: { type: "string" } }, [], false),
  },
  ONEPASSWORD_LIST_ITEMS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        vaultUuid: { type: "string", minLength: 1 },
        filter: { type: "string" },
      },
      ["vaultUuid"],
      false,
    ),
  },
  ONEPASSWORD_GET_ITEM: {
    operation: "read",
    inputSchema: objectSchema(
      {
        vaultUuid: { type: "string", minLength: 1 },
        itemUuid: { type: "string", minLength: 1 },
      },
      ["vaultUuid", "itemUuid"],
      false,
    ),
  },
  ONEPASSWORD_CREATE_ITEM: {
    operation: "write",
    inputSchema: objectSchema(
      {
        vaultUuid: { type: "string", minLength: 1 },
        category: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" } },
        fields: { type: "array" },
        sections: { type: "array" },
        urls: { type: "array" },
      },
      ["vaultUuid", "category", "title"],
    ),
  },
} as const satisfies Readonly<Record<string, HostedConnectActionDescriptor>>;

/**
 * Reviewed activation set for hosted-connect providers. Deliberately small: a
 * provider only appears here once its exact origin-binding model, credential
 * placement, and request plans have been reviewed.
 */
export const HOSTED_CONNECT_PROVIDER_DESCRIPTORS = [
  {
    connectorId: "1password",
    providerKey: "1password",
    displayName: "1Password",
    credentialLabel: "1Password Connect access token",
    originLabel: "1Password Connect server URL",
    originPlaceholder: "https://connect.your-company.com",
    tokenPlacement: { type: "bearer" },
    actions: ONEPASSWORD_ACTIONS,
  },
] as const satisfies readonly HostedConnectProviderDescriptor[];

const descriptorByConnector = new Map<string, HostedConnectProviderDescriptor>(
  HOSTED_CONNECT_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.connectorId,
    descriptor as HostedConnectProviderDescriptor,
  ]),
);
const descriptorByProvider = new Map<string, HostedConnectProviderDescriptor>(
  HOSTED_CONNECT_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.providerKey,
    descriptor as HostedConnectProviderDescriptor,
  ]),
);

export const getHostedConnectProviderDescriptor = (
  connectorId: string,
): HostedConnectProviderDescriptor | null =>
  descriptorByConnector.get(connectorId.trim().toLowerCase()) ?? null;

export const getHostedConnectProviderDescriptorByKey = (
  providerKey: string,
): HostedConnectProviderDescriptor | null =>
  descriptorByProvider.get(providerKey.trim().toLowerCase()) ?? null;

export const getHostedConnectActionDescriptor = (
  descriptor: HostedConnectProviderDescriptor,
  action: string,
): HostedConnectActionDescriptor | null => descriptor.actions[action] ?? null;

export const hostedConnectProviderForConnectorAction = (
  connectorId: string,
  action: string,
): HostedConnectProviderDescriptor | null => {
  const descriptor = getHostedConnectProviderDescriptor(connectorId);
  return descriptor && getHostedConnectActionDescriptor(descriptor, action)
    ? descriptor
    : null;
};

/**
 * Validate a customer-supplied Connect access token. 1Password Connect tokens
 * are JWTs (three base64url segments). We accept only that shape, printable and
 * length-bounded, so a stray secret / URL / origin can never be stored as a
 * token by mistake.
 */
export const validateHostedConnectToken = (value: unknown): string => {
  if (typeof value !== "string") throw new ConnectorError("invalid_credential");
  const token = value.trim();
  if (
    token.length < 20 ||
    token.length > 8192 ||
    token !== value ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new ConnectorError("invalid_credential");
  }
  return token;
};

/**
 * Separate, mandatory attestation that a hosted-connect provider has passed a
 * representative live call in staging. Independent from deployment enablement.
 */
export const isHostedConnectProviderVerified = (
  providerKey: string,
): boolean => {
  const raw = process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(providerKey.trim().toLowerCase());
};

export const requireReadyHostedConnectProvider = (
  connectorId: string,
): HostedConnectProviderDescriptor => {
  const descriptor = getHostedConnectProviderDescriptor(connectorId);
  if (!descriptor) throw new ConnectorError("provider_not_configured");
  if (!isHostedConnectProviderVerified(descriptor.providerKey)) {
    throw new ConnectorError("provider_unverified");
  }
  if (!isProviderEnabled(descriptor.providerKey)) {
    throw new ConnectorError("provider_disabled");
  }
  return descriptor;
};

export const buildHostedConnectRequest = (
  descriptor: HostedConnectProviderDescriptor,
  action: string,
  input: Record<string, unknown>,
): ApiKeyProviderRequest => {
  if (!getHostedConnectActionDescriptor(descriptor, action)) {
    throw new ConnectorError("action_not_found");
  }
  const request = buildApiKeyProviderRequest(
    descriptor.providerKey,
    action,
    input,
  );
  if (!request) throw new ConnectorError("action_not_found");
  return request;
};

/**
 * Structural invariants for the hosted-connect catalog. Every provider must be a
 * tenant-origin provider in the shared deferred planner catalog with matching
 * connector id, provider key and action operations — hosted connect never
 * introduces its own origin strategy or request plans out of band.
 */
export const validateHostedConnectProviderDescriptors = (): string[] => {
  const problems: string[] = [];
  const connectorIds = new Set<string>();
  const providerKeys = new Set<string>();
  const deferredByConnector = new Map<string, DeferredApiKeyProvider>(
    DEFERRED_API_KEY_PROVIDERS.map((provider) => [
      provider.connectorId,
      provider,
    ]),
  );
  for (const descriptor of HOSTED_CONNECT_PROVIDER_DESCRIPTORS) {
    if (connectorIds.has(descriptor.connectorId)) {
      problems.push(`duplicate connector ${descriptor.connectorId}`);
    }
    if (providerKeys.has(descriptor.providerKey)) {
      problems.push(`duplicate provider ${descriptor.providerKey}`);
    }
    connectorIds.add(descriptor.connectorId);
    providerKeys.add(descriptor.providerKey);
    const deferred = deferredByConnector.get(descriptor.connectorId);
    if (!deferred || deferred.providerKey !== descriptor.providerKey) {
      problems.push(`${descriptor.connectorId} is not in the planner catalog`);
      continue;
    }
    if (!deferred.requiresTenantOrigin) {
      problems.push(
        `${descriptor.connectorId} must be a tenant-origin planner provider`,
      );
    }
    // A hosted-connect provider is customer-hosted at an arbitrary origin: it
    // must NOT carry a fixed origin or a narrow suffix, or it would belong to a
    // different (fixed / account-suffix) execution path.
    if (
      deferred.fixedApiOrigin ||
      deferred.fixedApiOriginByAction ||
      deferred.tenantOriginSuffix
    ) {
      problems.push(
        `${descriptor.connectorId} must not declare a fixed or suffix origin`,
      );
    }
    const actionNames = Object.keys(descriptor.actions);
    if (actionNames.length === 0) {
      problems.push(`${descriptor.connectorId} has no actions`);
    }
    for (const [action, actionDescriptor] of Object.entries(
      descriptor.actions,
    )) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(action)) {
        problems.push(`${descriptor.connectorId}:${action} has an unsafe name`);
      }
      if (deferred.actions[action] !== actionDescriptor.operation) {
        problems.push(`${descriptor.connectorId}:${action} operation mismatch`);
      }
      if (actionDescriptor.inputSchema.type !== "object") {
        problems.push(
          `${descriptor.connectorId}:${action} has no object schema`,
        );
      }
    }
  }
  return problems;
};
