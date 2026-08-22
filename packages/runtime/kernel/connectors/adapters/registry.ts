/**
 * Registry of the CRM / recruiting / sales first-party adapters. This is the
 * single lookup surface for code-ready metadata and unit tests. Runtime
 * execution is intentionally not wired here; the backend shared core owns it.
 */

import { APOLLO_ADAPTER } from "./apollo.js";
import { ASHBY_ADAPTER } from "./ashby.js";
import { ATTIO_ADAPTER } from "./attio.js";
import { GONG_ADAPTER } from "./gong.js";
import { HUBSPOT_ADAPTER } from "./hubspot.js";
import { PEOPLE_DATA_LABS_ADAPTER } from "./people-data-labs.js";
import { PIPEDRIVE_ADAPTER } from "./pipedrive.js";
import { SALESFORCE_ADAPTER } from "./salesforce.js";
import { TWENTY_ONE_RISK_ADAPTER } from "./twenty-one-risk.js";
import type {
  ConnectorAdapter,
  ConnectorAdapterAction,
  ConnectorAdapterRequest,
} from "./types.js";

export type {
  ConnectorAdapter,
  ConnectorAdapterAction,
  ConnectorAdapterRequest,
  ConnectorAdapterActionKind,
  ConnectorAdapterAuth,
} from "./types.js";

const ADAPTERS: readonly ConnectorAdapter[] = [
  HUBSPOT_ADAPTER,
  GONG_ADAPTER,
  ASHBY_ADAPTER,
  PIPEDRIVE_ADAPTER,
  SALESFORCE_ADAPTER,
  APOLLO_ADAPTER,
  ATTIO_ADAPTER,
  PEOPLE_DATA_LABS_ADAPTER,
  TWENTY_ONE_RISK_ADAPTER,
];

const ADAPTER_BY_ID = new Map<string, ConnectorAdapter>(
  ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

/** All registered CRM/recruiting/sales adapters. */
export const listConnectorAdapters = (): readonly ConnectorAdapter[] =>
  ADAPTERS;

/** The set of connector ids that have a first-party adapter. */
export const CONNECTOR_ADAPTER_IDS: readonly string[] = ADAPTERS.map(
  (adapter) => adapter.id,
);

/** Look up an adapter by connector id (unchanged Store/catalog id). */
export const getConnectorAdapter = (id: string): ConnectorAdapter | undefined =>
  ADAPTER_BY_ID.get(id.trim().toLowerCase());

/** Look up a single named action within an adapter. */
export const getConnectorAdapterAction = (
  id: string,
  action: string,
): ConnectorAdapterAction | undefined => {
  const adapter = getConnectorAdapter(id);
  if (!adapter) return undefined;
  const wanted = action.trim();
  return adapter.actions.find((entry) => entry.name === wanted);
};

/** All action metadata for one adapter (for catalog/action listings). */
export const listConnectorAdapterActions = (
  id: string,
): readonly ConnectorAdapterAction[] => getConnectorAdapter(id)?.actions ?? [];

/**
 * Build one REST request for adapter contract tests and migration tooling.
 * Runtime callers must use the backend-owned connector dispatcher instead.
 */
export const buildConnectorAdapterRequest = (
  id: string,
  action: string,
  input: Record<string, unknown>,
): ConnectorAdapterRequest => {
  const adapterAction = getConnectorAdapterAction(id, action);
  if (!adapterAction) {
    throw new Error(
      `${id} does not expose a first-party adapter action named ${action}.`,
    );
  }
  return adapterAction.buildRequest(input ?? {});
};
