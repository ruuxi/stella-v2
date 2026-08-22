const SAFE_PUBLIC_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_TOOLKIT_SLUG = /^_?[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_44API_ACTION_NAME = /^44API_[A-Z0-9_]{1,122}$/u;
const SAFE_7SHIFTS_ACTION_NAME = /^7SHIFTS_[A-Z0-9_]{1,120}$/u;

const PUBLIC_CONNECTOR_ID_ALIASES = new Map([
  ["people_data_labs", "peopledatalabs"],
]);

const TOOLKIT_BY_PUBLIC_CONNECTOR_ID = new Map([
  ["21risk", "_21risk"],
  ["2chat", "_2chat"],
  ["1password", "_1password"],
]);

const TOOLKIT_SLUG_ALIASES = new Map([["people_data_labs", "peopledatalabs"]]);

export const canonicalizePublicConnectorId = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const canonical = PUBLIC_CONNECTOR_ID_ALIASES.get(normalized) ?? normalized;
  return SAFE_PUBLIC_CONNECTOR_ID.test(canonical) ? canonical : null;
};

export const compatiblePublicConnectorIds = (value) => {
  const canonical = canonicalizePublicConnectorId(value);
  if (!canonical) return [];
  const aliases = [...PUBLIC_CONNECTOR_ID_ALIASES.entries()]
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return [canonical, ...aliases];
};

export const composioToolkitForPublicConnectorId = (value) => {
  const id = canonicalizePublicConnectorId(value);
  if (!id) return null;
  return TOOLKIT_BY_PUBLIC_CONNECTOR_ID.get(id) ?? id;
};

export const canonicalizeComposioToolkitSlug = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!SAFE_TOOLKIT_SLUG.test(normalized)) return null;
  return TOOLKIT_SLUG_ALIASES.get(normalized) ?? normalized;
};

export const publicConnectorIdForComposioToolkitSlug = (value) => {
  const toolkit = canonicalizeComposioToolkitSlug(value);
  if (!toolkit) return null;
  for (const [id, mappedToolkit] of TOOLKIT_BY_PUBLIC_CONNECTOR_ID) {
    if (mappedToolkit === toolkit) return id;
  }
  return canonicalizePublicConnectorId(toolkit);
};

export const normalizeComposioConnectorIdentity = (idValue, toolkitValue) => {
  const id = canonicalizePublicConnectorId(idValue);
  const toolkit = canonicalizeComposioToolkitSlug(toolkitValue);
  if (!id || !toolkit || toolkit !== composioToolkitForPublicConnectorId(id)) {
    return null;
  }
  return { id, toolkit };
};

export const isSafeComposioActionName = (idValue, actionName) => {
  if (typeof actionName !== "string" || actionName.length > 128) return false;
  if (SAFE_ACTION_NAME.test(actionName)) return true;
  const connectorId = canonicalizePublicConnectorId(idValue);
  return (
    (connectorId === "44api" && SAFE_44API_ACTION_NAME.test(actionName)) ||
    (connectorId === "7shifts" && SAFE_7SHIFTS_ACTION_NAME.test(actionName))
  );
};
